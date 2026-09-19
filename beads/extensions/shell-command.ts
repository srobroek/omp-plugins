/**
 * Shell-shaped reading of a command string, shared by the beads gates.
 *
 * The gates have to answer "is this `bd` / `gh` at a command position, what is its
 * real argument, and which directory does it run in?" A plain regex over the whole
 * string gets the first wrong in two directions: it rewrites
 * `echo bd update x --claim`, and it reads `--body` out of a quoted title. Quotes
 * are the whole difficulty, so they are handled once here rather than in each gate.
 */

import { resolve } from "node:path";
import { tokenizeShell } from "./shell-tokenizer.ts";

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
