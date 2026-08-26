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
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

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
const ALLOW_INLINE = /(?:^|[\s;&|])DELIVERY_ALLOW_MAIN_COMMIT=1(?![\w-])/;

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

/**
 * Shell-ish tokenizer: enough to tell a git invocation from the same words inside
 * a quoted commit message. Duplicated rather than shared with the beads plugin's
 * copy because plugins install independently and depend on nothing but the host.
 */
export function tokenize(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let started = false;
	let quote: '"' | "'" | null = null;
	const flush = (): void => {
		if (started) {
			out.push(cur);
			cur = "";
			started = false;
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
			// `&&` and `||` must not read as `&` and `|`: only the doubled forms keep a `cd`
			// in the same shell, and the single forms put the next command back in the
			// directory the pipeline or background job inherited.
			if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
				out.push(ch + ch);
				i++;
				continue;
			}
			out.push(ch);
			continue;
		}
		cur += ch;
		started = true;
	}
	flush();
	return out;
}

export type CommitInvocation = {
	/** Repository the commit targets, relative to the bash call's cwd. */
	repoDir: string | null;
	/** `--dry-run` writes no commit, so the branch does not matter. */
	dryRun: boolean;
	/** Directory `cd` reached, relative to the bash cwd; `null` means that cwd itself. */
	chdir: string | null;
	/**
	 * A `cd` whose destination cannot be named: `cd -`, or a target built from a variable.
	 * Distinct from `chdir: null`, which names a real directory. Reading some other
	 * directory instead would either block a commit that was never on a protected branch
	 * or pass one that was, so the gate declines to guess.
	 */
	chdirUnknown: boolean;
};

/**
 * Every real `git`/`dgit` commit in the command.
 *
 * Command position is per line as well as per separator, because a multi-line
 * script commits from line two as readily as from line one. Successive `-C`
 * options are folded the way git folds them: each is relative to the last.
 *
 * A `cd` in the command moves the repository the commit lands in, so it is
 * tracked the same way. Without it `cd repo && git commit` was judged against
 * the session's own directory, which blocked commits to a feature branch in a
 * sibling repository and pointed the caller at the override for the wrong
 * reason.
 *
 * Only `&&`, `;`, and a newline carry a `cd` forward. Each side of a pipeline runs
 * in its own shell, so `cd repo | git commit` commits in the directory the
 * pipeline inherited; after `||` the `cd` either never ran or failed; and `&`
 * backgrounds it. Those three revert to the directory in force at the last
 * sequential boundary, and a subshell restores what it inherited.
 */
