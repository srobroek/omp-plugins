import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { writtenPaths } from "./written-paths.ts";

/**
 * Run impeccable's design detector after a UI file lands, the way its Claude Code
 * `PostToolUse` hook does, and prepend the findings to the write's result.
 *
 * impeccable ships its hooks as Claude Code `command` hooks in `hooks/hooks.json`.
 * OMP loads only `.ts`/`.js` extension and hook factories, so those commands never
 * run here. This module feeds the same `impeccable hook` verb the same stdin payload,
 * through the plugin's own launcher, so the detector, its config, and its per-session
 * dedup cache stay impeccable's.
 *
 * Only `PostToolUse` is reproduced. `SessionStart` only writes
 * `IMPECCABLE_SESSION_ID` into Claude Code's `CLAUDE_ENV_FILE`; OMP has no such file,
 * and this module passes the session id in each payload instead. The `Stop` deep pass
 * re-runs the full rule set over every touched file when a turn ends, which in OMP
 * would force an extra turn at the end of every session that touched a UI file;
 * impeccable already covers a harness without that hook, because `impeccable context`
 * then tells the agent to run `impeccable detect` once the changed UI is finished.
 *
 * It also hands `impeccable-asset-producer` the launcher's absolute path when that
 * agent starts: its instructions spell the launcher with `${CLAUDE_PLUGIN_ROOT}`,
 * which OMP never sets in an agent's shell.
 *
 * Advisory, so every failure leaves the result untouched: no impeccable install, a
 * launcher that exits non-zero or outruns the hook's 5 s budget, output that is not
 * the hook's JSON. `tool_result`, never `tool_call`: a throwing `tool_call` handler
 * blocks the tool (`skill://omp-extension-safety`).
 */

/** The `Edit|Write` matcher in impeccable's `hooks.json`, in OMP's tool names. */
const HOOK_TOOLS: ReadonlyMap<string, "Edit" | "Write"> = new Map([
	["write", "Write"],
	["edit", "Edit"],
	["ast_edit", "Edit"],
]);

/** The extensions impeccable's hook scans (`reference/hooks.md`); matched case-insensitively. */
const UI_EXTENSIONS: ReadonlySet<string> = new Set([
	".tsx",
	".jsx",
	".html",
	".vue",
	".svelte",
	".astro",
	".css",
	".scss",
	".sass",
	".less",
	".ts",
	".js",
]);

/** `timeout: 5` on the hook in impeccable's `hooks.json`. */
const HOOK_TIMEOUT_MS = 5_000;

const LAUNCHER_PATH = ["skills", "impeccable", "scripts", "impeccable"];

/** The impeccable agents whose instructions run `${CLAUDE_PLUGIN_ROOT}/…/scripts/impeccable`. */
const LAUNCHER_AGENTS: ReadonlySet<string> = new Set(["impeccable-asset-producer"]);

const LAUNCHER_MESSAGE_TYPE = "impeccable-launcher";

export type PluginRoot = { plugin: string; path: string };

export type DetectorDeps = {
	/** The installed plugin roots, in OMP's precedence order. */
	listPluginRoots: (cwd: string) => Promise<readonly PluginRoot[]>;
	timeoutMs: number;
};

type Timers = Pick<ExtensionContext, "setTimeout" | "clearTimer">;

/**
 * The plugin roots OMP itself resolves: `--plugin-dir` roots, project and user
 * registries, enabled entries only. Imported lazily and feature-checked, so a host
 * that moves the helper leaves the detector inert instead of failing the module load.
 */
export async function hostPluginRoots(cwd: string, home = homedir()): Promise<readonly PluginRoot[]> {
	const helpers = await import("@oh-my-pi/pi-coding-agent/discovery/helpers");
	if (typeof helpers.listClaudePluginRoots !== "function") return [];
	const { roots } = await helpers.listClaudePluginRoots(home, cwd);
	return roots;
}

