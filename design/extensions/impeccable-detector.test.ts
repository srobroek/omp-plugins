import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	bindImpeccableDetector,
	findLauncher,
	hookFindings,
	hookPayload,
	hostPluginRoots,
	isDetectorTarget,
	type PluginRoot,
} from "./impeccable-detector.ts";

const temps: string[] = [];

afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "impeccable-detector-"));
	temps.push(dir);
	return dir;
}

function put(root: string, rel: string, content: string): string {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
	return path;
}

/** A fake impeccable plugin whose launcher logs its stdin and runs `body`. */
function fakePlugin(body: string): { root: string; launcher: string; calls: () => Record<string, unknown>[] } {
	const root = tmpRoot();
	const launcher = put(
		root,
		"skills/impeccable/scripts/impeccable",
		`#!/bin/sh\npayload=$(cat)\nprintf '%s\\n' "$payload" >> "$(dirname "$0")/calls.log"\n${body}\n`,
	);
	chmodSync(launcher, 0o755);
	const log = join(dirname(launcher), "calls.log");
	const calls = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	return { root, launcher, calls };
}

const FINDINGS_BODY =
	'printf \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"[impeccable@1] findings quiet=%s"}}\\n\' "$IMPECCABLE_HOOK_QUIET"';

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function bind(roots: readonly PluginRoot[] | Error, timeoutMs = 5_000): Record<string, Handler> {
	const handlers: Record<string, Handler> = {};
	const pi = { on: (event: string, handler: Handler) => (handlers[event] = handler) };
	bindImpeccableDetector(pi as never, {
		listPluginRoots: async () => {
			if (roots instanceof Error) throw roots;
			return roots;
		},
		timeoutMs,
	});
	return handlers;
}

function context(cwd: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		cwd,
		agent: { kind: "main", name: "main" },
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
		setTimeout: () => 1,
		clearTimer: () => undefined,
		...overrides,
	};
}

function writeEvent(path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { toolName: "write", input: { path }, content: [{ type: "text", text: "wrote" }], isError: false, ...extra };
}

type Result = { content: Array<{ text: string }> } | undefined;

describe("isDetectorTarget", () => {
	test("takes impeccable's UI extensions in any case, inside the project", () => {
		const cwd = tmpRoot();
		for (const name of ["a.tsx", "b.HTML", "c.css", "d.vue", "e.ts", "f.js", "g.svelte", "h.astro", "i.less"]) {
			expect(isDetectorTarget(join(cwd, "src", name), cwd)).toBe(true);
		}
	});

	test("rejects other files and files outside the project", () => {
		const cwd = tmpRoot();
		expect(isDetectorTarget(join(cwd, "README.md"), cwd)).toBe(false);
		expect(isDetectorTarget(join(cwd, "app.py"), cwd)).toBe(false);
		expect(isDetectorTarget(join(tmpRoot(), "page.html"), cwd)).toBe(false);
	});

	test("adds the template extensions a project declares, and survives a malformed config", () => {
		const cwd = tmpRoot();
		const blade = join(cwd, "views", "home.blade.php");
		expect(isDetectorTarget(blade, cwd)).toBe(false);
		put(cwd, ".impeccable/config.json", JSON.stringify({ detector: { extensions: [{ ext: ".blade.php" }] } }));
		expect(isDetectorTarget(blade, cwd)).toBe(true);
		put(cwd, ".impeccable/config.json", "{not json");
		expect(isDetectorTarget(blade, cwd)).toBe(false);
	});
});

describe("hook protocol", () => {
	test("the payload is Claude Code's PostToolUse stdin", () => {
		expect(JSON.parse(hookPayload("s", "/repo", "Edit", "/repo/a.css"))).toEqual({
			session_id: "s",
			transcript_path: "",
			cwd: "/repo",
			hook_event_name: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: "/repo/a.css" },
			tool_response: { filePath: "/repo/a.css" },
		});
	});

	test("only a non-blank additionalContext counts as findings", () => {
		expect(hookFindings('{"hookSpecificOutput":{"additionalContext":" found \\n"}}')).toBe("found");
		expect(hookFindings('{"hookSpecificOutput":{"additionalContext":"  "}}')).toBeNull();
		expect(hookFindings('{"hookSpecificOutput":{}}')).toBeNull();
		expect(hookFindings("")).toBeNull();
		expect(hookFindings("not json")).toBeNull();
		expect(hookFindings("null")).toBeNull();
	});
});

describe("findLauncher", () => {
	test("picks the first impeccable root that still has a launcher", () => {
		const gone = { plugin: "impeccable", path: join(tmpRoot(), "missing") };
		const other = fakePlugin("exit 0");
		const real = fakePlugin("exit 0");
		const roots = [{ plugin: "styleseed", path: other.root }, gone, { plugin: "impeccable", path: real.root }];
		expect(findLauncher(roots)).toBe(real.launcher);
		expect(findLauncher([gone])).toBeNull();
		expect(findLauncher([])).toBeNull();
	});

	test("resolves the install from OMP's own plugin registry", async () => {
		const home = tmpRoot();
		const plugin = fakePlugin("exit 0");
		put(
			home,
			".omp/plugins/installed_plugins.json",
			JSON.stringify({
				version: 2,
				plugins: { "impeccable@impeccable": [{ scope: "user", installPath: plugin.root, version: "9.9.9" }] },
			}),
		);
		expect(findLauncher(await hostPluginRoots(tmpRoot(), home))).toBe(plugin.launcher);
		expect(findLauncher(await hostPluginRoots(tmpRoot(), tmpRoot()))).toBeNull();
	});
});

