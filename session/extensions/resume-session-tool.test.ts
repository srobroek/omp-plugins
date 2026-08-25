import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FixtureSession, writeSpillDir, writeStore } from "./fixtures";
import resumeSessionTool, {
	absoluteTime,
	branchLabel,
	relativeTime,
	renderList,
	renderRead,
	renderTodos,
	renderTurn,
	resolveSession,
	worktreeLabel,
} from "./resume-session-tool";
import {
	BranchTracker,
	briefArgs,
	candidates,
	clip,
	estimateTokens,
	listWorktrees,
	parseTranscript,
	pathKeys,
	readHead,
	sessionsRoot,
	storeFiles,
} from "./store";

function tmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A fixture store laid out exactly as the harness lays out the real one, so the
 * full list/read path can run against it by pointing HOME at `home`.
 */
function fixtureStore(sessions: FixtureSession[]): { home: string; root: string } {
	const home = tmp("resume-home-");
	const root = join(home, "agent", "sessions");
	mkdirSync(root, { recursive: true });
	writeStore(root, sessions);
	return { home, root };
}

/** `sessionsRoot` reads the environment, so full-path tests relocate HOME. */
function withHome<T>(home: string, run: () => T): T {
	const previous = { home: process.env.HOME, config: process.env.PI_CONFIG_DIR, omp: process.env.OMP_PROFILE, pi: process.env.PI_PROFILE };
	process.env.HOME = home;
	process.env.PI_CONFIG_DIR = ".";
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	try {
		return run();
	} finally {
		process.env.HOME = previous.home;
		if (previous.config === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = previous.config;
		if (previous.omp !== undefined) process.env.OMP_PROFILE = previous.omp;
		if (previous.pi !== undefined) process.env.PI_PROFILE = previous.pi;
	}
}

/** A real repo with a linked worktree — worktree logic must be proven for real. */
function repoWithWorktree(): { main: string; linked: string; linkedBranch: string } {
	const root = tmp("resume-repo-");
	const main = join(root, "main");
	mkdirSync(main, { recursive: true });
	const run = (args: string[]) => execFileSync("git", args, { cwd: main, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	run(["init", "-q", "-b", "main"]);
	run(["config", "user.email", "t@example.com"]);
	run(["config", "user.name", "Test"]);
	writeFileSync(join(main, "a.txt"), "one\n");
	run(["add", "-A"]);
	run(["commit", "-q", "-m", "first"]);
	const linked = join(root, "wt");
	run(["worktree", "add", "-q", "-b", "feat/linked", linked]);
	return { main, linked, linkedBranch: "feat/linked" };
}

const shipped: FixtureSession = {
	stem: "2026-08-24T09-00-00-000Z_aaaaaaaa-1111-7000-8888-000000000001",
	cwd: "/repo/main",
	title: "Wire the export path",
	updatedAt: "2026-08-24T13:30:00.000Z",
	entries: [
		{ kind: "user", text: "Add the CSV export" },
		{
			kind: "assistant",
			text: "Starting on the export path.",
			thinking: "secret reasoning that must stay hidden",
			tools: [
				{ name: "bash", args: { command: "git checkout -b feat/csv" }, result: "Switched to a new branch 'feat/csv'" },
			],
		},
		{
			kind: "todo",
			phases: [
				{
					name: "Export",
					tasks: [
						{ content: "Write writer", status: "completed" },
						{ content: "Wire CLI", status: "in_progress" },
					],
				},
			],
		},
		{
			kind: "assistant",
			text: "Writer landed; the CLI flag is still open.",
			tools: [{ name: "read", args: { path: "src/export.ts" }, intent: "Reading writer" }],
		},
	],
};

describe("unit: formatting", () => {
	test("estimateTokens is a 4-chars-per-token ceiling", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});

	test("clip reports how much it dropped", () => {
		expect(clip("short", 20)).toBe("short");
		expect(clip("0123456789", 4)).toBe("0123 …[+6 chars]");
	});

	test("relativeTime buckets and absoluteTime stay stable", () => {
		const now = Date.parse("2026-08-24T12:00:00.000Z");
		expect(relativeTime(null, now)).toBe("unknown");
		expect(relativeTime(now - 30_000, now)).toBe("just now");
		expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
		expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
		expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5d ago");
		expect(absoluteTime(null)).toBe("unknown");
		expect(absoluteTime(now)).toMatch(/^2026-08-2[45] \d\d:\d\d$/);
	});

	test("briefArgs prefers the first meaningful key, never the whole payload", () => {
		expect(briefArgs({ path: "src/a.ts", extra: "x" })).toBe("src/a.ts");
		expect(briefArgs({ command: "ls  -la\n/tmp" })).toBe("ls -la /tmp");
		expect(briefArgs({ nothing: {} })).toBe("");
		expect(briefArgs(undefined)).toBe("");
	});

	test("sessionsRoot honours config dir and profile like the harness", () => {
		expect(sessionsRoot(undefined, {})).toMatch(/\.omp\/agent\/sessions$/);
		expect(sessionsRoot(undefined, { PI_CONFIG_DIR: ".ompx" })).toMatch(/\.ompx\/agent\/sessions$/);
		expect(sessionsRoot("work", {})).toMatch(/\.omp\/profiles\/work\/agent\/sessions$/);
		expect(sessionsRoot(undefined, { OMP_PROFILE: "alt" })).toMatch(/profiles\/alt\/agent\/sessions$/);
	});
});

describe("unit: branch recovery", () => {
	test("a confirmed switch outranks status output, which outranks a bare command", () => {
		const tracker = new BranchTracker();
		tracker.offer("git checkout -b feat/early", "created");
		expect(tracker.get()).toEqual({ branch: "feat/early", tier: "created" });
		tracker.offer("On branch some/other\nYour branch is up to date with 'origin/some/other'", "status");
		expect(tracker.get()).toEqual({ branch: "some/other", tier: "status" });
		tracker.offer("Switched to a new branch 'feat/real'", "switched");
		expect(tracker.get()).toEqual({ branch: "feat/real", tier: "switched" });
		// Status output describes whatever directory ran it — possibly a sibling
		// worktree — so it must never displace this session's own switch.
		tracker.offer("On branch main", "status");
		tracker.offer("git checkout other", "mentioned");
		expect(tracker.get()).toEqual({ branch: "feat/real", tier: "switched" });
	});

	test("multi-segment names survive and refs/heads is stripped", () => {
		const tracked = new BranchTracker();
		tracked.offer("branch 'feat/a/b' set up to track origin/feat/a/b", "switched");
		expect(tracked.get()).toEqual({ branch: "feat/a/b", tier: "switched" });
		const push = new BranchTracker();
		push.offer("dgit push origin refs/heads/release/1.2", "mentioned");
		expect(push.get()?.branch).toBe("release/1.2");
	});

	test("filenames, shas, and HEAD are not mistaken for branches", () => {
		for (const command of [
			"git checkout package.json",
			"git checkout HEAD",
			"git checkout 1a2b3c4d",
			"git checkout -- src",
		]) {
			const tracker = new BranchTracker();
			tracker.offer(command, "mentioned");
			expect(tracker.get()).toBeNull();
		}
	});

	test("worktree add -b is a creating signal", () => {
		const tracker = new BranchTracker();
		tracker.offer("git -C /repo worktree add /wt -b feat/port", "created");
		expect(tracker.get()).toEqual({ branch: "feat/port", tier: "created" });
	});
});

describe("unit: transcript parsing", () => {
	test("head yields id, cwd, title, and the in-place updatedAt", () => {
		const { root } = fixtureStore([shipped]);
		const head = readHead(storeFiles(root)[0]);
		expect(head?.id).toBe("aaaaaaaa-1111-7000-8888-000000000001");
		expect(head?.cwd).toBe("/repo/main");
		expect(head?.title).toBe("Wire the export path");
		expect(head?.updatedAtMs).toBe(Date.parse("2026-08-24T13:30:00.000Z"));
	});

	test("turns fold tool results in, and thinking is dropped by default", () => {
		const { root } = fixtureStore([shipped]);
		const file = storeFiles(root)[0];
		const transcript = parseTranscript(file);
		expect(transcript.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
		expect(transcript.meta.turnCount).toBe(4);
		expect(transcript.turns[1].tools[0].name).toBe("bash");
		expect(transcript.turns[1].tools[0].result).toContain("Switched to a new branch");
		expect(JSON.stringify(transcript)).not.toContain("secret reasoning");
		expect(JSON.stringify(parseTranscript(file, true))).toContain("secret reasoning");
	});

	test("branch comes from git's own output, not the command", () => {
		const { root } = fixtureStore([shipped]);
		expect(parseTranscript(storeFiles(root)[0]).meta).toMatchObject({ branch: "feat/csv", branchTier: "switched" });
	});

	test("the newest todo board is the plan state", () => {
		const { root } = fixtureStore([
			{
				...shipped,
				entries: [
					{ kind: "todo", phases: [{ name: "Old", tasks: [{ content: "stale", status: "pending" }] }] },
					{ kind: "todo", phases: [{ name: "New", tasks: [{ content: "fresh", status: "in_progress" }] }] },
				],
			},
		]);
		const phases = parseTranscript(storeFiles(root)[0]).todoPhases;
		expect(phases).toHaveLength(1);
		expect(phases[0]).toEqual({ name: "New", tasks: [{ content: "fresh", status: "in_progress" }] });
	});

	test("left off is the last assistant prose, not the last record", () => {
		const { root } = fixtureStore([shipped]);
		expect(parseTranscript(storeFiles(root)[0]).meta.leftOff).toBe("Writer landed; the CLI flag is still open.");
	});

	test("compaction and exit are surfaced, not silently swallowed", () => {
		const { root } = fixtureStore([
			{
				...shipped,
				entries: [
					{ kind: "user", text: "go" },
					{ kind: "compaction", shortSummary: "earlier work summarized" },
					{ kind: "assistant", text: "continuing" },
					{ kind: "exit", reason: "dispose", exitKind: "normal" },
				],
			},
		]);
		const transcript = parseTranscript(storeFiles(root)[0]);
		expect(transcript.meta.compactions).toBe(1);
		expect(transcript.meta.exitReason).toBe("normal/dispose");
		expect(transcript.compactionSummaries).toEqual(["earlier work summarized"]);
		const rendered = renderRead(transcript, {});
		expect(rendered).toContain("compaction: earlier turns were summarized away");
		expect(rendered).toContain("session end: normal/dispose");
	});

	test("empty turns are dropped so the window is not wasted", () => {
		const { root } = fixtureStore([{ ...shipped, entries: [{ kind: "assistant" }, { kind: "user", text: "real" }] }]);
		expect(parseTranscript(storeFiles(root)[0]).meta.turnCount).toBe(1);
	});

	test("a truncated final line does not abort the parse", () => {
		const { root } = fixtureStore([shipped]);
		const file = storeFiles(root)[0];
		appendFileSync(file, '{"type":"message","message":{"role":"assis');
		expect(parseTranscript(file).meta.turnCount).toBe(4);
	});

	test("continuation chains are counted", () => {
		const { root } = fixtureStore([{ ...shipped, previousSessionFiles: ["/store/-a/x.jsonl"] }]);
		expect(parseTranscript(storeFiles(root)[0]).meta.continuedFrom).toBe(1);
	});
});

describe("unit: store enumeration", () => {
	test("spilled tool-output directories are not transcripts", () => {
		const { root } = fixtureStore([shipped]);
		writeSpillDir(root, shipped.cwd, shipped.stem);
		expect(storeFiles(root)).toHaveLength(1);
	});

	test("candidates match the recorded cwd, not the directory name", () => {
		const { root } = fixtureStore([
			shipped,
			{ ...shipped, stem: "2026-08-24T09-00-00-000Z_bbbbbbbb-2222", cwd: "/repo/other" },
		]);
		expect(candidates(root, new Set(["/repo/main"]))).toHaveLength(1);
		expect(candidates(root, new Set(["/repo/main", "/repo/other"]))).toHaveLength(2);
		expect(candidates(root, new Set(["/nowhere"]))).toHaveLength(0);
	});

	test("pathKeys accepts both spellings of a symlinked directory", () => {
		const real = tmp("resume-real-");
		expect(pathKeys(real)).toContain(real);
		// macOS hands out /var/folders paths that resolve under /private.
		expect(pathKeys(real).length).toBeGreaterThanOrEqual(1);
		expect(pathKeys("/definitely/not/here")).toEqual(["/definitely/not/here"]);
	});

	test("a missing store is empty, not an error", () => {
		expect(storeFiles(join(tmp("resume-empty-"), "absent"))).toEqual([]);
	});
});

describe("integration: worktrees", () => {
	test("listWorktrees returns the family with main first", () => {
		const { main, linked, linkedBranch } = repoWithWorktree();
		const family = listWorktrees(linked); // enumerating from the LINKED tree still finds main
		expect(family).toHaveLength(2);
		expect(family[0].isMain).toBe(true);
		expect(family.filter((w) => w.branch === linkedBranch)).toHaveLength(1);
		expect(family.filter((w) => w.branch === "main")).toHaveLength(1);
		expect(pathKeys(main)).toContain(family[0].path);
	});

	test("a non-repo directory yields no family", () => {
		expect(listWorktrees(tmp("resume-bare-"))).toEqual([]);
	});

	test("branchLabel reports drift when the checkout moved on", () => {
		const worktree = { path: "/repo/wt", head: "sha", branch: "main", detached: false, isMain: false };
		expect(branchLabel({ branch: "feat/csv", branchTier: "switched" }, worktree)).toBe(
			"feat/csv [worked-on → worktree now on main]",
		);
		expect(branchLabel({ branch: "main", branchTier: "switched" }, worktree)).toBe("main");
		expect(branchLabel({ branch: "feat/x", branchTier: "created" }, undefined)).toBe("feat/x (inferred)");
		expect(branchLabel({ branch: "", branchTier: null }, worktree)).toBe("? [worktree now on main]");
		expect(branchLabel({ branch: "feat/x", branchTier: "switched" }, { ...worktree, detached: true })).toBe(
			"feat/x [worked-on → worktree now on detached]",
		);
	});

	test("worktreeLabel marks the main checkout", () => {
		expect(worktreeLabel({ path: "/a/b", head: "", branch: "", detached: false, isMain: true })).toBe("b (main)");
		expect(worktreeLabel({ path: "/a/c", head: "", branch: "", detached: false, isMain: false })).toBe("c");
		expect(worktreeLabel(undefined)).toBe("?");
	});
});

describe("integration: list mode", () => {
	function twoWorktreeStore(repo: { main: string; linked: string }): string {
		return fixtureStore([
			{ ...shipped, cwd: repo.main, updatedAt: "2026-08-24T10:00:00.000Z", title: "older in main" },
			{
				...shipped,
				stem: "2026-08-24T11-00-00-000Z_cccccccc-3333-7000-8888-000000000003",
				cwd: repo.linked,
				updatedAt: "2026-08-25T09:00:00.000Z",
				title: "newest in the linked worktree",
			},
		]).home;
	}

	function list(home: string, project: string, extra: { worktrees?: boolean; git?: boolean; limit?: number } = {}): string {
		return withHome(home, () => renderList(project, { path: project, ...extra })).text;
	}

	test("rows are newest first and cover every worktree", () => {
		const repo = repoWithWorktree();
		const text = list(twoWorktreeStore(repo), repo.main);
		expect(text.indexOf("newest in the linked worktree")).toBeLessThan(text.indexOf("older in main"));
		expect(text).toContain("↳ left off: Writer landed");
		expect(text).toContain("4 turns");
		expect(text).toContain("STOP.");
	});

	test("drift against a worktree's current branch is shown", () => {
		const repo = repoWithWorktree();
		expect(list(twoWorktreeStore(repo), repo.main)).toContain("worked-on → worktree now on");
	});

	test("worktrees:false narrows to the current checkout", () => {
		const repo = repoWithWorktree();
		const home = twoWorktreeStore(repo);
		const narrowed = list(home, repo.linked, { worktrees: false });
		expect(narrowed).toContain("newest in the linked worktree");
		expect(narrowed).not.toContain("older in main");
		expect(narrowed).toContain("current checkout only");
	});

	test("limit caps the rows and says how many were held back", () => {
		const repo = repoWithWorktree();
		const text = list(twoWorktreeStore(repo), repo.main, { limit: 1 });
		expect(text).toContain("1 older session(s) not shown");
	});

	test("the git activity block ranks worktrees and can be suppressed", () => {
		const repo = repoWithWorktree();
		const home = twoWorktreeStore(repo);
		expect(list(home, repo.main)).toContain("## Worktree git activity");
		expect(list(home, repo.main, { git: false })).not.toContain("## Worktree git activity");
	});

	test("an empty store refuses to guess", () => {
		const repo = repoWithWorktree();
		const text = list(fixtureStore([]).home, repo.main);
		expect(text).toContain("No prior sessions recorded");
		expect(text).toContain("do not guess a session");
	});

	test("colliding ids are printed long enough to stay usable", () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_01a0382f-37e9-7000-9795-a883afa2a01b" },
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_01a0382f-76b6-7000-a37c-3ade9b7ca8df" },
		]);
		const text = list(home, repo.main);
		expect(text).toContain("01a0382f-3");
		expect(text).toContain("01a0382f-7");
	});

	test("a one-turn session is not reported as '1 turns'", () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([{ ...shipped, cwd: repo.main, entries: [{ kind: "user", text: "only" }] }]);
		expect(list(home, repo.main)).toContain("1 turn ");
	});

	test("every window reports its own token cost", () => {
		const repo = repoWithWorktree();
		expect(list(twoWorktreeStore(repo), repo.main)).toMatch(/~[\d,]+ uncached tokens/);
	});
});

