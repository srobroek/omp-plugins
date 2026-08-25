import { afterEach, describe, expect, test } from "bun:test";

import bdInitAdvisory, {
	decideBdInit,
	findInitInvocations,
	initAdvisory,
	missingInitFlags,
	resetInitAdvisoryForTests,
} from "./bd-init-advisory.ts";

afterEach(() => {
	resetInitAdvisoryForTests();
});

describe("findInitInvocations", () => {
	test("plain init", () => {
		expect(findInitInvocations("bd init")).toEqual([{ flags: [] }]);
	});

	test("flags are collected, `--flag=value` reduced to the name", () => {
		expect(findInitInvocations("bd init --init-if-missing --skip-hooks --server")).toEqual([
			{ flags: ["--init-if-missing", "--skip-hooks", "--server"] },
		]);
		expect(findInitInvocations("bd init --prefix=bdp")).toEqual([{ flags: ["--prefix"] }]);
	});

	test("a pre-verb value flag does not swallow the verb", () => {
		expect(findInitInvocations("bd -C /tmp/repo init --skip-hooks")).toEqual([
			{ flags: ["-C", "--skip-hooks"] },
		]);
		expect(findInitInvocations("bd --db /tmp/x.db init")).toEqual([{ flags: ["--db"] }]);
		expect(findInitInvocations("bd --db=/tmp/x.db init")).toEqual([{ flags: ["--db"] }]);
	});

	test("command position: after a separator, after a newline, behind env or sudo", () => {
		expect(findInitInvocations("bd where && bd init --server")).toEqual([
			{ flags: ["--server"] },
		]);
		expect(findInitInvocations("cd /repo\nbd init")).toEqual([{ flags: [] }]);
		expect(findInitInvocations("BEADS_ACTOR=omp/main/s1 bd init")).toEqual([{ flags: [] }]);
		expect(findInitInvocations("sudo bd init")).toEqual([{ flags: [] }]);
		expect(findInitInvocations("bd init; bd init --server")).toEqual([
			{ flags: [] },
			{ flags: ["--server"] },
		]);
	});

	// The live incident class: every one of these blocked a bash call under
	// `beads-init-skip-hooks`, which matched the substring `bd init`.
	test("a mention is not an invocation", () => {
		for (const command of [
			"echo how to bd init a repo",
			"rg 'bd init' beads/",
			"git log --grep='bd init'",
			"man bd init",
			"cat docs/beads.md | rg 'bd init'",
			"bd create --title 'bd init notes' -t task",
			"echo bd init --server > /tmp/notes",
		]) {
			expect(findInitInvocations(command)).toEqual([]);
		}
	});

	test("a different verb is a different command", () => {
		for (const command of ["bd init-db", "bd help init", "bd where", "bd hooks list"]) {
			expect(findInitInvocations(command)).toEqual([]);
		}
	});
});

describe("missingInitFlags", () => {
	test("both flags missing", () => {
		expect(missingInitFlags([])).toEqual({ server: true, skipHooks: true });
		expect(missingInitFlags(["--init-if-missing"])).toEqual({ server: true, skipHooks: true });
	});

	test("one flag present names only the other", () => {
		expect(missingInitFlags(["--server"])).toEqual({ server: false, skipHooks: true });
		expect(missingInitFlags(["--shared-server"])).toEqual({ server: false, skipHooks: true });
		expect(missingInitFlags(["--skip-hooks"])).toEqual({ server: true, skipHooks: false });
	});

	test("the correct form says nothing — the two retired rules each blocked it", () => {
		expect(missingInitFlags(["--server", "--skip-hooks"])).toBeUndefined();
		expect(
			missingInitFlags(["--init-if-missing", "--skip-hooks", "--shared-server"]),
		).toBeUndefined();
	});

	test("--help initialises nothing", () => {
		expect(missingInitFlags(["--help"])).toBeUndefined();
		expect(missingInitFlags(["-h"])).toBeUndefined();
	});
});

