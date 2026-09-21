import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worktreeDetachedGuard, {
	defaultProbe,
	type GitProbe,
	parseWorktreeList,
	removals,
	reviewCommand,
	segments,
	type WorktreeRecord,
} from "./worktree-detached-guard.ts";

const ATTACHED: WorktreeRecord = { path: "/repo/feature", head: "a".repeat(40), detached: false, branch: "feature" };
const DETACHED: WorktreeRecord = { path: "/repo/loose", head: "b".repeat(40), detached: true, branch: "" };

function probe(worktrees: WorktreeRecord[] | null, refs: string[] | null): GitProbe {
	return {
		list: () => worktrees,
		containingRefs: () => refs,
		resolve: (cwd, target) => (target.startsWith("/") ? target : join(cwd, target)).replace(/\/+$/, ""),
	};
}

describe("removal recognition", () => {
	test("names the target of each removal spelling", () => {
		expect(removals("git worktree remove ../loose")).toEqual([{ chdir: null, targets: ["../loose"], literal: true }]);
		expect(removals("wt remove loose")).toEqual([{ chdir: null, targets: ["loose"], literal: true }]);
		expect(removals("git -C /repo worktree remove --force ../loose")).toEqual([
			{ chdir: "/repo", targets: ["../loose"], literal: true },
		]);
		expect(removals("cd /repo && wt remove loose")).toEqual([{ chdir: null, targets: ["loose"], literal: true }]);
	});

	test("ignores commands that remove nothing", () => {
		expect(removals("git worktree list --porcelain")).toEqual([]);
		expect(removals("wt switch feature")).toEqual([]);
		expect(removals("rm -rf build")).toEqual([]);
		expect(removals("echo 'wt remove loose'")).toEqual([]);
	});

	test("marks wrapper-built and expanded removals as untrusted", () => {
		expect(removals("git worktree list --porcelain | xargs wt remove")[0]?.literal).toBe(false);
		expect(removals('wt remove "$STALE"')[0]?.literal).toBe(false);
		expect(removals("wt remove $(cat list)")[0]?.literal).toBe(false);
		expect(removals("bash -c 'wt remove loose'")[0]?.literal).toBe(false);
	});

	test("quoted words stay one target", () => {
		expect(removals("wt remove 'my worktree'")).toEqual([{ chdir: null, targets: ["my worktree"], literal: true }]);
	});
});

describe("refusals", () => {
	test("refuses a detached checkout no ref reaches", () => {
		const refusal = reviewCommand("wt remove ./loose", "/repo", probe([ATTACHED, DETACHED], []));
		expect(refusal).toContain("detached");
		expect(refusal).toContain("git branch recovered/loose bbbbbbb");
	});

	test("allows a detached checkout another ref reaches", () => {
		expect(reviewCommand("wt remove ./loose", "/repo", probe([ATTACHED, DETACHED], ["refs/heads/other"]))).toBeNull();
	});

	test("allows removing a checkout that is on a branch", () => {
		expect(reviewCommand("wt remove ./feature", "/repo", probe([ATTACHED, DETACHED], []))).toBeNull();
	});

	test("refuses a multi-target sweep before probing git", () => {
		let listed = 0;
		const counting: GitProbe = {
			...probe([ATTACHED], ["refs/heads/other"]),
			list: () => {
				listed++;
				return [ATTACHED];
			},
		};
		const refusal = reviewCommand("wt remove ./feature ./other", "/repo", counting);
		expect(refusal).toContain("2 targets in one call");
		expect(listed).toBe(0);
	});

	test("refuses when the worktree inventory cannot be read", () => {
		expect(reviewCommand("wt remove ./loose", "/repo", probe(null, []))).toContain("did not answer");
	});

	test("refuses when containment cannot be determined", () => {
		expect(reviewCommand("wt remove ./loose", "/repo", probe([DETACHED], null))).toContain(
			"containment could not be determined",
		);
	});

	test("resolves the target relative to a -C directory", () => {
		const seen: string[] = [];
		const tracking: GitProbe = {
			...probe([DETACHED], []),
			list: (cwd) => {
				seen.push(cwd);
				return [DETACHED];
			},
		};
		expect(reviewCommand("git -C /repo worktree remove loose", "/elsewhere", tracking)).toContain("detached");
		expect(seen).toEqual(["/repo"]);
	});
});

