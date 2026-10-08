import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
    ExtensionAPI,
    ToolCallEvent,
    ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import { commandWords } from "./command-words.ts";
import { ancestors, expandHome, firstPresent, readText, type ToolResultContext } from "./lib";
import { type ShellToken, tokenizeShell } from "./shell-tokenizer.ts";

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
	/** Returns whether a command-position token sequence invokes the legacy tool to change state. */
	matches: (words: readonly string[]) => boolean;
	markers: readonly Marker[];
	/** Files proving the legacy tool is still load-bearing here. */
	blockedBy?: readonly string[];
	modern: string;
	hint: string;
	/** What running the legacy tool costs in a tree the modern one owns. */
	cost: string;
};

const UV_MARKERS: readonly Marker[] = [
	{ file: "uv.lock" },
	{ file: "pyproject.toml", contains: "[tool.uv]" },
];

/** poetry subcommands that change the dependencies, the lockfile, or the environment. */
const POETRY_MUTATING: ReadonlySet<string> = new Set(["add", "remove", "install", "update", "lock", "sync"]);

/**
 * Version-manager subcommands that install or select a version, each with the
 * operands it needs to do so: bare, `pyenv local` and `nvm alias default` only report.
 */
const VERSION_MUTATING: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
	["nvm", new Map([["install", 0], ["uninstall", 1], ["use", 0], ["alias", 2], ["unalias", 1]])],
	["pyenv", new Map([["install", 0], ["uninstall", 1], ["local", 1], ["global", 1], ["shell", 1]])],
]);

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
		cost: "npm and yarn write their own lockfile beside bun.lock and resolve versions differently.",
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
		cost: "pip installs without recording the package in pyproject.toml or uv.lock, so the next `uv sync` removes it.",
	},
	{
		id: "poetry-to-uv",
		legacyName: "poetry",
		matches: (words) => words[0] === "poetry" && POETRY_MUTATING.has(words[1] ?? ""),
		markers: UV_MARKERS,
		modern: "uv",
		hint: "uv add / uv sync / uv run",
		cost: "poetry resolves from its own poetry.lock, which uv neither reads nor updates.",
	},
	{
		id: "version-manager-to-mise",
		legacyName: "nvm/pyenv",
		matches: (words) => {
			const operands = VERSION_MUTATING.get(words[0] ?? "")?.get(words[1] ?? "");
			return operands !== undefined && words.length - 2 >= operands;
		},
		markers: [{ file: "mise.toml" }, { file: ".mise.toml" }],
		modern: "mise",
		hint: "mise use <tool>@<version> / mise install",
		cost: "nvm and pyenv select the version outside mise's config, so this shell and mise-run tasks can run different versions.",
	},
	{
		id: "make-to-just",
		legacyName: "make",
		matches: (words) => words[0] === "make" || words[0] === "gmake",
		markers: [{ file: "justfile" }, { file: "Justfile" }, { file: ".justfile" }],
		blockedBy: ["Makefile", "makefile", "GNUmakefile"],
		modern: "just",
		hint: "just <recipe> (just --list)",
		cost: "The tasks live in the justfile, which make does not read.",
	},
];


export type SwapHit = {
	id: string;
	legacyName: string;
	modern: string;
	hint: string;
	cost: string;
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

/** Separator tokens from `tokenizeShell`; `&&`/`||` arrive as two tokens each. */
const SEPARATORS: ReadonlySet<string> = new Set([";", "&", "|", "\n", "(", ")", "$("]);
/** Reserved words that open or continue a compound command; the command word follows them. */
const RESERVED: ReadonlySet<string> = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"]);
/** Command substitutions, read wherever they appear: a single-quoted one is over-matched. */
const SUBSTITUTION = /`([^`]*)`|\$\(([^()]*)\)/g;

/** A simple command's words once wrappers are dropped, and the directory it runs in. */
type Invocation = { argv: readonly string[]; cwd: string };

function invocation(segment: readonly ShellToken[], cwd: string): Invocation | undefined {
	let start = 0;
	for (const token of segment) {
		if (token.sawQuote || !RESERVED.has(token.value)) break;
		start++;
	}
	const { argv, directories } = commandWords(segment.slice(start).map((token) => token.value));
	if (argv.length === 0) return undefined;
	// `env -C DIR` and `sudo -D DIR` run the command in DIR, so its markers are read there.
	return { argv, cwd: directories.reduce((dir, next) => resolve(dir, expandHome(next)), cwd) };
}

/**
 * Every simple command in `command`. Words are read quote-aware at command
 * position only, so `echo "npm install"` is data; here-document bodies count only
 * for their substitutions.
 */
function invocations(command: string, cwd: string): Invocation[] {
	const out: Invocation[] = [];
	let segment: ShellToken[] = [];
	const flush = () => {
		const found = invocation(segment, cwd);
		if (found) out.push(found);
		segment = [];
	};
	for (const token of tokenizeShell(command, { hereDocumentSubstitutionsOnly: true })) {
		if (token.sawQuote || !SEPARATORS.has(token.value)) segment.push(token);
		else flush();
	}
	flush();
	for (const match of command.matchAll(SUBSTITUTION)) out.push(...invocations(match[1] ?? match[2] ?? "", cwd));
	return out;
}

export function decideSwaps(command: string, cwd: string): SwapHit[] {
	const runs = invocations(command, cwd);
	const out: SwapHit[] = [];
	for (const swap of SWAPS) {
		for (const run of runs) {
			if (!swap.matches(run.argv)) continue;
			const marker = configuredMarker(swap, run.cwd);
			if (!marker) continue;
			out.push({ id: swap.id, legacyName: swap.legacyName, modern: swap.modern, hint: swap.hint, cost: swap.cost, marker });
			break;
		}
	}
	return out;
}

export function formatAdvisory(hits: SwapHit[]): string {
	const lines = hits.map(
		(entry) =>
			`- ${entry.marker} is present, so this tree runs on ${entry.modern}: use \`${entry.hint}\` instead of ${entry.legacyName}. ${entry.cost}`,
	);
	return [
		"TOOLCHAIN ADVISORY: this command used a legacy tool the repo has already replaced.",
		...lines,
	].join("\n");
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

	pi.on("tool_result", (event: ToolResultEvent): ToolResultContext | undefined => {
		try {
			const hits = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			// A failed run wrote no lockfile and selected no version, so it gets no advice.
			if (!hits || event.isError === true) return;
			return { additionalContext: formatAdvisory(hits) };
		} catch {
			return;
		}
	});
}
