import { describe, expect, test } from "bun:test";

import isolationPrecheck, { ISOLATION_REFUSAL, requestsIsolation } from "./isolation-precheck.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** The two handlers this extension registers, captured from a stub `pi`. */
function handlers(): { start: Handler; call: Handler; sent: { content: string }[] } {
	const registered: Record<string, Handler> = {};
	const sent: { content: string }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => {
			registered[event] = handler;
		},
		sendMessage: (message: { content: string }) => sent.push(message),
	};
	isolationPrecheck(pi as never);
	return { start: registered.session_start as Handler, call: registered.tool_call as Handler, sent };
}

describe("requestsIsolation", () => {
	test("finds the flag in the flat and batch wire shapes", () => {
		expect(requestsIsolation({ agent: "scout", task: "x", isolated: true })).toBe(true);
		expect(requestsIsolation({ context: "c", tasks: [{ task: "a" }, { task: "b", isolated: true }] })).toBe(true);
	});

	test("stays silent on a spawn that does not ask for isolation", () => {
		expect(requestsIsolation({ agent: "scout", task: "x" })).toBe(false);
		expect(requestsIsolation({ agent: "scout", task: "x", isolated: false })).toBe(false);
		expect(requestsIsolation({ context: "c", tasks: [{ task: "a" }] })).toBe(false);
		expect(requestsIsolation({ task: "mentions isolated: true in prose" })).toBe(false);
		expect(requestsIsolation(null)).toBe(false);
	});
});

describe("the task gate", () => {
	test("refuses an isolated spawn, naming the setting and the worktree remedy", () => {
		const { call } = handlers();
		const decision = call({ toolName: "task", input: { agent: "scout", task: "x", isolated: true } }) as
			| { block: boolean; reason: string }
			| undefined;
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toBe(ISOLATION_REFUSAL);
		expect(decision?.reason).toContain("task.isolation.enabled");
		expect(decision?.reason).toContain("wt switch");
	});

	test("passes an ordinary spawn and every other tool", () => {
		const { call } = handlers();
		expect(call({ toolName: "task", input: { agent: "scout", task: "x" } })).toBeUndefined();
		expect(call({ toolName: "bash", input: { command: "true", isolated: true } })).toBeUndefined();
	});
});

describe("the session-start advisory", () => {
	test("says nothing while isolation is off", () => {
		const { start, sent } = handlers();
		start({});
		expect(sent).toEqual([]);
	});
});
