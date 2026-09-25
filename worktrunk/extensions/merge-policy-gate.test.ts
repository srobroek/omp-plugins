import { describe, expect, test } from "bun:test";

import mergePolicyGate, { decideMergePolicy } from "./merge-policy-gate.ts";

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

	test("registers one tool_call gate with the blocking shape", () => {
		const { registered, call } = harness();
		expect(registered).toEqual(["tool_call"]);
		expect(call({ toolName: "write", input: { command: "wt merge develop" } }, { cwd: "/repo" })).toBeUndefined();
		expect(call({ toolName: "bash", input: { command: "git merge develop" } }, { cwd: "/repo" })).toBeUndefined();
	});
});
