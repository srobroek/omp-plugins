/**
 * Advise on bd init hook flags once per process without blocking the command.
 * The parser recognizes actual invocations rather than mentions in unrelated text.
 */
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { tokenize } from "./bd-close-gate.ts";

/** Flags consuming the next token, so `bd -C <dir> init` still reads as `init`. */
const PRE_VERB_VALUE_FLAGS: Record<string, true> = {
	"-C": true,
	"--db": true,
	"--directory": true,
};

/** `bd init` flags that consume the next token, so a value is never read as the verb. */
const VALUE_FLAGS: Record<string, true> = { "--prefix": true };

/** `NAME=value bd init`: an environment prefix is not the command. */
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

const HELP_FLAGS: Record<string, true> = { "--help": true, "-h": true };

const SEPARATOR: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, ")": true, "$(": true, "\n": true };

/**
 * Launchers that run the REAL command after their own arguments. Each entry names
 * the options that consume a following value; every other `-x` token is a flag.
 * `echo` is deliberately absent: a mention is never an invocation.
 */
const WRAPPERS: Record<string, Record<string, true>> = {
	command: {},
	exec: { "-a": true },
	nohup: {},
	chronic: {},
	unbuffer: {},
	caffeinate: { "-t": true, "-w": true },
	stdbuf: { "-i": true, "-o": true, "-e": true },
	nice: { "-n": true, "--adjustment": true },
	time: { "-f": true, "--format": true, "-o": true, "--output": true },
	timeout: { "-k": true, "--kill-after": true, "-s": true, "--signal": true },
	doas: { "-u": true, "-C": true },
	sudo: { "-u": true, "-g": true, "-C": true, "-D": true, "-h": true, "-p": true, "-r": true, "-t": true, "-T": true, "-U": true },
	env: { "-u": true, "--unset": true, "-C": true, "--chdir": true, "-S": true, "--split-string": true },
	mise: {},
};

/** Wrappers whose first positional argument is not the command (`timeout 10 cmd`). */
const POSITIONAL_BEFORE_COMMAND: Record<string, number> = { timeout: 1 };

/** Shells whose `-c STRING` runs a nested command line. */
const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true };

/** Cheap prefilter: never tokenize a command that cannot mention `bd`. */
const PREFILTER = /\bbd\b/;

export type InitInvocation = {
	/** Flag names on this invocation, `--flag=value` reduced to `--flag`. */
	flags: string[];
	/** The `--prefix` value when one is given. */
	prefix?: string;
	/** The `-C` / `--directory` value on `bd` itself when one is given. */
	dir?: string;
	/**
	 * The directory the shell was in when it reached `bd`: the caller's cwd, moved by an
	 * earlier `cd`, `env -C`, or `sudo -D`. `undefined` when a `cd` could not be followed
	 * (`cd -`, `cd "$var"`), which a gate must treat as unknown rather than as the caller's.
	 */
	cwd?: string;
	/**
	 * Environment the invocation itself sets or clears: `NAME=value` prefixes,
	 * `env NAME=value`, `sudo NAME=value`; `undefined` values are `env -u NAME`.
	 * `cleared` is `env -i`: nothing inherited survives.
	 */
	env: Record<string, string | undefined>;
	cleared: boolean;
	/**
	 * Set when a wrapper stood before `bd` that this reader could not see through
	 * (`env -S`, `mise` without `--`, a shell `-c` whose string is not literal). A
	 * blocking gate fails closed on this; the advisory says nothing.
	 */
	unresolved?: true;
};

/** `cd` targets this reader can follow: literal paths without expansion. */
function followCd(current: string | undefined, target: string | undefined): string | undefined {
	if (target === undefined || target === "~") return process.env.HOME;
	if (target === "-" || target.includes("$") || target.startsWith("~")) return undefined;
	if (path.isAbsolute(target)) return path.normalize(target);
	if (current === undefined) return undefined;
	return path.resolve(current, target);
}

/**
 * Every real `bd ... init` invocation in the command, with the flags it carries.
 *
 * A line is its own command position, as is anything after `;`, `&`, `|`, or a
 * subshell paren. `bd` is matched by basename, through environment prefixes, the
 * launchers in `WRAPPERS`, and a literal `sh -c '...'`. `bd init-db` and `bd help init`
 * are different verbs and do not appear here, and neither does a `bd init` that is some
 * other program's argument.
 */
