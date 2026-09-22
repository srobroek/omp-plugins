import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellQuoteBalanced, tokenizeShell } from "./shell-tokenizer.ts";

/** One shell token with both source-preserving and execution-normalized values. */
export type Token = { value: string; normalized: string; quoted: boolean };

const OPERATORS: Record<string, true> = { ";": true, "&&": true, "||": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "{": true, "}": true };
const WRAPPERS: Record<string, true> = {
	mise: true,
	builtin: true,
	env: true,
	command: true,
	exec: true,
	nohup: true,
	nice: true,
    sudo: true,
	xargs: true,
};

const SHELL_CONTROL_WORDS: Record<string, true> = {
	if: true, else: true, elif: true, fi: true, for: true, while: true,
	until: true, do: true, done: true, case: true, esac: true, in: true,
	function: true, select: true, coproc: true, time: true,
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

/** Preserve source spelling for safety checks and shell-normalized spelling for execution matching. */
export function tokenize(segment: string): Token[] {
	const normalized = tokenizeShell(segment);
	return tokenizeShell(segment, { preserveBackslashes: true }).map(({ value, startsQuoted }, index) => ({
		value,
		normalized: normalized[index]?.value ?? value,
		quoted: startsQuoted,
	}));
}

function structuralTokens(segment: string): Token[] {
	const normalized = tokenizeShell(segment, { preserveInputRedirects: true });
	return tokenizeShell(segment, { preserveBackslashes: true, preserveInputRedirects: true }).map(({ value, startsQuoted }, index) => ({
		value,
		normalized: normalized[index]?.value ?? value,
		quoted: startsQuoted,
	}));
}

/** Return argv beginning at a command name, accepting literal env/wrapper prefixes. */
export function invocation(segment: string, argv: string[]): Token[] | null {
	const tokens = tokenize(segment);
	const head = argv[0];
	if (!head) return null;
	let start = 0;
	for (; start < tokens.length; start++) {
		const token = tokens[start];
		if (!token) return null;
		const basename = token.normalized.split("/").pop() ?? token.normalized;
		if (basename === head) break;
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.normalized) && !token.normalized.startsWith("-") && WRAPPERS[basename] !== true) return null;
	}
	for (const [offset, word] of argv.entries()) {
		const token = tokens[start + offset];
		if (!token) return null;
		const value = offset === 0 ? (token.normalized.split("/").pop() ?? token.normalized) : token.normalized;
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
	executableIndex?: number;
	opaqueWrapperOptions: boolean;
	stdinFed: boolean;
};

export type ParsedCommand = {
	command: string;
	/** String argv segments retained for existing gate helpers. */
	segments: string[][];
	/** Raw command-position segments, preserving quoting for gate decisions. */
	commands: CommandPosition[];
	unknown: boolean;
	/** True when uncertainty remains after ignoring recognized wrapper-option syntax. */
	unknownBeyondWrapperOptions: boolean;
	nested: ParsedCommand[];
};

export type ParseFailure = ParsedCommand & { kind: "parse-failure"; reason: string };
export type CommandClass = "read-only" | "mutating" | "unknown";

const READ_BD: Record<string, true> = { show: true, list: true, ready: true, status: true, comments: true, lint: true, version: true, doctor: true, prime: true };
const MUTATING_TOOLS: Record<string, true> = { npm: true, bun: true, uv: true, cargo: true, rm: true, mv: true, cp: true, mkdir: true, touch: true, install: true };

const WRAPPER_BOOLEAN_OPTIONS: Record<string, Record<string, true>> = {
	env: { "-i": true, "--ignore-environment": true, "-0": true, "--null": true, "-v": true, "--debug": true },
	xargs: { "-0": true, "--null": true, "-r": true, "--no-run-if-empty": true, "-t": true, "--verbose": true, "-p": true, "--interactive": true, "-x": true, "--exit": true, "-o": true, "--open-tty": true },
	sudo: { "-A": true, "-b": true, "-E": true, "-e": true, "-H": true, "-K": true, "-k": true, "-n": true, "-P": true, "-S": true, "-V": true, "-v": true, "--askpass": true, "--background": true, "--edit": true, "--help": true, "--login": true, "--non-interactive": true, "--preserve-env": true, "--remove-timestamp": true, "--reset-timestamp": true, "--stdin": true, "--validate": true, "--version": true },
};
const WRAPPER_VALUE_OPTIONS: Record<string, string[]> = {
	env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"],
	xargs: ["-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"],
	sudo: ["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-u", "--user", "-U", "--other-user"],
};

