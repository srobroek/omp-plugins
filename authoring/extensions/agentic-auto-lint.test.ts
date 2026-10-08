import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import agenticAutoLint, { assetKind, formatReports, pendingReports, writtenPaths } from "./agentic-auto-lint.ts";

const CWD = "/repo";

const temps: string[] = [];

afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentic-auto-lint-"));
	temps.push(dir);
	return dir;
}

function put(root: string, rel: string, content: string): string {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
	return path;
}

/** A rule with no description, alwaysApply, or trigger: lint reports E14. */
const BROKEN_RULE = "---\nname: a\n---\nBody\n";
const CLEAN_RULE = "---\ndescription: A valid discoverable rule\n---\nBody\n";
/** A skill whose description lacks a trigger phrase: lint reports W11 only. */
const WARN_ONLY_SKILL = "---\nname: s\ndescription: Formats markdown tables into aligned columns.\n---\nBody\n";

type Handler = (event: Record<string, unknown>, ctx: { cwd?: string }) => unknown;

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`Missing ${label}`);
	}
	return value;
}

function requiredHandler(handlers: Record<string, Handler[]>, event: string): Handler {
	return required(handlers[event]?.[0], `${event} handler`);
}

function fakePi(): { handlers: Record<string, Handler[]>; pi: unknown } {
	const handlers: Record<string, Handler[]> = {};
	return {
		handlers,
		pi: {
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: Handler) => {
				const eventHandlers = handlers[event] ?? [];
				eventHandlers.push(handler);
				handlers[event] = eventHandlers;
			},
		},
	};
}

function boundSession(): { onResult: Handler; onStart: Handler } {
	const { handlers, pi } = fakePi();
	agenticAutoLint(pi as never);
	return { onResult: requiredHandler(handlers, "tool_result"), onStart: requiredHandler(handlers, "session_start") };
}

function writeEvent(path: string): Record<string, unknown> {
	return { toolName: "write", input: { path }, content: [{ type: "text", text: "wrote" }] };
}

