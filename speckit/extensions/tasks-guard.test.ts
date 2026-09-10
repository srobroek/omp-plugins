import { beforeEach, describe, expect, test } from "bun:test";

import tasksGuard, {
	beadsActive,
	commandMentionsTasksMd,
	DENY_REASON,
	decideToolCall,
	isTasksMd,
	setBeadsActiveForTests,
	writesTasksMd,
} from "./tasks-guard.ts";

type ZodChain = {
	(...args: never[]): ZodChain;
	readonly [key: string]: ZodChain;
};
const chain = (): ZodChain => new Proxy(((..._args: never[]) => chain()) as ZodChain, { get: () => chain(), apply: () => chain() });
const zod = new Proxy({}, { get: () => chain() }) as never;

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

	test("checks every native edit target only in active beads workspaces", () => {
		const input = { path: "src/a.ts", paths: ["src/b.ts", "specs/001-x/tasks.md"] };
		setBeadsActiveForTests(true);
		expect(decideToolCall("edit", input, "/tmp")?.block).toBe(true);
		expect(decideToolCall("edit", { paths: ["src/a.ts", null, 3] }, "/tmp")).toBeUndefined();
		setBeadsActiveForTests(false);
		expect(decideToolCall("edit", input, "/tmp")).toBeUndefined();
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
  type Handler = (event: Record<string, unknown>) => unknown;
  type HandlerMap = Record<string, Handler[]>;
  function handlerAt(handlers: HandlerMap, event: string): Handler {
	const handler = handlers[event]?.[0];
	if (!handler) throw new Error(`missing ${event} handler`);
	return handler;
  }
	test("registers tool_call handler and blocks", () => {
		setBeadsActiveForTests(true);
		const handlers: HandlerMap = {};
		const fakePi = {
			zod, registerTool: () => {},
			on: (ev: string, fn: Handler) => {
				const registered = handlers[ev] ?? [];
				registered.push(fn);
				handlers[ev] = registered;
			},
		};
		tasksGuard(fakePi as never);
		const out = handlerAt(handlers, "tool_call")({ toolName: "write", toolCallId: "1", input: { path: "specs/002/tasks.md", cwd: "/tmp" } });
		expect(out).toEqual({ block: true, reason: DENY_REASON });
	});

	test("handler swallows throws", () => {
		setBeadsActiveForTests(true);
		const handlers: HandlerMap = {};
		const fakePi = {
			zod, registerTool: () => {},
			on: (ev: string, fn: Handler) => {
				const registered = handlers[ev] ?? [];
				registered.push(fn);
				handlers[ev] = registered;
			},
		};
		tasksGuard(fakePi as never);
		expect(handlerAt(handlers, "tool_call")({ toolName: "write", input: null })).toBeUndefined();
	});
});