export function findInitInvocations(command: string, cwd: string | undefined = undefined): InitInvocation[] {
	const out: InitInvocation[] = [];
	const tokens = tokenize(command);
	let shellCwd = cwd;
	let i = 0;
	while (i < tokens.length) {
		// Skip separators to the next command position.
		while (i < tokens.length && SEPARATOR[tokens[i] as string] === true) i++;
		if (i >= tokens.length) break;
		const segmentEnd = ((): number => {
			let k = i;
			while (k < tokens.length && SEPARATOR[tokens[k] as string] !== true) k++;
			return k;
		})();
		const segment = tokens.slice(i, segmentEnd);
		i = segmentEnd;

		const env: Record<string, string | undefined> = {};
		let cleared = false;
		let segmentCwd = shellCwd;
		let unresolved: true | undefined;
		let k = 0;
		// Environment prefixes and launchers before the command word.
		while (k < segment.length) {
			const word = segment[k] as string;
			const assignment = ENV_ASSIGNMENT.exec(word);
			if (assignment !== null) {
				env[assignment[1] as string] = assignment[2];
				k++;
				continue;
			}
			const basename = word.split("/").pop() ?? word;
			if (basename === "cd") {
				shellCwd = followCd(shellCwd, segment[k + 1]);
				k = segment.length;
				break;
			}
			if (SHELLS[basename] === true) {
				// `sh -c STRING`: the string is a nested command line in the same directory.
				// `-c` may be combined with other single-letter options (`-lc`, `-ec`).
				let m = k + 1;
				while (m < segment.length && (segment[m] as string).startsWith("-") && !/^-[A-Za-z]*c$/.test(segment[m] as string)) m++;
				if (m < segment.length && /^-[A-Za-z]*c$/.test(segment[m] as string) && typeof segment[m + 1] === "string") {
					const inner = segment[m + 1] as string;
					if (inner.includes("$")) unresolved = true;
					for (const nested of findInitInvocations(inner, segmentCwd)) {
						nested.env = { ...env, ...nested.env };
						nested.cleared = cleared || nested.cleared;
						if (unresolved) nested.unresolved = true;
						out.push(nested);
					}
				}
				k = segment.length;
				break;
			}
			const valueFlags = WRAPPERS[basename];
			if (valueFlags === undefined) break;
			if (basename === "mise") {
				// `mise exec [tool...] -- cmd`: everything up to `--` belongs to mise.
				const dash = segment.indexOf("--", k);
				if (dash === -1) {
					unresolved = true;
					k = segment.length;
					break;
				}
				k = dash + 1;
				continue;
			}
			k++;
			let positionals = POSITIONAL_BEFORE_COMMAND[basename] ?? 0;
			while (k < segment.length) {
				const opt = segment[k] as string;
				if (opt === "--") {
					k++;
					break;
				}
				if (opt.startsWith("-") && opt.length > 1) {
					const eq = opt.indexOf("=");
					const name = eq === -1 ? opt : opt.slice(0, eq);
					const value = eq === -1 ? (valueFlags[name] === true ? segment[++k] : undefined) : opt.slice(eq + 1);
					if (basename === "env") {
						if (name === "-i") cleared = true;
						if ((name === "-u" || name === "--unset") && value !== undefined) env[value] = undefined;
						if ((name === "-C" || name === "--chdir") && value !== undefined) segmentCwd = followCd(segmentCwd, value);
						if (name === "-S" || name === "--split-string") unresolved = true;
					}
					if (basename === "sudo" && name === "-D" && value !== undefined) segmentCwd = followCd(segmentCwd, value);
					k++;
					continue;
				}
				const assign = ENV_ASSIGNMENT.exec(opt);
				if (assign !== null && (basename === "env" || basename === "sudo")) {
					env[assign[1] as string] = assign[2];
					k++;
					continue;
				}
				if (positionals > 0) {
					positionals--;
					k++;
					continue;
				}
				break;
			}
		}
		const word = segment[k];
		if (word === undefined || (word.split("/").pop() ?? word) !== "bd") {
			// A wrapper this reader could not see through hid the command word. When the
			// segment still carries `bd` and `init` somewhere, report it as unresolved so a
			// gate can fail closed; a mention elsewhere in the segment stays a mention.
			const mentionsInit =
				segment.some(token => (token.split("/").pop() ?? token) === "bd" || /\bbd\b/.test(token)) &&
				segment.some(token => /\binit\b/.test(token));
			if (unresolved && mentionsInit) out.push({ flags: [], env, cleared, unresolved: true });
			continue;
		}

		const flags: string[] = [];
		let verb: string | null = null;
		let prefix: string | undefined;
		let dir: string | undefined;
		for (let j = k + 1; j < segment.length; j++) {
			const arg = segment[j] as string;
			if (arg.startsWith("-") && arg !== "-") {
				const eq = arg.indexOf("=");
				const name = eq === -1 ? arg : arg.slice(0, eq);
				flags.push(name);
				const takesValue = VALUE_FLAGS[name] === true || (verb === null && PRE_VERB_VALUE_FLAGS[name] === true);
				let value: string | undefined;
				if (eq !== -1) value = arg.slice(eq + 1);
				else if (takesValue && j + 1 < segment.length) value = segment[++j] as string;
				if (name === "--prefix") prefix = value;
				if (name === "-C" || name === "--directory") dir = value;
				continue;
			}
			if (verb === null) verb = arg.toLowerCase();
		}
		if (verb !== "init") continue;
		const invocation: InitInvocation = { flags, env, cleared };
		if (prefix !== undefined) invocation.prefix = prefix;
		if (dir !== undefined) invocation.dir = dir;
		if (segmentCwd !== undefined) invocation.cwd = segmentCwd;
		if (unresolved) invocation.unresolved = true;
		out.push(invocation);
	}
	return out;
}

