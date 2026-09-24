import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

import hygieneOrientation, {
	type HygieneReport,
	type ProbeResult,
	type ProbeRunner,
	parsePorcelainPaths,
	parseWorktrees,
	permitted,
	scanHygiene,
	spawnProbe,
	UNKNOWN,
	type WorktreeState,
} from "./hygiene-orientation";
import { buildReceipt, receiptDirectory, repoKey, writeReceipt } from "./landing-receipt";

const temp = () => mkdtempSync(join(tmpdir(), "delivery-hygiene-"));
const git = (cwd: string, ...args: string[]) =>
	Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 5000,
	});

function repo(): string {
	const cwd = temp();
	git(cwd, "init", "-q");
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "base");
	return cwd;
}

function commit(cwd: string, name: string): void {
	writeFileSync(join(cwd, name), `${name}\n`);
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", name);
}

/** Point the receipt root at `agent` for one test, then put the environment back. */
function withAgentDir<T>(agent: string, body: () => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		return body();
	} finally {
		process.env.PI_CODING_AGENT_DIR = previous;
	}
}

type Registered = { approval?: string; description?: string; execute?: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }> };

/** The two registrations, captured from a stub host. */
function register(): Record<string, Registered> {
	const registered: Record<string, Registered> = {};
	const pi = {
		zod: { object: (value: unknown) => value },
		registerTool(definition: Registered & { name: string }) {
			registered[definition.name] = definition;
		},
	};
	hygieneOrientation(pi as never);
	return registered;
}

/** Every argv a scan asks its runner for, in order, with the real probe still running. */
function recordingScan(cwd: string, over?: (argv: readonly string[]) => ProbeResult | null): { argv: string[][]; report: HygieneReport } {
	const argv: string[][] = [];
	const runner: ProbeRunner = (command, directory, timeoutMs) => {
		argv.push([...command]);
		return over?.(command) ?? spawnProbe(command, directory, timeoutMs);
	};
	return { argv, report: scanHygiene(cwd, runner) };
}

/** Every sentence the report puts in front of a consumer: findings and row hand-offs. */
function prose(report: HygieneReport): string[] {
	return [...report.findings.map(finding => finding.description), ...report.worktrees.map(state => state.handOff ?? "")];
}

process.env.PI_CODING_AGENT_DIR = temp();

