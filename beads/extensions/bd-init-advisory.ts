/**
 * Advise on `bd init` flags, once per process, blocking nothing.
 *
 * This replaces two TTSR rules. `beads-init-skip-hooks` (`interruptMode: always`)
 * and `beads-init-prefer-server` both matched the substring `bd init` anywhere in
 * a bash command, so both fired on `echo how to bd init a repo`, `rg 'bd init'`,
 * `git log --grep='bd init'` and `man bd init` — and on each other's correct form.
 * skip-hooks demanded `--skip-hooks`, prefer-server demanded a server flag, and
 * the invocation this estate actually wants, `bd init --init-if-missing --skip-hooks`
 * plus an exported `BEADS_DIR`, was blocked by skip-hooks' sibling anyway.
 * Verified live 2026-08-25.
 *
 * Two things follow. Argv is the only honest trigger: a mention inside a quoted
 * string, a `--grep` pattern, or another program's arguments is not an
 * invocation, so this reads the `bd` at command position, its verb, and its
 * flags. And the wrongness is contextual — an already-initialised repository,
 * hooks the project deliberately manages — so this is advice: `bd init` always
 * proceeds, and the advisory speaks at most once per process.
 *
 * Command position is per line as well as per separator: `cd /repo\nbd init` is a
 * real invocation. The cost is that a `bd init` line inside a heredoc body reads
 * as one too, which is one advisory message and no block.
 */
import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { extractCommand, tokenize } from "./bd-close-gate.ts";

/** Flags consuming the next token, so `bd -C <dir> init` still reads as `init`. */
const PRE_VERB_VALUE_FLAGS: Record<string, true> = {
	"-C": true,
	"--db": true,
	"--directory": true,
};

/** Words that may stand before `bd` and leave it at command position. */
const TRANSPARENT_PREFIX: Record<string, true> = { command: true, env: true, sudo: true };

const SEPARATOR: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, ")": true };

/** `NAME=value bd init`: an environment prefix is not the command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `--help` prints; it initialises nothing. */
const HELP_FLAGS: Record<string, true> = { "--help": true, "-h": true };

/** Cheap prefilter: never tokenize a command that cannot be a `bd init`. */
const PREFILTER = /\bbd\b[\s\S]{0,400}?\binit\b/;

export type InitInvocation = {
	/** Flag names on this invocation, `--flag=value` reduced to `--flag`. */
	flags: string[];
};

/**
 * Every real `bd ... init` invocation in the command, with the flags it carries.
 *
 * A line is its own command position, as is anything after `;`, `&`, `|`, or a
 * subshell paren. `bd init-db` and `bd help init` are different verbs and do not
 * appear here, and neither does a `bd init` that is some other program's
 * argument.
 */
export function findInitInvocations(command: string): InitInvocation[] {
	const out: InitInvocation[] = [];
	for (const line of command.split(/\r?\n/)) {
		const tokens = tokenize(line);
		let atCommand = true;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i] as string;
			if (SEPARATOR[token] === true) {
				atCommand = true;
				continue;
			}
			if (!atCommand) continue;
			if (TRANSPARENT_PREFIX[token] === true || ENV_ASSIGNMENT.test(token)) continue;
			atCommand = false;
			if (token !== "bd") continue;

			const flags: string[] = [];
			let verb: string | null = null;
			let j = i + 1;
			for (; j < tokens.length; j++) {
				const arg = tokens[j] as string;
				if (SEPARATOR[arg] === true) break;
				if (arg.startsWith("-") && arg !== "-") {
					const eq = arg.indexOf("=");
					const name = eq === -1 ? arg : arg.slice(0, eq);
					flags.push(name);
					if (eq === -1 && verb === null && PRE_VERB_VALUE_FLAGS[name] === true) j++;
					continue;
				}
				if (verb === null) verb = arg.toLowerCase();
			}
			i = j;
			atCommand = true;
			if (verb === "init") out.push({ flags });
		}
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
	"Whatever starts a run must export `BEADS_DIR` to that run's `.beads` " +
	"directory so every child process inherits the pin. That is what makes a " +
	"worktree or a copied checkout read and write the run's database. Unpinned, " +
	"a read from a directory with no `.beads/` reports `No active beads " +
	"workspace found`, and a copied checkout can resolve a personal database " +
	"instead (`$HOME/.beads` exists on this machine). Something must own the " +
	"pin: a harness that copies a checkout without setting it still splits the " +
	"database. Measured: a copied 54-bead database accepted `create` and " +
	"`--claim` with none of it reaching the original.";

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

/** The advisory this command deserves, or `undefined` when it deserves none. */
export function decideBdInit(command: string): string | undefined {
	if (!PREFILTER.test(command)) return;
	for (const invocation of findInitInvocations(command)) {
		const missing = missingInitFlags(invocation.flags);
		if (missing !== undefined) return initAdvisory(missing);
	}
	return;
}

/**
 * Process-global once-guard, keyed on `globalThis` for the same reason
 * `dolt-server-lifecycle` is: when the plugin is momentarily reachable through
 * two load paths (a marketplace install plus a dev link, or an install plus a
 * settings.json entry) the module is instantiated twice, and a per-instance flag
 * lets each instance advise separately.
 */
const ADVISED_KEY = Symbol.for("com.srobroek.beads.init-advisory.sent");

export function resetInitAdvisoryForTests(): void {
	delete (globalThis as { [ADVISED_KEY]?: boolean })[ADVISED_KEY];
}

export default function bdInitAdvisory(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command) return;
			const advisory = decideBdInit(command);
			if (advisory === undefined) return;
			const holder = globalThis as { [ADVISED_KEY]?: boolean };
			if (holder[ADVISED_KEY] === true) return;
			holder[ADVISED_KEY] = true;
			// A message, not `ctx.ui.notify`: the agent is what runs `bd`, and a UI
			// notification reaches neither the agent nor a `--print`/RPC session.
			// `triggerTurn` belongs in the options argument, not the payload.
			pi.sendMessage(
				{
					customType: "com.srobroek.beads.init-advisory",
					content: advisory,
					display: true,
					attribution: "user",
				},
				{ triggerTurn: false },
			);
		} catch {
			// Advisory only: a bug here must never disturb a bash call.
		}
		// Returns nothing on every path: `bd init` is never blocked.
		return;
	});
}
