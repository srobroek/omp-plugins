import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LangVariant, parse as parseShSyntax } from "sh-syntax";
import { shellQuoteBalanced, tokenizeShell } from "./shell-tokenizer.ts";

/** A token in a command-position argv. Quoted words are data, not executable names. */
export type Token = { value: string; quoted: boolean };

const OPERATORS: Record<string, true> = { ";": true, "&&": true, "||": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "{": true, "}": true };
const WRAPPERS: Record<string, true> = {
	mise: true,
	env: true,
	command: true,
	exec: true,
	nohup: true,
	nice: true,
    sudo: true,
	xargs: true,
};

/** Split shell source at operators outside quoted words. */
export function commandSegments(command: string): string[] {
	const out: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") escaped = true;
			else if (ch === '"') quote = null;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			out.push(command.slice(start, i), two);
			i++;
			start = i + 1;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
			out.push(command.slice(start, i), ch);
			start = i + 1;
		}
	}
	out.push(command.slice(start));
	return out;
}

/** Preserve the historical token surface used by non-bash lifecycle helpers. */
export function tokenize(segment: string): Token[] {
	return tokenizeShell(segment, { preserveBackslashes: true }).map(({ value, startsQuoted }) => ({ value, quoted: startsQuoted }));
}

/** Return argv beginning at a command name, accepting literal env/wrapper prefixes. */
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
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) && !token.value.startsWith("-") && WRAPPERS[basename] !== true) return null;
	}
	for (const [offset, word] of argv.entries()) {
		const token = tokens[start + offset];
		if (!token || token.quoted) return null;
		const value = offset === 0 ? (token.value.split("/").pop() ?? token.value) : token.value;
		if (value !== word) return null;
	}
	return tokens.slice(start);
}

export function leadingCdCwd(command: string, cwd: string): string {
	const match = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command);
	if (!match) return cwd;
	const dir = match[1];
	if (!dir || /^[-~$]/.test(dir) || /[\\`"'*?\x5b\x5d{}]/.test(dir)) return cwd;
	return dir.startsWith("/") ? dir : resolve(cwd, dir);
}

export type CommandPosition = {
	raw: string;
	words: Token[];
	argv: string[];
	executable?: string;
};

export type ParsedCommand = {
	command: string;
	/** String argv segments retained for existing gate helpers. */
	segments: string[][];
	/** Raw command-position segments, preserving quoting for gate decisions. */
	commands: CommandPosition[];
	unknown: boolean;
	nested: ParsedCommand[];
};

export type ParseFailure = ParsedCommand & { kind: "parse-failure"; reason: string };
export type CommandClass = "read-only" | "mutating" | "unknown";

const READ_BD: Record<string, true> = { show: true, list: true, ready: true, status: true, comments: true, lint: true, version: true, doctor: true, prime: true };
const MUTATING_TOOLS: Record<string, true> = { npm: true, bun: true, uv: true, cargo: true, rm: true, mv: true, cp: true, mkdir: true, touch: true, install: true };

function splitCommands(source: string): CommandPosition[] {
	const positions: CommandPosition[] = [];
	let current: Token[] = [];
	const flush = (): void => {
		if (current.length === 0) return;
		const words = [...current];
		const argv = words.map(word => word.value);
		let index = 0;
		while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "") || words[index]?.value === "!")) index++;
		while (index < words.length && WRAPPERS[words[index]?.value.split("/").pop() ?? words[index]?.value ?? ""] === true) {
			const wrapper = words[index]?.value.split("/").pop() ?? words[index]?.value ?? "";
			index++;
			if (wrapper === "env") while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "") || words[index]?.value?.startsWith("-") === true)) index++;
			if (wrapper === "xargs") while (index < words.length && words[index]?.value?.startsWith("-") === true) index++;
			if (wrapper === "sudo") while (index < words.length && words[index]?.value?.startsWith("-") === true) { index++; if (index < words.length && words[index]?.value?.startsWith("-") === false) index++; }
		}
		const executable = words[index] && !words[index]?.quoted ? words[index]?.value : undefined;
		const raw = words.map(word => word.quoted ? `'${word.value.replaceAll("'", "'\\''")}'` : word.value).join(" ");
		positions.push({ raw, words, argv, executable });
		current = [];
	};
	for (const token of tokenize(source)) {
		if (OPERATORS[token.value] === true) {
			flush();
			continue;
		}
		current.push(token);
	}
	flush();
	return positions;
}

function nestedSources(source: string): { sources: string[]; unknown: boolean } {
	const sources: string[] = [];
	let unknown = false;
	let depth = 0;
	let start = -1;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") i++;
			else if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'") {
			quote = "'";
			continue;
		}
		if (ch === '"') {
			quote = '"';
			continue;
		}
		if (ch === '`') {
			const end = source.indexOf('`', i + 1);
			if (end < 0) return { sources, unknown: true };
			sources.push(source.slice(i + 1, end));
			i = end;
			continue;
		}
		if (source.startsWith("$(", i)) {
			if (depth++ === 0) start = i + 2;
			i++;
			continue;
		}
		if (depth > 0 && ch === ")") {
			if (--depth === 0) sources.push(source.slice(start, i));
		}
	}
	if (depth !== 0) unknown = true;
