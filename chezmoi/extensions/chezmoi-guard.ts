import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
	ExtensionAPI,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };
const SUBPROCESS_TIMEOUT_MS = 2000;
const REMINDER_MS = 10 * 60 * 1000;

const SED_INPLACE = /(?:^|[;&|]|\n)\s*sed\s+(?:-[^\s]*i[^\s]*\s+|-[^\s]*\s+)*-i(?:[^\s]*)?(?:\s|$)/;

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

export function sedInplacePaths(command: string): string[] {
	if (!SED_INPLACE.test(command)) return [];
	const tokens = command.split(/\s+/).filter(Boolean);
	const out: string[] = [];
	for (const t of tokens) {
		if (t === "sed" || t.startsWith("-")) continue;
		if (t.startsWith("/") || t.startsWith("~") || t.includes(sep)) out.push(t);
	}
	return out;
}

export function shouldInspect(abs: string, cwd: string): boolean {
	if (!under(abs, homedir())) return false;
	if (under(abs, cwd)) return false;
	return true;
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
	if (sourceDir && under(abs, sourceDir)) {
		refreshIfSourceEdit(abs);
		return;
	}
	const managed = loadManaged();
	if (!managed) return;
	if (!managed.has(abs)) return;
	const out = spawnChezmoi(["source-path", abs]);
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
		execute: async () => {
			const result = chezmoiStatusReport();
			return {
				content: [{ type: "text", text: result.text }],
				details: { ok: result.ok },
			};
		},
	});

	pi.on("tool_call", (event) => {
		try {
			const cwd =
				typeof event.input.cwd === "string" && event.input.cwd
					? event.input.cwd
					: process.cwd();
			const paths: string[] = [];

			if (EDIT_TOOLS[event.toolName]) {
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
				if (cache.sourceDir && under(abs, cache.sourceDir) && EDIT_TOOLS[event.toolName]) {
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
			if (!EDIT_TOOLS[event.toolName]) return;
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

export function chezmoiStatusReport(): { ok: boolean; text: string } {
	const capture = (args: string[]): string | null => {
		if (testSpawn) return testSpawn(args);
		try {
			const proc = Bun.spawnSync(["chezmoi", ...args], {
				stdout: "pipe",
				stderr: "pipe",
				timeout: SUBPROCESS_TIMEOUT_MS,
			});
			const out = new TextDecoder().decode(proc.stdout);
			const err = new TextDecoder().decode(proc.stderr);
			if (proc.exitCode !== 0 && !out.trim() && !err.trim()) return null;
			return [out, err].filter(Boolean).join("\n");
		} catch {
			return null;
		}
	};
	const status = capture(["status"]);
	const diff = capture(["diff"]);
	if (status === null && diff === null) {
		return { ok: false, text: "chezmoi not available or both commands failed" };
	}
	const parts = [status ?? "(chezmoi status failed)", "", diff ?? "(chezmoi diff failed)"];
	return { ok: true, text: parts.join("\n") };
}

