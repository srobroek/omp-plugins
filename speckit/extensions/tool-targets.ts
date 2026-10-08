/**
 * The files a tool call names as its targets, read statically from its input.
 *
 * Shared by the gates in this repository that refuse writes by path. Plugins are
 * bundled in isolation, so keep this file byte-identical in each plugin that
 * consumes it; `scripts/check-shared-detector.py` enforces that contract.
 */

/**
 * Host tools whose input names the files the call writes. In apply_patch mode the
 * host still reports the call as `edit`: `apply_patch` is only its wire name.
 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "ast_edit"]);

const HASHLINE_HEADER = /^\s*\[(?<path>[^#\r\n]+)#[0-9a-fA-F]{4}\]\s*$/;
const HASHLINE_MOVE = /^\s*MV\s+(?<path>.+?)\s*$/;
const PATCH_HEADER = /^\*\*\* (?:(?:Add|Update|Delete|Edit) File|Move to):\s*(?<path>.+?)\s*$/;

function unquote(path: string): string {
	const first = path[0];
	if (path.length > 1 && (first === '"' || first === "'") && path.endsWith(first)) return path.slice(1, -1);
	return path;
}

/**
 * Target paths in an edit payload: hashline `[PATH#TAG]` headers and their
 * `MV DEST` ops, plus apply_patch file and move headers. Hashline body rows
 * (`+…`) are content, so a quoted header inside one is not a target.
 */
export function patchPaths(payload: string): string[] {
	const out: string[] = [];
	let inHashline = false;
	for (const raw of payload.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const header = HASHLINE_HEADER.exec(line)?.groups?.path;
		if (header !== undefined) {
			inHashline = true;
			out.push(unquote(header.trim()));
			continue;
		}
		const patch = PATCH_HEADER.exec(line)?.groups?.path;
		if (patch !== undefined) {
			inHashline = false;
			out.push(unquote(patch));
			continue;
		}
		if (!inHashline || line.startsWith("+")) continue;
		const move = HASHLINE_MOVE.exec(line)?.groups?.path;
		if (move !== undefined) out.push(unquote(move));
	}
	return out.filter((path) => path.length > 0);
}

/**
 * Every path a tool call names: the top-level `path`/`file_path`/`_path`/`paths`
 * fields, patch-mode `edits[].rename` destinations, and the headers and moves of a
 * hashline or apply_patch payload in `input`/`_input`. The host derives `path` and
 * `paths` from hashline section headers only, so a move or an apply_patch target is
 * visible here and nowhere else.
 */
export function targetPaths(input: object): string[] {
	const fields = input as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ["path", "file_path", "_path"]) {
		const value = fields[key];
		if (typeof value === "string" && value) out.push(value);
	}
	if (Array.isArray(fields.paths)) {
		for (const value of fields.paths) if (typeof value === "string" && value) out.push(value);
	}
	if (Array.isArray(fields.edits)) {
		for (const entry of fields.edits) {
			const rename = (entry as { rename?: unknown } | null)?.rename;
			if (typeof rename === "string" && rename) out.push(rename);
		}
	}
	for (const key of ["input", "_input"]) {
		const value = fields[key];
		if (typeof value === "string" && value) out.push(...patchPaths(value));
	}
	return [...new Set(out)];
}
