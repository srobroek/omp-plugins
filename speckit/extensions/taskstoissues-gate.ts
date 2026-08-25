/**
 * Refuse bash that invokes speckit-taskstoissues at command position.
 *
 * The companion TTSR (`speckit-no-taskstoissues`) can only see the slash form
 * unambiguously. Quoting is invisible to a regex, so a title like
 * `bd create --title 'port speckit-taskstoissues deny'` used to fire. This gate
 * tokenizes argv so quoted mentions pass and real invocations do not.
 *
 * Fails open: a throwing tool_call handler is a bash outage.
 */
import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

export const DENY_REASON =
	"blocked by speckit (taskstoissues converts tasks.md into a second tracker): do not run speckit-taskstoissues / speckit.taskstoissues / specify … /speckit.taskstoissues. Task state lives in beads. Link an existing GitHub issue with `bd update <id> --external-ref gh-<number>` instead.";

const SEPARATOR: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, ")": true };

/**
 * Wrappers that hand off to another command, with enough of each grammar to
 * find the real command slot: which short options consume a following value,
 * and `--` as end-of-options. Unknown options are treated as valueless, which
 * errs toward checking a later token (conservative for detection, and an
 * unmodeled `-x value` wrapper shape at worst checks `value` for an exact
 * banned name - never a quoted string, so mentions stay safe).
 */
