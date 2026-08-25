import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import unpushedWorkAdvisory, {
	agentAuthoredDirty,
	extractWrittenPaths,
	formatAdvisory,
	handleSessionStop,
	hasGitDir,
	parseNumstat,
	parsePorcelain,
	recordAgentPath,
	resetUnpushedAdvisoryForTests,
	shouldAdvise,
	SIGNIFICANT_AGENT_CHANGED_LINES,
	SIGNIFICANT_AGENT_DIRTY_FILES,
	totalChangedLines,
} from "./unpushed-work-advisory.ts";

/** Build `git status --porcelain -b -z` output: NUL-terminated fields. */
const porcelain = (...fields: string[]): string => `${fields.join("\0")}\0`;

const authored = (cwd: string, ...paths: string[]): Set<string> => {
	const set = new Set<string>();
	for (const path of paths) recordAgentPath(cwd, path, set);
	return set;
};

const noStat = () => [];

/** Per-file stat for `paths`, each with the same magnitude. */
const evenStat = (lines: number, ...paths: string[]) =>
	paths.map(path => ({ path, added: lines, deleted: 0 }));

/**
 * Neutralise the developer's global git config for temp-repo fixtures.
 *
 * A global `commit.gpgsign=true` costs ~2s per commit — measured 2077ms against
 * 70ms with signing off — which alone pushes a three-commit fixture past bun's
 * 5s test timeout. Hook paths are cut for the same reason.
 */
const GIT_ISOLATED = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

describe("parsePorcelain", () => {
	test("branch, ahead, dirty paths and untracked", () => {
		const s = parsePorcelain(
			porcelain("## feature...origin/feature [ahead 2]", " M src/a.ts", "?? scratch"),
		);
		expect(s.branch).toBe("feature");
		expect(s.ahead).toBe(2);
		expect(s.dirtyPaths).toEqual(["src/a.ts"]);
		expect(s.untracked).toBe(1);
	});

	test("clean tracking branch has no dirty paths", () => {
		const s = parsePorcelain(porcelain("## main...origin/main"));
		expect(s.ahead).toBe(0);
		expect(s.dirtyPaths).toEqual([]);
		expect(shouldAdvise([], 0, 0)).toBe(false);
	});

	test("behind count parses without ahead", () => {
		const s = parsePorcelain(porcelain("## main...origin/main [behind 4]"));
		expect(s.behind).toBe(4);
		expect(s.ahead).toBe(0);
	});

	test("rename entry records both sides and consumes the original field", () => {
		const s = parsePorcelain(porcelain("## main", "R  new.ts", "old.ts", " M other.ts"));
		expect(s.dirtyPaths).toEqual(["new.ts", "old.ts", "other.ts"]);
	});

	test("paths with spaces survive because -z never quotes", () => {
		const s = parsePorcelain(porcelain("## main", " M docs/a file.md"));
		expect(s.dirtyPaths).toEqual(["docs/a file.md"]);
	});

	test("untracked alone never advises", () => {
		const s = parsePorcelain(porcelain("## main", "?? foo", "?? bar", "?? baz", "?? qux"));
		expect(agentAuthoredDirty(s, "/repo", new Set())).toEqual([]);
		expect(shouldAdvise([], 0, 0)).toBe(false);
	});
});

