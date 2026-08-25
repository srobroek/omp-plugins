import { relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionToolResultEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * Remind the agent to lint an agentic asset it just authored.
 *
 * `tool_result`, never `tool_call`: the reminder is advisory, and a throwing
 * `tool_call` handler blocks the tool (`skill://omp-extension-safety`). Acting on
 * the result also means only edits that landed are counted -- a rejected patch
 * leaves nothing to lint.
 */

/**
 * Path segments whose subtrees hold copies the agent did not author: vendored
 * dependencies, the OMP marketplace sync (`~/.omp/agent/managed-skills`), and the
 * on-disk caches beside it. Linting one reports findings against a file whose
 * source lives elsewhere. Membership is tested with `Object.hasOwn`, never a bare
 * index: a directory named `constructor` must not read as excluded.
 */
const EXCLUDED_SEGMENTS: Record<string, true> = {
	".git": true,
	cache: true,
	"managed-skills": true,
	node_modules: true,
};

/** `write` accepts internal URIs (`xd://ast_edit`, `artifact://…`) that are not files. */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Beyond this many files one reminder names the count instead of every path. */
const NAMED_PATH_LIMIT = 4;

const reminded = new Set<string>();

export function resetLintReminderForTests(): void {
	reminded.clear();
}

/**
 * Classify a path by where it sits, mirroring the install shapes in
 * `skill://write-agentic`: `skills/<name>/SKILL.md`, `rules/<name>.md`,
 * `agents/<name>.md`. Returns null when the path is not an agentic asset.
 */
export function assetKind(path: string): "skill" | "rule" | "agent" | null {
	const parts = path.split(/[/\\]/).filter(Boolean);
	const file = parts.at(-1);
	if (!file || !file.endsWith(".md")) return null;
	for (const part of parts) {
		if (Object.hasOwn(EXCLUDED_SEGMENTS, part)) return null;
	}
	if (file === "SKILL.md") return parts.at(-3) === "skills" ? "skill" : null;
	const dir = parts.at(-2);
	if (dir === "rules") return "rule";
	if (dir === "agents") return "agent";
	return null;
}

type ResultEvent = {
	toolName: string;
	isError?: boolean;
	input?: Record<string, unknown>;
	details?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * The files a completed write/edit/ast_edit left on disk.
 *
 * `write` carries its target in `input.path`. `edit` never does -- it takes a
 * hashline patch blob -- so its paths come from the result `details`, per file for
 * a multi-file edit, and post-move for a rename (the pre-move path no longer
 * exists). `ast_edit` stages a proposal before it is resolved, so its paths count
 * only once `details.applied` is true.
 */
export function writtenPaths(event: ResultEvent, cwd: string): string[] {
	if (event.isError === true) return [];
	const details = asRecord(event.details);
	const out: string[] = [];
	const take = (value: unknown, base = cwd): void => {
		if (typeof value !== "string" || value === "" || NON_FILE_SCHEME.test(value)) return;
		out.push(resolve(base, value));
	};

	if (event.toolName === "write") {
		take(event.input?.path);
		return out;
	}

	if (event.toolName === "edit") {
		if (!details) return out;
		const perFile = details.perFileResults;
		if (Array.isArray(perFile)) {
			for (const raw of perFile) {
				const entry = asRecord(raw);
				if (!entry || entry.isError === true || entry.op === "delete") continue;
				take(entry.move ?? entry.path);
			}
			return out;
		}
		if (details.op !== "delete") take(details.move ?? details.path);
		return out;
	}

	if (event.toolName === "ast_edit") {
		if (!details || details.applied !== true) return out;
		// Detail paths are printed relative to the cwd of the edit, which is the
		// session cwd unless the tool was pointed elsewhere.
		const base = typeof details.cwd === "string" && details.cwd !== "" ? details.cwd : cwd;
		if (Array.isArray(details.files)) {
			for (const file of details.files) take(file, base);
			return out;
		}
		if (Array.isArray(details.fileReplacements)) {
			for (const raw of details.fileReplacements) take(asRecord(raw)?.path, base);
		}
	}

	return out;
}

/**
 * Assets from this write that no reminder has named yet, marked as named.
 *
 * One reminder per file per session: the agent that ignored the first one will
 * ignore the fifth, and an author revising a rule ten times pays for the nudge
 * once.
 */
export function pendingAssets(paths: string[], seen: Set<string> = reminded): string[] {
	const out: string[] = [];
	for (const path of paths) {
		if (seen.has(path) || assetKind(path) === null) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

export function formatReminder(paths: string[], cwd: string): string {
	const shown = paths.slice(0, NAMED_PATH_LIMIT).map((path) => {
		const rel = relative(cwd, path);
		return rel === "" || rel.startsWith("..") ? path : rel;
	});
	const extra = paths.length - shown.length;
	const list = extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
	return `Agentic asset written: ${list}. Run \`agentic_lint\` on it before yielding -- fix every ERROR, justify or fix each WARN.`;
}

export default function agenticLintReminder(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		reminded.clear();
	});

	pi.on("tool_result", (event: ExtensionToolResultEvent, ctx: { cwd?: string }) => {
		try {
			const cwd = ctx?.cwd || process.cwd();
			const assets = pendingAssets(writtenPaths(event as ResultEvent, cwd));
			if (assets.length === 0) return;
			const prefix = { type: "text" as const, text: `${formatReminder(assets, cwd)}\n\n` };
			return { content: [prefix, ...(event.content ?? [])] };
		} catch {
			// A reminder is worth less than the result it rides on.
			return;
		}
	});
}