describe("integration: read mode", () => {
	test("newest-first window, todo anchor, and a paging hint", () => {
		const { root } = fixtureStore([
			{
				...shipped,
				entries: [
					...Array.from({ length: 12 }, (_, i) => ({ kind: "user" as const, text: `turn ${i + 1}` })),
					{ kind: "todo", phases: [{ name: "P", tasks: [{ content: "open item", status: "pending" }] }] },
				],
			},
		]);
		const text = renderRead(parseTranscript(storeFiles(root)[0]), { turns: 4 });
		expect(text).toContain("window: turns 10..13 of 13 (newest first)");
		expect(text.indexOf("[13]")).toBeLessThan(text.indexOf("[10]"));
		expect(text).toContain("## Latest plan / todo state");
		expect(text).toContain("[ ] open item");
		expect(text).toContain("offset=4 turns=4");
		expect(text).toContain("STOP.");
	});

	test("offset pages older and eventually reaches the start", () => {
		const { root } = fixtureStore([
			{ ...shipped, entries: Array.from({ length: 6 }, (_, i) => ({ kind: "user" as const, text: `t${i}` })) },
		]);
		const transcript = parseTranscript(storeFiles(root)[0]);
		expect(renderRead(transcript, { turns: 3, offset: 3 })).toContain("Start of session reached");
		expect(renderRead(transcript, { offset: 99 })).toContain("No turns at offset 99");
	});

	test("maxChars stops on a turn boundary and always emits one turn", () => {
		const { root } = fixtureStore([
			{
				...shipped,
				entries: Array.from({ length: 5 }, (_, i) => ({ kind: "assistant" as const, text: `${"x".repeat(400)}${i}` })),
			},
		]);
		const text = renderRead(parseTranscript(storeFiles(root)[0]), { turns: 5, maxChars: 1 });
		expect(text.match(/^### \[/gm)).toHaveLength(1);
		expect(text).toContain("window: turns 5..5 of 5");
	});

	test("renderTurn shows tool calls with an error marker", () => {
		const rendered = renderTurn(
			{
				role: "assistant",
				timestampMs: Date.parse("2026-08-24T12:00:00.000Z"),
				text: "trying",
				tools: [{ name: "bash", brief: "make", result: "boom", isError: true }],
			},
			7,
		);
		expect(rendered).toContain("### [7] ASSISTANT");
		expect(rendered).toContain("⮑ bash (make)");
		expect(rendered).toContain("✗ boom");
	});

	test("renderTodos counts each phase", () => {
		expect(
			renderTodos([
				{
					name: "P",
					tasks: [
						{ content: "a", status: "completed" },
						{ content: "b", status: "blocked" },
					],
				},
			]),
		).toEqual(["  P — 1/2", "    [x] a", "    [!] b"]);
	});
});

describe("integration: session resolution", () => {
	test("a prefix resolves, an ambiguous prefix refuses, a miss names the store", () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_dddddddd-1111-7000-8888-000000000001" },
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_dddddddd-2222-7000-8888-000000000002" },
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_eeeeeeee-3333-7000-8888-000000000003" },
		]);
		const resolve = (session: string) => withHome(home, () => resolveSession(repo.main, { session, path: repo.main }));
		expect(resolve("eeeeeeee")).toEqual({ file: expect.stringContaining("eeeeeeee") });
		expect(resolve("dddddddd")).toEqual({ error: expect.stringContaining("matches 2 sessions") });
		expect(resolve("nope")).toEqual({ error: expect.stringContaining("no session under") });
		expect(resolve("")).toEqual({ error: expect.stringContaining("needs `session`") });
	});

	test("an explicit file bypasses lookup entirely", () => {
		const { root } = fixtureStore([shipped]);
		const file = storeFiles(root)[0];
		expect(resolveSession("/nowhere", { file })).toEqual({ file });
	});
});