describe("extractWrittenPaths", () => {
	test("write reports its input path", () => {
		expect(extractWrittenPaths("write", false, { path: "src/a.ts" }, undefined)).toEqual([
			"src/a.ts",
		]);
	});

	test("edit reports the resolved details path, not its patch input", () => {
		const paths = extractWrittenPaths(
			"edit",
			false,
			{ input: "[src/a.ts#1234]" },
			{ path: "/repo/src/a.ts", diff: "" },
		);
		expect(paths).toEqual(["/repo/src/a.ts"]);
	});

	test("multi-file edit reports every per-file path", () => {
		const paths = extractWrittenPaths(
			"edit",
			false,
			{},
			{
				diff: "",
				perFileResults: [
					{ path: "/repo/a.ts", diff: "" },
					{ path: "/repo/b.ts", diff: "" },
				],
			},
		);
		expect(paths).toEqual(["/repo/a.ts", "/repo/b.ts"]);
	});

	test("rename reports source and destination", () => {
		const paths = extractWrittenPaths(
			"edit",
			false,
			{},
			{ diff: "", path: "/repo/new.ts", sourcePath: "/repo/old.ts", move: "/repo/new.ts" },
		);
		expect(paths).toContain("/repo/old.ts");
		expect(paths).toContain("/repo/new.ts");
	});

	test("a failed edit is not attributed", () => {
		expect(extractWrittenPaths("edit", true, {}, { path: "/repo/a.ts", diff: "" })).toEqual([]);
	});

	test("non-writing tools are ignored", () => {
		expect(extractWrittenPaths("bash", false, { command: "rm -rf x" }, undefined)).toEqual([]);
		expect(extractWrittenPaths("read", false, { path: "src/a.ts" }, undefined)).toEqual([]);
	});

	test("a tool named through the prototype chain is not a writing tool", () => {
		// Regression: a truthiness check on a plain-object lookup would accept
		// these, the bug class that once took a session's bash tool down.
		expect(extractWrittenPaths("constructor", false, { path: "a.ts" }, undefined)).toEqual([]);
		expect(extractWrittenPaths("toString", false, { path: "a.ts" }, undefined)).toEqual([]);
	});
});

describe("recordAgentPath", () => {
	test("resolves relative paths against cwd", () => {
		expect(authored("/repo", "src/a.ts").has(resolve("/repo", "src/a.ts"))).toBe(true);
	});

	test("rejects tool-device and artifact URIs", () => {
		expect(authored("/repo", "xd://ast_edit", "local://plan.md", "artifact://77").size).toBe(0);
	});
});

describe("parseNumstat", () => {
	test("keeps per-file counts and totals them", () => {
		const stats = parseNumstat("3\t4\tsrc/a.ts\n10\t0\tsrc/b.ts\n");
		expect(stats).toEqual([
			{ path: "src/a.ts", added: 3, deleted: 4 },
			{ path: "src/b.ts", added: 10, deleted: 0 },
		]);
		expect(totalChangedLines(stats)).toBe(17);
	});

	test("binary files are listed but count zero", () => {
		const stats = parseNumstat("-\t-\timage.png\n2\t1\tsrc/a.ts\n");
		expect(stats[0]).toEqual({ path: "image.png", added: 0, deleted: 0 });
		expect(totalChangedLines(stats)).toBe(3);
	});

	test("empty output yields no files", () => {
		expect(parseNumstat("")).toEqual([]);
		expect(totalChangedLines([])).toBe(0);
	});
});

describe("authorship gating", () => {
	const status = parsePorcelain(
		porcelain("## topic", " M mine-a.ts", " M mine-b.ts", " M mine-c.ts", " M theirs.ts"),
	);

	test("only agent-written files count as agent dirty", () => {
		const set = authored("/repo", "mine-a.ts", "mine-b.ts", "mine-c.ts");
		expect(agentAuthoredDirty(status, "/repo", set).sort()).toEqual([
			"mine-a.ts",
			"mine-b.ts",
			"mine-c.ts",
		]);
	});

	test("a human's dirty files never trigger the advisory", () => {
		// The regression this gating exists for: four dirty files in the tree,
		// none written by the agent, must produce silence rather than a demand.
		const dirty = agentAuthoredDirty(status, "/repo", new Set());
		expect(dirty).toEqual([]);
		expect(shouldAdvise(dirty, 5000, 0)).toBe(false);
	});

	test("few files and few lines stays silent", () => {
		const set = authored("/repo", "mine-a.ts", "mine-b.ts");
		const dirty = agentAuthoredDirty(status, "/repo", set);
		expect(dirty.length).toBe(SIGNIFICANT_AGENT_DIRTY_FILES - 1);
		expect(shouldAdvise(dirty, 10, 0)).toBe(false);
	});

	test("file count alone reaches the threshold", () => {
		const set = authored("/repo", "mine-a.ts", "mine-b.ts", "mine-c.ts");
		expect(shouldAdvise(agentAuthoredDirty(status, "/repo", set), 0, 0)).toBe(true);
	});

	test("line count alone reaches the threshold", () => {
		// One file, far below the file gate, but a substantial rewrite.
		const set = authored("/repo", "mine-a.ts");
		const dirty = agentAuthoredDirty(status, "/repo", set);
		expect(dirty.length).toBe(1);
		expect(shouldAdvise(dirty, SIGNIFICANT_AGENT_CHANGED_LINES, 0)).toBe(true);
		expect(shouldAdvise(dirty, SIGNIFICANT_AGENT_CHANGED_LINES - 1, 0)).toBe(false);
	});

	test("commits made this session advise; a human's pre-existing ones do not", () => {
		// The nag this attribution exists to kill: a branch sitting 25 commits ahead
		// from before the session must produce silence, not a push demand.
		expect(shouldAdvise([], 0, 1)).toBe(true);
		expect(shouldAdvise([], 0, 0)).toBe(false);
	});
});