describe("tool_result", () => {
	test("prepends findings for a UI write, in quiet mode, with the session and project", async () => {
		const plugin = fakePlugin(FINDINGS_BODY);
		const cwd = tmpRoot();
		const page = put(cwd, "src/page.html", "<h1>x</h1>");
		const handlers = bind([{ plugin: "impeccable", path: plugin.root }]);
		const result = (await handlers.tool_result?.(writeEvent(page), context(cwd))) as Result;
		expect(result?.content[0]?.text).toBe("[impeccable@1] findings quiet=1\n\n");
		expect(result?.content[1]?.text).toBe("wrote");
		expect(plugin.calls()).toEqual([JSON.parse(hookPayload("session-1", cwd, "Write", page))]);
	});

	test("an edit runs once per UI file it left, as Edit", async () => {
		const plugin = fakePlugin(FINDINGS_BODY);
		const cwd = tmpRoot();
		const handlers = bind([{ plugin: "impeccable", path: plugin.root }]);
		const event = {
			toolName: "edit",
			isError: false,
			content: [],
			details: {
				perFileResults: [
					{ path: join(cwd, "a.css") },
					{ path: join(cwd, "notes.md") },
					{ path: join(cwd, "b.tsx"), op: "delete" },
					{ path: join(cwd, "c.vue") },
				],
			},
		};
		const result = (await handlers.tool_result?.(event, context(cwd))) as Result;
		expect(result?.content).toHaveLength(1);
		expect(plugin.calls().map((call) => [call.tool_name, (call.tool_input as { file_path: string }).file_path])).toEqual([
			["Edit", join(cwd, "a.css")],
			["Edit", join(cwd, "c.vue")],
		]);
	});

	test("never spawns for a failed call, another tool, or a non-UI file", async () => {
		const plugin = fakePlugin(FINDINGS_BODY);
		const cwd = tmpRoot();
		const handlers = bind([{ plugin: "impeccable", path: plugin.root }]);
		const page = join(cwd, "page.html");
		expect(await handlers.tool_result?.(writeEvent(page, { isError: true }), context(cwd))).toBeUndefined();
		expect(await handlers.tool_result?.({ toolName: "bash", input: { command: "ls" } }, context(cwd))).toBeUndefined();
		expect(await handlers.tool_result?.(writeEvent(join(cwd, "README.md")), context(cwd))).toBeUndefined();
		expect(await handlers.tool_result?.(writeEvent(join(tmpRoot(), "x.html")), context(cwd))).toBeUndefined();
		expect(plugin.calls()).toEqual([]);
	});

	test("does nothing when impeccable is not installed or resolution fails", async () => {
		const cwd = tmpRoot();
		const page = join(cwd, "page.html");
		expect(await bind([]).tool_result?.(writeEvent(page), context(cwd))).toBeUndefined();
		expect(await bind(new Error("registry unreadable")).tool_result?.(writeEvent(page), context(cwd))).toBeUndefined();
	});

	test("stays silent on a clean file, a failed run, or output that is not the hook's JSON", async () => {
		const cwd = tmpRoot();
		const page = join(cwd, "page.html");
		for (const body of ["exit 0", `${FINDINGS_BODY}\nexit 1`, "echo 'engine missing' >&2; echo garbage"]) {
			const plugin = fakePlugin(body);
			const handlers = bind([{ plugin: "impeccable", path: plugin.root }]);
			expect(await handlers.tool_result?.(writeEvent(page), context(cwd))).toBeUndefined();
			expect(plugin.calls()).toHaveLength(1);
		}
	});

	test("kills a launcher that outruns the hook budget", async () => {
		const plugin = fakePlugin(`echo $$ > "$(dirname "$0")/pid"\nexec sleep 30`);
		const cwd = tmpRoot();
		let expire: (() => void) | undefined;
		const ctx = context(cwd, {
			setTimeout: (callback: () => void) => {
				expire = callback;
				return 1;
			},
		});
		const handlers = bind([{ plugin: "impeccable", path: plugin.root }]);
		const pending = handlers.tool_result?.(writeEvent(join(cwd, "page.html")), ctx);
		const pidFile = join(dirname(plugin.launcher), "pid");
		for (let i = 0; i < 200 && !(expire && existsSync(pidFile)); i++) await Bun.sleep(10);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expire?.();
		expect(await pending).toBeUndefined();
		let alive = true;
		for (let i = 0; i < 100 && alive; i++) {
			try {
				process.kill(pid, 0);
				await Bun.sleep(10);
			} catch {
				alive = false;
			}
		}
		expect(alive).toBe(false);
	});
});
