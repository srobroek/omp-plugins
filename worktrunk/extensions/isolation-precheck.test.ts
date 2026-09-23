import { describe, expect, test } from "bun:test";

import isolationPrecheck, { ISOLATION_REFUSAL, requestsIsolation } from "./isolation-precheck.ts";

type Handler = (event: unknown) => unknown;

/** Capture the handlers the extension registers, from a stub `pi`. */
function harness(): { registered: string[]; call: Handler } {
	const registered: string[] = [];
	let call: Handler = () => undefined;
	const pi = {
		on: (event: string, handler: Handler) => {
			registered.push(event);
			if (event === "tool_call") call = handler;
		},
		sendMessage: () => {
			throw new Error("the adopted extension must never send a message");
		},
	};
	isolationPrecheck(pi as never);
	return { registered, call };
}

describe("the adopted surface", () => {
	test("registers exactly one handler, and it is tool_call", () => {
		expect(harness().registered).toEqual(["tool_call"]);
	});
	test("never reads settings, the filesystem, git, or a subprocess", async () => {
		const raw = await Bun.file(new URL("./isolation-precheck.ts", import.meta.url)).text();
		// Strip comments: the prose deliberately NAMES these mechanisms to explain their absence.
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		for (const forbidden of ["settings.get", "config/settings", "readFileSync", "spawnSync", "execFile", "node:fs", "node:child_process", "node:os", '"session_start"', "sendMessage"]) {
			expect(code).not.toContain(forbidden);
		}
		// One import, and it is types only.
		expect(code.match(/^import /gm) ?? []).toHaveLength(1);
		expect(code).toContain("import type");
	});
});

describe("requestsIsolation", () => {
	test("finds the flag in the flat and batch wire shapes", () => {
		expect(requestsIsolation({ agent: "scout", task: "x", isolated: true })).toBe(true);
		expect(requestsIsolation({ context: "c", tasks: [{ task: "a" }, { task: "b", isolated: true }] })).toBe(true);
	});

	test("stays silent on payloads that do not request isolation", () => {
		expect(requestsIsolation({ agent: "scout", task: "x" })).toBe(false);
		expect(requestsIsolation({ agent: "scout", task: "x", isolated: false })).toBe(false);
		expect(requestsIsolation({ context: "c", tasks: [{ task: "a" }] })).toBe(false);
		expect(requestsIsolation({ task: "mentions isolated: true in prose" })).toBe(false);
		expect(requestsIsolation(null)).toBe(false);
		expect(requestsIsolation([{ isolated: true }])).toBe(false);
	});
});

describe("the refusal", () => {
	test("blocks an isolated task in both wire shapes, unconditionally", () => {
		const { call } = harness();
		expect(call({ toolName: "task", input: { agent: "scout", task: "x", isolated: true } })).toEqual({ block: true, reason: ISOLATION_REFUSAL });
		expect(call({ toolName: "task", input: { tasks: [{ task: "b", isolated: true }] } })).toEqual({ block: true, reason: ISOLATION_REFUSAL });
	});

	test("names the remedy and the worktree command", () => {
		expect(ISOLATION_REFUSAL).toContain("task.isolation.enabled: false");
		expect(ISOLATION_REFUSAL).toContain("wt switch -y --create --no-cd --base");
	});

	test("passes an ordinary spawn and every other tool, including a bash call carrying the flag", () => {
		const { call } = harness();
		expect(call({ toolName: "task", input: { agent: "scout", task: "x" } })).toBeUndefined();
		expect(call({ toolName: "bash", input: { command: "true", isolated: true } })).toBeUndefined();
		expect(call({ toolName: "write", input: { path: "/etc/passwd" } })).toBeUndefined();
		expect(call({ toolName: "task", input: null })).toBeUndefined();
	});
});