describe("formatAdvisory", () => {
	const status = parsePorcelain(porcelain("## wip", " M a.ts", " M b.ts", " M c.ts"));

	test("names the agent's own paths and forbids staging anything else", () => {
		const text = formatAdvisory(status, ["a.ts", "b.ts", "c.ts"], evenStat(40, "a.ts", "b.ts", "c.ts"));
		expect(text).toContain("wip");
		expect(text).toContain("a.ts");
		expect(text).toContain("~120 changed line(s)");
		expect(text).toContain("git commit <paths>");
		expect(text).toContain("not yours to commit, count, or mention");
		expect(text).not.toContain("add -A");
	});

	test("summarises each file's magnitude so chunks can be told apart", () => {
		const text = formatAdvisory(status, ["a.ts", "b.ts"], [
			{ path: "a.ts", added: 4, deleted: 2 },
			{ path: "b.ts", added: 90, deleted: 8 },
		]);
		expect(text).toContain("a.ts (+4/-2)");
		expect(text).toContain("b.ts (+90/-8)");
	});

	test("largest change is listed first, whatever the dirty order", () => {
		const text = formatAdvisory(status, ["small.ts", "big.ts"], [
			{ path: "small.ts", added: 1, deleted: 0 },
			{ path: "big.ts", added: 200, deleted: 0 },
		]);
		expect(text.indexOf("big.ts")).toBeLessThan(text.indexOf("small.ts"));
	});

	test("a file with no stat is marked rather than dropped", () => {
		// Untracked files never appear in `git diff HEAD`, so they carry no stat.
		const text = formatAdvisory(status, ["new.ts"], []);
		expect(text).toContain("new.ts (untracked)");
	});

	test("instructs one commit per unit of functionality", () => {
		const text = formatAdvisory(status, ["a.ts", "b.ts", "c.ts"], evenStat(10, "a.ts"));
		expect(text).toContain("unit of functionality");
		expect(text).toContain("separate commit per change with its own");
		expect(text).toContain("unfinished");
	});

	test("omits magnitude when the diff could not be taken", () => {
		expect(formatAdvisory(status, ["a.ts"], [])).not.toContain("changed line(s)");
	});

	test("only the agent's own session commits are mentioned", () => {
		const ahead = parsePorcelain(porcelain("## wip...origin/wip [ahead 25]"));
		const text = formatAdvisory(ahead, [], [], 3);
		expect(text).toContain("3 commit(s) you made this session");
		expect(text).not.toContain("25");
		expect(text).toContain("authority");
	});

	test("a branch ahead with no session commits says nothing about commits", () => {
		const ahead = parsePorcelain(porcelain("## wip...origin/wip [ahead 25]"));
		expect(formatAdvisory(ahead, [], [], 0)).not.toContain("unpushed");
	});

	test("long file lists are truncated", () => {
		const many = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
		expect(formatAdvisory(status, many, evenStat(1, ...many))).toContain("+4 more");
	});
});