export type MissingFlags = { skipHooks: true };

/**
 * What this invocation leaves out, or `undefined` when there is nothing to say:
 * a `--help` run, or `--skip-hooks` already present.
 */
export function missingInitFlags(flags: string[]): MissingFlags | undefined {
	if (flags.some(flag => HELP_FLAGS[flag] === true)) return;
	if (flags.includes("--skip-hooks")) return;
	return { skipHooks: true };
}

const BEADS_DIR_ADVICE =
	"The beads plugin pins `BEADS_DIR` for this session: the checkout's `.beads` " +
	"(a linked worktree resolves to the primary checkout's) is placed on Bash " +
	"calls in the same repository family. Calls whose working directory belongs " +
	"to another repository remain unpinned. A `BEADS_DIR` exported before omp " +
	"started is kept within the session repository. Verify with `printenv " +
	"BEADS_DIR`; an absolute path means the pin is in place. Do not ask the human " +
	"to export it or restart omp, and do not pass it on calls yourself. Unpinned, " +
	"a read from a directory with no `.beads/` reports `No active beads workspace " +
	"found`, and a copied checkout can resolve a personal database instead " +
	"(`$HOME/.beads` exists on this machine).";


const SKIP_HOOKS_ADVICE =
	"`--skip-hooks` wherever hooks are already managed: plain `bd init` repoints " +
	"`core.hooksPath` and copies ~349MB of hooks, which is broken on arm64.";

export function initAdvisory(_missing: MissingFlags): string {
	return (
		`bd init advisory — nothing was blocked, and this speaks once per session. ` +
		`This \`bd init\` omits \`--skip-hooks\`. ${SKIP_HOOKS_ADVICE} ${BEADS_DIR_ADVICE} ` +
		`The full form is \`bd init --init-if-missing --skip-hooks\` ` +
		`(rule://beads-setup). Both the flag and the pin are contextual, so decide ` +
		`rather than re-run blind: an already-initialised repository or hooks the ` +
		`project deliberately owns can each make the plainer form the right call.`
	);
}

/** Decide an init advisory from one validated command-position source. */
export function decideBdInit(command: string): string | undefined {
	if (!PREFILTER.test(command)) return;
	for (const invocation of findInitInvocations(command)) {
		if (invocation.unresolved) continue;
		const missing = missingInitFlags(invocation.flags);
		if (missing !== undefined) return initAdvisory(missing);
	}
	return undefined;
}
/** Decide init advisories from the shared parsed command positions. */
export function decideBdInitParsed(parsed: import("./shell-command.ts").ParsedCommand): string | undefined {
	for (const position of parsed.commands) {
		const advisory = decideBdInit(position.raw);
		if (advisory) return advisory;
	}
	for (const child of parsed.nested) {
		const advisory = decideBdInitParsed(child);
		if (advisory) return advisory;
	}
	return undefined;
}

/**
 * Process-global once-guard, keyed on `globalThis` for the same reason
 * `the plugin` is: when the plugin is momentarily reachable through
 * two load paths (a marketplace install plus a dev link, or an install plus a
 * settings.json entry) the module is instantiated twice, and a per-instance flag
 * lets each instance advise separately.
 */
const ADVISED_KEY = Symbol.for("com.srobroek.beads.init-advisory.sent");

export function resetInitAdvisoryForTests(): void {
	delete (globalThis as { [ADVISED_KEY]?: boolean })[ADVISED_KEY];
}

export default function bdInitAdvisory(_pi: ExtensionAPI): void {
	// Bash calls are dispatched by bash-gates.ts.
}