const WRAPPER_VALUE_OPTS: Record<string, Record<string, true>> = {
	sudo: { "-u": true, "-g": true, "-p": true, "-h": true, "-C": true, "-D": true, "-R": true, "-T": true, "-U": true },
	doas: { "-u": true, "-C": true, "-a": true },
	env: { "-u": true, "-C": true, "-S": true, "-P": true },
	command: {},
	nice: { "-n": true },
	ionice: { "-c": true, "-n": true, "-p": true },
	nohup: {},
	setsid: {},
	stdbuf: { "-i": true, "-o": true, "-e": true },
	time: { "-f": true, "-o": true },
	builtin: {},
	exec: { "-a": true },
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const BANNED_COMMAND: Record<string, true> = {
	"speckit-taskstoissues": true,
	"speckit.taskstoissues": true,
};

const SPECIFY_BANNED: Record<string, true> = {
	"/speckit.taskstoissues": true,
	"speckit.taskstoissues": true,
	"speckit-taskstoissues": true,
	"/speckit-taskstoissues": true,
};

const PREFILTER = /speckit[-.]taskstoissues/;

export function extractCommand(input: Record<string, unknown>): string {
	if (typeof input.command === "string") return input.command;
	if (typeof input.cmd === "string") return input.cmd;
	return "";
}

/**
 * Shell-ish tokenizer: enough to tell a command-position invocation from the
 * same words inside a quoted --title/--reason/-m. Duplicated from the delivery
 * plugin because plugins install independently.
 */
export interface Token {
	text: string;
	/** Any part of the token was quoted: a mention, not something the agent typed as a command name. */
	quoted: boolean;
}

export function tokenize(command: string): Token[] {
	const out: Token[] = [];
	let cur = "";
	let started = false;
	let sawQuote = false;
	let quote: '"' | "'" | null = null;
	const flush = (): void => {
		if (started) {
			out.push({ text: cur, quoted: sawQuote });
			cur = "";
			started = false;
			sawQuote = false;
		}
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			else {
				cur += ch;
				started = true;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			sawQuote = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			cur += command[i + 1] as string;
			started = true;
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (SEPARATOR[ch] === true) {
			flush();
			out.push({ text: ch, quoted: false });
			continue;
		}
		cur += ch;
		started = true;
	}
	flush();
	return out;
}

function isBannedToken(token: string): boolean {
	const base = token.split("/").pop() ?? token;
	return BANNED_COMMAND[token] === true || BANNED_COMMAND[base] === true;
}

/**
 * The one place command-slot semantics live: the resolved executable is banned,
 * or it is `specify` and a following argument names the banned command. `args`
 * are the argv words after the executable (already segment- or argv-scoped by
 * the caller); quoting does not matter here - argv is argv.
 */
function isBannedResolvedCommand(executable: string, args: readonly string[]): boolean {
	if (isBannedToken(executable)) return true;
	const base = executable.split("/").pop() ?? executable;
	if (executable === "specify" || base === "specify") {
		for (const arg of args) {
			if (SPECIFY_BANNED[arg] === true) return true;
		}
	}
	return false;
}

/**
 * env -S splits its value into argv WORDS: quotes group words, but shell
 * separators are ordinary arguments, and nothing after the command word
 * executes. So resolve the command slot in argv mode - peel wrapper chains and
 * assignments from the front, check exactly one word - and never shell-parse:
 * `env -S 'echo ; speckit-taskstoissues'` runs echo with two literal args.
 */
function isBannedSplitString(value: string): boolean {
	const words = tokenize(value)
		.map(token => token.text)
		.filter(word => word.length > 0);
	let wrapper: Record<string, true> | undefined;
	let optionsEnded = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (ENV_ASSIGNMENT.test(word)) continue;
		if (wrapper !== undefined && !optionsEnded && word.startsWith("-")) {
			if (word === "--") optionsEnded = true;
			else if (wrapper[word] === true) i++;
			continue;
		}
		const base = word.split("/").pop() ?? word;
		const nextWrapper = WRAPPER_VALUE_OPTS[word] ?? WRAPPER_VALUE_OPTS[base];
		if (nextWrapper !== undefined) {
			wrapper = nextWrapper;
			optionsEnded = false;
			continue;
		}
		return isBannedResolvedCommand(word, words.slice(i + 1));
	}
	return false;
}

/**
 * Walk one command line. At each command slot, peel wrapper chains
 * (sudo/env/nice/...) by their own option grammars until the real executable
 * token is found, and check only that token (plus specify subcommand args).
 * Arguments - quoted or not - are never checked: `sudo echo
 * speckit-taskstoissues` passes, `sudo -u root speckit-taskstoissues` blocks,
 * and a QUOTED name in the command slot (`sudo 'speckit-taskstoissues'`) still
 * blocks because the shell would execute it.
 */
function isBannedInvocation(tokens: Token[]): boolean {
	let i = 0;
	while (i < tokens.length) {
		// Find the command slot for this segment.
		while (i < tokens.length && SEPARATOR[(tokens[i] as Token).text] === true && !(tokens[i] as Token).quoted) i++;
		let optionsEnded = false;
		let wrapper: Record<string, true> | undefined;
		while (i < tokens.length) {
			const { text: token, quoted } = tokens[i] as Token;
			if (SEPARATOR[token] === true && !quoted) break; // empty segment
			if (!quoted && ENV_ASSIGNMENT.test(token)) {
				i++;
				continue;
			}
			// A partially-quoted --split-string='...' still carries argv in its
			// value; quoting is tokenization, not semantics. The value is a whole
			// nested command line (it can itself start with a wrapper), so recurse.
			if (wrapper === WRAPPER_VALUE_OPTS.env && token.startsWith("--split-string=")) {
				if (isBannedSplitString(token.slice("--split-string=".length))) return true;
				i++;
				continue;
			}
			if (wrapper !== undefined && !optionsEnded && !quoted && token.startsWith("-")) {
				if (token === "--") optionsEnded = true;
				else if (wrapper[token] === true) {
					// env -S VALUE splits into argv words (wrapper chains resolve,
					// shell separators do not execute), so check in argv mode.
					if (wrapper === WRAPPER_VALUE_OPTS.env && token === "-S") {
						const value = tokens[i + 1] as Token | undefined;
						if (value !== undefined && isBannedSplitString(value.text)) return true;
					}
					i++; // option value follows
				}
				i++;
				continue;
			}
			const base = token.split("/").pop() ?? token;
			const nextWrapper = quoted ? undefined : (WRAPPER_VALUE_OPTS[token] ?? WRAPPER_VALUE_OPTS[base]);
			if (nextWrapper !== undefined) {
				wrapper = nextWrapper;
				optionsEnded = false;
				i++;
				continue;
			}
			// The command slot: collect this segment's remaining argv (quoting
			// matters for tokenization, not argv semantics) and apply the one
			// shared resolved-command check.
			const args: string[] = [];
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j] as Token;
				if (SEPARATOR[arg.text] === true && !arg.quoted) break;
				args.push(arg.text);
			}
			if (isBannedResolvedCommand(token, args)) return true;
			break;
		}
		// Skip the rest of this segment.
		while (i < tokens.length && !(SEPARATOR[(tokens[i] as Token).text] === true && !(tokens[i] as Token).quoted)) i++;
		i++;
	}
	return false;
}

export function isTaskstoissuesInvocation(command: string): boolean {
	if (!PREFILTER.test(command)) return false;
	for (const line of command.split(/\r?\n/)) {
		if (isBannedInvocation(tokenize(line))) return true;
	}
	return false;
}

export function decideToolCall(
	toolName: string,
	input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
	if (toolName !== "bash") return;
	const command = extractCommand(input);
	if (!command) return;
	if (isTaskstoissuesInvocation(command)) return { block: true, reason: DENY_REASON };
	return;
}

export default function taskstoissuesGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			return decideToolCall(event.toolName, event.input);
		} catch {
			return;
		}
	});
}
