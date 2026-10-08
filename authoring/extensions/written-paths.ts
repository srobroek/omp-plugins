import { resolve } from "node:path";

/**
 * The files a completed tool call left on disk, read from its `tool_result` event.
 *
 * Shared by the extensions in this repository that act on a write after it lands.
 * Plugins are bundled in isolation, so keep this file byte-identical in each plugin
 * that consumes it; `scripts/check-shared-detector.py` enforces that contract.
 */

/** `write` accepts internal URIs (`xd://ast_edit`, `artifact://…`) that are not files. */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export type ResultEvent = {
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
		if (details?.applied !== true) return out;
		// Detail paths are printed relative to the cwd of the edit, which is the
		// session cwd unless the tool was pointed elsewhere.
		const base = typeof details.cwd === "string" && details.cwd !== "" ? details.cwd : cwd;
		if (Array.isArray(details.files)) {
			for (const file of details.files) take(file, base);
		}
		if (Array.isArray(details.fileReplacements)) {
			for (const raw of details.fileReplacements) take(asRecord(raw)?.path, base);
		}
	}

	return out;
}
