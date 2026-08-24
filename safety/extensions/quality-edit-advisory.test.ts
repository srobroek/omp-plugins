import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import qualityEditAdvisory, {
	changedLineCount,
	editedFiles,
	languageEnabled,
	languageForFile,
	parseSelection,
	precommitCovered,
	resetQualityAdvisoryForTests,
	selectedLanguages,
	stateDir,
} from "./quality-edit-advisory.ts";

const temps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function stash(key: string, value: string | undefined): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

afterEach(() => {
	resetQualityAdvisoryForTests();
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
		delete savedEnv[k];
	}
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Handler = (event: Record<string, unknown>) => unknown;

function fakePi(): { handlers: Record<string, Handler[]>; pi: { zod: unknown; registerTool: () => void; on: (ev: string, h: Handler) => void } } {
	const handlers: Record<string, Handler[]> = {};
	const chain: Record<string, unknown> = {};
	const self = () => chain;
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

function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "qea-"));
	temps.push(dir);
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, "package.json"), "{}\n");
	return dir;
}

describe("language selection", () => {
	test("parseSelection splits commas and spaces", () => {
		expect([...parseSelection("ts, python rust")].sort()).toEqual(["python", "rust", "ts"]);
	});

	test("languageForFile maps extensions and special names", () => {
		expect(languageForFile("a.ts")).toBe("ts");
		expect(languageForFile("a.py")).toBe("python");
		expect(languageForFile("Cargo.toml")).toBe("rust");
		expect(languageForFile("go.mod")).toBe("go");
		expect(languageForFile("README.md")).toBeUndefined();
	});

	test("languageEnabled treats all / ts aliases", () => {
		expect(languageEnabled("go", new Set(["all"]))).toBe(true);
		expect(languageEnabled("ts", new Set(["typescript"]))).toBe(true);
		expect(languageEnabled("ts", new Set(["javascript"]))).toBe(true);
		expect(languageEnabled("python", new Set(["ts"]))).toBe(false);
	});

	test("selectedLanguages uses override then markers", () => {
		stash("AGENTIC_QUALITY_LANGS", "rust");
		expect([...selectedLanguages("/unused")]).toEqual(["rust"]);
		stash("AGENTIC_QUALITY_LANGS", undefined);
		const dir = tempRepo();
		expect(selectedLanguages(dir).has("ts")).toBe(true);
	});

	test("precommitCovered reads checker names", () => {
		const dir = tempRepo();
		expect(precommitCovered(dir).size).toBe(0);
		writeFileSync(join(dir, ".pre-commit-config.yaml"), "repos:\n  - hooks: [ruff, biome]\n");
		const covered = precommitCovered(dir);
		expect(covered.has("python")).toBe(true);
		expect(covered.has("ts")).toBe(true);
	});
});

describe("counters / hash state", () => {
	test("editedFiles and changedLineCount", () => {
		expect(editedFiles({ file_path: "a.ts" })).toEqual(["a.ts"]);
		expect(editedFiles({ paths: ["a.ts", "b.ts"] })).toEqual(["a.ts", "b.ts"]);
		expect(changedLineCount({ new_string: "a\nb\nc" })).toBe(3);
		expect(changedLineCount({})).toBe(1);
	});

	test("stateDir is under TMPDIR and hashed by root", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qea-state-"));
		temps.push(tmp);
		stash("TMPDIR", tmp);
		const a = stateDir("/repo/a");
		const b = stateDir("/repo/b");
		expect(a.startsWith(tmp)).toBe(true);
		expect(a).not.toBe(b);
		expect(a).toContain("agentic-quality-advisory-");
	});
});

describe("quality-edit-advisory integration", () => {
	test("accumulates edits then prepends reminder and throttles", () => {
		const repo = tempRepo();
		const tmp = mkdtempSync(join(tmpdir(), "qea-int-"));
		temps.push(tmp);
		stash("TMPDIR", tmp);
		stash("AGENTIC_QUALITY_LANGS", "ts");
		stash("AGENTIC_QUALITY_ADVISORY_LINES", "3");
		stash("AGENTIC_QUALITY_ADVISORY_FILES", "99");
		stash("AGENTIC_QUALITY_ADVISORY_COOLDOWN_SECONDS", "300");

		const cwd = process.cwd();
		process.chdir(repo);
		try {
			const { handlers, pi } = fakePi();
			qualityEditAdvisory(pi as never);

			const fire = (id: string, path: string, content: string) => {
				handlers.tool_call?.[0]?.({
					toolName: "edit",
					toolCallId: id,
					input: { path, new_string: content, cwd: repo },
				});
				return handlers.tool_result?.[0]?.({
					toolName: "edit",
					toolCallId: id,
					content: [{ type: "text", text: "ok" }],
				}) as { content: Array<{ text: string }> } | undefined;
			};

			expect(fire("1", "a.ts", "x")).toBeUndefined();
			const advised = fire("2", "b.ts", "1\n2\n3");
			expect(advised?.content[0]?.text).toContain("QUALITY ADVISORY");
			expect(advised?.content[0]?.text).toContain("biome check");
			expect(advised?.content[0]?.text).toContain("<system-reminder>");

			const throttled = fire("3", "c.ts", "1\n2\n3\n4");
			expect(throttled).toBeUndefined();
		} finally {
			process.chdir(cwd);
		}
	});
});
