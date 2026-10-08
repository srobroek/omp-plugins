/**
 * The command a simple command runs once its leading wrappers are dropped.
 *
 * Shared by the gates in this repository that read shell commands. Plugins are
 * bundled in isolation, so keep this file byte-identical in each plugin that
 * consumes it; `scripts/check-shared-detector.py` enforces that contract.
 *
 * This is a static reading of literal words, never a shell evaluator: a wrapper
 * reached through a variable, an alias, or a function is not recognised.
 */

import { tokenizeShell } from "./shell-tokenizer.ts";

export type CommandWords = {
	/** The command word and its arguments; empty when nothing runs (`command -v npm`, a bare assignment). */
	argv: string[];
	/**
	 * The directories wrappers run the command in (`env -C DIR`, `sudo -D DIR`),
	 * outermost first and as written: a relative one resolves against the one before
	 * it. The shell opens redirections before any wrapper runs, so these apply to the
	 * command's own paths only.
	 */
	directories: string[];
};

type Wrapper = {
	/** Options that take a value: the next word, the rest of a short cluster (`-uroot`), or `--name=value`. */
	valued: ReadonlySet<string>;
	/** Valued options naming the directory the command runs in. */
	chdir?: ReadonlySet<string>;
	/** Valued options whose value is split into words that take its place (`env -S 'npm i'`). */
	split?: ReadonlySet<string>;
	/** Options that look the command up instead of running it (`command -v npm`). */
	lookup?: ReadonlySet<string>;
	/** Positional operands between the options and the command (`timeout DURATION`). */
	operands?: number;
	/** Whether `NAME=value` words may sit among the options (`env CI=1 npm ci`). */
	assignments?: boolean;
};

const NONE: ReadonlySet<string> = new Set();

/** Words that run the words after their own options as the command. */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
	["sudo", {
		valued: new Set([
			"-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u",
			"--chdir", "--chroot", "--close-from", "--command-timeout", "--group", "--host",
			"--other-user", "--prompt", "--role", "--type", "--user",
		]),
		chdir: new Set(["-D", "--chdir"]),
	}],
	["doas", { valued: new Set(["-C", "-u"]) }],
	["env", {
		valued: new Set(["-C", "-L", "-P", "-S", "-U", "-u", "--chdir", "--split-string", "--unset"]),
		chdir: new Set(["-C", "--chdir"]),
		split: new Set(["-S", "--split-string"]),
		assignments: true,
	}],
	["nice", { valued: new Set(["-n", "--adjustment"]) }],
	["timeout", { valued: new Set(["-k", "-s", "--kill-after", "--signal"]), operands: 1 }],
	["stdbuf", { valued: new Set(["-e", "-i", "-o", "--error", "--input", "--output"]) }],
	["exec", { valued: new Set(["-a"]) }],
	["command", { valued: NONE, lookup: new Set(["-V", "-v"]) }],
	["time", { valued: new Set(["-f", "-o", "--format", "--output"]) }],
	["nohup", { valued: NONE }],
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A valued option found in one word: its name, its value, and how many words it spans. */
type Valued = { name: string; value: string | undefined; span: number };

/** The valued option a word starts, `null` for a flag, or `"lookup"` for a lookup option. */
function readOption(words: readonly string[], at: number, wrapper: Wrapper): Valued | null | "lookup" {
	const word = words[at] as string;
	if (word.startsWith("--")) {
		const eq = word.indexOf("=");
		const name = eq === -1 ? word : word.slice(0, eq);
		if (!wrapper.valued.has(name)) return null;
		return eq === -1 ? { name, value: words[at + 1], span: 2 } : { name, value: word.slice(eq + 1), span: 1 };
	}
	// A short cluster, read the way getopt does: flags until the first valued option,
	// whose value is the rest of the word or else the next word.
	for (let j = 1; j < word.length; j++) {
		const name = `-${word[j]}`;
		if (wrapper.lookup?.has(name)) return "lookup";
		if (!wrapper.valued.has(name)) continue;
		const attached = word.slice(j + 1);
		return attached ? { name, value: attached, span: 1 } : { name, value: words[at + 1], span: 2 };
	}
	return null;
}

/**
 * Drop the wrappers (`sudo`, `doas`, `env`, `nice`, `timeout`, `stdbuf`, `exec`,
 * `command`, `time`, `nohup`, a bare `--`) and assignment prefixes that run the
 * following words as the command, together with each wrapper's own options and
 * operands. Wrappers are matched by basename, so `/usr/bin/sudo` is one.
 */
export function commandWords(input: readonly string[]): CommandWords {
	const words = [...input];
	const directories: string[] = [];
	let i = 0;
	while (i < words.length) {
		const word = words[i] as string;
		if (ASSIGNMENT.test(word) || word === "--") {
			i++;
			continue;
		}
		const wrapper = WRAPPERS.get(word.slice(word.lastIndexOf("/") + 1));
		if (wrapper === undefined) break;
		i++;
		while (i < words.length) {
			const option = words[i] as string;
			if (option === "--") {
				i++;
				break;
			}
			if (wrapper.assignments && ASSIGNMENT.test(option)) {
				i++;
				continue;
			}
			if (!option.startsWith("-")) break;
			const read = readOption(words, i, wrapper);
			if (read === "lookup") return { argv: [], directories };
			if (read === null) {
				i++;
				continue;
			}
			if (read.value === undefined) return { argv: [], directories };
			if (wrapper.split?.has(read.name)) {
				words.splice(i, read.span, ...tokenizeShell(read.value).map((token) => token.value));
				continue;
			}
			if (wrapper.chdir?.has(read.name)) directories.push(read.value);
			i += read.span;
		}
		i += Math.min(wrapper.operands ?? 0, words.length - i);
	}
	return { argv: words.slice(i), directories };
}
