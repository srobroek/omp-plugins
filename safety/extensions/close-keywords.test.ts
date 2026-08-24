import { describe, expect, test } from "bun:test";
import closeKeywords, {
	extractBody,
	normalize,
	replaceLastBody,
	shellSegments,
} from "./close-keywords.ts";

type Handler = (event: Record<string, unknown>) => unknown;

function fakePi(): { handlers: Record<string, Handler[]>; pi: { zod: unknown; registerTool: () => void; on: (ev: string, h: Handler) => void } } {
	const handlers: Record<string, Handler[]> = {};
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	chain.string = self;
	return {
		handlers,
		pi: {
			zod: chain,
			registerTool: () => {},
			on: (ev, h) => {
				(handlers[ev] ??= []).push(h);
			},
		},
	};
}

describe("normalize close-keyword lists", () => {
	test("expands comma issue lists after a keyword", () => {
		expect(normalize("Fixes #1, #2, and #3")).toBe("Fixes #1, fixes #2, and fixes #3");
	});

	test("handles owner/repo refs and GH- ids", () => {
		expect(normalize("Closes org/repo#4, GH-5")).toBe("Closes org/repo#4, closes GH-5");
	});

	test("leaves non-keyword text alone", () => {
		expect(normalize("See #1, #2")).toBe("See #1, #2");
	});

	test("is line-scoped", () => {
		expect(normalize("Fixes #1, #2\nNotes: keep")).toBe("Fixes #1, fixes #2\nNotes: keep");
	});
});

describe("extractBody / replaceLastBody / shellSegments", () => {
	test("extracts --body and -b forms", () => {
		expect(extractBody("gh pr create --body 'Fixes #1, #2'")).toBe("Fixes #1, #2");
		expect(extractBody("gh pr edit --body=Fixes\\ #1")).toBe("Fixes #1");
		expect(extractBody("FOO=1 gh pr create -b 'x'")).toBe("x");
	});

	test("replaceLastBody rewrites last --body value", () => {
		const next = replaceLastBody("gh pr create --title t --body 'old'", "new");
		expect(next).toBe("gh pr create --title t --body 'new'");
	});

	test("shellSegments splits operators", () => {
		expect(shellSegments("echo a && gh pr create --body x")).toEqual([
			["echo", "a"],
			["gh", "pr", "create", "--body", "x"],
		]);
	});
});

describe("close-keywords integration", () => {
	test("rewrites matching gh pr create --body", () => {
		const { handlers, pi } = fakePi();
		closeKeywords(pi as never);
		const out = handlers.tool_call?.[0]?.({
			toolName: "bash",
			toolCallId: "1",
			input: { command: "gh pr create --title t --body 'Fixes #1, #2'" },
		}) as { input: { command: string } } | undefined;
		expect(out?.input.command).toContain("Fixes #1, fixes #2");
	});

	test("rewrites gh pr edit", () => {
		const { handlers, pi } = fakePi();
		closeKeywords(pi as never);
		const out = handlers.tool_call?.[0]?.({
			toolName: "bash",
			toolCallId: "2",
			input: { command: "gh pr edit 12 --body 'Closes #9, #10'" },
		}) as { input: { command: string } } | undefined;
		expect(out?.input.command).toContain("Closes #9, closes #10");
	});

	test("passes through non-matching commands", () => {
		const { handlers, pi } = fakePi();
		closeKeywords(pi as never);
		expect(
			handlers.tool_call?.[0]?.({
				toolName: "bash",
				toolCallId: "3",
				input: { command: "gh issue list" },
			}),
		).toBeUndefined();
		expect(
			handlers.tool_call?.[0]?.({
				toolName: "edit",
				toolCallId: "4",
				input: { path: "x.ts" },
			}),
		).toBeUndefined();
		expect(
			handlers.tool_call?.[0]?.({
				toolName: "bash",
				toolCallId: "5",
				input: { command: "gh pr create --body 'Fixes #1'" },
			}),
		).toBeUndefined();
	});
});