/** The launcher of the highest-precedence installed impeccable plugin, or null. */
export function findLauncher(roots: readonly PluginRoot[]): string | null {
	for (const root of roots) {
		if (root.plugin !== "impeccable") continue;
		const launcher = join(root.path, ...LAUNCHER_PATH);
		try {
			if (statSync(launcher).isFile()) return launcher;
		} catch {
			// A registry entry whose tree is gone; a lower-precedence install may remain.
		}
	}
	return null;
}

/** Extensions a project adds through `detector.extensions` in `.impeccable/config.json`. */
function configuredExtensions(cwd: string): string[] {
	const file = join(cwd, ".impeccable", "config.json");
	if (!existsSync(file)) return [];
	try {
		const config: unknown = JSON.parse(readFileSync(file, "utf8"));
		const entries = (config as { detector?: { extensions?: unknown } } | null)?.detector?.extensions;
		if (!Array.isArray(entries)) return [];
		const out: string[] = [];
		for (const entry of entries) {
			const ext = (entry as { ext?: unknown } | null)?.ext;
			if (typeof ext === "string" && ext.startsWith(".")) out.push(ext.toLowerCase());
		}
		return out;
	} catch {
		// impeccable ignores a malformed config file too.
		return [];
	}
}

/**
 * Whether the hook would scan this file: a UI extension, built in or configured, inside
 * the project. impeccable skips a file outside the project, so it is not worth a spawn.
 */
export function isDetectorTarget(path: string, cwd: string): boolean {
	const rel = relative(cwd, path);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	if (UI_EXTENSIONS.has(extname(path).toLowerCase())) return true;
	const name = path.toLowerCase();
	return configuredExtensions(cwd).some((ext) => name.endsWith(ext));
}

/** The stdin Claude Code hands a `PostToolUse` command hook, reduced to what the hook reads. */
export function hookPayload(sessionId: string, cwd: string, toolName: "Edit" | "Write", path: string): string {
	return JSON.stringify({
		session_id: sessionId,
		transcript_path: "",
		cwd,
		hook_event_name: "PostToolUse",
		tool_name: toolName,
		tool_input: { file_path: path },
		tool_response: { filePath: path },
	});
}

/** The `additionalContext` of the hook's JSON reply, or null when it has nothing to say. */
export function hookFindings(stdout: string): string | null {
	const text = stdout.trim();
	if (text === "") return null;
	try {
		const reply = JSON.parse(text) as { hookSpecificOutput?: { additionalContext?: unknown } } | null;
		const context = reply?.hookSpecificOutput?.additionalContext;
		return typeof context === "string" && context.trim() !== "" ? context.trim() : null;
	} catch {
		return null;
	}
}

function killGroup(proc: Bun.Subprocess): void {
	try {
		// The launcher may still be fetching its engine; end curl with it.
		process.kill(-proc.pid, "SIGKILL");
	} catch {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already reaped.
		}
	}
}

/** Run `<launcher> hook` once; its stdout on a zero exit within the budget, else null. */
export async function runHook(
	launcher: string,
	payload: string,
	cwd: string,
	timeoutMs: number,
	timers: Timers,
): Promise<string | null> {
	let proc: Bun.Subprocess<Uint8Array, "pipe", "ignore">;
	try {
		proc = Bun.spawn(["/bin/sh", launcher, "hook"], {
			cwd,
			// Quiet mode is impeccable's own switch for "findings only": it drops the
			// clean-file ack and the re-nudge about findings it already reported.
			env: { ...process.env, IMPECCABLE_HOOK_QUIET: "1" },
			stdin: new TextEncoder().encode(payload),
			stdout: "pipe",
			stderr: "ignore",
			detached: true,
		});
	} catch {
		return null;
	}
	const child = proc;
	const { promise: expired, resolve: expire } = Promise.withResolvers<null>();
	const timer = timers.setTimeout(() => {
		killGroup(child);
		expire(null);
	}, timeoutMs);
	try {
		const done = Promise.all([new Response(child.stdout).text(), child.exited]).catch(() => null);
		const result = await Promise.race([done, expired]);
		if (result === null) return null;
		const [stdout, exitCode] = result;
		return exitCode === 0 ? stdout : null;
	} finally {
		timers.clearTimer(timer);
	}
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager.getSessionId();
		if (typeof id === "string" && id !== "") return id;
	} catch {
		// Fall through: the hook needs a stable key, not a real one.
	}
	return "omp";
}

