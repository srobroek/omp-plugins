import { describe, expect, test } from "bun:test";

import mergePolicyGate, { decideMergePolicy } from "./merge-policy-gate.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
const git = (branch: string | null) => (_args: string[], _cwd: string) => branch ? `origin/${branch}` : null;

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
		const result = decideMergePolicy("wt merge develop", "/repo", git("main"));
		expect(result).toEqual({ block: true, reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff" });
	});

	test("blocks when either required flag is missing", () => {
		expect(decideMergePolicy("wt merge develop --no-squash", "/repo", git("main"))).toEqual({ block: true, reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff" });
		expect(decideMergePolicy("wt merge develop --no-ff", "/repo", git("main"))).toEqual({ block: true, reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff" });
	});

	test("allows a non-default target with both flags", () => {
		expect(decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git("main"))).toBeUndefined();
	});

	test("allows default-target and omitted-target merges", () => {
		expect(decideMergePolicy("wt merge main", "/repo", git("main"))).toBeUndefined();
		expect(decideMergePolicy("wt merge", "/repo", git("main"))).toBeUndefined();
	});

	test("fails closed when default branch cannot be determined", () => {
		const result = decideMergePolicy("wt merge develop --no-squash --no-ff", "/repo", git(null));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("cannot determine the repository default branch");
	});

	test("finds compound and absolute-path invocations, but ignores git merge", () => {
		const runner = git("main");
		expect(decideMergePolicy("echo ready && /opt/wt merge develop", "/repo", runner)?.reason).toContain("wt merge develop --no-squash --no-ff");
		expect(decideMergePolicy("git merge develop", "/repo", runner)).toBeUndefined();
	});

	test("sees merges behind global options and resolves the default branch in -C", () => {
		const seen: string[] = [];
		const runner = (_args: string[], cwd: string) => { seen.push(cwd); return "origin/main"; };
		expect(decideMergePolicy("wt -C sub -v merge develop", "/repo", runner)?.reason).toContain("wt merge develop --no-squash --no-ff");
		expect(seen).toEqual(["/repo/sub"]);
		expect(decideMergePolicy("wt --config /c.toml merge develop --no-squash --no-ff", "/repo", runner)).toBeUndefined();
	});

	test("registers one tool_call gate with the blocking shape", () => {
		const { registered, call } = harness();
		expect(registered).toEqual(["tool_call"]);
		expect(call({ toolName: "write", input: { command: "wt merge develop" } }, { cwd: "/repo" })).toBeUndefined();
		expect(call({ toolName: "bash", input: { command: "git merge develop" } }, { cwd: "/repo" })).toBeUndefined();
	});
});