describe("gate wiring", () => {
	const handlers: Array<(event: { toolName: string; input: Record<string, unknown> }) => unknown> = [];
	const pi = {
		on: (_event: string, handler: (event: { toolName: string; input: Record<string, unknown> }) => unknown) => {
			handlers.push(handler);
		},
	};

	test("blocks the bash call by throwing, and only that call", () => {
		worktreeDetachedGuard(pi as never, probe([DETACHED], []));
		const handler = handlers[0];
		if (!handler) throw new Error("tool_call handler not registered");
		expect(() => handler({ toolName: "bash", input: { command: "wt remove ./loose", cwd: "/repo" } })).toThrow(
			/detached/,
		);
		expect(handler({ toolName: "bash", input: { command: "git worktree list", cwd: "/repo" } })).toBeUndefined();
		expect(handler({ toolName: "bash", input: {} })).toBeUndefined();
		expect(handler({ toolName: "edit", input: { path: "wt remove ../loose" } })).toBeUndefined();
	});
});

// The bug is a git behaviour, so the probes are proved against a real repository. Nothing is
// removed: only the refusal is computed for a removal that is never run.
describe("live git evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "wt-detached-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const repo = join(root, "repo");
	const loose = join(root, "loose");
	const contained = join(root, "contained");
	const git = (cwd: string, ...args: string[]) => {
		const proc = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		});
		if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
		return proc.stdout.toString().trim();
	};

	Bun.spawnSync(["mkdir", "-p", repo]);
	git(root, "init", "-q", "-b", "main", repo);
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "t");
	git(repo, "commit", "-q", "--allow-empty", "-m", "base");
	// A detached checkout whose tip only it references — the orphan case.
	git(repo, "worktree", "add", "-q", "--detach", loose);
	git(loose, "commit", "-q", "--allow-empty", "-m", "loose tip");
	// A detached checkout whose tip a branch also references — safe to remove.
	git(repo, "worktree", "add", "-q", "--detach", contained);
	git(contained, "commit", "-q", "--allow-empty", "-m", "contained tip");
	git(repo, "branch", "keep", git(contained, "rev-parse", "HEAD"));

	test("reads a real worktree inventory and real containment", () => {
		const live = defaultProbe();
		const worktrees = live.list(repo);
		expect(worktrees).not.toBeNull();
		const looseRecord = worktrees?.find((w) => live.resolve(repo, w.path) === live.resolve(repo, loose));
		expect(looseRecord?.detached).toBe(true);
		expect(live.containingRefs(repo, looseRecord?.head ?? "")).toEqual([]);
		const containedRecord = worktrees?.find((w) => live.resolve(repo, w.path) === live.resolve(repo, contained));
		expect(live.containingRefs(repo, containedRecord?.head ?? "")).toEqual(["refs/heads/keep"]);
	});

	test("refuses the orphaning removal and allows the contained one", () => {
		const live = defaultProbe();
		expect(reviewCommand(`wt remove ${loose}`, repo, live)).toContain("no ref reaches that commit");
		expect(reviewCommand(`git worktree remove ${contained}`, repo, live)).toBeNull();
		// Both checkouts still exist: the gate refuses, it never removes.
		expect(live.list(repo)?.length).toBe(3);
	});
});

describe("porcelain parsing", () => {
	test("separates detached checkouts from branch checkouts", () => {
		expect(
			parseWorktreeList(
				"worktree /repo\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree /repo/loose\nHEAD 2222222222222222222222222222222222222222\ndetached\n",
			),
		).toEqual([
			{ path: "/repo", head: "1".repeat(40), detached: false, branch: "main" },
			{ path: "/repo/loose", head: "2".repeat(40), detached: true, branch: "" },
		]);
	});
});

describe("word splitting", () => {
	test("separators end a segment and quotes keep a word whole", () => {
		expect(segments("cd /repo && wt remove 'a b'")).toEqual([
			{ words: ["cd", "/repo"], safe: true },
			{ words: ["wt", "remove", "a b"], safe: true },
		]);
	});
});
