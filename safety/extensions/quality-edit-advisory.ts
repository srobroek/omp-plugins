import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * After enough edits accumulate, suggest targeted checks. Original was
 * PostToolUse additionalContext. OMP equivalent: prepend to tool_result.
 * Fail-open on any I/O or parse error.
 */

const LANGUAGE_MARKERS: Record<string, string[]> = {
	go: ["go.mod"],
	python: ["pyproject.toml"],
	rust: ["Cargo.toml"],
	ts: ["package.json"],
};

const EXTENSION_LANGUAGES: Record<string, string> = {
	".go": "go",
	".py": "python",
	".pyi": "python",
	".rs": "rust",
	".ts": "ts",
	".tsx": "ts",
	".js": "ts",
	".jsx": "ts",
	".mjs": "ts",
	".cjs": "ts",
};

const FILENAME_LANGUAGES: Record<string, string> = {
	"Cargo.toml": "rust",
	"go.mod": "go",
};

const PRECOMMIT_CHECKERS: Record<string, string[]> = {
	go: ["gofmt", "gofumpt", "goimports", "golangci-lint", "go-vet"],
	python: ["ruff", "black", "isort", "flake8", "pyupgrade"],
	rust: ["rustfmt", "cargo-fmt", "clippy", "cargo-clippy"],
	ts: ["biome", "prettier", "eslint", "oxlint", "dprint"],
};

const SUGGESTIONS: Record<string, string> = {
	go: "gofmt -l {files} && go vet ./...",
	python: "ruff check {files} && ruff format --check {files}",
	rust: "cargo fmt --all -- --check && cargo clippy",
	ts: "biome check {files}",
};

const EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);

type Pending = { files: string[]; lines: number; cwd: string };
type Counters = { files: Set<string>; lines: number; last: number };

export function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}

export function findRepoRoot(start: string): string | null {
	try {
		let dir = resolve(start);
		while (true) {
			if (existsSync(join(dir, ".git"))) return dir;
			const parent = resolve(dir, "..");
			if (parent === dir) return null;
			dir = parent;
		}
	} catch {
		return null;
	}
}

export function parseSelection(text: string): Set<string> {
	return new Set(text.replaceAll(",", " ").split(/\s+/).filter(Boolean));
}

export function selectedLanguages(root: string): Set<string> {
	const override = process.env.AGENTIC_QUALITY_LANGS ?? "";
	if (override) return parseSelection(override);
	const found = new Set<string>();
	for (const [language, markers] of Object.entries(LANGUAGE_MARKERS)) {
		if (markers.some((m) => existsSync(join(root, m)))) found.add(language);
	}
	return found;
}

export function languageEnabled(language: string, selected: Set<string>): boolean {
	if (selected.has("all")) return true;
	if (language === "ts") {
		return selected.has("ts") || selected.has("javascript") || selected.has("typescript");
	}
	return selected.has(language);
}

export function languageForFile(path: string): string | undefined {
	const name = basename(path);
	if (name in FILENAME_LANGUAGES) return FILENAME_LANGUAGES[name];
	return EXTENSION_LANGUAGES[extname(path)];
}

export function precommitCovered(root: string): Set<string> {
	const configName = [".pre-commit-config.yaml", ".pre-commit-config.yml"].find((n) =>
		existsSync(join(root, n)),
	);
	if (!configName) return new Set();
	let text = "";
	try {
		text = readFileSync(join(root, configName), "utf8").toLowerCase();
	} catch {
		return new Set();
	}
	const covered = new Set<string>();
	for (const [language, checkers] of Object.entries(PRECOMMIT_CHECKERS)) {
		if (checkers.some((c) => text.includes(c))) covered.add(language);
	}
	return covered;
}

export function editedFiles(input: ToolCallEvent["input"]): string[] {
	// `in` narrows one literal key at a time, so the two spellings stay unrolled.
	if ("file_path" in input && typeof input.file_path === "string" && input.file_path) {
		return [input.file_path];
	}
	if ("path" in input && typeof input.path === "string" && input.path) return [input.path];
	if ("paths" in input && Array.isArray(input.paths)) {
		return input.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
	}
	return [];
}

