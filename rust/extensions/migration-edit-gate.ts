import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * Blocks edits to a migration that is already committed history.
 *
 * Numbered migrations are append-only: once a migration has shipped, every
 * database that ran it keeps the old statements, so editing the file makes the
 * recorded history and the live schema disagree. The single exception is the
 * highest-numbered migration in the directory -- the one still being authored.
 * Creating a new migration is always allowed.
 */

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };

/** Internal URIs (`xd://ast_edit`, `artifact://…`) are not filesystem paths. */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const HASHLINE_HEADER = /^\s*\[([^#\r\n]+)#[0-9a-fA-F]{4}\]\s*$/;

const NUMERIC_PREFIX = /^(\d+)/;

export type MigrationTarget = { dir: string; entry: string };

/**
 * The migrations directory and the numbered entry inside it, or `null` when the
 * path is not a numbered migration. The entry is the segment directly under
 * `migrations/`, so per-migration directories (`0003_name/up.sql`) resolve to the
 * same unit as flat files (`0003_name.sql`).
 */
export function migrationTarget(path: string): MigrationTarget | null {
	const parts = path.replaceAll("\\", "/").split("/");
	const at = parts.lastIndexOf("migrations");
	if (at === -1 || at + 1 >= parts.length) return null;
	const entry = parts[at + 1] ?? "";
	if (!NUMERIC_PREFIX.test(entry)) return null;
	return { dir: parts.slice(0, at + 1).join("/") || "migrations", entry };
}

/**
 * Highest-numbered entry in a migrations directory. Prefixes are compared as
 * numbers first: lexical order alone would rank `2_x` above `10_x`.
 */
export function latestMigration(absDir: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(absDir);
	} catch {
		return undefined;
	}
	let best: { name: string; ordinal: number } | undefined;
	for (const name of names) {
		const digits = NUMERIC_PREFIX.exec(name)?.[1];
		if (!digits) continue;
		const ordinal = Number(digits);
		if (!Number.isFinite(ordinal)) continue;
		if (!best || ordinal > best.ordinal || (ordinal === best.ordinal && name > best.name)) {
			best = { name, ordinal };
		}
	}
	return best?.name;
}

export function decidePath(path: string, cwd: string): { block: true; reason: string } | undefined {
	if (!path || NON_FILE_SCHEME.test(path)) return undefined;
	const target = migrationTarget(path);
	if (!target) return undefined;
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	// A migration that does not exist yet is the new one being written.
	if (!existsSync(abs)) return undefined;
	const absDir = isAbsolute(target.dir) ? target.dir : resolve(cwd, target.dir);
	const latest = latestMigration(absDir);
	if (latest === undefined || latest === target.entry) return undefined;
	return {
		block: true,
		reason:
			`blocked by rust (migrations are append-only): '${path}' is committed migration history. ` +
			`Every database that already ran it keeps the old statements, so editing the file makes the ` +
			`recorded history and the live schema disagree. Only the latest migration ('${latest}') is ` +
			`still editable. Express this change as a NEW migration with the next prefix after ` +
			`'${latest}' -- an ALTER, not a rewrite. Reading the file is unaffected.`,
	};
}

/** Section paths of a hashline `edit` payload; the headers are its only target list. */
export function hashlinePaths(payload: string): string[] {
	const out: string[] = [];
	for (const raw of payload.split("\n")) {
		const match = HASHLINE_HEADER.exec(raw.replace(/\r$/, ""));
		if (!match) continue;
		let path = (match[1] ?? "").trim();
		const first = path[0];
		if (path.length > 1 && (first === '"' || first === "'") && path.endsWith(first)) {
			path = path.slice(1, -1);
		}
		if (path) out.push(path);
	}
	return out;
}

export function editedPaths(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["path", "file_path", "_path"] as const) {
		const value = input[key];
		if (typeof value === "string" && value) out.push(value);
	}
	const paths = input.paths;
	if (Array.isArray(paths)) {
		for (const value of paths) if (typeof value === "string" && value) out.push(value);
	}
	for (const key of ["input", "_input"] as const) {
		const value = input[key];
		if (typeof value === "string" && value) out.push(...hashlinePaths(value));
	}
	return [...new Set(out)];
}

export function decideToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): { block: true; reason: string } | undefined {
	if (!EDIT_TOOLS[toolName]) return undefined;
	for (const path of editedPaths(input)) {
		const decision = decidePath(path, cwd);
		if (decision) return decision;
	}
	return undefined;
}

export default function migrationEditGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			return decideToolCall(event.toolName, event.input ?? {}, process.cwd());
		} catch {
			return;
		}
	});
}
