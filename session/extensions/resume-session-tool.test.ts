import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getAgentDir,
	normalizeProfileName,
} from "@oh-my-pi/pi-utils/dirs";
import { type FixtureSession, renderSession, writeSpillDir, writeStore } from "./fixtures";
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
function required<T>(value: T | undefined, label = "fixture value"): T {
	if (value === undefined) throw new Error(`Missing ${label}`);
	return value;
}

function fixtureFile(root: string): string {
	return required(storeFiles(root)[0], "fixture transcript");
}

/**
 * A fixture store laid out exactly as the harness lays it out, rooted at the
 * explicit native agent directory used by `withHome`.
 */
function fixtureStore(sessions: FixtureSession[]): { home: string; root: string } {
	const home = tmp("resume-home-");
	const root = join(home, "agent", "sessions");
	mkdirSync(root, { recursive: true });
	writeStore(root, sessions);
	return { home, root };
}
/**
 * A fixture store rooted at an explicit native agent directory. This avoids
 * relying on HOME changes after pi-utils/dirs has cached its resolver.
 */
async function withHome<T>(home: string, run: () => T | Promise<T>): Promise<T> {
	const keys = ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME"] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
		(typeof keys)[number],
		string | undefined
	>;
	process.env.PI_CODING_AGENT_DIR = join(home, "agent");
	process.env.PI_CONFIG_DIR = ".";
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	delete process.env.XDG_DATA_HOME;
	__resetDirsFromEnvForTests();
	try {
		return await run();
	} finally {
		for (const key of keys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
	}
}

/** A real repo with a linked worktree — worktree logic must be proven for real. */
function repoWithWorktree(): { main: string; linked: string; linkedBranch: string } {
	const root = tmp("resume-repo-");
	const main = join(root, "main");
	mkdirSync(main, { recursive: true });
	const run = (args: string[]) =>
		execFileSync("git", args, { cwd: main, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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

	test("sessionsRoot follows native active and read-only profile stores", async () => {
		if (process.platform !== "linux" && process.platform !== "darwin") return;
		const xdg = tmp("resume-xdg-");
		const previous = {
			agent: process.env.PI_CODING_AGENT_DIR,
			config: process.env.PI_CONFIG_DIR,
			omp: process.env.OMP_PROFILE,
			pi: process.env.PI_PROFILE,
			xdg: process.env.XDG_DATA_HOME,
		};
		try {
			delete process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CONFIG_DIR = ".";
			delete process.env.OMP_PROFILE;
			delete process.env.PI_PROFILE;
			process.env.XDG_DATA_HOME = xdg;
			mkdirSync(join(xdg, "omp"), { recursive: true });
			__resetDirsFromEnvForTests();
			expect(getActiveProfile()).toBeUndefined();
			expect(sessionsRoot()).toBe(join(xdg, "omp", "sessions"));

			process.env.OMP_PROFILE = "active";
			mkdirSync(join(xdg, "omp", "profiles", "active"), { recursive: true });
			mkdirSync(join(xdg, "omp", "profiles", "other"), { recursive: true });
			__resetDirsFromEnvForTests();

			expect(getActiveProfile()).toBe("active");
			expect(sessionsRoot()).toBe(join(xdg, "omp", "profiles", "active", "sessions"));
			const beforeAgent = getAgentDir();
			expect(sessionsRoot("other")).toBe(join(xdg, "omp", "profiles", "other", "sessions"));
			expect(getActiveProfile()).toBe("active");
			expect(getAgentDir()).toBe(beforeAgent);
			expect(sessionsRoot("default")).toBe(join(xdg, "omp", "sessions"));
			expect(normalizeProfileName(" other ")).toBe("other");
		} finally {
			if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.agent;
			if (previous.config === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous.config;
			if (previous.omp === undefined) delete process.env.OMP_PROFILE;
			else process.env.OMP_PROFILE = previous.omp;
			if (previous.pi === undefined) delete process.env.PI_PROFILE;
			else process.env.PI_PROFILE = previous.pi;
			if (previous.xdg === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previous.xdg;
			__resetDirsFromEnvForTests();
			rmSync(xdg, { recursive: true, force: true });
		}
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
	test("head yields id, cwd, title, and the in-place updatedAt", async () => {
		const { root } = fixtureStore([shipped]);
		const head = await readHead(fixtureFile(root));
		expect(head?.id).toBe("aaaaaaaa-1111-7000-8888-000000000001");
		expect(head?.cwd).toBe("/repo/main");
		expect(head?.title).toBe("Wire the export path");
		expect(head?.updatedAtMs).toBe(Date.parse("2026-08-24T13:30:00.000Z"));
	});

	test("turns fold tool results in, and thinking is dropped by default", async () => {
		const { root } = fixtureStore([shipped]);
		const file = fixtureFile(root);
		const transcript = await parseTranscript(file);
		expect(transcript.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
		expect(transcript.meta.turnCount).toBe(4);
		const tool = required(required(transcript.turns[1], "assistant turn").tools[0], "bash tool");
		expect(tool.name).toBe("bash");
		expect(tool.result).toContain("Switched to a new branch");
		expect(JSON.stringify(transcript)).not.toContain("secret reasoning");
		expect(JSON.stringify(await parseTranscript(file, true))).toContain("secret reasoning");
	});

	test("branch comes from git's own output, not the command", async () => {
		const { root } = fixtureStore([shipped]);
		expect((await parseTranscript(fixtureFile(root))).meta).toMatchObject({
			branch: "feat/csv",
			branchTier: "switched",
		});
	});

	test("the newest todo board is the plan state", async () => {
		const { root } = fixtureStore([
			{
				...shipped,
				entries: [
					{ kind: "todo", phases: [{ name: "Old", tasks: [{ content: "stale", status: "pending" }] }] },
					{ kind: "todo", phases: [{ name: "New", tasks: [{ content: "fresh", status: "in_progress" }] }] },
				],
			},
		]);
		const phases = (await parseTranscript(fixtureFile(root))).todoPhases;
		expect(phases).toHaveLength(1);
		expect(required(phases[0], "todo phase")).toEqual({ name: "New", tasks: [{ content: "fresh", status: "in_progress" }] });
	});

	test.each([{ phases: [] }, { phases: [{ name: "Cleared", tasks: [] }] }])(
		"an empty latest board clears current tasks: %j",
		async ({ phases }) => {
			const { root } = fixtureStore([
				{
					...shipped,
					entries: [
						{ kind: "todo", phases: [{ name: "Old", tasks: [{ content: "obsolete", status: "pending" }] }] },
						{ kind: "todo", phases: phases.map((phase) => ({ name: phase.name, tasks: [...phase.tasks] })) },
					],
				},
			]);
			const transcript = await parseTranscript(fixtureFile(root));
			expect(transcript.todoPhases).toEqual([]);
			expect(renderRead(transcript, {})).not.toContain("## Latest plan / todo state");
			expect(renderRead(transcript, {})).not.toContain("obsolete");
		},
	);

	test("left off is the last assistant prose, not the last record", async () => {
		const { root } = fixtureStore([shipped]);
		expect((await parseTranscript(fixtureFile(root))).meta.leftOff).toBe(
			"Writer landed; the CLI flag is still open.",
		);
	});

	test("compaction and exit are surfaced, not silently swallowed", async () => {
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
		const transcript = await parseTranscript(fixtureFile(root));
		expect(transcript.meta.compactions).toBe(1);
		expect(transcript.meta.exitReason).toBe("normal/dispose");
		expect(transcript.compactionSummaries).toEqual(["earlier work summarized"]);
		const rendered = renderRead(transcript, {});
		expect(rendered).toContain("compaction: earlier turns were summarized away");
		expect(rendered).toContain("session end: normal/dispose");
	});

	test("empty turns are dropped so the window is not wasted", async () => {
		const { root } = fixtureStore([{ ...shipped, entries: [{ kind: "assistant" }, { kind: "user", text: "real" }] }]);
		expect((await parseTranscript(fixtureFile(root))).meta.turnCount).toBe(1);
	});

	test("a truncated final line does not abort the parse", async () => {
		const { root } = fixtureStore([shipped]);
		const file = fixtureFile(root);
		appendFileSync(file, '{"type":"message","message":{"role":"assis');
		expect((await parseTranscript(file)).meta.turnCount).toBe(4);
	});

	test("continuation chains are counted", async () => {
		const { root } = fixtureStore([{ ...shipped, previousSessionFiles: ["/store/-a/x.jsonl"] }]);
		expect((await parseTranscript(fixtureFile(root))).meta.continuedFrom).toBe(1);
	});
});

describe("unit: store enumeration", () => {
	test("spilled tool-output directories are not transcripts", () => {
		const { root } = fixtureStore([shipped]);
		writeSpillDir(root, shipped.cwd, shipped.stem);
		expect(storeFiles(root)).toHaveLength(1);
	});

	test("candidates match the recorded cwd, not the directory name", async () => {
		const { root } = fixtureStore([
			shipped,
			{ ...shipped, stem: "2026-08-24T09-00-00-000Z_bbbbbbbb-2222", cwd: "/repo/other" },
		]);
		expect(await candidates(root, new Set(["/repo/main"]))).toHaveLength(1);
		expect(await candidates(root, new Set(["/repo/main", "/repo/other"]))).toHaveLength(2);
		expect(await candidates(root, new Set(["/nowhere"]))).toHaveLength(0);
	});

	test("pathKeys accepts both spellings of a symlinked directory", () => {
		const parent = tmp("resume-symlink-");
		const realDirectory = join(parent, "real");
		const symlink = join(parent, "link");
		mkdirSync(realDirectory);
		symlinkSync(realDirectory, symlink, "dir");
		try {
			expect(pathKeys(symlink)).toEqual(expect.arrayContaining([symlink, realpathSync(realDirectory)]));
			expect(pathKeys("/definitely/not/here")).toEqual(["/definitely/not/here"]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
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
		expect(required(family[0], "main worktree").isMain).toBe(true);
		expect(family.filter((w) => w.branch === linkedBranch)).toHaveLength(1);
		expect(family.filter((w) => w.branch === "main")).toHaveLength(1);
		expect(pathKeys(main)).toContain(required(family[0], "main worktree").path);
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

// The tests in this describe, and in `session resolution` and `tool registration`
// below, each carry an explicit 20s allowance. They build a fixture session store
// on disk and drive the tool against it, and that is genuinely slow: measured per
// describe, minus the file's import-and-setup baseline, `list mode` costs ~3.5s a
// test, `session resolution` ~2.7s and `tool registration` ~2.3s, while every
// `unit:` describe here runs a whole block in about a second.
//
// Against Bun's 5s default the heaviest sat ~1.5s from the ceiling unloaded, so
// they lost roughly half of all runs under concurrent load. Four concurrent runs
// of this file on the unfixed tree failed in 3 of 4, and surfaced a third test
// name beyond the two already reported -- the cost belongs to the harness, not to
// particular assertions.
//
// The allowance is deliberately NOT a file-wide `setDefaultTimeout`: the 34 fast
// tests here should keep failing at 5s, because a unit test that hangs is a
// diagnostic signal worth getting quickly. Any new test in these three describes
// needs the same third argument.
//
// This is a ceiling, not a cure. ~850ms per test with no subprocesses at all is
// the real defect, and each test does get its own temp store (53 created for 50
// tests), so it is not fixture accumulation. Tracked on omp-plugins-dg3.
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

	async function list(
		home: string,
		project: string,
		extra: { worktrees?: boolean; git?: boolean; limit?: number } = {},
	): Promise<string> {
		return (await withHome(home, () => renderList(project, { path: project, ...extra }))).text;
	}

	test("rows are newest first and cover every worktree", async () => {
		const repo = repoWithWorktree();
		const text = await list(twoWorktreeStore(repo), repo.main);
		expect(text.indexOf("newest in the linked worktree")).toBeLessThan(text.indexOf("older in main"));
		expect(text).toContain("↳ left off: Writer landed");
		expect(text).toContain("4 turns");
		expect(text).toContain("STOP.");
	}, 20_000);

	test("drift against a worktree's current branch is shown", async () => {
		const repo = repoWithWorktree();
		expect(await list(twoWorktreeStore(repo), repo.main)).toContain("worked-on → worktree now on");
	}, 20_000);

	test("worktrees:false narrows to the current checkout", async () => {
		const repo = repoWithWorktree();
		const home = twoWorktreeStore(repo);
		const narrowed = await list(home, repo.linked, { worktrees: false });
		expect(narrowed).toContain("newest in the linked worktree");
		expect(narrowed).not.toContain("older in main");
		expect(narrowed).toContain("current checkout only");
	}, 20_000);

	test("limit caps the rows and says how many were held back", async () => {
		const repo = repoWithWorktree();
		const text = await list(twoWorktreeStore(repo), repo.main, { limit: 1 });
		expect(text).toContain("1 older session(s) not shown");
	}, 20_000);

	test("the git activity block ranks worktrees and can be suppressed", async () => {
		const repo = repoWithWorktree();
		const home = twoWorktreeStore(repo);
		expect(await list(home, repo.main)).toContain("## Worktree git activity");
		expect(await list(home, repo.main, { git: false })).not.toContain("## Worktree git activity");
	}, 20_000);

	test("an empty store refuses to guess", async () => {
		const repo = repoWithWorktree();
		const text = await list(fixtureStore([]).home, repo.main);
		expect(text).toContain("No prior sessions recorded");
		expect(text).toContain("do not guess a session");
	}, 20_000);

	test("colliding ids are printed long enough to stay usable", async () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_01a0382f-37e9-7000-9795-a883afa2a01b" },
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_01a0382f-76b6-7000-a37c-3ade9b7ca8df" },
		]);
		const text = await list(home, repo.main);
		expect(text).toContain("01a0382f-3");
		expect(text).toContain("01a0382f-7");
	}, 20_000);

	test("a one-turn session is not reported as '1 turns'", async () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([{ ...shipped, cwd: repo.main, entries: [{ kind: "user", text: "only" }] }]);
		expect(await list(home, repo.main)).toContain("1 turn ");
	}, 20_000);

	test("every window reports its own token cost", async () => {
		const repo = repoWithWorktree();
		expect(await list(twoWorktreeStore(repo), repo.main)).toMatch(/~[\d,]+ uncached tokens/);
	}, 20_000);
});

describe("integration: read mode", () => {
	test("newest-first window, todo anchor, and a paging hint", async () => {
		const { root } = fixtureStore([
			{
				...shipped,
				entries: [
					...Array.from({ length: 12 }, (_, i) => ({ kind: "user" as const, text: `turn ${i + 1}` })),
					{ kind: "todo", phases: [{ name: "P", tasks: [{ content: "open item", status: "pending" }] }] },
				],
			},
		]);
		const text = renderRead(await parseTranscript(fixtureFile(root), false, { turns: 4 }), { turns: 4 });
		expect(text).toContain("window: turns 10..13 of 13 (newest first)");
		expect(text.indexOf("[13]")).toBeLessThan(text.indexOf("[10]"));
		expect(text).toContain("## Latest plan / todo state");
		expect(text).toContain("[ ] open item");
		expect(text).toContain("offset=4 turns=4");
		expect(text).toContain("STOP.");
	});

	test("offset pages older and eventually reaches the start", async () => {
		const { root } = fixtureStore([
			{ ...shipped, entries: Array.from({ length: 6 }, (_, i) => ({ kind: "user" as const, text: `t${i}` })) },
		]);
		const transcript = await parseTranscript(fixtureFile(root), false, { turns: 3, offset: 3 });
		expect(renderRead(transcript, { turns: 3, offset: 3 })).toContain("Start of session reached");
		expect(renderRead(transcript, { offset: 99 })).toContain("No turns at offset 99");
	});

	test("large transcripts yield only the selected window and remain discoverable", async () => {
		const { home, root } = fixtureStore([{ ...shipped, entries: [{ kind: "user", text: "OLD-HISTORY-MARKER" }] }]);
		try {
			const file = fixtureFile(root);
			const chunk = `${JSON.stringify({ type: "custom", data: "x".repeat(8192) })}\n`.repeat(128);
			for (let i = 0; i < 65; i++) appendFileSync(file, chunk);
			for (const text of ["older selected turn", "newest selected turn"]) {
				appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`);
			}
			const size = statSync(file).size;
			expect(size).toBeGreaterThan(64 * 1024 * 1024);
			expect((await candidates(root, new Set([shipped.cwd]))).map((candidate) => candidate.head.id)).toEqual([
				"aaaaaaaa-1111-7000-8888-000000000001",
			]);
			const newest = await parseTranscript(file, false, { turns: 1 });
			expect(newest.meta.turnCount).toBe(3);
			expect(newest.meta.bytes).toBe(size);
			expect(newest.turns.map((turn) => turn.text)).toEqual(["newest selected turn"]);
			expect(renderRead(newest, { turns: 1 })).not.toContain("OLD-HISTORY-MARKER");
			const older = await parseTranscript(file, false, { turns: 1, offset: 1 });
			expect(older.turns.map((turn) => turn.text)).toEqual(["older selected turn"]);
			expect(older.windowStart).toBe(1);
			expect(statSync(file).size).toBe(size);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("maxChars refuses oversized turns and stops on complete boundaries", async () => {
		const { root } = fixtureStore([
			{
				...shipped,
				entries: Array.from({ length: 5 }, (_, i) => ({ kind: "assistant" as const, text: `${"x".repeat(400)}${i}` })),
			},
		]);
		const transcript = await parseTranscript(fixtureFile(root));
		const refused = renderRead(transcript, { turns: 5, maxChars: 1 });
		expect(refused.length).toBeLessThanOrEqual(1);
		expect(refused).not.toContain("### [");
		const text = renderRead(transcript, { turns: 5, maxChars: 600 });
		expect(text.length).toBeLessThanOrEqual(600);
		if (text.includes("### [")) {
			expect(text).toContain(`${"x".repeat(400)}4`);
		}
		const envelope = renderRead(transcript, { turns: 1, maxChars: 2000 });
		expect(envelope.length).toBeLessThanOrEqual(2000);
		expect(envelope).toContain("# Fresh-session handoff context");
		expect(envelope).toContain(`${"x".repeat(400)}4`);
		expect(envelope).toContain("STOP. Summarize the goal");
		const footerStart = envelope.lastIndexOf("\n\nThis window:");
		expect(footerStart).toBeGreaterThan(0);
		const narrow = renderRead(transcript, { turns: 1, maxChars: footerStart });
		expect(narrow.length).toBeLessThanOrEqual(footerStart);
		expect(narrow).toContain("Insufficient max_chars");
		expect(narrow).not.toContain("# Fresh-session handoff context");
		const required = Number(narrow.match(/complete output requires (\d+) characters/)?.[1]);
		expect(required).toBeGreaterThan(footerStart);
		const exact = renderRead(transcript, { turns: 1, maxChars: required });
		expect(exact.length).toBeLessThanOrEqual(required);
		expect(exact).toContain("# Fresh-session handoff context");
		expect(exact).toContain("\n\nThis window:");
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
	test("a prefix resolves, an ambiguous prefix refuses, a miss names the store", async () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_dddddddd-1111-7000-8888-000000000001" },
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_dddddddd-2222-7000-8888-000000000002" },
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00-000Z_eeeeeeee-3333-7000-8888-000000000003" },
		]);
		const resolve = (session: string) => withHome(home, () => resolveSession(repo.main, { session, path: repo.main }));
		expect(await resolve("eeeeeeee")).toEqual({ file: expect.stringContaining("eeeeeeee") });
		expect(await resolve("dddddddd")).toEqual({ error: expect.stringContaining("matches 2 sessions") });
		expect(await resolve("nope")).toEqual({ error: expect.stringContaining("no session under") });
		expect(await resolve("")).toEqual({ error: expect.stringContaining("needs `session`") });
	}, 20_000);

	test("an explicit file bypasses lookup entirely", async () => {
		const { root } = fixtureStore([shipped]);
		const file = fixtureFile(root);
		expect(await resolveSession("/nowhere", { file })).toEqual({ file });
	}, 20_000);

	test.each(["collision", "explicit file"])("paging preserves the selected transcript: %s", async (selection) => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00Z_dddddddd-1111-7000-8888-000000000001" },
			{ ...shipped, cwd: repo.main, stem: "2026-08-24T09-00-00Z_dddddddd-2222-7000-8888-000000000002" },
		]);
		const external = join(tmp("resume-export-"), 'selected "transcript".jsonl');
		writeFileSync(external, renderSession(shipped));
		await withHome(home, async () => {
			const selected = await resolveSession(
				repo.main,
				selection === "collision"
					? { session: "dddddddd-1111", path: repo.main, worktrees: false }
					: { file: external },
			);
			if ("error" in selected) throw new Error(selected.error);
			const transcript = await parseTranscript(selected.file, true, { turns: 1 });
			const text = renderRead(transcript, { turns: 1, maxChars: 2000, includeThinking: true });
			const paging = text.match(
				/resume_session mode="read" file=("(?:\\.|[^"\\])*") offset=(\d+) turns=(\d+) max_chars=(\d+) include_thinking=(true|false)/,
			);
			if (!paging) throw new Error("Expected a file-scoped paging instruction");
			const next = await resolveSession("/unrelated-project", {
				file: JSON.parse(required(paging[1], "paging file path")),
				profile: "unrelated-profile",
			});
			expect(next).toEqual(selected);
			if ("error" in next) throw new Error(next.error);
			const older = renderRead(
				await parseTranscript(next.file, required(paging[5], "paging thinking flag") === "true", {
					offset: Number(required(paging[2], "paging offset")),
					turns: Number(required(paging[3], "paging turns")),
				}),
				{
					offset: Number(required(paging[2], "paging offset")),
					turns: Number(required(paging[3], "paging turns")),
					maxChars: Number(required(paging[4], "paging max chars")),
					includeThinking: required(paging[5], "paging thinking flag") === "true",
				},
			);
			expect(older).toContain("window: turns 3..3 of 4");
			expect(older).toContain("STOP.");
		});
	}, 20_000);
});

describe("integration: tool registration", () => {
	function fakePi(): { pi: Record<string, unknown>; captured: Record<string, unknown> } {
		const captured: Record<string, unknown> = {};
		return {
			pi: { zod, registerTool: (d: Record<string, unknown>) => Object.assign(captured, d), on: () => {} },
			captured,
		};
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
	}, 20_000);

	test("both modes run end to end through execute", async () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([{ ...shipped, cwd: repo.main }]);
		const { pi, captured } = fakePi();
		resumeSessionTool(pi as never);
		const execute = captured.execute as Execute;

		const listed = await withHome(home, () =>
			execute("1", { mode: "list", path: repo.main }, undefined, undefined, { cwd: repo.main }),
		);
		expect(listed.details).toMatchObject({ mode: "list", sessions: 1 });
		expect(required(listed.content[0], "list response").text).toContain("Wire the export path");

		const id = required((listed.details.ids as string[])[0], "listed session id");
		const read = await withHome(home, () =>
			execute("2", { mode: "read", session: id, path: repo.main }, undefined, undefined, { cwd: repo.main }),
		);
		expect(read.details).toMatchObject({ mode: "read", branch: "feat/csv", branchTier: "switched", turns: 4 });
		expect(required(read.content[0], "read response").text).toContain("## Latest plan / todo state");
	}, 20_000);

	test("an unresolvable session reports the problem instead of throwing", async () => {
		const repo = repoWithWorktree();
		const { home } = fixtureStore([{ ...shipped, cwd: repo.main }]);
		const { pi, captured } = fakePi();
		resumeSessionTool(pi as never);
		const result = await withHome(home, () =>
			(captured.execute as Execute)("3", { mode: "read", session: "zzzz", path: repo.main }, undefined, undefined, {
				cwd: repo.main,
			}),
		);
		expect(required(result.content[0], "error response").text).toContain("no session under");
		expect(result.details.error).toBeDefined();
	}, 20_000);
});
