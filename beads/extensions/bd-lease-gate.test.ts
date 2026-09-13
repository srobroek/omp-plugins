import { describe, expect, test } from "bun:test";

import bdLeaseGate, { anchorArgs, claimedIds, setBdRunForTests } from "./bd-lease-gate.ts";

/** Shapes bd 1.1.2 prints for a claim, envelope and plain. */
const ENVELOPE = '{"data":[{"id":"omp-plugins-dd1","status":"in_progress","assignee":"omp/Main/01a08b2b"}]}';

describe("claimedIds", () => {
	test("reads the id out of a claim's own JSON", () => {
		expect(claimedIds(ENVELOPE)).toEqual(["omp-plugins-dd1"]);
	});

	test("reads a plain claimed line", () => {
		expect(claimedIds("Claimed chezmoi-5vn (in_progress)")).toEqual(["chezmoi-5vn"]);
	});

	test("collects every bead a batch claim reports, without duplicates", () => {
		const out = '{"id":"omp-1"}\n{"id":"omp-2"}\n{"id":"omp-1"}';
		expect(claimedIds(out).sort()).toEqual(["omp-1", "omp-2"]);
	});

	test("ignores text that carries no bead id", () => {
		expect(claimedIds("error: unknown flag: --set-metadata")).toEqual([]);
		expect(claimedIds("")).toEqual([]);
	});

	test("ignores values that are not bead-shaped", () => {
		expect(claimedIds('{"id":"not a bead"}')).toEqual([]);
		expect(claimedIds('{"id":"12345"}')).toEqual([]);
	});
});

describe("anchorArgs", () => {
	test("builds an argv, so nothing is quoted or parsed as shell", () => {
		expect(anchorArgs("omp-1", "boxy", 7)).toEqual([
			"bd",
			"update",
			"omp-1",
			"--set-metadata",
			"lease_host=boxy",
			"--set-metadata",
			"lease_pid=7",
		]);
	});

	test("carries a host with punctuation without escaping", () => {
		expect(anchorArgs("omp-1", "box-1", 7)[4]).toBe("lease_host=box-1");
	});
});

type Handler = (event: unknown, context?: unknown) => unknown;

function handlers(): { toolCall: Handler; toolResult: Handler } {
	const registered: Record<string, Handler[]> = {};
	const pi = {
		on(event: string, handler: Handler) {
			(registered[event] ??= []).push(handler);
		},
	};
	bdLeaseGate(pi as never);
	const toolCall = registered.tool_call?.[0];
	const toolResult = registered.tool_result?.[0];
	if (toolCall === undefined || toolResult === undefined) throw new Error("lease gate handlers were not registered");
	return { toolCall, toolResult };
}

function claimResult(toolCallId: string, text: string, details?: unknown): unknown {
	return {
		toolName: "bash",
		toolCallId,
		input: { command: "bd update omp-1 --claim", cwd: "/claiming/repo" },
		content: [{ type: "text", text }],
		isError: false,
		details,
	};
}

describe("bdLeaseGate", () => {
	test("stamps from the bash call cwd, not the extension process cwd", () => {
		const calls: Array<{ argv: string[]; cwd: string }> = [];
		setBdRunForTests((argv, cwd) => {
			calls.push({ argv, cwd });
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		try {
			const { toolCall, toolResult } = handlers();
			toolCall({ toolName: "bash", toolCallId: "cwd", input: { command: "bd update omp-1 --claim", cwd: "/claiming/repo" } }, { cwd: "/session/repo" });
			toolResult(claimResult("cwd", '{"id":"omp-1"}'));
			expect(calls).toHaveLength(1);
			expect(calls[0]?.cwd).toBe("/claiming/repo");
		} finally {
			setBdRunForTests(null);
		}
	});

	test("falls back to the session cwd and resolves a literal leading cd", () => {
		const calls: string[] = [];
		setBdRunForTests((_argv, cwd) => {
			calls.push(cwd);
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		try {
			const { toolCall, toolResult } = handlers();
			toolCall({ toolName: "bash", toolCallId: "fallback", input: { command: "cd /claiming/repo && bd update omp-1 --claim" } }, { cwd: "/session/repo" });
			toolResult(claimResult("fallback", '{"id":"omp-1"}'));
			expect(calls).toEqual(["/claiming/repo"]);
		} finally {
			setBdRunForTests(null);
		}
	});

	test("returns an advisory when the stamp command fails", () => {
		setBdRunForTests(() => ({ exitCode: 7, stdout: "", stderr: "permission denied" }));
		try {
			const { toolCall, toolResult } = handlers();
			toolCall({ toolName: "bash", toolCallId: "failure", input: { command: "bd update omp-1 --claim", cwd: "/claiming/repo" } });
			const result = toolResult(claimResult("failure", '{"id":"omp-1"}')) as { content: Array<{ text?: string }> } | undefined;
			expect(result?.content[0]?.text).toContain("omp-1");
			expect(result?.content[0]?.text).toContain("bd exited 7");
			expect(result?.content[0]?.text).toContain("permission denied");
		} finally {
			setBdRunForTests(null);
		}
	});

	test("returns no advisory when the stamp succeeds", () => {
		setBdRunForTests(() => ({ exitCode: 0, stdout: "", stderr: "" }));
		try {
			const { toolCall, toolResult } = handlers();
			toolCall({ toolName: "bash", toolCallId: "success", input: { command: "bd update omp-1 --claim", cwd: "/claiming/repo" } });
			expect(toolResult(claimResult("success", '{"id":"omp-1"}'))).toBeUndefined();
		} finally {
			setBdRunForTests(null);
		}
	});

	test("returns an advisory when the stamp command throws", () => {
		setBdRunForTests(() => {
			throw new Error("spawn unavailable");
		});
		try {
			const { toolCall, toolResult } = handlers();
			toolCall({ toolName: "bash", toolCallId: "throw", input: { command: "bd update omp-1 --claim", cwd: "/claiming/repo" } });
			const result = toolResult(claimResult("throw", '{"id":"omp-1"}')) as { content: Array<{ text?: string }> } | undefined;
			expect(result?.content[0]?.text).toContain("spawn unavailable");
		} finally {
			setBdRunForTests(null);
		}
	});

	test("advises when a successful claim result has no parseable bead id", () => {
		const { toolCall, toolResult } = handlers();
		toolCall({ toolName: "bash", toolCallId: "missing", input: { command: "bd update omp-1 --claim", cwd: "/claiming/repo" } });
		const result = toolResult(claimResult("missing", "claim completed")) as { content: Array<{ text?: string }> } | undefined;
		expect(result?.content[0]?.text).toContain("could not parse a bead id");
	});
});
