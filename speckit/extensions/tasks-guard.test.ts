import { beforeEach, describe, expect, test } from "bun:test";

import tasksGuard, {
	beadsActive,
	commandMentionsTasksMd,
	DENY_REASON,
	decideToolCall,
	isTasksMd,
	setBdWhereSpawnForTests,
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

	test("treats only cp's destination as a write", () => {
		expect(writesTasksMd("cp specs/001-a/tasks.md /tmp/legacy.md")).toBe(false);
		expect(writesTasksMd("cp /tmp/x specs/001-a/tasks.md")).toBe(true);
		expect(writesTasksMd("cp /tmp/x /repo/specs/001-a/tasks.md && echo ok")).toBe(true);
		expect(writesTasksMd('cp /tmp/x "specs/001-a/tasks.md"')).toBe(true);
		expect(writesTasksMd("cp /tmp/x specs/001-a/tasks.md 2>/dev/null")).toBe(true);
		expect(writesTasksMd("cp specs/001-a/tasks.md specs/002-b/tasks.md")).toBe(true);
		expect(writesTasksMd("cp -t specs/001-a /tmp/tasks.md")).toBe(true);
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

	test("blocks hashline headers, MV destinations, rename destinations and ast_edit paths", () => {
		setBeadsActiveForTests(true);
		const header = { input: "[/repo/specs/001-x/tasks.md#AB12]\nPUT 1.=1:\n+- [ ] T001\n" };
		const move = { input: "[src/notes.md#AB12]\nMV specs/001-x/tasks.md\n" };
		const rename = { path: "src/notes.md", edits: [{ rename: "specs/001-x/tasks.md" }] };
		const ast = { ops: [{ pat: "a", out: "b" }], paths: ["specs/001-x/tasks.md"] };
		expect(decideToolCall("edit", header, "/tmp")?.block).toBe(true);
		expect(decideToolCall("edit", move, "/tmp")?.block).toBe(true);
		expect(decideToolCall("edit", rename, "/tmp")?.block).toBe(true);
		expect(decideToolCall("ast_edit", ast, "/tmp")?.block).toBe(true);
	});

	test("allows a hashline body row that quotes a tasks.md header", () => {
		setBeadsActiveForTests(true);
		const quoted = { input: "[src/notes.md#AB12]\nPUT >1:\n+[specs/001-x/tasks.md#AB12]\n+MV specs/001-x/tasks.md\n" };
		expect(decideToolCall("edit", quoted, "/tmp")).toBeUndefined();
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
  type Handler = (event: Record<string, unknown>, ctx?: { cwd: string }) => unknown;
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

	test("probes Beads in the session cwd when the input names none", () => {
		setBeadsActiveForTests(null);
		const probes: string[][] = [];
		setBdWhereSpawnForTests((args) => {
			probes.push(args);
			return 0;
		});
		const handlers: HandlerMap = {};
		const fakePi = {
			zod, registerTool: () => {},
			on: (ev: string, fn: Handler) => {
				handlers[ev] = [...(handlers[ev] ?? []), fn];
			},
		};
		try {
			tasksGuard(fakePi as never);
			const handler = handlerAt(handlers, "tool_call");
			expect(handler({ toolName: "write", input: { path: "specs/002/tasks.md" } }, { cwd: "/session/worktree" })).toEqual({ block: true, reason: DENY_REASON });
			handler({ toolName: "bash", input: { command: "echo x > specs/002/tasks.md", cwd: "/bash/cwd" } }, { cwd: "/session/worktree" });
			expect(probes).toEqual([["-C", "/session/worktree", "where"], ["-C", "/bash/cwd", "where"]]);
		} finally {
			setBdWhereSpawnForTests(null);
		}
	});
});