function launcherDelivered(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager
			.getBranch()
			.some((entry) => entry.type === "custom_message" && entry.customType === LAUNCHER_MESSAGE_TYPE);
	} catch {
		return false;
	}
}

// Concatenated so the literal placeholder does not read as a template-string slip.
const PLUGIN_ROOT_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";

/**
 * impeccable's agents are written for Claude Code, which exports `CLAUDE_PLUGIN_ROOT`
 * to their shell. OMP substitutes that variable only in MCP server config, so in a
 * subagent's bash it expands to the empty string and the launcher path breaks.
 */
export function launcherNote(launcher: string): string {
	return [
		`Your instructions run \`${PLUGIN_ROOT_VAR}/skills/impeccable/scripts/impeccable\`.`,
		"OMP does not set `CLAUDE_PLUGIN_ROOT` in your shell, so that path expands to `/skills/…` and fails.",
		`Run the launcher by its absolute path instead: "${launcher}".`,
	].join(" ");
}

export function bindImpeccableDetector(pi: ExtensionAPI, deps: DetectorDeps): void {
	// Child sessions rebind the factory, so this state belongs to one session.
	const launchers = new Map<string, Promise<string | null>>();
	// One detector at a time: the hook rewrites `.impeccable/hook.cache.json`.
	let queue: Promise<unknown> = Promise.resolve();

	const launcherFor = (cwd: string): Promise<string | null> => {
		let found = launchers.get(cwd);
		if (found === undefined) {
			found = deps.listPluginRoots(cwd).then(findLauncher, () => null);
			launchers.set(cwd, found);
		}
		return found;
	};

	pi.on("session_start", () => {
		launchers.clear();
	});

	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		try {
			const toolName = HOOK_TOOLS.get(event.toolName);
			if (toolName === undefined || event.isError === true) return;
			const cwd = ctx.cwd || process.cwd();
			const targets = [...new Set(writtenPaths(event, cwd))].filter((path) => isDetectorTarget(path, cwd));
			if (targets.length === 0) return;
			const launcher = await launcherFor(cwd);
			if (launcher === null) return;

			const sessionId = sessionIdOf(ctx);
			const scan = queue.then(async () => {
				const findings: string[] = [];
				for (const path of targets) {
					const payload = hookPayload(sessionId, cwd, toolName, path);
					const reply = await runHook(launcher, payload, cwd, deps.timeoutMs, ctx);
					const found = reply === null ? null : hookFindings(reply);
					if (found !== null) findings.push(found);
				}
				return findings;
			});
			queue = scan.catch(() => undefined);
			const findings = await scan;
			if (findings.length === 0) return;
			const prefix = { type: "text" as const, text: `${findings.join("\n\n")}\n\n` };
			return { content: [prefix, ...(event.content ?? [])] };
		} catch {
			// A design reminder is worth less than the result it rides on.
			return;
		}
	});

	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		try {
			if (!LAUNCHER_AGENTS.has(ctx.agent?.name ?? "") || launcherDelivered(ctx)) return;
			const launcher = await launcherFor(ctx.cwd || process.cwd());
			if (launcher === null) return;
			return {
				message: { customType: LAUNCHER_MESSAGE_TYPE, content: launcherNote(launcher), display: false },
			};
		} catch {
			return;
		}
	});
}

export default function impeccableDetector(pi: ExtensionAPI): void {
	bindImpeccableDetector(pi, { listPluginRoots: hostPluginRoots, timeoutMs: HOOK_TIMEOUT_MS });
}
