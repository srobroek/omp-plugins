/**
 * Shell-shaped reading of a command string, shared by the beads gates.
 *
 * The gates have to answer "is this `bd` / `gh` at a command position, what is its
 * real argument, and which directory does it run in?" A plain regex over the whole
 * string gets the first wrong in two directions: it rewrites
 * `echo bd update x --claim`, and it reads `--body` out of a quoted title. Quotes
 * are the whole difficulty, so they are handled once here rather than in each gate.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellQuoteBalanced, tokenizeShell } from "./shell-tokenizer.ts";

/**
 * This module's public token shape, unchanged by the shared-tokenizer migration.
 * `quoted` means the token BEGAN in quotes, which is the only distinction its
 * consumers make: a command at token position must not be honoured when quoted,
 * while a partially quoted argument such as `--body="..."` stays an option.
 * The shared lexer reports `startsQuoted` and `sawQuote` separately; `tokenize`
 * below narrows that to this contract deliberately rather than by alias.
 */
export type Token = {
	value: string;
	quoted: boolean;
};

const SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "\n": true };

/**
 * Split on separators that sit outside quotes, keeping the separators, so
 * `segments.join("")` reproduces the input exactly.
 */
export function commandSegments(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (quote) {
			current += char;
			if (char === quote && command[i - 1] !== "\\") quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (SEPARATORS[char]) {
			let run = char;
			while (command[i + 1] === char) {
				run += char;
				i++;
			}
			out.push(current, run);
			current = "";
			continue;
		}
		current += char;
	}
	out.push(current);
	return out;
}
/**
 * Public compatibility wrapper retaining shell-command's token shape.
 * It records only whether a token began in quotes; a partial quote such as
 * `--body="..."` remains an option token.
 */
export function tokenize(segment: string): Token[] {
	return tokenizeShell(segment, { preserveBackslashes: true }).map(({ value, startsQuoted }) => ({ value, quoted: startsQuoted }));
}

/**
 * Launchers that run the REAL command after their own arguments, so `bd` behind
 * one is still `bd` at command position. `echo` is deliberately absent: text
 * that merely mentions a command must never be treated as running it.
 */
const WRAPPERS: Record<string, true> = {
	mise: true,
	env: true,
	command: true,
	exec: true,
	nohup: true,
	nice: true,
	time: true,
};

/**
 * The tokens of `segment` from `argv` onward when it invokes `argv` at command
 * position, looking through `VAR=value` prefixes and wrapper launchers, and
 * matching a path (`/usr/bin/bd`) by its basename; null when it invokes
 * something else.
 */
export function invocation(segment: string, argv: string[]): Token[] | null {
	const tokens = tokenize(segment);
	const head = argv[0];
	if (!head) return null;
	let start = 0;
	for (; start < tokens.length; start++) {
		const token = tokens[start];
		if (!token || token.quoted) return null;
		const basename = token.value.split("/").pop() ?? token.value;
		if (basename === head) break;
		const skippable =
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) ||
			token.value.startsWith("-") ||
			WRAPPERS[basename] === true;
		if (!skippable) return null;
	}
	for (const [offset, word] of argv.entries()) {
		const token = tokens[start + offset];
		if (!token || token.quoted) return null;
		const value = offset === 0 ? (token.value.split("/").pop() ?? token.value) : token.value;
		if (value !== word) return null;
	}
	return tokens.slice(start);
}

/**
 * The directory a command line really runs in: `cwd`, or the target of a literal
 * leading `cd <path> &&`.
 *
 * Only that one literal shape. A shell expansion, a wrapper, or a quoted or
 * globbed path is left unresolved, because guessing the directory wrong points a
 * gate at the wrong repository, and reporting `cwd` unchanged is the honest answer.
 */