describe("delivery hygiene orientation", () => {
	test("the manifest keeps the advisory extension and registers orientation after it", () => {
		const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { omp: { extensions: string[] } };
		const extensions = manifest.omp.extensions;
		const advisory = extensions.indexOf("./extensions/unpushed-work-advisory.ts");
		const orientation = extensions.indexOf("./extensions/hygiene-orientation.ts");
		expect(advisory).toBeGreaterThanOrEqual(0);
		expect(orientation).toBeGreaterThan(advisory);
		expect(extensions.filter(entry => entry === "./extensions/hygiene-orientation.ts").length).toBe(1);
	});


	test("the hygiene report is read-approved and reads the context cwd", () => {
		const registered = register();
		expect(Object.keys(registered)).toEqual(["delivery_hygiene_report"]);
		expect(registered.delivery_hygiene_report?.approval).toBe("read");
		expect(registered.delivery_hygiene_report?.description).toContain("main-worktree flag");
	});

	test("delivery_hygiene_report names itself in its first line and reports the scanned cwd only", async () => {
		const cwd = repo();
		const report = register().delivery_hygiene_report;
		const result = await report?.execute?.("id", {}, null, null, { cwd });
		const first = result?.content[0]?.text.split("\n")[0] ?? "";
		expect(first.startsWith("delivery_hygiene_report: ")).toBe(true);
		expect(result?.details).toMatchObject({ mutation: "none", scope: { cwd } });
	});

	test("every argv the runner receives is in the read-only allowlist", () => {
		const { argv } = recordingScan(repo());
		expect(argv.length).toBeGreaterThan(0);
		for (const command of argv) expect({ command, allowed: permitted(command) }).toEqual({ command, allowed: true });
		const labels = argv.map(command => command.filter(word => word !== "--no-optional-locks").join(" "));
		expect(labels).toContain("git remote get-url origin");
		expect(labels).toContain("bd list --limit 1 --json");
		expect(labels).toContain("git worktree list --porcelain");
		expect(labels).toContain("git status --porcelain=v1 -z -b");
	});

	test("the allowlist fails closed for anything that is not one of its exact read-only commands", () => {
		expect(permitted(["git", "--no-optional-locks", "worktree", "list", "--porcelain"])).toBe(true);
		expect(permitted(["git", "--no-optional-locks", "rev-list", "--left-right", "--count", "refs/heads/x...refs/remotes/origin/x"])).toBe(true);
		// A write verb, an extra operand, a dropped flag, a relaxed lock, an option-shaped ref, another binary.
		expect(permitted(["git", "--no-optional-locks", "worktree", "remove", "/tmp/x"])).toBe(false);
		expect(permitted(["git", "--no-optional-locks", "push", "--force"])).toBe(false);
		expect(permitted(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z", "-b", "--", "/etc"])).toBe(false);
		expect(permitted(["git", "status", "--porcelain=v1", "-z", "-b"])).toBe(false);
		expect(permitted(["git", "--no-optional-locks", "rev-list", "--left-right", "--count", "--upload-pack=sh"])).toBe(false);
		expect(permitted(["bd", "update", "x", "--status", "closed"])).toBe(false);
		expect(permitted(["bd", "list", "--limit", "1"])).toBe(false);
	});

	test("dirty state is actionable but missing publication evidence is ambiguous", () => {
		const cwd = repo();
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		const result = scanHygiene(cwd);
		expect(result.status).toBe("ambiguous");
		expect(result.findings.some(f => f.kind === "dirty" && f.status === "actionable")).toBe(true);
		expect(result.findings.some(f => f.kind === "beads" || f.kind === "forge" || f.kind === "publication")).toBe(true);
	});

	test("a readable branch with no upstream is ambiguous rather than clean", () => {
		const result = scanHygiene(repo());
		const publication = result.findings.find(f => f.kind === "publication");
		expect(publication?.status).toBe("ambiguous");
		expect(publication?.description).toContain("no upstream");
		expect(result.worktrees.find(w => w.current)?.tracking).toBe("no-upstream");
	});

	test("a diverged branch reports both its ahead and its behind count", () => {
		const origin = repo();
		const clone = join(temp(), "clone");
		git(temp(), "clone", "-q", origin, clone);
		commit(clone, "local.txt");
		commit(origin, "one.txt");
		commit(origin, "two.txt");
		git(clone, "fetch", "-q", "origin");
		const result = scanHygiene(clone);
		const current = result.worktrees.find(w => w.current);
		expect(current?.tracking).toBe("tracked");
		expect(current?.ahead).toBe(1);
		expect(current?.behind).toBe(2);
		expect(result.findings.some(f => f.kind === "unpushed" && f.status === "actionable")).toBe(true);
		const behind = result.findings.find(f => f.kind === "upstream");
		expect(behind?.status).toBe("actionable");
		expect(behind?.description).toContain("2 commit(s) behind");
	});

	test("the inventory identifies the main worktree and counts each row's dirty paths", () => {
		const cwd = repo();
		const linked = join(temp(), "linked");
		git(cwd, "worktree", "add", "-q", "-b", "other", linked);
		writeFileSync(join(linked, "tracked.txt"), "changed here\n");
		writeFileSync(join(linked, "extra.txt"), "new here\n");
		const result = scanHygiene(cwd);
		const main = result.worktrees.find(w => w.main === true);
		const sibling = result.worktrees.find(w => !w.current);
		expect(realpathSync(main?.path ?? "")).toBe(realpathSync(cwd));
		expect(main?.current).toBe(true);
		expect(main?.dirty).toBe(0);
		expect(sibling?.main).toBe(false);
		expect(sibling?.branch).toBe("other");
		expect(sibling?.dirty).toBe(2);
		expect(realpathSync(result.scope.mainWorktree === UNKNOWN ? "/" : result.scope.mainWorktree)).toBe(realpathSync(cwd));
	});

	test("a scan run from a subdirectory is still held by its own worktree", () => {
		const cwd = repo();
		const nested = join(cwd, "packages", "inner");
		mkdirSync(nested, { recursive: true });
		const result = scanHygiene(nested);
		const current = result.worktrees.find(w => w.current);
		expect(current?.origin).toBe("git-worktree-list");
		expect(current?.owner).toBe("this-scan");
		expect(result.findings.some(f => f.kind === "scope")).toBe(false);
	});

	test("every linked worktree is inventoried, not only same-branch siblings", () => {
		const cwd = repo();
		const linked = join(temp(), "linked");
		git(cwd, "worktree", "add", "-q", "-b", "other", linked);
		const result = scanHygiene(cwd);
		expect(result.worktrees.length).toBe(2);
		const sibling = result.worktrees.find(w => !w.current);
		expect(sibling?.branch).toBe("other");
		expect(sibling?.tracking).toBe("no-upstream");
		const inventory = result.findings.find(f => f.kind === "linked-worktrees");
		expect(inventory?.paths?.map(path => realpathSync(path))).toEqual([realpathSync(linked)]);
	});

	test("a worktree outside the repository on another actor's branch is unknown with a hand-off, never a removal", () => {
		const cwd = repo();
		const outside = join(temp(), "omp-agent-other");
		git(cwd, "worktree", "add", "-q", "-b", "omp/agent/other-actor", outside);
		commit(outside, "their-work.txt");
		const result = scanHygiene(cwd);
		const foreign = result.worktrees.find(w => w.branch === "omp/agent/other-actor");
		expect(foreign?.owner).toBe(UNKNOWN);
		expect(foreign?.handOff).toContain("hand it to that party");
		expect(result.worktrees.find(w => w.current)?.owner).toBe("this-scan");
		expect(result.worktrees.find(w => w.current)?.handOff).toBeNull();
		for (const sentence of prose(result)) expect(sentence).not.toMatch(/\b(remove|removal|delete|deleted|prune)\b/i);
	});

	test("a path no listed worktree holds is inventoried as unknown with a hand-off", () => {
		const cwd = repo();
		const elsewhere = realpathSync(temp());
		const { report } = recordingScan(cwd, command =>
			command.includes("worktree")
				? { exitCode: 0, signalCode: null, stdout: `worktree ${elsewhere}\nHEAD abc\nbranch refs/heads/main\n\n`, stderr: "", timedOut: false }
				: null,
		);
		const row = report.worktrees.find(state => state.origin === "scan-path");
		expect(row?.current).toBe(true);
		expect(row?.owner).toBe(UNKNOWN);
		expect(row?.main).toBe(UNKNOWN);
		expect(row?.handOff).toContain("another actor's work");
		const scope = report.findings.find(f => f.kind === "scope");
		expect(scope?.status).toBe("ambiguous");
		expect(scope?.description).toContain("does not own it");
		for (const sentence of prose(report)) expect(sentence).not.toMatch(/\b(remove|removal|delete|deleted|prune)\b/i);
	});

	test("a probe that times out yields unknown, names itself as incomplete, and still returns a report", () => {
		const cwd = repo();
		const { report } = recordingScan(cwd, command =>
			command.includes("status") ? { exitCode: 143, signalCode: 9, stdout: "", stderr: "", timedOut: true } : null,
		);
		expect(report.status).toBe("ambiguous");
		expect(report.worktrees.find(state => state.current)?.dirty).toBe(UNKNOWN);
		expect(report.findings.some(f => f.kind === "git" && f.description.includes("dirty state is unknown"))).toBe(true);
		const incomplete = report.limitations.find(line => line.includes("git status --porcelain=v1 -z -b"));
		expect(incomplete).toContain("timed out");
		expect(report.mutation).toBe("none");
		for (const sentence of prose(report)) expect(sentence).not.toMatch(/\b(remove|removal|delete|deleted|prune)\b/i);
	});

	test("every probe hanging still returns a bounded report with nothing measured", () => {
		const cwd = repo();
		const bounds: number[] = [];
		const runner: ProbeRunner = (_command, _directory, timeoutMs) => {
			bounds.push(timeoutMs);
			return { exitCode: 143, signalCode: 9, stdout: "", stderr: "", timedOut: true };
		};
		const report = scanHygiene(cwd, runner);
		expect(report.status).toBe("ambiguous");
		expect(report.receipts.ids).toBe(UNKNOWN);
		expect(report.worktrees).toEqual([
			{
				path: cwd,
				origin: "scan-path",
				current: true,
				main: UNKNOWN,
				branch: null,
				bare: false,
				tracking: "unavailable",
				upstream: null,
				ahead: null,
				behind: null,
				dirty: UNKNOWN,
				owner: UNKNOWN,
				handOff: expect.stringContaining("hand it to that party"),
			},
		]);
		// Each child carries its own bound, and no probe may outlive the per-probe cap.
		expect(bounds.length).toBeGreaterThan(0);
		for (const bound of bounds) expect(bound).toBeLessThanOrEqual(2000);
		expect(report.limitations.every(line => line.includes("was incomplete") || line.includes("no dirty count applies"))).toBe(true);
	});

	test("porcelain worktree records carry branch, detached and bare state", () => {
		expect(parseWorktrees("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n\nworktree /c\nbare\n")).toEqual([
			{ path: "/a", branch: "main", detached: false, bare: false },
			{ path: "/b", branch: null, detached: true, bare: false },
			{ path: "/c", branch: null, detached: false, bare: true },
		]);
	});

	test("missing git is conservatively ambiguous", () => {
		const result = scanHygiene(temp());
		expect(result.status).toBe("ambiguous");
		expect(result.findings.some(f => f.kind === "git" || f.kind === "scope")).toBe(true);
	});

	test("porcelain rename and copy records consume both paths", () => {
		expect(parsePorcelainPaths("R  new.txt\0old.txt\0C  copy.txt\0source.txt\0")).toEqual(["new.txt", "old.txt", "copy.txt", "source.txt"]);
	});

	test("read-only scan does not change the git index", () => {
		const cwd = repo();
		const index = join(cwd, ".git", "index");
		const before = statSync(index).mtimeMs;
		scanHygiene(cwd);
		expect(statSync(index).mtimeMs).toBe(before);
	});

	test("scan leaves inspected files unchanged", () => {
		const cwd = repo();
		const before = readFileSync(join(cwd, "tracked.txt"), "utf8");
		scanHygiene(cwd);
		expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe(before);
	});

	test("receipt ids present for this repository are reported, read through the receipt module", () => {
		const cwd = repo();
		const agent = temp();
		const key = repoKey(cwd);
		if (!key) throw new Error("missing repo key");
		const receipt = buildReceipt({
			now: 1_800_000_000_000,
			emitter: { plugin: "@srobroek/delivery", version: pkg.version, tool: "delivery_land" },
			repo: { key, canonicalRoot: realpathSync(cwd), remote: "origin", forge: "github", nameWithOwner: "owner/repo" },
			pr: {
				number: 7,
				url: "https://github.com/owner/repo/pull/7",
				state: "MERGED",
				baseRefName: "main",
				headRefName: "feat/x",
				headRefOid: "a".repeat(40),
				mergeCommitOid: "b".repeat(40),
				mergedAt: "2027-01-15T08:00:00.000Z",
			},
			branch: { name: "feat/x", deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
			worktree: { path: null, removed: true, localRefDeleted: true, absenceVerifiedAt: "2027-01-15T08:00:02.000Z" },
			beads: { ids: ["delivery-7"], ledgerActive: true },
			proof: { method: "gh pr view", observedAt: "2027-01-15T08:00:00.000Z", evidence: { state: "MERGED" } },
			outcome: "landed",
		});
		const dir = receiptDirectory({ PI_CODING_AGENT_DIR: agent }, key);
		mkdirSync(dir, { recursive: true });
		writeReceipt(receipt, dir);
		const result = withAgentDir(agent, () => scanHygiene(cwd));
		expect(result.receipts.ids).toEqual([receipt.receiptId]);
		expect(realpathSync(result.receipts.directory ?? "")).toBe(realpathSync(dir));
		const receipts = result.findings.find(f => f.kind === "receipts");
		expect(receipts?.status).toBe("actionable");
		expect(receipts?.description).toContain("1 valid landing receipt(s)");
	});

	test("a symlink standing in for <agentRoot>/receipts is refused, not traversed", () => {
		const cwd = repo();
		const agent = temp();
		const elsewhere = temp();
		const key = repoKey(cwd);
		if (!key) throw new Error("missing repo key");
		mkdirSync(join(elsewhere, key), { recursive: true });
		const planted = join(agent, "receipts");
		symlinkSync(elsewhere, planted);
		const result = withAgentDir(agent, () => scanHygiene(cwd));
		const receipts = result.findings.find(f => f.kind === "receipts");
		expect(receipts?.status).toBe("ambiguous");
		expect(receipts?.description).toContain("is a symlink");
		expect(receipts?.paths).toEqual([planted]);
		expect(result.receipts.ids).toBe(UNKNOWN);
	});

	test("hostile receipt entries are ambiguous", () => {
		const cwd = repo();
		const agent = temp();
		const key = repoKey(cwd);
		if (!key) throw new Error("missing repo key");
		const dir = receiptDirectory({ PI_CODING_AGENT_DIR: agent }, key);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "oversize.json"), "x".repeat(1024 * 1024 + 1));
		symlinkSync(join(cwd, "tracked.txt"), join(dir, "linked.json"));
		const fifo = join(dir, "pipe.json");
		Bun.spawnSync(["mkfifo", fifo]);
		const result = withAgentDir(agent, () => scanHygiene(cwd));
		expect(result.status).toBe("ambiguous");
		const receipts = result.findings.find(f => f.kind === "receipts");
		expect(receipts?.paths).toEqual(expect.arrayContaining([join(dir, "oversize.json"), join(dir, "linked.json"), fifo]));
	});

	test("receipt directory falls back to platform home when HOME is unset", () => {
		expect(receiptDirectory({ HOME: "", PI_CODING_AGENT_DIR: "" })).toContain(".omp/receipts");
	});

	test("no row ever carries a removal recommendation", () => {
		const cwd = repo();
		const linked = join(temp(), "linked");
		git(cwd, "worktree", "add", "-q", "-b", "other", linked);
		const rows: WorktreeState[] = scanHygiene(cwd).worktrees;
		expect(rows.length).toBe(2);
		for (const row of rows) expect(row.handOff ?? "").not.toMatch(/\b(remove|removal|delete|deleted|prune)\b/i);
	});
});
