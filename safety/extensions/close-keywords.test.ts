import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import closeKeywords, {
	extractBody,
	normalize,
	replaceLastBody,
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
				const registered = handlers[ev] ?? [];
				registered.push(h);
				handlers[ev] = registered;
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

describe("extractBody / replaceLastBody", () => {
	test("extracts --body and -b forms", () => {
		expect(extractBody("gh pr create --body 'Fixes #1, #2'")).toBe("Fixes #1, #2");
		expect(extractBody("gh pr edit --body=Fixes\\ #1")).toBe("Fixes #1");
		expect(extractBody("FOO=1 gh pr create -b 'x'")).toBe("x");
	});

	test("replaceLastBody rewrites last --body value", () => {
		const next = replaceLastBody("gh pr create --title t --body 'old'", "new");
		expect(next).toBe("gh pr create --title t --body 'new'");
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

test("rewritten literal bodies remain data in a real shell and leave later bodies alone", () => {
	const body = "Fixes #1, #2; it's $(printf INJECTED >&2) `printf BACKTICK >&2`";
	const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
	const command = `gh pr create -b old --body=${quote(body)}; gh issue edit 3 --body 'unrelated'`;
	const { handlers, pi } = fakePi();
	closeKeywords(pi as never);
	const handler = handlers.tool_call?.[0];
	if (!handler) throw new Error("tool_call handler not registered");
	const result = handler({
		toolName: "bash", input: { command },
	}) as { input: { command: string } };
	const run = spawnSync("timeout", ["5s", "bash", "-c",
		`gh() { printf '%s\\0' "$@"; }; ${result.input.command}`], { encoding: "utf8" });
	expect(run.status).toBe(0);
	expect(run.stderr).toBe("");
	expect(run.stdout.split("\0")).toEqual([
		"pr", "create", "-b", "old", `--body=${normalize(body)}`,
		"issue", "edit", "3", "--body", "unrelated", "",
	]);
});

test("body-valued option arguments and shell expansions are not reinterpreted", () => {
	expect(extractBody("gh pr create --body 'Fixes #1, #2' --title '--body'")).toBe("Fixes #1, #2");
	expect(replaceLastBody('gh pr create --body "$BODY"', "other")).toBeNull();
	expect(replaceLastBody("gh pr create --body 'unterminated", "other")).toBeNull();
});
