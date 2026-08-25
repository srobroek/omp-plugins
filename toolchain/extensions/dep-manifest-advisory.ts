import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type {
	ExtensionAPI,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import { ancestors, firstPresent, readText } from "./lib";

/**
 * Advises the package-manager CLI when a call hand-edits a dependency table.
 *
 * Filename alone is not the trigger: a manifest holds prose (`description`),
 * scripts, and metadata that are edited legitimately and often. The gate
 * compares the call's payload against the manifest's dependency-key regions and
 * stays silent unless the change lands inside one.
 */

export type ManifestKind = "npm" | "cargo" | "python" | "go";

const KIND_BY_FILE: Record<string, ManifestKind> = {
	"package.json": "npm",
	"Cargo.toml": "cargo",
	"pyproject.toml": "python",
	"go.mod": "go",
};

/** Internal URIs the `write` tool accepts (`xd://ast_edit`, `artifact://…`) are not files. */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const EDIT_PAYLOAD_KEYS = ["old_string", "new_string", "patch", "diff", "content", "text"] as const;

const NPM_DEP_KEY =
	/^\s*"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/;
const TOML_HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/;
const CARGO_DEP_TABLE = /(?:^|\.)(?:dev-|build-)?dependencies(?:\.|$)/;
const PY_DEP_TABLE = /(?:^|\.)(?:dev-|optional-)?dependencies(?:\.|$)|^dependency-groups(?:\.|$)/;
const PY_DEP_ARRAY = /^\s*(?:dev-|optional-)?dependencies\s*=\s*\[/;
const GO_REQUIRE_BLOCK = /^\s*require\s*\(/;
const GO_REQUIRE_LINE = /^\s*require\s+\S/;
const GO_BLOCK_END = /^\s*\)/;

const HASHLINE_HEADER = /^\s*\[([^#\r\n]+)#[0-9a-fA-F]{4}\]\s*$/;
const HASHLINE_OP =
	/^(?:PUT|CUT)\s+(?:(?<gap>[<>])\s*(?<gapLine>\d+)|(?<start>\d+)\s*(?:[.=\-…\s]+(?<end>\d+))?)/;

export type Tooling = { cli: string; lock: string };

const DEFAULT_TOOLING: Record<ManifestKind, Tooling> = {
	npm: { cli: "bun add", lock: "bun.lock" },
	python: { cli: "uv add", lock: "uv.lock" },
	cargo: { cli: "cargo add", lock: "Cargo.lock" },
	go: { cli: "go get", lock: "go.sum" },
};

/** A lockfile in the tree names the manager that already owns this manifest. */
const TOOLING_BY_LOCKFILE: Record<string, Tooling> = {
	"pnpm-lock.yaml": { cli: "pnpm add", lock: "pnpm-lock.yaml" },
	"yarn.lock": { cli: "yarn add", lock: "yarn.lock" },
	"package-lock.json": { cli: "npm install", lock: "package-lock.json" },
	"poetry.lock": { cli: "poetry add", lock: "poetry.lock" },
};

/** Lockfiles worth probing for; bun and uv are the defaults, so they need no entry. */
const LOCKFILES_BY_KIND: Record<ManifestKind, readonly string[]> = {
	npm: ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
	python: ["poetry.lock"],
	cargo: [],
	go: [],
};

export type LineRange = { start: number; end: number };

/** One op's footprint. Gap ops insert between two lines rather than replacing any. */
export type Touch = { start: number; end: number; gap?: "before" | "after" };

export type PatchSection = { path: string; touches: Touch[] };

export type Hit = { path: string; abs: string; kind: ManifestKind; cli: string; lock: string };

export type Reader = (absPath: string) => string | null;

const pending = new Map<string, Hit[]>();
const advised = new Set<string>();

export function resetDepManifestAdvisoryForTests(): void {
	pending.clear();
	advised.clear();
}

export function manifestKind(path: string): ManifestKind | undefined {
	return KIND_BY_FILE[basename(path.replaceAll("\\", "/"))];
}

function unquote(value: string): string {
	const first = value[0];
	if (value.length > 1 && (first === '"' || first === "'") && value.endsWith(first)) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * 1-indexed line holding the delimiter that closes the one opened on
 * `startIdx`, ignoring delimiters inside strings and TOML comments.
 */
function blockEnd(lines: string[], startIdx: number, open: string, close: string): number {
	let depth = 0;
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i] ?? "";
		let quote: string | null = null;
		for (let c = 0; c < line.length; c++) {
			const ch = line[c];
			if (quote !== null) {
				if (ch === "\\") c++;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === "#") break;
			if (ch === open) depth++;
			else if (ch === close && --depth === 0) return i + 1;
		}
	}
	return lines.length;
}

/** Inclusive 1-indexed line ranges covering every dependency table in the manifest. */
export function depRegions(kind: ManifestKind, text: string): LineRange[] {
	const lines = text.split("\n");
	const out: LineRange[] = [];

	if (kind === "npm") {
		for (let i = 0; i < lines.length; i++) {
			if (NPM_DEP_KEY.test(lines[i] ?? "")) {
				out.push({ start: i + 1, end: blockEnd(lines, i, "{", "}") });
			}
		}
		return out;
	}

	if (kind === "go") {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (GO_REQUIRE_BLOCK.test(line)) {
				let end = lines.length;
				for (let j = i + 1; j < lines.length; j++) {
					if (GO_BLOCK_END.test(lines[j] ?? "")) {
						end = j + 1;
						break;
					}
				}
				out.push({ start: i + 1, end });
				i = end - 1;
			} else if (GO_REQUIRE_LINE.test(line)) {
				out.push({ start: i + 1, end: i + 1 });
			}
		}
		return out;
	}

	// TOML: a dependency table runs until the next table header; a dependency
	// array (`dependencies = [`) until its closing bracket.
	const tableRe = kind === "cargo" ? CARGO_DEP_TABLE : PY_DEP_TABLE;
	let open: number | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const header = TOML_HEADER.exec(line);
		if (header) {
			if (open !== null) out.push({ start: open, end: i });
			const name = (header[1] ?? "").replaceAll(/['"]/g, "");
			open = tableRe.test(name) ? i + 1 : null;
			continue;
		}
		if (open === null && kind === "python" && PY_DEP_ARRAY.test(line)) {
			out.push({ start: i + 1, end: blockEnd(lines, i, "[", "]") });
		}
	}
	if (open !== null) out.push({ start: open, end: lines.length });
	return out;
}

export function touchesRegion(touch: Touch, region: LineRange): boolean {
	if (touch.gap === "before") return region.start < touch.start && touch.start <= region.end;
	if (touch.gap === "after") return region.start <= touch.start && touch.start < region.end;
	return touch.start <= region.end && region.start <= touch.end;
}

/** Trimmed text of every dependency-region line, for content comparison. */
export function regionText(text: string, regions: LineRange[]): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (const region of regions) {
		for (let n = region.start; n <= region.end; n++) out.push((lines[n - 1] ?? "").trim());
	}
	return out.join("\n");
}

/**
 * Section paths and op footprints of a hashline `edit` payload. Body rows (`+…`)
 * are content, never ops, so a literal `+PUT 3.=4:` row is not read as one.
 */
export function parseHashline(payload: string): PatchSection[] {
	const sections: PatchSection[] = [];
	let current: PatchSection | undefined;
	for (const raw of payload.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const header = HASHLINE_HEADER.exec(line);
		if (header) {
			current = { path: unquote((header[1] ?? "").trim()), touches: [] };
			sections.push(current);
			continue;
		}
		if (!current || line.startsWith("+")) continue;
		const op = HASHLINE_OP.exec(line.trimStart())?.groups;
		if (!op) continue;
		if (op.gap) {
			const at = Number(op.gapLine);
			if (at > 0) current.touches.push({ start: at, end: at, gap: op.gap === "<" ? "before" : "after" });
			continue;
		}
		const start = Number(op.start);
		if (!(start > 0)) continue;
		const end = op.end ? Number(op.end) : start;
		current.touches.push({ start, end: Math.max(start, end) });
	}
	return sections;
}

function toolingFor(kind: ManifestKind, manifestDir: string): Tooling {
	const candidates = LOCKFILES_BY_KIND[kind];
	if (candidates.length > 0) {
		for (const dir of ancestors(manifestDir)) {
			const found = firstPresent(dir, candidates);
			if (found) return TOOLING_BY_LOCKFILE[found] ?? DEFAULT_TOOLING[kind];
		}
	}
	return DEFAULT_TOOLING[kind];
}

function hit(path: string, abs: string, kind: ManifestKind): Hit {
	return { path, abs, kind, ...toolingFor(kind, dirname(abs)) };
}

function manifestTarget(path: string, cwd: string): { abs: string; kind: ManifestKind } | undefined {
	if (!path || NON_FILE_SCHEME.test(path)) return undefined;
	const kind = manifestKind(path);
	if (!kind) return undefined;
	return { abs: isAbsolute(path) ? path : resolve(cwd, path), kind };
}

/** A whole-file write changes deps when its dependency regions differ from the current ones. */
export function adviseForWrite(path: string, content: string, cwd: string, read: Reader): Hit[] {
	const target = manifestTarget(path, cwd);
	if (!target) return [];
	const before = read(target.abs);
	// A manifest that does not exist yet is being scaffolded, not amended.
	if (before === null) return [];
	const previous = regionText(before, depRegions(target.kind, before));
	const next = regionText(content, depRegions(target.kind, content));
	return previous === next ? [] : [hit(path, target.abs, target.kind)];
}

/** A hashline edit changes deps when an op's footprint lands in a dependency region. */
export function adviseForHashline(payload: string, cwd: string, read: Reader): Hit[] {
	const out: Hit[] = [];
	for (const section of parseHashline(payload)) {
		const target = manifestTarget(section.path, cwd);
		if (!target) continue;
		const text = read(target.abs);
		if (text === null) continue;
		const regions = depRegions(target.kind, text);
		const touched = section.touches.some((touch) =>
			regions.some((region) => touchesRegion(touch, region)),
		);
		if (touched) out.push(hit(section.path, target.abs, target.kind));
	}
	return out;
}

/**
 * Replace/patch edit modes carry no line numbers, so the anchor text is the
 * signal: reaching a dependency table means quoting a line from it.
 */
export function adviseForAnchoredEdit(
	path: string,
	payload: string,
	cwd: string,
	read: Reader,
): Hit[] {
	const target = manifestTarget(path, cwd);
	if (!target || !payload) return [];
	const text = read(target.abs);
	if (text === null) return [];
	// A region line long enough to be unique: quoting one means the payload reached the table.
	const lines = regionText(text, depRegions(target.kind, text))
		.split("\n")
		.filter((line) => line.length >= 4 && /[A-Za-z0-9]/.test(line));
	return lines.some((line) => payload.includes(line)) ? [hit(path, target.abs, target.kind)] : [];
}

/** Literal fragments of an ast-grep pattern, with metavariables removed. */
export function patternLiterals(pattern: string): string[] {
	return pattern
		.split(/\$+[A-Z_][A-Z0-9_]*|\$+_/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 3);
}

export function adviseForAstEdit(
	paths: string[],
	patterns: string[],
	cwd: string,
	read: Reader,
): Hit[] {
	const out: Hit[] = [];
	const literals = patterns.flatMap(patternLiterals);
	if (literals.length === 0) return out;
	for (const path of paths) {
		const target = manifestTarget(path, cwd);
		if (!target) continue;
		const text = read(target.abs);
		if (text === null) continue;
		const region = regionText(text, depRegions(target.kind, text));
		if (region && literals.some((literal) => region.includes(literal))) {
			out.push(hit(path, target.abs, target.kind));
		}
	}
	return out;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pathFields(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["path", "file_path", "_path"] as const) {
		const value = stringField(input, key);
		if (value) out.push(value);
	}
	const paths = input.paths;
	if (Array.isArray(paths)) {
		for (const value of paths) if (typeof value === "string" && value) out.push(value);
	}
	return [...new Set(out)];
}

function astPatterns(input: Record<string, unknown>): string[] {
	const ops = input.ops;
	if (!Array.isArray(ops)) return [];
	const out: string[] = [];
	for (const op of ops) {
		if (op && typeof op === "object") {
			const pat = (op as Record<string, unknown>).pat;
			if (typeof pat === "string" && pat) out.push(pat);
		}
	}
	return out;
}

export function collectHits(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	read: Reader = readText,
): Hit[] {
	if (toolName === "write") {
		const path = stringField(input, "path") ?? stringField(input, "file_path");
		const content = input.content;
		if (!path || typeof content !== "string") return [];
		return adviseForWrite(path, content, cwd, read);
	}

	if (toolName === "edit") {
		const payload = stringField(input, "input") ?? stringField(input, "_input");
		if (payload) return adviseForHashline(payload, cwd, read);
		const anchors = EDIT_PAYLOAD_KEYS.map((key) => stringField(input, key))
			.filter((value): value is string => value !== undefined)
			.join("\n");
		const out: Hit[] = [];
		for (const path of pathFields(input)) out.push(...adviseForAnchoredEdit(path, anchors, cwd, read));
		return out;
	}

	if (toolName === "ast_edit") {
		return adviseForAstEdit(pathFields(input), astPatterns(input), cwd, read);
	}

	return [];
}

export function formatAdvisory(hits: Hit[], cwd: string): string {
	const lines = hits.map((entry) => {
		const shown = isAbsolute(entry.path) ? relative(cwd, entry.abs) || entry.path : entry.path;
		return `- ${shown}: \`${entry.cli} <package>\` resolves the version and updates ${entry.lock}.`;
	});
	return [
		"DEPENDENCY MANIFEST ADVISORY: this change edits a dependency table by hand.",
		...lines,
		"A hand-edited manifest leaves the lockfile stale until an install runs, and pins whatever version was typed rather than the latest compatible one.",
	].join("\n");
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

export default function depManifestAdvisory(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			const hits = collectHits(event.toolName, event.input ?? {}, process.cwd());
			if (hits.length > 0) pending.set(event.toolCallId, hits);
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event: ExtensionToolResultEvent) => {
		try {
			const hits = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			// A failed edit changed nothing, so the reminder is still owed next time.
			if (!hits || event.isError === true) return;
			const fresh = hits.filter((entry) => !advised.has(entry.abs));
			if (fresh.length === 0) return;
			for (const entry of fresh) advised.add(entry.abs);
			return prepend(event, formatAdvisory(fresh, process.cwd()));
		} catch {
			return;
		}
	});
}