export function findCommitInvocations(command: string): CommitInvocation[] {
	const out: CommitInvocation[] = [];
	let chdir: string | null = null;
	/** A `cd` this walker cannot resolve, so no directory may be read for the commit. */
	let chdirUnknown = false;
	/** State at the last `&&`, `;`, or newline: what a pipeline or a failed `cd` inherits. */
	let sequential: { chdir: string | null; unknown: boolean } = { chdir: null, unknown: false };
	/** Inside a pipeline every segment is its own shell, so no `cd` here may escape it. */
	let inPipeline = false;
	/** A `cd` whose success decided which side of a `||` ran: a later `&&` rejoins both. */
	let pendingBranchDependent = false;
	const subshells: {
		chdir: string | null;
		chdirUnknown: boolean;
		sequential: { chdir: string | null; unknown: boolean };
		inPipeline: boolean;
		pendingBranchDependent: boolean;
	}[] = [];
	const revert = (): void => {
		chdir = sequential.chdir;
		chdirUnknown = sequential.unknown;
	};
	/**
	 * Leave a pipeline or a sequential boundary, then set the new baseline. A `cd` whose
	 * success chose which side of an earlier `||` ran leaves the directory branch-dependent
	 * from here on, because both paths reach whatever follows.
	 */
	const endSegment = (): void => {
		if (inPipeline) revert();
		if (pendingBranchDependent) chdirUnknown = true;
		pendingBranchDependent = false;
		inPipeline = false;
		sequential = { chdir, unknown: chdirUnknown };
	};
	for (const line of command.split(/\r?\n/)) {
		endSegment();
		const tokens = tokenize(line);
		let atCommand = true;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i] as string;
			if (SEPARATOR[token] === true) {
				if (token === "(") {
					subshells.push({ chdir, chdirUnknown, sequential, inPipeline, pendingBranchDependent });
					inPipeline = false;
					pendingBranchDependent = false;
					sequential = { chdir, unknown: chdirUnknown };
				} else if (token === ")") {
					const outer = subshells.pop();
					if (outer !== undefined) {
						chdir = outer.chdir;
						chdirUnknown = outer.chdirUnknown;
						sequential = outer.sequential;
						inPipeline = outer.inPipeline;
						pendingBranchDependent = outer.pendingBranchDependent;
					}
				} else if (token === "|" || token === "&") {
					// Each pipeline segment and a background job run in their own shell, so a `cd`
					// in one definitively does not reach what follows.
					revert();
					inPipeline = token === "|";
				} else if (token === "||") {
					// This segment runs only when the left side failed, so a `cd` there did not take
					// effect and the directory here is the baseline. What the outcome leaves open is
					// everything AFTER this segment, which both paths reach. Accumulate rather than
					// assign: in `cd d || false || true` the first `||` already reverted the
					// directory, so the second sees no move and would clear the flag that the
					// first `cd` earned.
					pendingBranchDependent ||=
						chdir !== sequential.chdir || chdirUnknown !== sequential.unknown;
					revert();
					inPipeline = false;
				} else endSegment();
				atCommand = true;
				continue;
			}
			if (!atCommand) continue;
			if (TRANSPARENT_PREFIX[token] === true || ENV_ASSIGNMENT.test(token)) continue;
			atCommand = false;
			if (token === "cd") {
				const target = tokens[i + 1];
				const bare = target === undefined || SEPARATOR[target] === true;
				if (bare) {
					// Bare `cd` goes to HOME, which is a real directory and often a git repository.
					chdir = homedir();
					chdirUnknown = false;
					continue;
				}
				const dir = target as string;
				i++;
				if (dir === "-" || dir.startsWith("-") || dir.includes("$") || dir.includes("`")) {
					// `cd -` returns to a directory only the live shell remembers, and a target built
					// from a variable is not resolvable here either.
					chdirUnknown = true;
					continue;
				}
				const expanded = dir === "~" || dir.startsWith("~/") ? resolve(homedir(), dir.slice(2)) : dir;
				chdir = chdir === null || chdirUnknown ? expanded : resolve(chdir, expanded);
				chdirUnknown = chdirUnknown && !isAbsolute(expanded);
				continue;
			}
			if (GIT_COMMANDS[token] !== true) continue;

			let repoDir: string | null = null;
			let verb: string | null = null;
			let dryRun = false;
			let j = i + 1;
			for (; j < tokens.length; j++) {
				const arg = tokens[j] as string;
				if (SEPARATOR[arg] === true) break;
				if (arg.startsWith("-") && arg !== "-") {
					const eq = arg.indexOf("=");
					const name = eq === -1 ? arg : arg.slice(0, eq);
					if (name === "--dry-run") dryRun = true;
					if (eq === -1 && verb === null && PRE_VERB_VALUE_FLAGS[name] === true) {
						const value = tokens[j + 1];
						if (value !== undefined && SEPARATOR[value] !== true) {
							if (name === "-C") repoDir = repoDir === null ? value : resolve(repoDir, value);
							j++;
						}
					}
					continue;
				}
				if (verb === null) verb = arg.toLowerCase();
			}
			// Step back so the outer loop lands ON the separator the scan stopped at, letting it
			// make its own cwd and command-position transition. Skipping it leaked a `cd` from
			// a pipeline segment into the sequential baseline.
			i = j - 1;
			if (verb === "commit") out.push({ repoDir, dryRun, chdir, chdirUnknown });
		}
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
		`blocked by delivery (work lands on a branch, never on ${branch}): the repository ` +
		`this commit targets has \`${branch}\` checked out. Create or switch to a feature ` +
		"branch first (`git switch -c <type>/<slug>`, or `git switch <existing>` when the " +
		"branch was made for this task), then commit there and open a PR. The branch was " +
		"read with `git branch --show-current` in that repository, not guessed from the " +
		"commit message. If the user explicitly asked for a commit on " +
		`${branch} — a repository with no PR flow, or an instruction to land directly — ` +
		`say so and re-issue with \`${ALLOW_ENV}=1\` set inline on the command or in the ` +
		"environment."
	);
}

export function decideCommit(
	command: string,
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): { block: true; reason: string } | undefined {
	if (env[ALLOW_ENV] === "1" || ALLOW_INLINE.test(command)) return;
	if (!PREFILTER.test(command)) return;
	for (const invocation of findCommitInvocations(command)) {
		if (invocation.dryRun) continue;
		// An absolute `-C` names the repository outright, so an unresolvable `cd` cannot
		// change which one is read. Otherwise the target depends on that `cd`, and reading
		// some other directory would decide this commit on evidence from elsewhere.
		const repoDir = invocation.repoDir;
		if (invocation.chdirUnknown && (repoDir === null || !isAbsolute(repoDir))) continue;
		const base = invocation.chdir === null ? cwd : resolve(cwd, invocation.chdir);
		const target = repoDir === null ? base : resolve(base, repoDir);
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
			return decideCommit(command, cwd);
		} catch {
			return;
		}
	});
}
