/**
 * Refuse a commit that would land on main/master, reading the branch from git.
 *
 * This replaces `delivery-no-work-on-main`, a TTSR whose condition matched
 * `main`/`master` anywhere after `git commit` — so `git commit -m 'fix main bug'`
 * was blocked (`interruptMode: always`) while an actual commit on main went
 * through whenever its message happened not to say so. A commit message is not a
 * branch. The branch is knowable, but only by asking git, which a regex cannot.
 *
 * Fails open on purpose. `git branch --show-current` printing nothing (detached
 * HEAD, a fresh repository with no commits), exiting non-zero (not a work tree),
 * a missing binary, or a throwing spawn all allow the call: a guard that blocks
 * when it cannot see is worse than the rule it replaces. `--dry-run` commits
 * nothing and is allowed for the same reason.
 *
 * The escape hatch is deliberate. Local commits on main are sanctioned when the
 * user asks or the repository has no PR flow (rule://delivery-git-workflow), and
 * the rule this replaces could be re-armed per `ttsr.repeatMode` whereas a gate
 * blocks every attempt. `DELIVERY_ALLOW_MAIN_COMMIT=1`, in the environment or
 * inline on the command, makes that decision explicit and auditable instead of
 * unavailable. This is advisory-strength, not a security boundary.
 */
import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 2000;

const PROTECTED_BRANCHES: Record<string, true> = { main: true, master: true };

/** `dgit` is the Git Defender wrapper this estate uses to reach github.com. */
const GIT_COMMANDS: Record<string, true> = { dgit: true, git: true };

/**
 * Command separators. `&&` and `||` are listed beside the single forms because the walker
 * treats them differently: only `&&`, `;`, and a newline keep a `cd` in the same shell.
 */
const SEPARATOR: Record<string, true> = {
	";": true,
	"&": true,
	"&&": true,
	"|": true,
	"||": true,
	"(": true,
	")": true,
};

/** Words that may stand before `git` and leave it at command position. */
const TRANSPARENT_PREFIX: Record<string, true> = { command: true, env: true, sudo: true };

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Pre-verb git options that consume the following token. */
const PRE_VERB_VALUE_FLAGS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--exec-path": true,
	"--git-dir": true,
	"--namespace": true,
	"--work-tree": true,
};

/** Cheap prefilter: never tokenize or spawn for a command that cannot commit. */
const PREFILTER = /\bd?git\b[\s\S]{0,400}?\bcommit\b/;

const ALLOW_ENV = "DELIVERY_ALLOW_MAIN_COMMIT";

/**
 * The override is honoured from the ENVIRONMENT only. There is deliberately no form that
 * reads the command text.
 *
 * A regex over the raw command granted it to any text with whitespace before the flag, so
 * `git commit -m "set DELIVERY_ALLOW_MAIN_COMMIT=1 to override"` disabled the gate, and a
 * commit explaining this gate contains exactly that prose. Two narrower scans were tried and
 * both failed: quotes had to be tracked, because bash reads a quoted assignment as a command
 * name, and then a `#` comment or a here-document body carrying `; FLAG=1 git commit`
 * authorised the real commit that came before it. Recognising an assignment soundly needs
 * comment and here-document grammar, which is a shell parser.
 *
 * Authorising on text that only LOOKS like an assignment is worse than requiring the
 * environment, because it turns a commit message into a way to switch the gate off.
 */

export type GitRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string };

let injectedRun: GitRun | null = null;

/** Replace the `git branch --show-current` seam. Pass `null` to restore it. */
export function setGitRunForTests(fn: GitRun | null): void {
	injectedRun = fn;
}

function defaultRun(argv: string[], cwd: string): { exitCode: number; stdout: string } {
	const proc = Bun.spawnSync(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: TIMEOUT_MS,
	});
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

export function extractCommand(input: Record<string, unknown>): string {
	if (typeof input.command === "string") return input.command;
	if (typeof input.cmd === "string") return input.cmd;
	return "";
}
export type Token = {
	text: string;
	/**
	 * Any part of this word arrived inside quotes, so it is an operand however it reads.
	 * `git -C '&&' commit` passed `&&` as a directory, and an untyped scan stopped there as
	 * though it were the operator, emitting no invocation at all.
	 */
	quoted: boolean;
};

/**
 * Words and separators, with quoting recorded. A quoted region is inert here: finding where a
 * substitution inside one ENDS needs a real parser, so `hasHiddenSubstitution` handles that
 * case conservatively instead.
 */
