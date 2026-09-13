import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
    ExtensionAPI,
    ToolCallEvent,
    ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import { ancestors, firstPresent, readText } from "./lib";

/**
 * Advises the modern tool when a bash command reaches for the legacy one AND the
 * modern counterpart is already configured in the tree. Scoped tight on purpose:
 * with no marker file the repo has made no such choice, and advising anyway would
 * be a migration the agent was never asked for.
 */

/** A file whose presence proves the modern tool owns this tree; `contains` narrows it. */
type Marker = { file: string; contains?: string };

type ToolSwap = {
	id: string;
	legacyName: string;
	/** Returns whether a command-position token sequence invokes the legacy tool. */
	matches: (words: readonly string[]) => boolean;
	markers: readonly Marker[];
	/** Files proving the legacy tool is still load-bearing here. */
	blockedBy?: readonly string[];
	modern: string;
	hint: string;
};

const UV_MARKERS: readonly Marker[] = [
	{ file: "uv.lock" },
	{ file: "pyproject.toml", contains: "[tool.uv]" },
];

const SWAPS: readonly ToolSwap[] = [
	{
		id: "npm-to-bun",
		legacyName: "npm/yarn",
		matches: (words) =>
			(words[0] === "npm" || words[0] === "yarn") &&
			(words[1] === "install" || words[1] === "add" || words[1] === "i"),
		markers: [{ file: "bun.lock" }, { file: "bun.lockb" }, { file: "bunfig.toml" }],
		modern: "bun",
		hint: "bun install / bun add <package>",
	},
	{
		id: "pip-to-uv",
		legacyName: "pip",
		matches: (words) =>
			(words[0] === "pip" || words[0] === "pip3") && words[1] === "install" ||
			(words[0] === "python" || words[0] === "python3") &&
			words[1] === "-m" &&
			(words[2] === "pip" || words[2] === "pip3") &&
			words[3] === "install",
		markers: UV_MARKERS,
		modern: "uv",
		hint: "uv add <package> / uv sync",
	},
	{
		id: "poetry-to-uv",
		legacyName: "poetry",
		matches: (words) => words[0] === "poetry" && /^[a-z]/.test(words[1] ?? ""),
		markers: UV_MARKERS,
		modern: "uv",
		hint: "uv add / uv sync / uv run",
	},
	{
		id: "version-manager-to-mise",
		legacyName: "nvm/pyenv",
		matches: (words) =>
			(words[0] === "nvm" || words[0] === "pyenv") && /^[a-z]/.test(words[1] ?? ""),
		markers: [{ file: "mise.toml" }, { file: ".mise.toml" }],
		modern: "mise",
		hint: "mise use <tool>@<version> / mise install",
	},
	{
		id: "make-to-just",
		legacyName: "make",
		matches: (words) => words[0] === "make" || words[0] === "gmake",
		markers: [{ file: "justfile" }, { file: "Justfile" }, { file: ".justfile" }],
		blockedBy: ["Makefile", "makefile", "GNUmakefile"],
		modern: "just",
		hint: "just <recipe> (just --list)",
	},
];


export type SwapHit = {
	id: string;
	legacyName: string;
	modern: string;
	hint: string;
	marker: string;
};


/** The marker proving the modern tool owns this tree, searched from cwd upward. */
function configuredMarker(swap: ToolSwap, cwd: string): string | undefined {
	for (const dir of ancestors(cwd)) {
		if (swap.blockedBy && firstPresent(dir, swap.blockedBy)) return undefined;
		for (const marker of swap.markers) {
			const path = join(dir, marker.file);
			if (!existsSync(path)) continue;
			if (!marker.contains || (readText(path) ?? "").includes(marker.contains)) return marker.file;
		}
	}
	return undefined;
}

type ShellToken = { text: string; separator: boolean };

/** Copied locally from delivery's main-branch-gate tokenizer; plugin boundaries stay isolated. */
function tokenize(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;
	const flush = () => {
		if (word) tokens.push({ text: word, separator: false });
		word = "";
	};
	const separator = (text: string) => {
		flush();
		tokens.push({ text, separator: true });
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			else word += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && i + 1 < command.length) word += command[++i]!;
			else if (ch === "$" && command[i + 1] === "(") separator("$(");
			else if (ch === "`") separator("`");
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			word += command[++i]!;
			continue;
		}
		if (/\s/.test(ch)) {
			if (ch === "\n" || ch === "\r") separator("\n");
			else flush();
			continue;
		}
		if (ch === ";") {
			separator(";");
			continue;
		}
		if (ch === "|") {
			separator(command[i + 1] === "|" ? "||" : "|");
			if (command[i + 1] === "|") i++;
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			separator("&&");
			i++;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			separator("$(");
			i++;
			continue;
		}
		if (ch === "`" || ch === ")") {
			separator(ch);
			continue;
		}
		word += ch;
	}
	flush();
	return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS: Record<string, true> = { env: true, sudo: true, nice: true, time: true };
const VALUE_OPTIONS: Record<string, true> = {
	"-u": true,
	"-C": true,
	"-n": true,
	"--user": true,
	"--group": true,
	"--chdir": true,
	"--adjustment": true,
};

function commandWords(segment: readonly string[]): readonly string[] {
	let i = 0;
	while (i < segment.length) {
		const word = segment[i]!;
		if (ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (!WRAPPERS[word]) break;
		i++;
		while (i < segment.length && segment[i]!.startsWith("-")) {
			const option = segment[i++]!;
			if (VALUE_OPTIONS[option]) i++;
		}
	}
	return segment.slice(i);
}

function commandSegments(command: string): readonly (readonly string[])[] {
	const segments: string[][] = [[]];
	for (const token of tokenize(command)) {
		if (token.separator) segments.push([]);
		else segments[segments.length - 1]!.push(token.text);
	}
	return segments.map(commandWords);
}

export function decideSwaps(command: string, cwd: string): SwapHit[] {
	const segments = commandSegments(command);
	const out: SwapHit[] = [];
	for (const swap of SWAPS) {
		if (!segments.some((words) => swap.matches(words))) continue;
		const marker = configuredMarker(swap, cwd);
		if (!marker) continue;
		out.push({ id: swap.id, legacyName: swap.legacyName, modern: swap.modern, hint: swap.hint, marker });
	}
	return out;
}

export function formatAdvisory(hits: SwapHit[]): string {
	const lines = hits.map(
		(entry) =>
			`- ${entry.marker} is present, so this tree runs on ${entry.modern}: use \`${entry.hint}\` instead of ${entry.legacyName}.`,
	);
	return [
		"TOOLCHAIN ADVISORY: this command used a legacy tool the repo has already replaced.",
		...lines,
		"Mixing the two managers writes a second lockfile and resolves versions differently.",
	].join("\n");
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

export default function preferToolsAdvisory(pi: ExtensionAPI): void {
	const pending = new Map<string, SwapHit[]>();
	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		try {
			if (event.toolName !== "bash") return;
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!command) return;
			const cwd =
				typeof event.input.cwd === "string" && event.input.cwd
					? resolve(ctx.cwd, event.input.cwd)
					: ctx.cwd;
			const hits = decideSwaps(command, cwd);
			if (hits.length === 0) return;
			pending.set(event.toolCallId, hits);
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		try {
			const hits = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			// A failed run still made the tool choice, so the advisory stands either way.
			if (!hits) return;
			return prepend(event, formatAdvisory(hits));
		} catch {
			return;
		}
	});
}