function skipWrapperOptions(words: Token[], index: number, wrapper: string): { index: number; opaque: boolean } {
	const booleans = WRAPPER_BOOLEAN_OPTIONS[wrapper];
	const values = WRAPPER_VALUE_OPTIONS[wrapper];
	if (booleans === undefined || values === undefined) return { index, opaque: words[index]?.normalized.startsWith("-") === true };
	let opaque = false;
	while (index < words.length) {
		const token = words[index]?.normalized ?? "";
		if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index++; continue; }
		if (token === "--") return { index: index + 1, opaque };
		if (!token.startsWith("-") && !(wrapper === "sudo" && token.startsWith("+"))) break;
		if (booleans[token] === true) { index++; continue; }
		const valueOption = values.find(option => token === option || (option.startsWith("--") ? token.startsWith(`${option}=`) : token.startsWith(option)));
		if (valueOption !== undefined) { index += token === valueOption ? 2 : 1; continue; }
		opaque = true;
		index++;
	}
	return { index, opaque };
}

/** Resolve a command word through assignments, negation, and literal wrappers. */
export function commandExecutableIndex(words: Token[], start = 0): { index: number; opaqueWrapperOptions: boolean } {
	let opaqueWrapperOptions = false;
	let index = start;
	while (index < words.length) {
		while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.normalized ?? "") || words[index]?.normalized === "!")) index++;
		const redirect = words[index]?.normalized ?? "";
		if (/^\d*(?:>&|>\|)#redirect$/.test(redirect) || /^\d*(?:<&|<>)#stdin$/.test(redirect)) {
			index += 2;
			continue;
		}
		if (/^\d*<<#stdin$/.test(redirect)) {
			index++;
			continue;
		}
		if (/^\d*(?:<|<<<)#stdin$/.test(redirect)) {
			index += 2;
			continue;
		}
		if (/^\d*(?:>>?|>\|)$/.test(redirect)) {
			index += 2;
			continue;
		}
		if (/^\d*(?:>>?|>\|).+/.test(redirect)) {
			index++;
			continue;
		}
		const wrapper = words[index]?.normalized.split("/").pop() ?? words[index]?.normalized ?? "";
		if (WRAPPERS[wrapper] !== true) break;
		const skipped = skipWrapperOptions(words, index + 1, wrapper);
		index = skipped.index;
		opaqueWrapperOptions ||= skipped.opaque;
	}
	return { index, opaqueWrapperOptions };
}