export function changedLineCount(input: ToolCallEvent["input"]): number {
	// `in` narrows one literal key at a time, so the three payload spellings stay unrolled.
	if ("new_string" in input && typeof input.new_string === "string" && input.new_string) {
		return input.new_string.split("\n").length || 1;
	}
	if ("content" in input && typeof input.content === "string" && input.content) {
		return input.content.split("\n").length || 1;
	}
	if ("out" in input && typeof input.out === "string" && input.out) {
		return input.out.split("\n").length || 1;
	}
	return 1;
}


function cwdOf(event: ToolCallEvent): string {
	// Edit tools carry their own `cwd`; only fall back when the call omits it.
	if (!("cwd" in event.input)) return process.cwd();
	const raw = event.input.cwd;
	if (typeof raw === "string" && raw) return raw;
	return process.cwd();
}

function prepend(
	event: ToolResultEvent,
	text: string,
): { content: ToolResultEvent["content"] } {
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

export default function qualityEditAdvisory(pi: ExtensionAPI): void {
	const pending = new Map<string, Pending>();
	const counters = new Map<string, Counters>();
	pi.on("session_start", () => {
		pending.clear();
		counters.clear();
	});
	pi.on("tool_call", (event) => {
		try {
			if (!EDIT_TOOLS.has(event.toolName)) return;
			const input = event.input;
			const files = editedFiles(input);
			if (!files.length) return;
			pending.set(event.toolCallId, {
				files,
				lines: changedLineCount(input),
				cwd: cwdOf(event),
			});
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event) => {
		try {
			if (!EDIT_TOOLS.has(event.toolName)) return;
			const rec = pending.get(event.toolCallId);
			if (!rec) return;
			pending.delete(event.toolCallId);
			if (event.isError) return;

			const base = findRepoRoot(rec.cwd);
			if (!base) return;

			const selected = selectedLanguages(base);
			if (!selected.size) return;

			const state = counters.get(base) ?? { files: new Set<string>(), lines: 0, last: 0 };
			counters.set(base, state);
			const known = state.files;
			for (const f of rec.files) known.add(f);
			state.lines += rec.lines;
			const totalLines = state.lines;
			const last = state.last;

			const lineThreshold = envInt("AGENTIC_QUALITY_ADVISORY_LINES", 120);
			const fileThreshold = envInt("AGENTIC_QUALITY_ADVISORY_FILES", 5);
			const cooldown = envInt("AGENTIC_QUALITY_ADVISORY_COOLDOWN_SECONDS", 300);
			const now = Math.floor(Date.now() / 1000);
			if (now - last < cooldown) return;
			if (totalLines < lineThreshold && known.size < fileThreshold) return;

			const covered = precommitCovered(base);
			const byLanguage = new Map<string, string[]>();
			for (const path of [...known].sort()) {
				const language = languageForFile(path);
				if (language && languageEnabled(language, selected) && !covered.has(language)) {
					const list = byLanguage.get(language) ?? [];
					list.push(path);
					byLanguage.set(language, list);
				}
			}
			if (!byLanguage.size) return;

			const suggestions: string[] = [];
			for (const [language, paths] of byLanguage) {
				const tmpl = SUGGESTIONS[language];
				if (tmpl) suggestions.push(tmpl.replace("{files}", paths.slice(0, 8).join(" ")));
			}
			if (!suggestions.length) return;

			const preview = [...known].sort();
			let shown = preview.slice(0, 10).join(", ");
			if (preview.length > 10) shown += `, +${preview.length - 10} more`;

			state.last = now;

			const langs = [...byLanguage.keys()].sort().join(", ");
			const text =
				`QUALITY ADVISORY: ${preview.length} file(s) and approximately ${totalLines} ` +
				`changed line(s) in ${langs}. Before committing, ` +
				`run checks on the edited files only where practical. Suggested targeted ` +
				`checks: ${suggestions.join("; ")}. Files: ${shown}`;
			return prepend(event, text);
		} catch {
			return;
		}
	});
}