export function leadingCdCwd(command: string, cwd: string): string {
	const match = /^\s*cd\s+([^\s;&]+)\s*&&/.exec(command);
	if (!match) return cwd;
	const dir = match[1];
	if (dir === undefined || /^[-~$]/.test(dir) || /[\\`"'*?[\]{}]/.test(dir)) return cwd;
	return dir.startsWith("/") ? dir : resolve(cwd, dir);
}

/** A parsed shell command. Tokens are command-position words, never prose. */
export type ParsedCommand = {
	command: string;
	segments: string[][];
	unknown: boolean;
	nested: ParsedCommand[];
};

export type CommandClass = "read-only" | "mutating" | "unknown";

const MUTATING_BD = new Set([
	"create", "new", "create-form", "update", "close", "done", "claim", "release", "edit",
	"delete", "rm", "purge", "init", "sync", "import", "export", "reopen", "dep", "stack",
]);
const READ_BD = new Set(["show", "list", "ready", "status", "comments", "lint", "version", "doctor", "prime"]);

function commandWords(source: string): string[][] {
	const words = tokenizeShell(source).map(token => token.startsQuoted ? `\u0000${token.value}` : token.value);
	const out: string[][] = [];
	let current: string[] = [];
	for (const word of words) {
		if ([";", "&&", "||", "&", "|", "\n"].includes(word)) {
			if (current.length) out.push(current);
			current = [];
			continue;
		}
		if (word === "(") {
			if (current.length) out.push(current);
			current = [];
			continue;
		}
		if (word === ")") {
			if (current.length) out.push(current);
			current = [];
			continue;
		}
		current.push(word);
	}
	if (current.length) out.push(current);
	return out;
}

function nestedCommands(source: string): { commands: string[]; unknown: boolean } {
	const commands: string[] = [];
	let unknown = false;
	for (const match of source.matchAll(/\$\(([^()]*)\)/g)) {
		if (match[1] !== undefined) commands.push(match[1]);
	}
	if (!source.includes("'`")) {
		for (const match of source.matchAll(/`([^`]*)`/g)) if (match[1] !== undefined) commands.push(match[1]);
	}
	for (const match of source.matchAll(/\b(?:bash|sh|zsh|dash|ksh)\s+-c\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
		const value = match[1];
		if (!value || value.startsWith("\"$") || value.startsWith("'$")) unknown = true;
		else commands.push(value.replace(/^['"]|['"]$/g, ""));
	}
	for (const match of source.matchAll(/\beval\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
		const value = match[1];
		if (value) commands.push(value.replace(/^['"]|['"]$/g, ""));
	}
	return { commands, unknown };
}

/** Parse shell syntax without executing it; literals and quoted heredocs stay inert. */
export function parse(command: string): ParsedCommand {
	if (command.length > 64_000 || !shellQuoteBalanced(command)) return { command, segments: [], unknown: true, nested: [] };
	const segments = commandWords(command);
	const nested = nestedCommands(command);
	const children = nested.commands.map(parse);
	return { command, segments, unknown: nested.unknown || children.some(child => child.unknown), nested: children };
}

/** Classify a parsed command, including recursively executable substitutions. */
export function classify(parsed: ParsedCommand): CommandClass {
	if (parsed.unknown) return "unknown";
	let result: CommandClass = "read-only";
	for (const words of parsed.segments) {
		const executable = words.find(word => !word.startsWith("\u0000") && !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word) && !word.startsWith("-"));
		if (!executable) continue;
		const base = executable.split("/").pop() ?? executable;
		if (base === "bd") {
			const verb = words.slice(words.indexOf(executable) + 1).find(word => !word.startsWith("\u0000") && !word.startsWith("-"));
			if (!verb || !READ_BD.has(verb)) result = "mutating";
		} else if (["npm", "bun", "uv", "cargo", "rm", "mv", "cp", "mkdir", "touch"].includes(base)) {
			result = "mutating";
		}
	}
	for (const child of parsed.nested) {
		const nestedClass = classify(child);
		if (nestedClass === "unknown") return "unknown";
		if (nestedClass === "mutating") result = "mutating";
	}
	return result;
}

type SettingsCache = { at: number; value: Record<string, unknown> };
const settingsCache = new Map<string, SettingsCache>();
function settingValue(root: Record<string, unknown>, plugin: string, gate: string): unknown {
	const plugins = root.plugins;
	if (!plugins || typeof plugins !== "object") return undefined;
	const config = (plugins as Record<string, unknown>)[plugin];
	if (!config || typeof config !== "object") return undefined;
	const gates = (config as Record<string, unknown>).gates;
	if (!gates || typeof gates !== "object") return undefined;
	const selected = (gates as Record<string, unknown>)[gate];
	return selected && typeof selected === "object" ? (selected as Record<string, unknown>).enabled : undefined;
}

/** Read the documented on-disk gate toggle, with a short cache for live edits. */
export function settingsEnabled(plugin: string, gate: string, cwd = process.cwd()): boolean {
	const now = Date.now();
	const cached = settingsCache.get(cwd);
	let merged: Record<string, unknown> = {};
	if (cached && now - cached.at < 5_000) merged = cached.value;
	else {
		const files = [resolve(cwd, ".omp/config.yml"), resolve(cwd, ".omp/settings.json"), resolve(process.env.HOME ?? "~", ".omp/agent/config.yml")];
		for (const file of files) {
			try {
				const text = readFileSync(file, "utf8");
				const parsed = file.endsWith(".json") ? JSON.parse(text) : (Bun as typeof Bun & { YAML?: { parse(text: string): unknown } }).YAML?.parse(text);
				if (parsed && typeof parsed === "object") merged = { ...merged, ...(parsed as Record<string, unknown>) };
			} catch { /* missing or malformed settings retain safe defaults */ }
		}
		settingsCache.set(cwd, { at: now, value: merged });
	}
	return settingValue(merged, plugin, gate) !== false;
}

export function blockReason(input: { gate: string; plugin?: string; cause: string; resolution: string }): string {
	const plugin = input.plugin ?? "beads";
	return `${input.cause}; ${input.resolution}. Disable locally: set plugins.${plugin}.gates.${input.gate}.enabled=false`;
}