describe("handleSessionStop", () => {
	const noOwn = () => 0;
	const oneOwn = () => 1;

	test("skips when stop_hook_active", () => {
		resetUnpushedAdvisoryForTests();
		expect(
			handleSessionStop(
				{ stop_hook_active: true },
				"/tmp",
				porcelain("## x [ahead 1]"),
				new Set(),
				noStat,
				oneOwn,
				"base",
			),
		).toBeUndefined();
	});

	test("continues with context when the session left its own commits unpushed", () => {
		resetUnpushedAdvisoryForTests();
		const r = handleSessionStop(
			{},
			"/tmp",
			porcelain("## feat...origin/feat [ahead 1]"),
			new Set(),
			noStat,
			oneOwn,
			"base",
		);
		expect(r?.continue).toBe(true);
		expect(r?.additionalContext).toContain("feat");
	});

	test("a branch ahead of upstream from before the session is ignored", () => {
		// Verbatim shape of the false demand: 25 commits ahead, none of them made
		// this session, nothing dirty that the agent wrote.
		resetUnpushedAdvisoryForTests();
		const text = porcelain("## feat...origin/feat [ahead 25]");
		expect(handleSessionStop({}, "/repo", text, new Set(), noStat, noOwn, "base")).toBeUndefined();
	});

	test("no baseline means no claim about commits", () => {
		// `sessionHead` is null in a non-repo or unreadable checkout. The real
		// counter must then report zero rather than fall back to the ahead count.
		resetUnpushedAdvisoryForTests();
		const text = porcelain("## feat...origin/feat [ahead 4]");
		expect(handleSessionStop({}, "/repo", text, new Set(), noStat)).toBeUndefined();
	});

	test("does not fire twice in a row", () => {
		resetUnpushedAdvisoryForTests();
		const text = porcelain("## feat...origin/feat [ahead 1]");
		expect(handleSessionStop({}, "/tmp", text, new Set(), noStat, oneOwn, "base")).toBeDefined();
		expect(handleSessionStop({}, "/tmp", text, new Set(), noStat, oneOwn, "base")).toBeUndefined();
	});

	test("stays silent on an unattributed dirty tree", () => {
		resetUnpushedAdvisoryForTests();
		const text = porcelain("## feat", " M a.ts", " M b.ts", " M c.ts", " M d.ts");
		expect(handleSessionStop({}, "/repo", text, new Set(), noStat, noOwn)).toBeUndefined();
	});

	test("a single large agent rewrite advises via the line gate", () => {
		resetUnpushedAdvisoryForTests();
		const text = porcelain("## feat", " M big.ts");
		const r = handleSessionStop(
			{},
			"/repo",
			text,
			authored("/repo", "big.ts"),
			() => [{ path: "big.ts", added: SIGNIFICANT_AGENT_CHANGED_LINES + 1, deleted: 0 }],
			noOwn,
		);
		expect(r?.additionalContext).toContain("big.ts");
	});
});

