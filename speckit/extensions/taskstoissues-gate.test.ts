import { describe, expect, test } from "bun:test";

import taskstoissuesGate, {
	DENY_REASON,
	decideToolCall,
	isTaskstoissuesInvocation,
	tokenize,
} from "./taskstoissues-gate.ts";

describe("tokenize", () => {
	test("keeps a quoted title as one token", () => {
		expect(tokenize("bd create --title 'port speckit-taskstoissues deny'")).toEqual([
			"bd",
			"create",
			"--title",
			"port speckit-taskstoissues deny",
		]);
	});
});

describe("isTaskstoissuesInvocation", () => {
	test("blocks command-position invocations", () => {
		for (const command of [
			"speckit-taskstoissues",
			"speckit.taskstoissues",
			"specify run /speckit.taskstoissues",
			"specify /speckit.taskstoissues",
			"sudo speckit-taskstoissues --yes",
			"FOO=1 speckit-taskstoissues",
			"echo hi; speckit-taskstoissues",
			"./bin/speckit-taskstoissues",
		]) {
			expect(isTaskstoissuesInvocation(command)).toBe(true);
		}
	});

	test("quoted mentions and other commands pass", () => {
		for (const command of [
			"bd create --title 'port speckit-taskstoissues deny'",
			"echo speckit-taskstoissues",
			"git commit -m 'speckit-taskstoissues'",
			"bd close x --reason 'retire speckit-taskstoissues'",
			"rg speckit-taskstoissues",
			"cat .specify/scripts/bash/speckit-taskstoissues.sh",
		]) {
			expect(isTaskstoissuesInvocation(command)).toBe(false);
		}
	});
});

describe("decideToolCall", () => {
	test("blocks bash invocations", () => {
		expect(decideToolCall("bash", { command: "speckit-taskstoissues" })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
	});

	test("allows other tools and empty input", () => {
		expect(decideToolCall("write", { command: "speckit-taskstoissues" })).toBeUndefined();
		expect(decideToolCall("bash", {})).toBeUndefined();
	});
});

describe("register", () => {
	test("registers a tool_call handler that blocks", () => {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		taskstoissuesGate(fakePi as never);
		expect(
			handlers.tool_call?.[0]?.({
				toolName: "bash",
				toolCallId: "1",
				input: { command: "specify run /speckit.taskstoissues" },
			}),
		).toEqual({ block: true, reason: DENY_REASON });
	});

	test("fail-open on malformed input", () => {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		taskstoissuesGate(fakePi as never);
		expect(handlers.tool_call?.[0]?.({ toolName: "bash", input: null })).toBeUndefined();
	});
});
