import { describe, expect, test, beforeEach } from "bun:test";

import tasksGuard, {
	beadsActive,
	commandMentionsTasksMd,
	decideToolCall,
	DENY_REASON,
	isTasksMd,
	setBeadsActiveForTests,
	writesTasksMd,
} from "./tasks-guard.ts";

const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

describe("isTasksMd", () => {
	test("matches relative and absolute specs/*/tasks.md", () => {
		expect(isTasksMd("specs/001-foo/tasks.md")).toBe(true);
		expect(isTasksMd("/repo/specs/001-foo/tasks.md")).toBe(true);
		expect(isTasksMd("specs/readme.md")).toBe(false);
		expect(isTasksMd("docs/tasks.md")).toBe(false);
	});
});

describe("writesTasksMd", () => {
	test("detects redirect and writers", () => {
		expect(writesTasksMd("echo x > specs/001/tasks.md")).toBe(true);
		expect(writesTasksMd("tee specs/001/tasks.md")).toBe(true);
		expect(writesTasksMd("cat specs/001/tasks.md")).toBe(false);
		expect(writesTasksMd("rg foo specs/001/tasks.md")).toBe(false);
	});
});

describe("commandMentionsTasksMd", () => {
	test("requires specs/ then /tasks.md", () => {
		expect(commandMentionsTasksMd("cat specs/001/tasks.md")).toBe(true);
		expect(commandMentionsTasksMd("echo tasks.md")).toBe(false);
	});
});

describe("decideToolCall", () => {
	beforeEach(() => setBeadsActiveForTests(null));

	test("blocks write to tasks.md when beads active", () => {
		setBeadsActiveForTests(true);
		const d = decideToolCall("write", { path: "specs/001-x/tasks.md" }, "/tmp");
		expect(d?.block).toBe(true);
		expect(d?.reason).toBe(DENY_REASON);
	});

	test("allows write when beads inactive", () => {
		setBeadsActiveForTests(false);
		expect(decideToolCall("write", { path: "specs/001-x/tasks.md" }, "/tmp")).toBeUndefined();
	});

	test("allows other files", () => {
		setBeadsActiveForTests(true);
		expect(decideToolCall("edit", { path: "specs/001-x/spec.md" }, "/tmp")).toBeUndefined();
	});

	test("blocks bash write, allows bash read", () => {
		setBeadsActiveForTests(true);
		expect(decideToolCall("bash", { command: "echo x > specs/001/tasks.md" }, "/tmp")?.block).toBe(
			true,
		);
		expect(decideToolCall("bash", { command: "cat specs/001/tasks.md" }, "/tmp")).toBeUndefined();
	});

	test("fail-open when beads probe unset and bd missing is handled by beadsActive", () => {
		setBeadsActiveForTests(false);
		expect(beadsActive("/no/such")).toBe(false);
	});
});

describe("register", () => {
	test("registers tool_call handler and blocks", () => {
		setBeadsActiveForTests(true);
		const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
		const fakePi = {
			zod: z,
			registerTool: () => {},
			on: (ev: string, fn: (e: Record<string, unknown>) => unknown) => {
				(handlers[ev] ??= []).push(fn);
			},
		};
		tasksGuard(fakePi as never);
		const out = handlers.tool_call?.[0]?.({
			toolName: "write",
			toolCallId: "1",
			input: { path: "specs/002/tasks.md", cwd: "/tmp" },
		});
		expect(out).toEqual({ block: true, reason: DENY_REASON });
	});

	test("handler swallows throws", () => {
		setBeadsActiveForTests(true);
		const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
		const fakePi = {
			zod: z,
			registerTool: () => {},
			on: (ev: string, fn: (e: Record<string, unknown>) => unknown) => {
				(handlers[ev] ??= []).push(fn);
			},
		};
		tasksGuard(fakePi as never);
		expect(
			handlers.tool_call?.[0]?.({
				toolName: "write",
				input: null,
			}),
		).toBeUndefined();
	});
});
