import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import type {
	ExtensionAPI,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

const EDIT_TOOLS = new Set(["edit", "write"]);
const SUBPROCESS_TIMEOUT_MS = 2000;
const REMINDER_MS = 10 * 60 * 1000;


type Cache = {
	managed: Set<string> | null;
	sourceDir: string | null;
	sourceDirResolved: boolean;
};

const cache: Cache = {
	managed: null,
	sourceDir: null,
	sourceDirResolved: false,
};

const pendingSourceEdits = new Map<string, string[]>();
let lastReminderAt = 0;

let testSpawn: ((args: string[]) => string | null) | null = null;

export function spawnChezmoi(args: string[]): string | null {
	if (testSpawn) return testSpawn(args);
	try {
		const proc = Bun.spawnSync(["chezmoi", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: SUBPROCESS_TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return null;
		return new TextDecoder().decode(proc.stdout);
	} catch {
		return null;
	}
}

export function setChezmoiSpawnForTests(fn: ((args: string[]) => string | null) | null): void {
	testSpawn = fn;
}

export function resetChezmoiGuardForTests(): void {
	cache.managed = null;
	cache.sourceDir = null;
	cache.sourceDirResolved = false;
	pendingSourceEdits.clear();
	lastReminderAt = 0;
	testSpawn = null;
}

export function seedChezmoiCacheForTests(managed: Set<string> | null, sourceDir: string | null): void {
	cache.managed = managed;
	cache.sourceDir = sourceDir;
	cache.sourceDirResolved = true;
}

export function setLastReminderAtForTests(ms: number): void {
	lastReminderAt = ms;
}

export function lexicalAbs(target: string, cwd: string): string {
	let expanded = target.startsWith("~") ? homedir() + target.slice(1) : target;
	if (!isAbsolute(expanded)) expanded = resolve(cwd, expanded);
	const parts: string[] = [];
	for (const segment of expanded.split(/[/\\]/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return "/" + parts.join("/");
}

export function under(child: string, parent: string): boolean {
	if (!parent) return false;
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function editedFiles(input: Record<string, unknown>): string[] {
	for (const key of ["file_path", "path"] as const) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return [value];
	}
	const paths = input.paths;
	if (Array.isArray(paths)) {
		return paths.filter((p): p is string => typeof p === "string" && p.length > 0);
	}
	return [];
}

/** Literal shell words only; no expansion or shell execution. */
export function shellWords(command: string): string[] {
	return (command.match(/(?:[^\s"';&|]+|'[^']*'|"[^"]*")+|[;&|]+|\n/g) ?? [])
		.map((word) => word.replace(/'([^']*)'|"([^"]*)"/g, (_match, single, double) => single ?? double));
}

export function sedInplacePaths(command: string): string[] {
	const words = shellWords(command);
	const paths: string[] = [];
	let start = 0;
	for (let i = 0; i <= words.length; i++) {
		if (i < words.length && !/^[;&|\n]+$/.test(words[i]!)) continue;
		paths.push(...sedWordPaths(words.slice(start, i)));
		start = i + 1;
	}
	return paths;
}

function sedWordPaths(tokens: string[]): string[] {
	let start = 0;
	while (tokens[start] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!) ||
		["env", "command", "exec", "--"].includes(tokens[start]!))) start++;
	if (!/(?:^|\/)sed$/.test(tokens[start] ?? "")) return [];
	let inplace = false;
	let script = false;
	const paths: string[] = [];
	for (let i = start + 1; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--") {
			paths.push(...tokens.slice(i + 1 + (script ? 0 : 1)));
			break;
		}
		if (token === "-e" || token === "-f" || token === "--expression" || token === "--file") {
			script = true;
			i++;
		} else if (/^--(?:expression|file)=/.test(token) || /^-[ef].+/.test(token)) {
			script = true;
		} else if (/^--in-place(?:=|$)/.test(token) || /^-[a-zA-Z]*i/.test(token)) {
			inplace = true;
			if (token === "-i" && tokens[i + 1] === "") i++;
		} else if (!token.startsWith("-")) {
			if (!script) script = true;
			else paths.push(token);
		}
	}
	return inplace ? paths : [];
}

function normalized(path: string): string {
	try { return realpathSync(path); } catch { return path; }
}

export function shouldInspect(abs: string, _cwd: string): boolean {
	return under(abs, homedir()) || under(normalized(abs), normalized(homedir()));
}

export function loadManaged(): Set<string> | null {
	if (cache.managed) return cache.managed;
	const out = spawnChezmoi(["managed", "--path-style=absolute"]);
	if (out === null) return null;
	const set = new Set<string>();
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (t) set.add(t);
	}
	cache.managed = set;
	return set;
}

export function loadSourceDir(): string | null {
	if (cache.sourceDirResolved) return cache.sourceDir;
	const out = spawnChezmoi(["source-path"]);
	cache.sourceDirResolved = true;
	if (out === null) {
		cache.sourceDir = null;
		return null;
	}
	const dir = out.trim();
	cache.sourceDir = dir || null;
	return cache.sourceDir;
}

function refreshIfSourceEdit(abs: string): void {
	const source = loadSourceDir();
	if (source && under(abs, source)) cache.managed = null;
}

export function considerPath(abs: string, cwd: string): { block: true; reason: string } | undefined {
	if (!shouldInspect(abs, cwd)) return;
	const sourceDir = loadSourceDir();
	if (sourceDir && under(normalized(abs), normalized(sourceDir))) {
		refreshIfSourceEdit(abs);
		return;
	}
	const managed = loadManaged();
	if (!managed) return;
	const normalizedAbs = normalized(abs);
	let target = managed.has(abs) ? abs : undefined;
	if (!target) {
		for (const path of managed) {
			if (normalized(path) === normalizedAbs) { target = path; break; }
		}
	}
	if (!target) return;
	const out = spawnChezmoi(["source-path", target]);
	const source = out?.trim() || `(run: chezmoi source-path ${abs})`;
	return {
		block: true,
		reason:
			`'${abs}' is a chezmoi-managed TARGET, not the source. ` +
			`Edit the source at '${source}', then run chezmoi apply. ` +
			`Do not write the live home-directory copy.`,
	};
}

function prepend(
	event: ExtensionToolResultEvent,
	text: string,
): { content: ExtensionToolResultEvent["content"] } {
	const banner = `<system-reminder>\n${text}\n</system-reminder>\n\n`;
	if (event.content[0]?.type === "text") {
		return {
			content: event.content.map((chunk, i) =>
				i === 0 && chunk.type === "text" ? { ...chunk, text: banner + chunk.text } : chunk,
			),
		};
	}
	return { content: [{ type: "text", text: banner }, ...event.content] };
}

export default function chezmoiGuard(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "chezmoi_status",
		label: "Chezmoi status and diff",
		description: "Run chezmoi status and chezmoi diff; return both (read-only).",
		parameters: z.object({}),
		approval: "read",
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			const result = chezmoiStatusReport(ctx.cwd);
			return {
				content: [{ type: "text", text: result.text }],
				details: { ok: result.ok },
			};
		},
	});

	pi.on("tool_call", (event, ctx) => {
		try {
			const sessionCwd = ctx?.cwd || process.cwd();
			const cwd = typeof event.input.cwd === "string" && event.input.cwd
				? lexicalAbs(event.input.cwd, sessionCwd) : sessionCwd;
			const paths: string[] = [];

			if (EDIT_TOOLS.has(event.toolName)) {
				paths.push(...editedFiles(event.input));
			} else if (event.toolName === "bash") {
				const command = typeof event.input.command === "string" ? event.input.command : "";
				if (!command) return;
				paths.push(...sedInplacePaths(command));
				if (!paths.length) return;
			} else {
				return;
			}

			const sourceHits: string[] = [];
			for (const raw of paths) {
				const abs = lexicalAbs(raw, cwd);
				refreshIfSourceEdit(abs);
				if (cache.sourceDir && under(abs, cache.sourceDir) && EDIT_TOOLS.has(event.toolName)) {
					sourceHits.push(abs);
				}
				const decision = considerPath(abs, cwd);
				if (decision) return decision;
			}
			if (sourceHits.length) pendingSourceEdits.set(event.toolCallId, sourceHits);
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event) => {
		try {
			if (!EDIT_TOOLS.has(event.toolName)) return;
			const hits = pendingSourceEdits.get(event.toolCallId);
			pendingSourceEdits.delete(event.toolCallId);
			if (!hits?.length) return;
			if (event.isError === true) return;
			const now = Date.now();
			if (now - lastReminderAt < REMINDER_MS) return;
			lastReminderAt = now;
			return prepend(
				event,
				"Chezmoi source edited. Preview with chezmoi diff, then chezmoi apply when ready.",
			);
		} catch {
			return;
		}
	});
}

export function chezmoiStatusReport(cwd = process.cwd()): { ok: boolean; text: string } {
	const capture = (args: string[]): { ok: boolean; text: string } => {
		if (testSpawn) {
			const text = testSpawn(args);
			return { ok: text !== null, text: text ?? `(chezmoi ${args[0]} failed)` };
		}
		try {
			const proc = Bun.spawnSync(["chezmoi", ...args], {
				cwd, stdout: "pipe", stderr: "pipe", timeout: SUBPROCESS_TIMEOUT_MS,
			});
			const text = [new TextDecoder().decode(proc.stdout), new TextDecoder().decode(proc.stderr)]
				.filter(Boolean).join("\n");
			return { ok: proc.exitCode === 0, text: proc.exitCode === 0 ? text : `chezmoi ${args[0]} failed (exit ${proc.exitCode})\n${text}` };
		} catch {
			return { ok: false, text: `chezmoi ${args[0]} unavailable or failed` };
		}
	};
	const status = capture(["status"]);
	const diff = capture(["diff"]);
	return { ok: status.ok && diff.ok, text: [status.text, "", diff.text].join("\n") };
}

