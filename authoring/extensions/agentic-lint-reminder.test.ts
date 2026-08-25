import { afterEach, describe, expect, test } from "bun:test";

import agenticLintReminder, {
	assetKind,
	formatReminder,
	pendingAssets,
	resetLintReminderForTests,
	writtenPaths,
} from "./agentic-lint-reminder.ts";

afterEach(() => {
	resetLintReminderForTests();
});

const CWD = "/repo";

type Handler = (event: Record<string, unknown>, ctx: { cwd?: string }) => unknown;

function fakePi(): { handlers: Record<string, Handler[]>; pi: unknown } {
	const handlers: Record<string, Handler[]> = {};
	return {
		handlers,
		pi: {
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: Handler) => {
				(handlers[event] ??= []).push(handler);
			},
		},
	};
}

describe("assetKind", () => {
	test("recognises the three install shapes", () => {
		expect(assetKind("/repo/authoring/skills/write-agentic/SKILL.md")).toBe("skill");
		expect(assetKind("/repo/authoring/rules/authoring-repomix-include.md")).toBe("rule");
		expect(assetKind("/repo/build/agents/builder.md")).toBe("agent");
	});

	test("rejects non-assets", () => {
		expect(assetKind("/repo/authoring/README.md")).toBeNull();
		expect(assetKind("/repo/authoring/skills/write-agentic/references/template-skill.md")).toBeNull();
		expect(assetKind("/repo/authoring/rules/notes.txt")).toBeNull();
		expect(assetKind("/repo/skills/SKILL.md")).toBeNull();
	});

	test("rejects copies the agent did not author", () => {
		expect(assetKind("/repo/node_modules/x/rules/a.md")).toBeNull();
		expect(assetKind("/home/u/.omp/agent/managed-skills/x/skills/y/SKILL.md")).toBeNull();
		expect(assetKind("/home/u/.omp/agent/cache/rules/a.md")).toBeNull();
	});

	test("prototype keys are not excluded segments", () => {
		expect(assetKind("/repo/constructor/rules/a.md")).toBe("rule");
	});
});

describe("writtenPaths", () => {
	test("write takes its target from the input", () => {
		expect(writtenPaths({ toolName: "write", input: { path: "authoring/rules/a.md" } }, CWD)).toEqual([
			"/repo/authoring/rules/a.md",
		]);
	});

	test("write ignores internal URIs", () => {
		expect(writtenPaths({ toolName: "write", input: { path: "xd://ast_edit" } }, CWD)).toEqual([]);
	});

	test("failed calls leave nothing on disk", () => {
		const event = { toolName: "write", isError: true, input: { path: "authoring/rules/a.md" } };
		expect(writtenPaths(event, CWD)).toEqual([]);
	});

	test("edit reads single-file and per-file details", () => {
		expect(writtenPaths({ toolName: "edit", details: { path: "/repo/rules/a.md" } }, CWD)).toEqual([
			"/repo/rules/a.md",
		]);
		const multi = {
			toolName: "edit",
			details: {
				perFileResults: [
					{ path: "/repo/rules/a.md" },
					{ path: "/repo/rules/b.md", isError: true },
					{ path: "/repo/rules/c.md", op: "delete" },
				],
			},
		};
		expect(writtenPaths(multi, CWD)).toEqual(["/repo/rules/a.md"]);
	});

	test("edit reports the post-move path, not the vanished source", () => {
		const event = {
			toolName: "edit",
			details: { sourcePath: "/repo/rules/old.md", path: "/repo/rules/old.md", move: "/repo/rules/new.md" },
		};
		expect(writtenPaths(event, CWD)).toEqual(["/repo/rules/new.md"]);
	});

	test("ast_edit counts only an applied proposal", () => {
		const staged = { toolName: "ast_edit", details: { applied: false, files: ["rules/a.md"] } };
		expect(writtenPaths(staged, CWD)).toEqual([]);
		const applied = { toolName: "ast_edit", details: { applied: true, files: ["rules/a.md"], cwd: "/other" } };
		expect(writtenPaths(applied, CWD)).toEqual(["/other/rules/a.md"]);
		const replacements = {
			toolName: "ast_edit",
			details: { applied: true, fileReplacements: [{ path: "rules/b.md", count: 2 }] },
		};
		expect(writtenPaths(replacements, CWD)).toEqual(["/repo/rules/b.md"]);
	});

	test("unrelated tools contribute nothing", () => {
		expect(writtenPaths({ toolName: "bash", input: { command: "ls rules/a.md" } }, CWD)).toEqual([]);
	});
});

describe("pendingAssets", () => {
	test("names a file once per session", () => {
		const seen = new Set<string>();
		expect(pendingAssets(["/repo/rules/a.md", "/repo/README.md"], seen)).toEqual(["/repo/rules/a.md"]);
		expect(pendingAssets(["/repo/rules/a.md"], seen)).toEqual([]);
	});
});

describe("formatReminder", () => {
	test("relative paths, capped list", () => {
		const text = formatReminder(["/repo/rules/a.md", "/elsewhere/rules/b.md"], CWD);
		expect(text).toContain("rules/a.md");
		expect(text).toContain("/elsewhere/rules/b.md");
		expect(text).toContain("agentic_lint");

		const many = ["a", "b", "c", "d", "e", "f"].map((n) => `/repo/rules/${n}.md`);
		expect(formatReminder(many, CWD)).toContain("(+2 more)");
	});
});

describe("integration", () => {
	test("prepends one reminder to the write that authored a rule", () => {
		const { handlers, pi } = fakePi();
		agenticLintReminder(pi as never);
		const handler = handlers.tool_result![0]!;

		const first = handler(
			{
				toolName: "write",
				toolCallId: "t1",
				input: { path: "authoring/rules/authoring-repomix-include.md" },
				content: [{ type: "text", text: "wrote 900 bytes" }],
			},
			{ cwd: CWD },
		) as { content: Array<{ text: string }> };
		expect(first.content[0]!.text).toContain("agentic_lint");
		expect(first.content[1]!.text).toBe("wrote 900 bytes");

		const second = handler(
			{
				toolName: "write",
				toolCallId: "t2",
				input: { path: "authoring/rules/authoring-repomix-include.md" },
				content: [{ type: "text", text: "wrote 950 bytes" }],
			},
			{ cwd: CWD },
		);
		expect(second).toBeUndefined();
	});

	test("stays silent on a non-asset write and survives a malformed event", () => {
		const { handlers, pi } = fakePi();
		agenticLintReminder(pi as never);
		const handler = handlers.tool_result![0]!;

		expect(handler({ toolName: "write", input: { path: "README.md" } }, { cwd: CWD })).toBeUndefined();
		expect(handler({ toolName: "write", input: { path: 7 } }, {})).toBeUndefined();
		expect(handler({}, { cwd: CWD })).toBeUndefined();
	});

	test("session_start clears the per-file latch", () => {
		const { handlers, pi } = fakePi();
		agenticLintReminder(pi as never);
		const event = {
			toolName: "write",
			toolCallId: "t3",
			input: { path: "authoring/rules/a.md" },
			content: [{ type: "text", text: "ok" }],
		};
		expect(handlers.tool_result![0]!(event, { cwd: CWD })).toBeDefined();
		expect(handlers.tool_result![0]!(event, { cwd: CWD })).toBeUndefined();
		handlers.session_start![0]!({}, {});
		expect(handlers.tool_result![0]!(event, { cwd: CWD })).toBeDefined();
	});
});
