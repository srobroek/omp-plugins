import { describe, expect, test } from "bun:test";

import fixtureWriteGate, {
	DENY_REASON,
	decideToolCall,
	isFixturePath,
	targetPaths,
} from "./fixture-write-gate.ts";

const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

function fakePi(): {
	handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>>;
	pi: never;
} {
	const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
	const pi = {
		zod: z,
		registerTool: () => {},
		on: (ev: string, fn: (e: Record<string, unknown>) => unknown) => {
			(handlers[ev] ??= []).push(fn);
		},
	};
	return { handlers, pi: pi as never };
}

describe("isFixturePath", () => {
	test("matches both fixtures at any depth", () => {
		expect(isFixturePath(".project-setup/answers.toml")).toBe(true);
		expect(isFixturePath(".project-setup/sources.toml")).toBe(true);
		expect(isFixturePath("packages/api/.project-setup/answers.toml")).toBe(true);
		expect(isFixturePath("/Users/x/repo/.project-setup/sources.toml")).toBe(true);
		expect(isFixturePath("C:\\repo\\.project-setup\\answers.toml")).toBe(true);
	});

	test("leaves every other toml alone", () => {
		expect(isFixturePath("answers.toml")).toBe(false);
		expect(isFixturePath("pyproject.toml")).toBe(false);
		expect(isFixturePath(".project-setup/answers.toml.bak")).toBe(false);
		expect(isFixturePath(".project-setup/modules.toml")).toBe(false);
		expect(isFixturePath("project-setup/answers.toml")).toBe(false);
		expect(isFixturePath("docs/.project-setup-notes/answers.toml")).toBe(false);
	});
});

describe("targetPaths", () => {
	test("collects path, file_path, and the derived hashline paths array", () => {
		expect(targetPaths({ path: "a.ts" })).toEqual(["a.ts"]);
		expect(targetPaths({ file_path: "b.ts" })).toEqual(["b.ts"]);
		expect(targetPaths({ paths: ["c.ts", "", "d.ts"] })).toEqual(["c.ts", "d.ts"]);
		expect(targetPaths({ path: "a.ts", paths: ["a.ts", "e.ts"] })).toEqual(["a.ts", "a.ts", "e.ts"]);
		expect(targetPaths({})).toEqual([]);
	});
});

describe("decideToolCall", () => {
	test("blocks write and edit of either fixture", () => {
		expect(decideToolCall("write", { path: ".project-setup/answers.toml" })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
		expect(decideToolCall("edit", { path: "sub/.project-setup/sources.toml" })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
	});

	test("blocks a multi-file hashline edit that only carries paths", () => {
		expect(
			decideToolCall("edit", { paths: ["src/lib.ts", ".project-setup/answers.toml"] }),
		).toEqual({ block: true, reason: DENY_REASON });
	});

	test("allows unrelated writes and non-writing tools", () => {
		expect(decideToolCall("write", { path: "pyproject.toml" })).toBeUndefined();
		expect(decideToolCall("edit", { paths: ["src/lib.ts", "uv.lock"] })).toBeUndefined();
		expect(decideToolCall("read", { path: ".project-setup/answers.toml" })).toBeUndefined();
		expect(decideToolCall("grep", { path: ".project-setup/answers.toml" })).toBeUndefined();
		expect(
			decideToolCall("bash", { command: "cat .project-setup/answers.toml" }),
		).toBeUndefined();
	});
});

describe("register", () => {
	test("registers a tool_call handler that blocks", () => {
		const { handlers, pi } = fakePi();
		fixtureWriteGate(pi);
		expect(
			handlers.tool_call?.[0]?.({
				toolName: "write",
				toolCallId: "1",
				input: { path: ".project-setup/answers.toml", content: "x" },
			}),
		).toEqual({ block: true, reason: DENY_REASON });
	});

	test("handler swallows throws", () => {
		const { handlers, pi } = fakePi();
		fixtureWriteGate(pi);
		expect(handlers.tool_call?.[0]?.({ toolName: "write", input: null })).toBeUndefined();
	});
});