function splitCommands(source: string): CommandPosition[] {
	const positions: CommandPosition[] = [];
	let current: Token[] = [];
	let pendingStdin = false;
	const groupStdin: boolean[] = [];
	const flush = (): boolean => {
		if (current.length === 0) return false;
		const words = [...current];
		const argv = words.map(word => word.normalized);
		const resolved = commandExecutableIndex(words);
		const { index, opaqueWrapperOptions } = resolved;
		const executable = words[index]?.normalized;
		const raw = words.map(word => word.quoted ? `'${word.value.replaceAll("'", "'\\''")}'` : word.value).join(" ");
		positions.push({ raw, words, argv, executable, executableIndex: executable === undefined ? undefined : index, opaqueWrapperOptions, stdinFed: pendingStdin || groupStdin.includes(true) || words.some(word => /^0*(?:<{1,3}|(?:<|<<|<<<)#stdin)/.test(word.normalized)) });
		current = [];
		pendingStdin = false;
		return true;
	};
	for (const token of structuralTokens(source)) {
		if (OPERATORS[token.value] === true) {
			const hadCommand = flush();
			if (token.value === "|") pendingStdin = true;
			else if (token.value === "(" || token.value === "{") {
				groupStdin.push(pendingStdin || groupStdin.includes(true));
				pendingStdin = false;
			} else if (token.value === ")" || token.value === "}") groupStdin.pop();
			else if (hadCommand) pendingStdin = false;
			continue;
		}
		current.push(token);
	}
	flush();
	return positions;
}

/** Return the source operand executed by a shell's command-mode option. */
export function shellCommandOperand(words: Token[], shellIndex: number): Token | undefined {
	for (let argument = shellIndex + 1; argument < words.length; argument++) {
		const word = words[argument];
		if (word === undefined || word.normalized === "--") return undefined;
		if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(word.normalized)) {
			argument++;
			continue;
		}
		if (/^[-+][^-]*c/.test(word.normalized)) return words[argument + 1];
		if (word.normalized.startsWith("-") || word.normalized.startsWith("+")) continue;
		return undefined;
	}
	return undefined;
}

/** Whether a shell invocation executes a filename operand rather than inline source. */
export function shellHasScriptOperand(words: Token[], shellIndex: number): boolean {
	if (words.slice(0, shellIndex).some(word => /^(?:BASH_ENV|ENV)=.+/.test(word.normalized))) return true;
	for (let argument = shellIndex + 1; argument < words.length; argument++) {
		const word = words[argument];
		if (word === undefined) return false;
		if (word.normalized === "--") return words[argument + 1] !== undefined;
		if (["--rcfile", "--init-file"].includes(word.normalized)) return words[argument + 1] !== undefined;
		if (["-o", "+o", "-O", "+O"].includes(word.normalized)) {
			argument++;
			continue;
		}
		if (/^[-+][^-]*c/.test(word.normalized)) return false;
		if (word.normalized.startsWith("-") || word.normalized.startsWith("+")) continue;
		return true;
	}
	return false;
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
	for (const position of splitCommands(source)) {
		if ((position.executable?.split("/").pop() ?? position.executable) === "alias") unknown = true;
		const xargs = position.words.findIndex(word => (word.normalized.split("/").pop() ?? word.normalized) === "xargs");
		for (let index = 0; index < position.words.length; index++) {
			const shell = position.words[index]?.normalized.split("/").pop() ?? "";
			if (!["bash", "sh", "zsh", "dash", "ksh"].includes(shell)) continue;
			if (shellHasScriptOperand(position.words, index)) unknown = true;
			const command = shellCommandOperand(position.words, index);
			if (command === undefined) {
				if (xargs >= 0 && xargs < index && position.words.slice(index + 1).some(word => /^[-+][^-]*c/.test(word.normalized))) unknown = true;
				if (position.stdinFed || shellHasScriptOperand(position.words, index)) unknown = true;
				continue;
			}
			if (/(^|[^\\])[$`*?[\]{}~]/.test(command.value)) unknown = true;
			else sources.push(command.normalized);
		}
	}
	for (const position of splitCommands(source)) {
		const index = position.executableIndex;
		if (index === undefined || (position.words[index]?.normalized.split("/").pop() ?? "") !== "trap") continue;
		const handler = position.words.slice(index + 1).find(word => !word.normalized.startsWith("-"));
		if (handler === undefined) continue;
		if (/(^|[^\\])[$`*?[\]{}~]/.test(handler.value)) unknown = true;
		else sources.push(handler.normalized);
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
	if (command.length > 64_000) return { kind: "parse-failure", reason: "input exceeds 64000 characters", command, segments: [], commands: [], unknown: true, unknownBeyondWrapperOptions: true, nested: [] };
	if (!shellQuoteBalanced(command)) return { kind: "parse-failure", reason: "unbalanced shell quote", command, segments: [], commands: [], unknown: true, unknownBeyondWrapperOptions: true, nested: [] };
	const commands = splitCommands(command);
	const nested = nestedSources(command);
	const children = nested.sources.map(staticParse);
	const unknownBeyondWrapperOptions = nested.unknown || children.some(child => child.unknownBeyondWrapperOptions) || commands.some(position => {
		if (position.opaqueWrapperOptions && position.words.some(word => /(^|[^\\])[$`*?[\]{}~]/.test(word.value))) return true;
		if (position.opaqueWrapperOptions && position.words.some(word => ["bash", "sh", "zsh", "dash", "ksh"].includes(word.normalized.split("/").pop() ?? word.normalized))) return true;
		const index = position.executableIndex;
		const source = index === undefined ? undefined : position.words[index]?.value;
		const executable = position.executable?.split("/").pop();
		if (executable === "eval" || executable === "source" || executable === ".") return true;
		if (executable === "then" || (executable !== undefined && SHELL_CONTROL_WORDS[executable] === true)) return true;
		if (executable === "find" && position.argv.some(word => word === "-exec" || word === "-execdir")) return true;
		const envIndex = position.argv.findIndex(word => (word.split("/").pop() ?? word) === "env");
		if (envIndex >= 0 && position.argv.slice(envIndex + 1).some(word => word.startsWith("-S") || word === "--split-string" || word.startsWith("--split-string="))) return true;
		if (position.executable?.includes(" ")) return true;
		return source !== undefined && /(^|[^\\])[$`*?[\]{}~]/.test(source);
	});
	const unknown = unknownBeyondWrapperOptions || children.some(child => child.unknown) || commands.some(position => position.opaqueWrapperOptions);
	return {
		command,
		segments: commands.map(position => position.argv),
		commands,
		unknown,
		unknownBeyondWrapperOptions,
		nested: children,
	};
}

/** Synchronous structural parse used by tests and callers that already have syntax proof. */
export function parse(command: string): ParsedCommand | ParseFailure {
	return staticParse(command);
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
		const index = position.executableIndex;
		if (index === undefined) continue;
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
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;
const CLOSE_VERBS: Record<string, true> = { close: true, done: true };
const DB_VALUE_FLAGS: Record<string, true> = { "--db": true, "-C": true, "--directory": true };
const VALUE_FLAGS: Record<string, true> = { "--reason": true, "-r": true, "--message": true, "--session": true, "--assignee": true, "--status": true, "--type": true };

/** Extract close invocations from an already validated shared parse. */
export function closeInvocationsFromParsed(parsed: ParsedCommand | ParseFailure): CloseInvocation[] {
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

/** Extract close invocations from the shared parser, including recursively executed children. */
export function closeInvocations(command: string): CloseInvocation[] {
	return closeInvocationsFromParsed(parse(command));
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
