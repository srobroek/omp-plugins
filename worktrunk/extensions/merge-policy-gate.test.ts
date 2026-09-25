import { describe, expect, test } from "bun:test";

import mergePolicyGate, { decideEvalMergePolicy, decideMergePolicy } from "./merge-policy-gate.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
const git = (defaultBranch: string | null, currentBranch = "worker") => (args: string[], _cwd: string) => args[0] === "branch" ? currentBranch : defaultBranch ? `origin/${defaultBranch}` : null;
const wt = (branch: string | null) => (_args: string[], _cwd: string) => branch;

function harness(): { registered: string[]; call: Handler } {
	const registered: string[] = [];
	let call: Handler = () => undefined;
	mergePolicyGate({
		on: (event: string, handler: Handler) => { registered.push(event); if (event === "tool_call") call = handler; },
	} as never);
	return { registered, call };
}

describe("merge policy", () => {
	test("blocks unflagged eval merges in Python argv and shell strings", () => {
		expect(decideEvalMergePolicy("subprocess.run(['wt', 'merge', 'orc/epic'])")?.block).toBe(true);
		expect(decideEvalMergePolicy('os.system("wt merge orc/epic --no-squash")')?.block).toBe(true);
	});
	test("allows flagged eval merges in Python argv and Bun templates", () => {
		expect(decideEvalMergePolicy("subprocess.run([\"wt\", \"merge\", \"orc/epic\", \"--no-squash\", \"--no-ff\"])")).toBeUndefined();
		expect(decideEvalMergePolicy("await Bun.$`wt merge orc/epic --no-squash --no-ff`")).toBeUndefined();
	});

	test("blocks dynamic eval merge construction fail-closed", () => {
		const code = 'tool = "wt"; action = "merge"; subprocess.run([tool, action, "orc/epic"])';
		expect(decideEvalMergePolicy(code)?.block).toBe(true);
		expect(decideEvalMergePolicy("subprocess.run(['w' + 't', 'merge', 'orc/epic'])")?.block).toBe(true);
	});

	test("parses tuple argv and blocks exact dynamic command literals", () => {
		expect(decideEvalMergePolicy("subprocess.run(('wt', 'merge', 'e'))")?.block).toBe(true);
		expect(decideEvalMergePolicy("subprocess.run(('wt', 'merge', 'e', '--no-squash', '--no-ff'))")).toBeUndefined();
		expect(decideEvalMergePolicy("cmd='wt'; subprocess.run([cmd,'merge','e'])")?.block).toBe(true);
	});

	test("covers shell strings and absolute Worktrunk paths", () => {
		for (const code of [
			'os.system("cd x && wt merge e")',
			"shlex.split('wt merge e')",
			"['wt', '-C', '/x', 'merge', 'e']",
			"['/opt/homebrew/bin/wt', 'merge', 'e']",
			"subprocess.run([\"wt\", \"merge\", \"e\", \"--no-ff\"])",
		]) {
			expect(decideEvalMergePolicy(code)?.block).toBe(true);
		}
	});

	test("keeps non-Worktrunk merge words and comments unblocked", () => {
		expect(decideEvalMergePolicy("['git', 'merge-tree', 'origin/main']")).toBeUndefined();
		expect(decideEvalMergePolicy("pd.merge(a, b); d.merge(x); print('merge')")).toBeUndefined();
		expect(decideEvalMergePolicy("['wt', 'list', '--format', 'json']")).toBeUndefined();
		expect(decideEvalMergePolicy("# we will later wt merge from bash")).toBeUndefined();
	});

	test("does not treat unrelated merge words as Worktrunk merges", () => {
		expect(decideEvalMergePolicy("git merge-tree origin/main HEAD")).toBeUndefined();
		expect(decideEvalMergePolicy("pd.merge(left, right)")).toBeUndefined();
		expect(decideEvalMergePolicy("subprocess.run(['wt', 'list'])")).toBeUndefined();
	});
	test("blocks a non-default target without both history flags", () => {
		const result = decideMergePolicy("wt merge develop", "/repo", git("main"), wt(null));
		expect(result).toEqual({ block: true, reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff" });
	});

	test("blocks when either required flag is missing", () => {
		expect(decideMergePolicy("wt merge develop --no-squash", "/repo", git("main"), wt(null))).toEqual({ block: true, reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff" });
		expect(decideMergePolicy("wt merge develop --no-ff", "/repo", git("main"), wt(null))).toEqual({ block: true, reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff" });
	});

	test("allows a non-default target with both flags", () => {
		expect(decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git("main"), wt(null))).toBeUndefined();
	});

	test("refuses a worker merge launched from the target worktree", () => {
		const result = decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git("main", "develop"), wt(null));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("run from the source worktree");
	});

	test("refuses when the current branch cannot be read (detached HEAD)", () => {
		expect(decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git("main", ""), wt(null))?.block).toBe(true);
	});

	test("allows a flagged merge from a worker branch and a main-to-epic refresh", () => {
		expect(decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git("main", "worker"), wt(null))).toBeUndefined();
		expect(decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git("main", "main"), wt(null))).toBeUndefined();
	});

	test("reads the current branch in the -C directory", () => {
		const seen: Array<[string, string]> = [];
		const runner = (args: string[], cwd: string) => { seen.push([args[0] ?? "", cwd]); return args[0] === "branch" ? "worker" : "origin/main"; };
		expect(decideMergePolicy("wt -C sub merge develop --no-squash --no-ff", "/repo", runner, wt(null))).toBeUndefined();
		expect(seen).toContainEqual(["branch", "/repo/sub"]);
	});

	test("allows default-target and omitted-target merges", () => {
		expect(decideMergePolicy("wt merge main", "/repo", git("main"), wt(null))).toBeUndefined();
		expect(decideMergePolicy("wt merge", "/repo", git("main"), wt(null))).toBeUndefined();
	});

	test("uses Worktrunk default branch before origin/HEAD", () => {
		expect(decideMergePolicy("wt merge fixture-base --no-squash --no-ff", "/repo", git(null), wt("fixture-base"))).toBeUndefined();
		expect(decideMergePolicy("wt merge develop", "/repo", git(null), wt("fixture-base"))?.block).toBe(true);
	});

	test("fails closed when both default branch lookups fail for an explicit target", () => {
		const result = decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git(null), wt(null));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("cannot determine the repository default branch");
	});

	test("allows omitted target when both default branch lookups fail", () => {
		expect(decideMergePolicy("wt merge", "/repo", git(null), wt(null))).toBeUndefined();
	});

	test("does not treat merge help as a merge", () => {
		expect(decideMergePolicy("wt merge --help", "/repo", git(null), wt(null))).toBeUndefined();
		expect(decideMergePolicy("wt merge -h", "/repo", git(null), wt(null))).toBeUndefined();
	});

	test("finds compound and absolute-path invocations, but ignores git merge", () => {
		const runner = git("main");
		expect(decideMergePolicy("echo ready && /opt/wt merge develop", "/repo", runner, wt(null))?.reason).toContain("wt merge develop --no-squash --no-ff");
		expect(decideMergePolicy("git merge develop", "/repo", runner, wt(null))).toBeUndefined();
	});

	test("sees merges behind global options and resolves the default branch in -C", () => {
		const seen: string[] = [];
		const runner = (_args: string[], cwd: string) => { seen.push(cwd); return "origin/main"; };
		const wtRunner = (_args: string[], cwd: string) => { seen.push(cwd); return null; };
		expect(decideMergePolicy("wt -C sub -v merge develop", "/repo", runner, wtRunner)?.reason).toContain("wt merge develop --no-squash --no-ff");
		expect(seen).toEqual(["/repo/sub", "/repo/sub"]);
		expect(decideMergePolicy("wt --config /c.toml merge develop --no-squash --no-ff", "/repo", runner, wtRunner)).toBeUndefined();
	});

	test("registers one tool_call gate with eval support and unchanged bash behavior", () => {
		const { registered, call } = harness();
		expect(registered).toEqual(["tool_call"]);
		expect(call({ toolName: "write", input: { command: "wt merge develop" } }, { cwd: "/repo" })).toBeUndefined();
		expect(call({ toolName: "bash", input: { command: "git merge develop" } }, { cwd: "/repo" })).toBeUndefined();
		expect(decideMergePolicy("wt merge develop", "/repo", git("main"), wt(null))).toEqual({
			block: true,
			reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff",
		});
		expect(call({ toolName: "eval", input: { language: "py", code: "subprocess.run(['wt', 'merge', 'develop'])" } })).toEqual({
			block: true,
			reason: expect.stringContaining("run the merge through the bash tool from the source worktree"),
		});
		expect(call({ toolName: "eval", input: { language: "js", code: "await Bun.$`wt merge develop --no-squash --no-ff`" } })).toBeUndefined();
	});
});