describe("initAdvisory", () => {
	test("names both flags and both reasons when both are missing", () => {
		const text = initAdvisory({ server: true, skipHooks: true });
		expect(text).toContain("--server");
		expect(text).toContain("--shared-server");
		expect(text).toContain("--skip-hooks");
		expect(text).toContain("core.hooksPath");
		expect(text).toContain("embeddeddolt");
		expect(text).toContain("both flags");
		expect(text).toContain("rule://beads-setup");
	});

	test("a partial invocation is not lectured about what it already did", () => {
		const server = initAdvisory({ server: true, skipHooks: false });
		expect(server).toContain("embeddeddolt");
		expect(server).not.toContain("core.hooksPath");

		const hooks = initAdvisory({ server: false, skipHooks: true });
		expect(hooks).toContain("core.hooksPath");
		expect(hooks).not.toContain("embeddeddolt");
	});
});

describe("decideBdInit", () => {
	test("advises a real init that omits a flag", () => {
		expect(decideBdInit("bd init")).toContain("bd init advisory");
		expect(decideBdInit("bd init --skip-hooks")).toContain("embeddeddolt");
		expect(decideBdInit("bd -C /tmp/repo init --server")).toContain("core.hooksPath");
	});

	test("silent on the correct form, on --help, and on every mention", () => {
		for (const command of [
			"bd init --init-if-missing --skip-hooks --server",
			"bd init --skip-hooks --shared-server",
			"bd init --help",
			"echo how to bd init a repo",
			"rg 'bd init' beads/",
			"git log --grep='bd init'",
			"man bd init",
			"bd init-db",
			"bd help init",
			"git status",
			"bd ready --json",
		]) {
			expect(decideBdInit(command)).toBeUndefined();
		}
	});

	test("the first advisable invocation in a chain wins", () => {
		expect(decideBdInit("bd init --server --skip-hooks && bd init")).toContain("both flags");
	});
});

describe("integration", () => {
	type Sent = { payload: Record<string, unknown>; options?: Record<string, unknown> };

	function register(): {
		handlers: Array<(e: unknown) => unknown>;
		sent: Sent[];
	} {
		const sent: Sent[] = [];
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			sendMessage: (payload: Record<string, unknown>, options?: Record<string, unknown>) => {
				sent.push({ payload, options });
			},
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		bdInitAdvisory(fakePi as never);
		return { handlers: handlers.tool_call as Array<(e: unknown) => unknown>, sent };
	}

	test("one advisory, displayed, non-blocking, and never a second time", () => {
		const { handlers, sent } = register();
		const [handler] = handlers;

		expect(
			handler?.({ toolName: "bash", toolCallId: "c1", input: { command: "bd init" } }),
		).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.payload).toEqual(
			expect.objectContaining({
				customType: "com.srobroek.beads.init-advisory",
				display: true,
				attribution: "user",
			}),
		);
		expect(sent[0]?.options).toEqual({ triggerTurn: false });

		expect(
			handler?.({ toolName: "bash", toolCallId: "c2", input: { command: "bd init" } }),
		).toBeUndefined();
		expect(sent).toHaveLength(1);
	});

	test("the guard is process-global, so a second instance stays quiet", () => {
		const first = register();
		first.handlers[0]?.({ toolName: "bash", toolCallId: "c1", input: { command: "bd init" } });
		expect(first.sent).toHaveLength(1);

		const second = register();
		second.handlers[0]?.({ toolName: "bash", toolCallId: "c2", input: { command: "bd init" } });
		expect(second.sent).toEqual([]);
	});

	test("mentions, other tools, and empty input send nothing", () => {
		const { handlers, sent } = register();
		const [handler] = handlers;

		handler?.({ toolName: "bash", toolCallId: "c1", input: { command: "echo bd init" } });
		handler?.({ toolName: "edit", toolCallId: "c2", input: { command: "bd init" } });
		handler?.({ toolName: "bash", toolCallId: "c3", input: {} });
		expect(sent).toEqual([]);
	});

	test("a throwing sendMessage does not take the bash call down", () => {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			sendMessage: () => {
				throw new Error("send failed");
			},
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		bdInitAdvisory(fakePi as never);
		const [handler] = handlers.tool_call as Array<(e: unknown) => unknown>;
		expect(
			handler?.({ toolName: "bash", toolCallId: "c1", input: { command: "bd init" } }),
		).toBeUndefined();
	});
});
