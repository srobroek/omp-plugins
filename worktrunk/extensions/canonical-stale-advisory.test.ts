import { afterEach, describe, expect, test, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import canonicalStaleAdvisory, {
	commitsBehind,
	handleSessionStart,
	PROBE_TIMEOUT_MS,
	type ProbeResult,
} from "./canonical-stale-advisory.ts";
import { repositoryTopology, resetTopologyCache } from "./worktree-gate.ts";

const roots: string[] = [];
const GIT_ISOLATED = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

afterEach(() => {
	resetTopologyCache();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_ISOLATED, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

function configure(repo: string): void {
	git(repo, "config", "user.name", "fixture");
	git(repo, "config", "user.email", "fixture@example.invalid");
}

function commit(repo: string, file: string, contents: string, message: string): void {
	writeFileSync(join(repo, file), contents);
	git(repo, "add", file);
	git(repo, "commit", "-m", message);
}

interface Fixture {
	canonical: string;
	linked: string;
}

/**
 * Make a real canonical checkout whose local HEAD is one commit behind its
 * upstream. The upstream ref is written with `update-ref` rather than produced
 * by pushing from a second clone: this host gates `git push` behind Git
 * Defender, which hangs a non-interactive fixture until the runner kills it,
 * and a clone plus two pushes does not fit bun's five-second per-test limit.
 * Nothing here ever contacts the remote, and the advisory does not either, so
 * the recorded remote URL only has to exist as configuration.
 */
function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "worktrunk-canonical-stale-"));
	roots.push(root);
	const canonical = join(root, "canonical");
	const linked = join(root, "linked");
	mkdirSync(canonical);
	git(canonical, "init", "-b", "main");
	configure(canonical);
	commit(canonical, "tracked.txt", "first\n", "first");
	commit(canonical, "tracked.txt", "first\nsecond\n", "upstream update");
	git(canonical, "update-ref", "refs/remotes/origin/main", "HEAD");
	git(canonical, "remote", "add", "origin", join(root, "origin.git"));
	git(canonical, "branch", "--set-upstream-to=origin/main", "main");
	git(canonical, "reset", "--hard", "HEAD~1");
	return { canonical, linked };
}

function wire(): { start: (event: unknown, ctx: { cwd: string }) => Promise<void>; sent: string[] } {
	let start: ((event: unknown, ctx: { cwd: string }) => Promise<void>) | undefined;
	const sent: string[] = [];
	canonicalStaleAdvisory({
		on: (name: string, handler: unknown) => {
			if (name === "session_start") start = handler as typeof start;
		},
		sendMessage: (message: { content: string }) => sent.push(message.content),
	} as never);
	if (start === undefined) throw new Error("session_start handler was not registered");
	return { start, sent };
}

describe("canonical staleness advisory", () => {
	test("reports the commit count and remedy for a canonical checkout behind upstream", async () => {
		const f = fixture();
		const { start, sent } = wire();

		await start({}, { cwd: f.canonical });

		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(`Canonical checkout ${f.canonical} is 1 commit behind`);
		expect(sent[0]).toContain("reading files there reads history");
		expect(sent[0]).toContain("read a worktree of origin/main instead");
	});

	test("stays silent when the canonical checkout is current", async () => {
		const f = fixture();
		git(f.canonical, "merge", "--ff-only", "origin/main");
		const { start, sent } = wire();

		await start({}, { cwd: f.canonical });

		expect(sent).toEqual([]);
	});

	test("stays silent when there is no upstream", async () => {
		const f = fixture();
		git(f.canonical, "branch", "--unset-upstream");
		const { start, sent } = wire();

		await start({}, { cwd: f.canonical });

		expect(sent).toEqual([]);
	});

	test("stays silent when the checkout has no remote", async () => {
		const f = fixture();
		git(f.canonical, "remote", "remove", "origin");
		const { start, sent } = wire();

		await start({}, { cwd: f.canonical });

		expect(sent).toEqual([]);
	});

	test("stays silent inside a linked worktree", async () => {
		const f = fixture();
		git(f.canonical, "worktree", "add", "-b", "agent", f.linked);
		const { start, sent } = wire();

		await start({}, { cwd: f.linked });

		expect(sent).toEqual([]);
	});

	test("a failed or timed-out Git probe cannot report a false count", async () => {
		const f = fixture();
		const failed: ProbeResult = { exitCode: 128, stdout: "9", signal: null };
		const timedOut: ProbeResult = { exitCode: null, stdout: "9", signal: "SIGTERM" };
		expect(commitsBehind(f.canonical, () => failed)).toBeNull();
		expect(commitsBehind(f.canonical, () => timedOut)).toBeNull();
		expect(await handleSessionStart(f.canonical, () => null)).toBeUndefined();
	});

	test("a slow probe is bounded and the handler returns without reporting", async () => {
		const f = fixture();
		const topology = repositoryTopology(f.canonical);
		const pendingProbe = Promise.withResolvers<number>();
		vi.useFakeTimers();
		try {
			const pending = handleSessionStart(
				f.canonical,
				() => pendingProbe.promise,
				() => topology,
			);
			await Promise.resolve();
			vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
			expect(await pending).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			pendingProbe.resolve(7);
			vi.useRealTimers();
		}
	});
});