describe("integration: tool registration", () => {
	function fakePi(): { pi: Record<string, unknown>; captured: Record<string, unknown> } {
		const chain: Record<string, unknown> = {};
		const self = () => chain;
		chain.string = self;
		chain.number = self;
		chain.boolean = self;
		chain.optional = self;
		chain.describe = self;
		chain.object = self;
		chain.enum = self;
		const captured: Record<string, unknown> = {};
		return { pi: { zod: chain, registerTool: (d: Record<string, unknown>) => Object.assign(captured, d), on: () => {} }, captured };
	}

	type Execute = (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;

	test("the extension registers a read-approval resume_session tool", () => {
		const { pi, captured } = fakePi();
		resumeSessionTool(pi as never);
		expect(captured.name).toBe("resume_session");
		expect(captured.approval).toBe("read");
		expect(typeof captured.execute).toBe("function");
	});

	test("both modes run end to end through execute", async () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([{ ...shipped, cwd: repo.main }]);
		const { pi, captured } = fakePi();
		resumeSessionTool(pi as never);
		const execute = captured.execute as Execute;

		const listed = await withHome(home, () => execute("1", { mode: "list", path: repo.main }, undefined, undefined, { cwd: repo.main }));
		expect(listed.details).toMatchObject({ mode: "list", sessions: 1 });
		expect(listed.content[0].text).toContain("Wire the export path");

		const id = (listed.details.ids as string[])[0];
		const read = await withHome(home, () =>
			execute("2", { mode: "read", session: id, path: repo.main }, undefined, undefined, { cwd: repo.main }),
		);
		expect(read.details).toMatchObject({ mode: "read", branch: "feat/csv", branchTier: "switched", turns: 4 });
		expect(read.content[0].text).toContain("## Latest plan / todo state");
	});

	test("an unresolvable session reports the problem instead of throwing", async () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([{ ...shipped, cwd: repo.main }]);
		const { pi, captured } = fakePi();
		resumeSessionTool(pi as never);
		const result = await withHome(home, () =>
			(captured.execute as Execute)("3", { mode: "read", session: "zzzz", path: repo.main }, undefined, undefined, { cwd: repo.main }),
		);
		expect(result.content[0].text).toContain("no session under");
		expect(result.details.error).toBeDefined();
	});
});
