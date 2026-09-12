/**
 * Shell-shaped reading of a command string, shared by the beads gates.
 *
 * Both gates have to answer "is this `bd` / `gh` at a command position, and what
 * is its real argument?" A plain regex over the whole string gets this wrong in
 * two directions: it rewrites `echo bd update x --claim`, and it reads `--body`
 * out of a quoted title. Quotes are the whole difficulty, so they are handled
 * once here rather than in each gate.
 */

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
 * `quoted` records whether the token BEGINS inside quotes, which is what
 * separates an argument from a flag: `'--claim'` is text, while `--body="x"`
 * is still the `--body` flag carrying a quoted value.
 */
export type Token = { value: string; quoted: boolean };

/** Words of one segment, with quotes removed and the quoting recorded. */
export function tokenize(segment: string): Token[] {
	const out: Token[] = [];
	let value = "";
	let quoted = false;
	let quote: string | null = null;
	let started = false;
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i] as string;
		if (quote) {
			if (char === quote && segment[i - 1] !== "\\") {
				quote = null;
				continue;
			}
			value += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			if (!started) quoted = true;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) out.push({ value, quoted });
			value = "";
			quoted = false;
			started = false;
			continue;
		}
		value += char;
		started = true;
	}
	if (started) out.push({ value, quoted });
	return out;
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