// Command substitutions and backticks remain executable inside double quotes.
for (const match of source.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
	const body = match[1] ?? "";
	for (const substitution of body.matchAll(/\$\(([^()]*)\)/g)) if (substitution[1] !== undefined) sources.push(substitution[1]);
	for (const substitution of body.matchAll(/`([^`]*)`/g)) if (substitution[1] !== undefined) sources.push(substitution[1]);
}
for (const match of source.matchAll(/\b(?:bash|sh|zsh|dash|ksh)\s+-c\s+((?:'[^']*')|(?:"[^"]*")|[^\s;&|]+)/g)) {
	const value = match[1];
	if (!value || value.startsWith("\"$") || value.startsWith("'$")) unknown = true;
	else sources.push(value.replace(/^['"]|['"]$/g, ""));
}
for (const match of source.matchAll(/\beval\s+((?:'[^']*')|(?:"[^"]*")|[^\s;&|]+)/g)) {
	const value = match[1];
	if (value?.startsWith("$")) unknown = true;
	else if (value) sources.push(value.replace(/^['"]|['"]$/g, ""));
}
for (const match of source.matchAll(/\bxargs(?:\s+-[^\s;&|]+)*\s+([^;&|]+?)(?=\s*(?:[;&|]|$))/g)) {
	const value = match[1]?.trim();
	if (value?.startsWith("$")) unknown = true;
	else if (value) sources.push(value.replace(/^['"]|['"]$/g, ""));
}
	return { sources, unknown };
}

function staticParse(command: string): ParsedCommand | ParseFailure {
	if (command.length > 64_000) return { kind: "parse-failure", reason: "input exceeds 64000 characters", command, segments: [], commands: [], unknown: true, nested: [] };
	if (!shellQuoteBalanced(command)) return { kind: "parse-failure", reason: "unbalanced shell quote", command, segments: [], commands: [], unknown: true, nested: [] };
	const commands = splitCommands(command);
	const nested = nestedSources(command);
	const children = nested.sources.map(staticParse);
	const unknown = nested.unknown || children.some(child => child.unknown);
	return {
		command,
		segments: commands.map(position => position.argv),
		commands,
		unknown,
		nested: children,
	};
}

/** Synchronous structural parse used by tests and callers that already have syntax proof. */
export function parse(command: string): ParsedCommand | ParseFailure {
	return staticParse(command);
}

/** Validate shell grammar with mvdan/sh before dispatching any gate. */
export async function parseCommand(command: string): Promise<ParsedCommand | ParseFailure> {
	const parsed = staticParse(command);
	if (parsed.unknown || "kind" in parsed) return parsed;
	try {
		await parseShSyntax(command, { variant: LangVariant.LangBash });
	} catch (error) {
		return { ...parsed, kind: "parse-failure", reason: error instanceof Error ? error.message : String(error), unknown: true };
	}
	return parsed;
}

function commandClass(position: CommandPosition): CommandClass {
	const executable = position.executable;
	if (!executable) return "unknown";
	const base = executable.split("/").pop() ?? executable;
	if (base === "bd") {
		const verb = position.argv.slice(position.argv.indexOf(executable) + 1).find(word => !word.startsWith("-"));
    return verb && READ_BD[verb] === true ? "read-only" : "mutating";
    }
    return MUTATING_TOOLS[base] === true ? "mutating" : "read-only";
}

export function classify(parsed: ParsedCommand | ParseFailure): CommandClass {
	if (parsed.unknown) return "unknown";
	let result: CommandClass = "read-only";
	for (const position of parsed.commands) {
		const next = commandClass(position);
		if (next === "unknown") result = "unknown";
		else if (next === "mutating") result = "mutating";
	}
	for (const child of parsed.nested) {
		const next = classify(child);
		if (next === "unknown") return "unknown";
		if (next === "mutating") result = "mutating";
	}
	return result;
}

export function commandFromInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const value = input as Record<string, unknown>;
	if (typeof value.command === "string") return value.command;
	if (typeof value.cmd === "string") return value.cmd;
	return "";
}

export type ParsedInvocation = { position: CommandPosition; command: string; args: string[]; verb?: string; globals: string[] };

/** Find executable invocations recursively from the shared command-position model. */
export function parsedInvocations(parsed: ParsedCommand | ParseFailure, executable = "bd"): ParsedInvocation[] {
	if (parsed.unknown) return [];
	const found: ParsedInvocation[] = [];
	for (const position of parsed.commands) {
        const executableName = position.executable?.split("/").pop();
        if (executableName !== executable) continue;
        const index = position.argv.findIndex((word, i) => !position.words[i]?.quoted && (word.split("/").pop() ?? word) === executable);
        if (index < 0) continue;
		const args = position.argv.slice(index + 1);
		const globals: string[] = [];
		let verb: string | undefined;
		for (let i = 0; i < args.length; i++) {
			const word = args[i];
			if (word === undefined) continue;
			if (word.startsWith("-") && verb === undefined) {
				globals.push(word);
				const next = args[i + 1];
				if (!["--global", "--claim", "--force", "--json"].includes(word) && !word.includes("=") && next !== undefined && !next.startsWith("-")) {
					globals.push(next);
					i++;
				}
				continue;
			}
			if (verb === undefined && !word.startsWith("\u0000")) verb = word;
		}
		found.push({ position, command: position.raw, args, verb, globals });
	}
	for (const child of parsed.nested) found.push(...parsedInvocations(child, executable));
	return found;
}
export type CloseInvocation = { ids: string[]; dbArgs: string[] };
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
const CLOSE_VERBS: Record<string, true> = { close: true, done: true };
const DB_VALUE_FLAGS: Record<string, true> = { "--db": true, "-C": true, "--directory": true };
const VALUE_FLAGS: Record<string, true> = { "--reason": true, "-r": true, "--message": true, "--session": true, "--assignee": true, "--status": true, "--type": true };

/** Extract close invocations from the shared parser, including recursively executed children. */
export function closeInvocations(command: string): CloseInvocation[] {
	const parsed = parse(command);
	if (parsed.unknown) return [];
	const out: CloseInvocation[] = [];
	for (const invocation of parsedInvocations(parsed)) {
		if (!invocation.verb || CLOSE_VERBS[invocation.verb.toLowerCase()] !== true) continue;
		const ids: string[] = [];
		const dbArgs: string[] = [];
		const args = invocation.args;
		let verbSeen = false;
		for (let i = 0; i < args.length; i++) {
			const token = args[i];
			if (token === undefined) continue;
			if (!verbSeen) {
				if (token.toLowerCase() === invocation.verb.toLowerCase()) verbSeen = true;
				else if (token.startsWith("-")) {
					const flag = token.split("=", 1)[0] ?? "";
					if (DB_VALUE_FLAGS[flag] === true) {
						dbArgs.push(token);
						const next = args[i + 1];
						if (!token.includes("=") && next !== undefined) {
							dbArgs.push(next);
							i++;
						}
					} else if (token === "--global") dbArgs.push(token);
				}
				continue;
			}
			if (token.startsWith("-")) {
				const flag = token.split("=", 1)[0] ?? "";
				if (DB_VALUE_FLAGS[flag] === true) {
					dbArgs.push(token);
					const next = args[i + 1];
					if (!token.includes("=") && next !== undefined) {
						dbArgs.push(next);
						i++;
					}
				} else if (token === "--global") dbArgs.push(token);
				else if (VALUE_FLAGS[flag] === true && !token.includes("=") && args[i + 1] !== undefined) i++;
				continue;
			}
			if (BEAD_ID.test(token)) ids.push(token);
		}
		out.push({ ids, dbArgs });
	}
	return out;
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

export function settingsEnabled(plugin: string, gate: string, cwd = process.cwd()): boolean {
	const now = Date.now();
	const cached = settingsCache.get(cwd);
	let merged: Record<string, unknown> = {};
	if (cached && now - cached.at < 500) merged = cached.value;
	else {
		const files = [resolve(cwd, ".omp/config.yml"), resolve(cwd, ".omp/settings.json"), resolve(process.env.HOME ?? "~", ".omp/agent/settings.json")];
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