describe("integration temp git repo", () => {
	const gitOk = Bun.which("git");
	const dir = mkdtempSync(join(tmpdir(), "unpushed-adv-"));

	afterAll(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test.skipIf(!gitOk)("advises only about files the agent wrote", () => {
		resetUnpushedAdvisoryForTests();
		const run = (args: string[]) =>
			Bun.spawnSync(["git", ...GIT_ISOLATED, ...args], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
		run(["init", "-b", "topic"]);
		run(["config", "user.email", "t@t.test"]);
		run(["config", "user.name", "t"]);

		const files = ["mine-a.txt", "mine-b.txt", "mine-c.txt", "theirs.txt"];
		for (const file of files) writeFileSync(join(dir, file), "one\n");
		run(["add", "."]);
		run(["commit", "-m", "c1"]);
		for (const file of files) writeFileSync(join(dir, file), "two\n");

		expect(hasGitDir(dir)).toBe(true);

		const handlers: Record<string, Array<(e: unknown, ctx?: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (e: string, h: (ev: unknown, ctx?: unknown) => unknown) => {
				(handlers[e] ??= []).push(h);
			},
		};
		unpushedWorkAdvisory(fakePi as never);

		// Nothing attributed yet: four dirty files, all of them somebody else's.
		expect(handlers.session_stop![0]!({}, { cwd: dir })).toBeUndefined();

		const toolResult = handlers.tool_result![0]!;
		toolResult({ toolName: "write", isError: false, input: { path: "mine-a.txt" } }, { cwd: dir });
		toolResult(
			{
				toolName: "edit",
				isError: false,
				input: {},
				details: { diff: "", path: join(dir, "mine-b.txt") },
			},
			{ cwd: dir },
		);
		toolResult(
			{
				toolName: "edit",
				isError: false,
				input: {},
				details: { diff: "", perFileResults: [{ path: join(dir, "mine-c.txt"), diff: "" }] },
			},
			{ cwd: dir },
		);
		// A failed write and a bash mutation must not attribute the fourth file.
		toolResult({ toolName: "write", isError: true, input: { path: "theirs.txt" } }, { cwd: dir });
		toolResult(
			{ toolName: "bash", isError: false, input: { command: "sed -i s/a/b/ theirs.txt" } },
			{ cwd: dir },
		);

		const result = handlers.session_stop![0]!({}, { cwd: dir }) as {
			continue: boolean;
			additionalContext: string;
		};
		expect(result.continue).toBe(true);
		expect(result.additionalContext).toContain("mine-a.txt");
		expect(result.additionalContext).toContain("mine-b.txt");
		expect(result.additionalContext).toContain("mine-c.txt");
		expect(result.additionalContext).not.toContain("theirs.txt");
		// Real numstat ran against the agent's three files. Each rewrote its single
		// line, and numstat counts a modification as one added plus one deleted.
		expect(result.additionalContext).toContain("~6 changed line(s)");
		expect(result.additionalContext).toContain("mine-a.txt (+1/-1)");

		expect(handlers.session_stop![0]!({}, { cwd: dir })).toBeUndefined();

		handlers.turn_start![0]!({});
		expect(handlers.session_stop![0]!({}, { cwd: dir })).toBeDefined();
	});

	test.skipIf(!gitOk)("counts only commits made after the session opened", () => {
		resetUnpushedAdvisoryForTests();
		const work = mkdtempSync(join(tmpdir(), "unpushed-adv-commits-"));
		const origin = mkdtempSync(join(tmpdir(), "unpushed-adv-origin-"));
		const run = (args: string[], cwd = work) =>
			Bun.spawnSync(["git", ...GIT_ISOLATED, ...args], { cwd, stdout: "pipe", stderr: "pipe" });

		run(["init", "--bare", "-b", "topic"], origin);
		run(["init", "-b", "topic"]);
		run(["config", "user.email", "t@t.test"]);
		run(["config", "user.name", "t"]);
		writeFileSync(join(work, "a.txt"), "one\n");
		run(["add", "."]);
		run(["commit", "-m", "c1"]);
		run(["remote", "add", "origin", origin]);
		run(["push", "-u", "origin", "topic"]);

		// A human's commit, made before this session and never pushed.
		writeFileSync(join(work, "theirs.txt"), "theirs\n");
		run(["add", "."]);
		run(["commit", "-m", "human work"]);

		const handlers: Record<string, Array<(e: unknown, ctx?: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (e: string, h: (ev: unknown, ctx?: unknown) => unknown) => {
				(handlers[e] ??= []).push(h);
			},
		};
		unpushedWorkAdvisory(fakePi as never);
		handlers.session_start![0]!({}, { cwd: work });

		// One commit ahead of origin, none of it this session's: silence.
		expect(handlers.session_stop![0]!({}, { cwd: work })).toBeUndefined();

		writeFileSync(join(work, "mine.txt"), "mine\n");
		run(["add", "."]);
		run(["commit", "-m", "agent work"]);
		handlers.turn_start![0]!({});

		const result = handlers.session_stop![0]!({}, { cwd: work }) as {
			additionalContext: string;
		};
		// Two commits ahead of origin, exactly one of them made after the baseline.
		expect(result.additionalContext).toContain("1 commit(s) you made this session");
		expect(result.additionalContext).not.toContain("2 commit(s)");

		rmSync(work, { recursive: true, force: true });
		rmSync(origin, { recursive: true, force: true });
	});
});