export function tokenize(command: string): Token[] {
	const out: Token[] = [];
	let cur = "";
	let started = false;
	let wasQuoted = false;
	let quote: string | null = null;
	const flush = (): void => {
		if (started) out.push({ text: cur, quoted: wasQuoted });
		cur = "";
		started = false;
		wasQuoted = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote === "'") {
			if (ch === quote) quote = null;
			else {
				cur += ch;
				started = true;
			}
			continue;
		}
		if (quote === '"') {
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
			wasQuoted = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			cur += command[i + 1] as string;
			started = true;
			wasQuoted = true;
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			// An unquoted newline is a command separator. Splitting the command on newlines
			// first would close a quote at the break, so a `git commit` inside that quote
			// would look like a real invocation.
			if (ch === "\n" || ch === "\r") {
				flush();
				out.push({ text: "\n", quoted: false });
				if (ch === "\r" && command[i + 1] === "\n") i++;
				continue;
			}
			flush();
			continue;
		}
		if (SEPARATOR[ch] === true) {
			flush();
			// `&&` and `||` must not read as `&` and `|`.
			if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
				out.push({ text: ch + ch, quoted: false });
				i++;
				continue;
			}
			out.push({ text: ch, quoted: false });
			continue;
		}
		cur += ch;
		started = true;
	}
	flush();
	return out;
}

/**
 * Whether a substitution the walker cannot see through is present.
 *
 * Two shapes qualify. A `$(` or a backtick inside DOUBLE quotes executes, and treating the
 * quoted region as inert hides the commit in it. An UNQUOTED backtick also hides one, because
 * the backtick is not a separator, so `` echo `git commit -m x` `` leaves the commit off
 * command position. An unquoted `$(` needs no help: the `(` is already a separator.
 *
 * Finding where a substitution ENDS does not work, which is why this only answers the
 * question. A `)` behind a quote or a backslash closes it early, so
 * `$(printf ')'; git commit -m x)` truncates before the commit. The caller re-scans instead,
 * which over-detects, and over-detection blocks visibly rather than clearing a commit nobody
 * read.
 */
export function hasHiddenSubstitution(command: string): boolean {
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		// A backslash escapes outside quotes and inside double quotes. Inside SINGLE quotes it
		// is a literal character, so consuming the next one there loses the closing quote.
		if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
			i++;
			continue;
		}
		if (quote !== null) {
			if (ch === quote) quote = null;
			else if (quote === '"' && (ch === "`" || (ch === "$" && command[i + 1] === "(")))
				return true;
			continue;
		}
		if (ch === "`") return true;
		if (ch === '"' || ch === "'") quote = ch;
	}
	return false;
}

export type CommitInvocation = {
	/** Repository the commit targets, relative to the bash call's cwd. */
	repoDir: string | null;
	/** `--dry-run` writes no commit, so the branch does not matter. */
	dryRun: boolean;
};

/**
 * Every real `git`/`dgit` commit in the command.
 *
 * Command position is per separator, including an unquoted newline. A quoted operand that
 * contains a git verb is not an invocation, which is why this walks ONE token stream rather
 * than splitting on newlines: a quoted operand may span one. Successive `-C` options are
 * folded the way git folds them, each relative to the last.
 *
 * A `cd` in the command is NOT followed. Inferring the directory from one was tried three
 * times and reverted each time. The walker cannot tell a `cd` that ran from one that did not:
 * a failed `cd` before `;` leaves the shell where it was, `||` may skip it, `&` backgrounds
 * the list it belongs to, and a `cd` inside a brace group, a loop, a comment or a
 * here-document body is invisible or inert. `pushd`, `eval` and a function can move the
 * directory with no `cd` token at all.
 *
 * Each of those produced a SILENT permit: the gate read a directory the commit never ran in
 * and cleared a commit on a protected branch. Blocking safe work is visible and retryable,
 * so the gate reads the directory it is given and names the two ways to state another one.
 * Telling them apart needs a typed lexer and a command grammar, which is a shell parser.
 */
