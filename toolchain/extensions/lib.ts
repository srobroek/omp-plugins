import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";

/**
 * `from` and its parents, stopping at the git root (inclusive) or after `limit`
 * levels. Marker files that configure a toolchain (lockfiles, `justfile`) sit at
 * the repo root while the agent's cwd is often a package subdirectory, so a
 * cwd-only check misses them; walking past the git root would leak a sibling
 * repository's toolchain into this one.
 */
export function ancestors(from: string, limit = 8): string[] {
	const out: string[] = [];
	let dir = resolve(from);
	for (let i = 0; i < limit; i++) {
		out.push(dir);
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

/** First of `names` that exists directly in `dir`. */
export function firstPresent(dir: string, names: readonly string[]): string | undefined {
	for (const name of names) {
		if (existsSync(join(dir, name))) return name;
	}
	return undefined;
}

/** File text, or `null` when the path is absent or unreadable. */
export function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** `path` with a leading `~` read as the home directory, the way the shell and OMP's file tools read it. */
export function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/**
 * A `tool_result` reply carrying passive context. OMP delivers `additionalContext`
 * outside the tool output as trusted guidance, so an advisory never edits the
 * output the model reads as untrusted data. The pinned SDK types predate the field.
 */
export type ToolResultContext = ToolResultEventResult & { additionalContext: string };