describe("assetKind", () => {
	test("recognises the three install shapes", () => {
		expect(assetKind("/repo/authoring/skills/write-agentic/SKILL.md")).toBe("skill");
		expect(assetKind("/repo/authoring/rules/authoring-extension-ctx-timers.md")).toBe("rule");
		expect(assetKind("/repo/build/agents/external-repo-worker.md")).toBe("agent");
	});

	test("AGENTS.md and RULES.md count as steering", () => {
		expect(assetKind("/repo/AGENTS.md")).toBe("steering");
		expect(assetKind("/repo/.omp/AGENTS.md")).toBe("steering");
		expect(assetKind("/home/u/.omp/agent/RULES.md")).toBe("steering");
		expect(assetKind("/repo/.omp/RULES.md")).toBe("steering");
	});

	test("docs/rules is documentation, not a rule directory", () => {
		expect(assetKind("/repo/docs/rules/no-console.md")).toBeNull();
		expect(assetKind("/repo/.omp/rules/no-console.md")).toBe("rule");
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
		const cached = join(homedir(), ".omp/plugins/cache/plugins/srobroek-omp___authoring___2.1.1/rules/a.md");
		expect(assetKind(cached)).toBeNull();
		expect(assetKind(join(homedir(), ".omp/plugins/cache/marketplaces/m/x/AGENTS.md"))).toBeNull();
	});

	test("a cache directory outside the OMP plugin cache is source", () => {
		expect(assetKind("/repo/src/cache/rules/local.md")).toBe("rule");
		expect(assetKind("/repo/cache/skills/x/SKILL.md")).toBe("skill");
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

	test("ast_edit includes every applied result target", () => {
		const event = {
			toolName: "ast_edit",
			details: {
				applied: true,
				files: ["rules/a.md"],
				fileReplacements: [{ path: "rules/b.md", count: 1 }],
			},
		};
		expect(writtenPaths(event, CWD)).toEqual(["/repo/rules/a.md", "/repo/rules/b.md"]);
	});

	test("unrelated tools contribute nothing", () => {
		expect(writtenPaths({ toolName: "bash", input: { command: "ls rules/a.md" } }, CWD)).toEqual([]);
	});
});

describe("pendingReports", () => {
	test("reports only ERROR findings, and nothing for a clean or WARN-only asset", () => {
		const root = tmpRoot();
		const broken = put(root, "p/rules/broken.md", BROKEN_RULE);
		const clean = put(root, "p/rules/clean.md", CLEAN_RULE);
		const warnOnly = put(root, "p/skills/s/SKILL.md", WARN_ONLY_SKILL);
		const reports = pendingReports([broken, clean, warnOnly], new Map());
		expect(reports.map((report) => report.path)).toEqual([broken]);
		expect(required(reports[0], "broken report").errors).toEqual([
			"E14: rule has no description, alwaysApply, or TTSR trigger; it is not discoverable",
		]);
	});

	test("lints AGENTS.md as steering", () => {
		const root = tmpRoot();
		const agents = put(root, "AGENTS.md", "Route reviews to opus.\n");
		const [report] = pendingReports([agents], new Map());
		expect(required(report, "AGENTS.md report").errors[0]).toStartWith("E3: line 1: model name 'opus'");
	});

	test("skips docs/rules and unreadable paths", () => {
		const root = tmpRoot();
		const documented = put(root, "docs/rules/broken.md", BROKEN_RULE);
		expect(pendingReports([documented, join(root, "p/rules/missing.md")], new Map())).toEqual([]);
	});

	test("repeats a report only when the errors change or return", () => {
		const root = tmpRoot();
		const path = put(root, "p/rules/a.md", BROKEN_RULE);
		const reported = new Map<string, string>();
		expect(pendingReports([path], reported)).toHaveLength(1);
		expect(pendingReports([path], reported)).toEqual([]);
		put(root, "p/rules/a.md", CLEAN_RULE);
		expect(pendingReports([path], reported)).toEqual([]);
		put(root, "p/rules/a.md", BROKEN_RULE);
		expect(pendingReports([path], reported)).toHaveLength(1);
	});
});

describe("formatReports", () => {
	test("relative paths, one ERROR line per finding", () => {
		const text = formatReports(
			[
				{ path: "/repo/rules/a.md", errors: ["E14: x"] },
				{ path: "/elsewhere/rules/b.md", errors: ["E3: y", "E8: z"] },
			],
			CWD,
		);
		expect(text).toContain("rules/a.md:\n  ERROR E14: x");
		expect(text).toContain("/elsewhere/rules/b.md:\n  ERROR E3: y\n  ERROR E8: z");
	});
});

describe("integration", () => {
	test("prepends the errors to the write that authored a broken rule", () => {
		const root = tmpRoot();
		const path = put(root, "p/rules/a.md", BROKEN_RULE);
		const { onResult } = boundSession();
		const result = onResult(writeEvent(path), { cwd: root }) as { content: Array<{ text: string }> };
		expect(required(result.content[0], "lint report").text).toContain("p/rules/a.md:\n  ERROR E14:");
		expect(required(result.content[1], "original result").text).toBe("wrote");
		expect(onResult(writeEvent(path), { cwd: root })).toBeUndefined();
	});

	test("stays silent on a clean asset, a non-asset, and a malformed event", () => {
		const root = tmpRoot();
		const clean = put(root, "p/rules/clean.md", CLEAN_RULE);
		const { onResult } = boundSession();
		expect(onResult(writeEvent(clean), { cwd: root })).toBeUndefined();
		expect(onResult({ toolName: "write", input: { path: "README.md" } }, { cwd: CWD })).toBeUndefined();
		expect(onResult({ toolName: "write", input: { path: 7 } }, {})).toBeUndefined();
		expect(onResult({}, { cwd: CWD })).toBeUndefined();
	});

	test("each factory binding keeps its own state", () => {
		const root = tmpRoot();
		const path = put(root, "p/rules/a.md", BROKEN_RULE);
		const parent = boundSession();
		const child = boundSession();
		expect(parent.onResult(writeEvent(path), { cwd: root })).toBeDefined();
		// A sibling reports the same file on its own; the parent's report does not suppress it.
		expect(child.onResult(writeEvent(path), { cwd: root })).toBeDefined();
		// A child's session_start clears only the child.
		child.onStart({}, {});
		expect(parent.onResult(writeEvent(path), { cwd: root })).toBeUndefined();
		expect(child.onResult(writeEvent(path), { cwd: root })).toBeDefined();
	});
});