export function findCommitInvocations(command: string): CommitInvocation[] {
	// A substitution inside double quotes executes, and this walker cannot find where it ends.
	// Re-scan with every quote turned into a space: that reveals the commit, at the cost of
	// reading some quoted prose as a command. Over-detection blocks visibly; missing a real
	// invocation clears a commit nobody read.
	// Quotes become spaces; a backtick becomes `;` so the command inside it reaches command
	// position. `$(` already leaves a `(`, which is a separator.
	const scanned = hasHiddenSubstitution(command)
		? command.replace(/["']/g, " ").replace(/`/g, ";")
		: command;
	const out: CommitInvocation[] = [];
	const tokens = tokenize(scanned);
	const isSep = (t: Token | undefined): boolean =>
		t !== undefined && !t.quoted && (SEPARATOR[t.text] === true || t.text === "\n");
	let atCommand = true;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as Token;
		if (isSep(token)) {
			atCommand = true;
			continue;
		}
		if (!atCommand) continue;
		if (TRANSPARENT_PREFIX[token.text] === true || ENV_ASSIGNMENT.test(token.text)) continue;
		atCommand = false;
		// Quoting removes SYNTAX meaning, not argv meaning: `'git' commit` runs git, so command
		// identity ignores it. Only `isSep` consults `quoted`.
		if (GIT_COMMANDS[token.text] !== true) continue;

		let repoDir: string | null = null;
		let verb: string | null = null;
		let dryRun = false;
		let j = i + 1;
		for (; j < tokens.length; j++) {
			const arg = tokens[j] as Token;
			if (isSep(arg)) break;
			if (arg.text.startsWith("-") && arg.text !== "-") {
				const eq = arg.text.indexOf("=");
				const name = eq === -1 ? arg.text : arg.text.slice(0, eq);
				if (name === "--dry-run") dryRun = true;
				if (eq === -1 && verb === null && PRE_VERB_VALUE_FLAGS[name] === true) {
					const value = tokens[j + 1];
					if (value !== undefined && !isSep(value)) {
						if (name === "-C")
							repoDir = repoDir === null ? value.text : resolve(repoDir, value.text);
						j++;
					}
				}
				continue;
			}
			if (verb === null) verb = arg.text.toLowerCase();
		}
		// Step back so the outer loop lands ON the separator the scan stopped at, letting it make
		// its own command-position transition.
		i = j - 1;
		if (verb === "commit") out.push({ repoDir, dryRun });
	}
	return out;
}

/**
 * The checked-out branch of the repository at `cwd`, or `null` when git cannot
 * say: no work tree, a detached HEAD, an unborn branch, or no `git` at all.
 */
export function currentBranch(cwd: string): string | null {
	const run = injectedRun ?? defaultRun;
	try {
		const result = run(["git", "branch", "--show-current"], cwd);
		if (result.exitCode !== 0) return null;
		const branch = result.stdout.trim();
		return branch === "" ? null : branch;
	} catch {
		return null;
	}
}

export function denyReason(branch: string): string {
	return (
		`blocked by delivery (work lands on a branch, never on ${branch}): the directory this ` +
		`commit was read against has \`${branch}\` checked out. Create or switch to a feature ` +
		"branch first (`git switch -c <type>/<slug>`, or `git switch <existing>` when the " +
		"branch was made for this task), then commit there and open a PR.\n\n" +
		"If the commit targets a DIFFERENT repository, that one is what to check. A `cd` in the " +
		"command is NOT followed, so the branch above was read in the bash call's own working " +
		"directory. Inferring it from a `cd` cleared commits onto protected branches, because " +
		"the walker cannot tell a `cd` that ran from one that did not. Name the repository " +
		"instead: pass the bash tool's `cwd`, or use an absolute `git -C <path> commit`. Both " +
		"are read directly.\n\n" +
		`Only when the user explicitly asked for a commit on ${branch}, in a repository with ` +
		`no PR flow or under an instruction to land directly, set \`${ALLOW_ENV}=1\` in the ` +
		"ENVIRONMENT, either on the bash call or in the session. There is no command-text " +
		"form: a commit message mentioning that flag used to disable this gate, so nothing " +
		"written in the command grants it."
	);
}

export function decideCommit(
	command: string,
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): { block: true; reason: string } | undefined {
	if (env[ALLOW_ENV] === "1") return;
	if (!PREFILTER.test(command)) return;
	for (const invocation of findCommitInvocations(command)) {
		if (invocation.dryRun) continue;
		// `-C` is the only directory the command states outright, so it is the only one applied.
		// A `cd` is not followed, for the reasons on `findCommitInvocations`.
		const target =
			invocation.repoDir === null ? cwd : resolve(cwd, invocation.repoDir);
		const branch = currentBranch(target);
		if (branch === null) continue;
		if (PROTECTED_BRANCHES[branch] === true) return { block: true, reason: denyReason(branch) };
	}
	return;
}

export default function mainBranchGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command) return;
			const cwd =
				typeof event.input.cwd === "string" && event.input.cwd
					? event.input.cwd
					: process.cwd();
			// The bash call's own environment counts, layered over the process environment.
			// Without it the override is reachable only by relaunching the session with the flag
			// set, which disables the gate for every commit rather than the one the user
			// authorised. Structured tool input is safe to trust here in a way command text is
			// not: a commit message or a here-document body cannot forge a field.
			const callEnv =
				typeof event.input.env === "object" && event.input.env !== null
					? (event.input.env as NodeJS.ProcessEnv)
					: undefined;
			return decideCommit(command, cwd, callEnv ? { ...process.env, ...callEnv } : process.env);
		} catch {
			return;
		}
	});
}
