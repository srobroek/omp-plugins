import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { type ShellToken, shellQuoteBalanced, tokenizeShell } from "./shell-tokenizer.ts";
import { ProbeTimeout, type SpawnBudget, type SpawnResult, spawnBudget, spawnWithin } from "./spawn-budget.ts";
import { parseWorktreeList } from "./worktree-detached-guard.ts";

/**
 * Let a local branch force-delete through only when its work provably landed; otherwise ask the owner.
 *
 * Covered: `git [-C dir] branch` with `-D`, `--delete --force`, `-d -f` and their spellings, and
 * `wt remove` with `-D`/`--force-delete`. Plain `git branch -d` and `wt remove` without `-D` are left
 * alone: git and wt already refuse an unmerged branch there.
 *
 * Each target tip is classified at gate time:
 * 1. landed: an ancestor of the default remote branch (`origin/HEAD`, else `origin/main|master`);
 * 2. landed: GitHub reports a MERGED pull request whose head is this branch at this exact tip, which
 *    covers squash merges. Any gh failure or timeout means the signal is absent, never that it holds;
 * 3. otherwise unlanded: the owner confirms through OMP's dialog, which shows the commits not in the
 *    default branch, whether a remote ref still holds the tip, and the `git branch NAME SHA` restore.
 *    Without an interactive UI the call is refused with that same text.
 *
 * Invariants: nothing is allowed silently unless signal 1 or 2 holds for every target. A command whose
 * targets, directory, or repository cannot be read with certainty (expansion, a wrapper, an unknown
 * option, an unresolvable branch, a git timeout) is refused, and so is a target an earlier command in
 * the same call could move before the delete runs. Every other bash call is left alone.
 */

const MAX_COMMAND_LENGTH = 64_000;
const GH_TIMEOUT_MS = 8_000;
const SUBJECTS_SHOWN = 5;
const SUBJECT_WIDTH = 100;
const PREFIX = "Branch force-delete refused";

/** Run gh with `args` in `cwd` for at most `timeoutMs`; stdout, or null on any failure or timeout. */
export type GhRunner = (args: string[], cwd: string, timeoutMs: number) => string | null;

export type GateOptions = {
	/** Per git call. */
	timeoutMs?: number;
	/** For every git and gh call one bash command triggers. */
	budgetMs?: number;
	/** Per gh call, further capped by what is left of the budget. */
	ghTimeoutMs?: number;
	gh?: GhRunner;
};

export type Verdict =
	| { action: "allow" }
	| { action: "refuse"; reason: string }
	| { action: "confirm"; title: string; message: string; branches: string[] };

const ALLOW: Verdict = { action: "allow" };

function refuse(reason: string): Verdict {
	return { action: "refuse", reason: `${PREFIX}: ${reason}` };
}

/** A classification step that cannot proceed with certainty. */
class Refusal extends Error {}

// --- Detection ---------------------------------------------------------------------------------

const EDGE = String.raw`(?:^|[\s;&|(\x60])`;
const END = String.raw`(?=$|[\s;&|)\x60])`;
const BRANCH_WORD = new RegExp(`${EDGE}branch${END}`);
const BIG_D = new RegExp(`${EDGE}-[A-Za-z]*D[A-Za-z]*${END}`);
const DELETE_FLAG = new RegExp(`${EDGE}(?:-[A-Za-z]*d[A-Za-z]*|--d[a-z]*)${END}`);
const FORCE_FLAG = new RegExp(`${EDGE}(?:-[A-Za-z]*f[A-Za-z]*|--f[a-z]*)${END}`);
const WT_WORD = new RegExp(`(?:^|[\\s;&|(\\x60/])(?:wt|worktrunk)${END}`);
const REMOVE_WORD = new RegExp(`${EDGE}(?:remove|rm)${END}`);
const WT_FORCE_DELETE = new RegExp(`${EDGE}(?:-[A-Za-z]*D[A-Za-z]*|--force-d[a-z-]*)${END}`);

/**
 * Whether text spells a branch force-delete anywhere, including inside quotes or another command's
 * argument. A superset of what the parser accepts, so it serves both as the cheap prefilter and as
 * the test for a delete hidden where the parser cannot attribute it.
 */
export function mentionsForceDelete(text: string): boolean {
	const flat = text.replace(/['"\\]/g, "");
	if (flat.includes("branch") && BRANCH_WORD.test(flat)) {
		if (BIG_D.test(flat) || (DELETE_FLAG.test(flat) && FORCE_FLAG.test(flat))) return true;
	}
	if (!(flat.includes("wt") || flat.includes("worktrunk")) || !WT_FORCE_DELETE.test(flat)) return false;
	// Two linear scans: a remove after any wt word follows the first one.
	const wt = WT_WORD.exec(flat);
	return wt !== null && REMOVE_WORD.test(flat.slice(wt.index));
}

// --- Lexing ------------------------------------------------------------------------------------

export type Segment = {
	words: ShellToken[];
	/** Operators between the previous segment and this one: `&&`, `||`, `;`, newline, `|`, `&`, `(`, `)`, `$(`. */
	gap: string[];
	/** The words continue past a substitution or carry a process substitution, so they are incomplete. */
	opaque: boolean;
};

const OPERATORS = new Set([";", "&", "|", "(", ")", "\n", "$("]);
/** A redirection operator at the start of an unquoted word: `>`, `2>>`, `<`, `>&`, `<>`, `>|`. */
const REDIRECTION = /^\d*(?:>>|>&|>\||>|<&|<>|<)/;
/** A quoted here-document delimiter. Its body would be dropped as data, but a shell may run it. */
const QUOTED_HEREDOC = /(?<!<)<<(?!<)(-?)([ \t]*)([^\s;&|<>()]*['"\\][^\s;&|<>()]*)/g;

function isOperator(token: ShellToken | undefined): boolean {
	return token !== undefined && !token.sawQuote && OPERATORS.has(token.value);
}

/** Split a command into simple commands, dropping redirections, here-strings, and comments. */
export function segments(command: string): Segment[] {
	// Lex every here-document body as commands: whether it runs depends on what reads it.
	const lexable = command.replace(QUOTED_HEREDOC, (_all, dash: string, space: string, word: string) => `<<${dash}${space}${word.replace(/['"\\]/g, "")}`);
	const tokens = tokenizeShell(lexable, { preserveBackslashes: true });
	const out: Segment[] = [];
	let words: ShellToken[] = [];
	let gap: string[] = [];
	let opaque = false;
	const close = () => {
		if (words.length > 0) {
			out.push({ words, gap, opaque });
			gap = [];
		}
		words = [];
		opaque = false;
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as ShellToken;
		if (isOperator(token)) {
			if (token.value === "$(") opaque = true;
			close();
			const last = gap.at(-1);
			if ((token.value === "&" || token.value === "|") && last === token.value) gap[gap.length - 1] = `${last}${last}`;
			else gap.push(token.value);
			continue;
		}
		if (!token.sawQuote && token.value.startsWith("#")) {
			while (i + 1 < tokens.length && tokens[i + 1]?.value !== "\n") i++;
			continue;
		}
		if (!token.sawQuote && token.value === "<<<") {
			if (!isOperator(tokens[i + 1])) i++;
			continue;
		}
		const redirection = token.sawQuote ? null : REDIRECTION.exec(token.value);
		if (redirection) {
			if (redirection[0].length < token.value.length) continue;
			const next = tokens[i + 1];
			if (next && !isOperator(next)) {
				i++;
				continue;
			}
			// `2>&1`: the tokenizer splits the duplication's `&` off as an operator.
			const fd = tokens[i + 2];
			if (next?.value === "&" && fd && !isOperator(fd) && /^(?:\d+|-)$/.test(fd.value)) {
				i += 2;
				continue;
			}
			opaque = true;
			continue;
		}
		words.push(token);
	}
	close();
	return out;
}

// --- Parsing -----------------------------------------------------------------------------------

const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"]);
/** Wrappers that run their tail unchanged when given no options of their own. */
const PASSTHROUGH = new Set(["sudo", "doas", "env", "nohup", "command", "exec", "nice", "time"]);
const DIRECTORY_CHANGES = new Set(["cd", "pushd", "popd"]);
/** Commands that cannot move a branch, so a delete after them is classified on current state. */
const INERT = new Set(["cd", "pushd", "echo", "printf", "true", ":", "pwd", "ls", "cat", "test", "[", "sleep"]);
const INERT_GIT = new Set(["status", "log", "show", "diff", "rev-parse", "for-each-ref", "ls-files"]);
const GIT_FLAGS = new Set([
	"--no-pager", "-P", "-p", "--paginate", "--no-optional-locks", "--no-replace-objects",
	"--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-advice",
]);
const WT_VALUE_OPTIONS = new Set(["--config", "--config-set", "--format"]);
/** Characters whose meaning the shell decides at run time: expansion, globbing, escapes. */
const EXPANSION = /[$`*?[\]{}\\]/;

type CommandLine = { name: string; args: ShellToken[]; gitEnvironment: boolean };

function commandLine(words: ShellToken[]): CommandLine | null {
	let gitEnvironment = false;
	let i = 0;
	for (; i < words.length; i++) {
		const word = words[i] as ShellToken;
		if (!word.sawQuote && RESERVED.has(word.value)) continue;
		const assignment = word.startsQuoted ? null : /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word.value);
		if (assignment) {
			if (assignment[1]?.startsWith("GIT_")) gitEnvironment = true;
			continue;
		}
		// A wrapper option (`sudo -u`, `nice -n`, `env -C`) may take a value or change the directory,
		// so the wrapper itself stays the command and the delete behind it reads as wrapped.
		if (PASSTHROUGH.has(basename(word.value)) && !words[i + 1]?.value.startsWith("-")) continue;
		break;
	}
	const head = words[i];
	return head ? { name: basename(head.value), args: words.slice(i + 1), gitEnvironment } : null;
}

function untrusted(word: ShellToken): boolean {
	if (EXPANSION.test(word.value)) return true;
	if (!word.sawQuote && /[<>]/.test(word.value)) return true;
	return !word.startsQuoted && /^~[^/]/.test(word.value);
}

/** The path a word names, with an unquoted leading `~` expanded. */
function pathOf(word: ShellToken): string {
	if (!word.startsQuoted && (word.value === "~" || word.value.startsWith("~/"))) return homedir() + word.value.slice(1);
	return word.value;
}

type GitCommand = { chdirs: ShellToken[]; subcommand: string; args: ShellToken[] };

/** The subcommand after git's global options, or null when an option this gate does not know precedes it. */
function gitCommand(args: ShellToken[]): GitCommand | null {
	const chdirs: ShellToken[] = [];
	for (let i = 0; i < args.length; i++) {
		const value = (args[i] as ShellToken).value;
		if (value === "-C" || value === "-c") {
			const operand = args[++i];
			if (!operand) return null;
			if (value === "-C") chdirs.push(operand);
			continue;
		}
		if (GIT_FLAGS.has(value)) continue;
		if (value.startsWith("-")) return null;
		return { chdirs, subcommand: value, args: args.slice(i + 1) };
	}
	return null;
}

type BranchFlags = { forceDelete: boolean; deletes: boolean; remotes: boolean; mayMove: boolean; names: ShellToken[] };

/** `git branch` arguments, read as a superset: an over-detected force flag only costs a question. */
function branchFlags(args: ShellToken[]): BranchFlags {
	let bigD = false;
	let del = false;
	let force = false;
	let remotes = false;
	let mayMove = false;
	let afterSeparator = false;
	const names: ShellToken[] = [];
	for (const word of args) {
		const value = word.value;
		if (!afterSeparator && value === "--") {
			afterSeparator = true;
			continue;
		}
		if (!afterSeparator && value.startsWith("--")) {
			// git accepts any unambiguous prefix of a long option.
			const flag = value.split("=", 1)[0] as string;
			if (flag.length >= 3) {
				if ("--delete".startsWith(flag)) del = true;
				if ("--force".startsWith(flag)) force = true;
				if ("--remotes".startsWith(flag) || "--all".startsWith(flag)) remotes = true;
				if ("--move".startsWith(flag) || "--copy".startsWith(flag)) mayMove = true;
			}
			continue;
		}
		if (!afterSeparator && value.length > 1 && value.startsWith("-")) {
			for (const letter of value.slice(1)) {
				if (letter === "D") bigD = true;
				else if (letter === "d") del = true;
				else if (letter === "f") force = true;
				else if (letter === "r" || letter === "a") remotes = true;
				else if ("mMcC".includes(letter)) mayMove = true;
			}
			continue;
		}
		names.push(word);
	}
	return { forceDelete: bigD || (del && force), deletes: bigD || del, remotes, mayMove: mayMove || force, names };
}

type WtRemoval = { forceDelete: boolean; chdirs: ShellToken[]; targets: ShellToken[] };

/** `wt remove` arguments; null when the words are not a `wt remove` this gate can read. */
function wtRemoval(args: ShellToken[]): WtRemoval | null {
	const chdirs: ShellToken[] = [];
	const positional: ShellToken[] = [];
	let forceDelete = false;
	let keepBranch = false;
	let afterSeparator = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i] as ShellToken;
		const value = word.value;
		if (!afterSeparator && value === "--") {
			afterSeparator = true;
			continue;
		}
		if (!afterSeparator && value.startsWith("--")) {
			const flag = value.split("=", 1)[0] as string;
			if (flag === "--force-delete") forceDelete = true;
			else if (flag === "--no-delete-branch") keepBranch = true;
			else if (WT_VALUE_OPTIONS.has(flag) && !value.includes("=")) i++;
			continue;
		}
		if (!afterSeparator && value.length > 1 && value.startsWith("-")) {
			for (let k = 1; k < value.length; k++) {
				if (value[k] === "D") forceDelete = true;
				if (value[k] !== "C") continue;
				const attached = value.slice(k + 1);
				const operand = attached ? { ...word, value: attached } : args[++i];
				if (!operand) return null;
				chdirs.push(operand);
				break;
			}
			continue;
		}
		positional.push(word);
	}
	const [subcommand, ...targets] = positional;
	if (subcommand?.value !== "remove" && subcommand?.value !== "rm") return null;
	return { forceDelete: forceDelete && !keepBranch, chdirs, targets };
}

/** Whether a command that is not itself a delete leaves every local branch where it is. */
function leavesBranchesAlone(line: CommandLine): boolean {
	if (INERT.has(line.name)) return true;
	if (line.name === "wt" || line.name === "worktrunk") {
		const removal = wtRemoval(line.args);
		return removal !== null || line.args[0]?.value === "list";
	}
	if (line.name !== "git") return false;
	const git = gitCommand(line.args);
	if (!git) return false;
	const values = git.args.map((word) => word.value);
	switch (git.subcommand) {
		case "branch": {
			const flags = branchFlags(git.args);
			return flags.deletes || (flags.names.length === 0 && !flags.mayMove);
		}
		// Both bring in only commits a remote already holds; a `src:dst` refspec can rewrite any local branch.
		case "fetch":
		case "pull":
			return !values.some((value) => value.includes(":"));
		case "switch":
		case "checkout":
			return !values.some((value) =>
				value === "--orphan" || value === "--create" || value === "--force-create" ||
				(/^-[A-Za-z]+$/.test(value) && /[bBcC]/.test(value)));
		case "worktree":
			return values[0] === "list" || values[0] === "prune" || values[0] === "remove";
		default:
			return INERT_GIT.has(git.subcommand);
	}
}

/** Whether a name can be a local branch, by `git check-ref-format` rules. */
export function validBranchName(name: string): boolean {
	if (name === "" || name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
	if (name.endsWith(".") || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what git forbids.
	if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
	return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

export type DeleteRequest = {
	tool: "git" | "wt";
	/** Absolute directory git runs in. */
	dir: string;
	/** Branch names for git; worktree paths or branch names for wt, empty for the current worktree. */
	targets: string[];
	/** An earlier command in the same call may move a branch before this delete runs. */
	unverified: boolean;
	/** The literal words, for messages. */
	text: string;
};

const URL_CWD = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The force-deletes a command performs, or the reason they cannot be read with certainty. */
export function deleteRequests(command: string, cwd: string): DeleteRequest[] | string {
	if (!shellQuoteBalanced(command)) return "the command's quotes do not balance, so its targets cannot be read.";
	const base = URL_CWD.test(cwd) ? null : cwd;
	const requests: DeleteRequest[] = [];
	let unverified = false;
	// The shell's directory: certain until a directory change whose effect the delete cannot rely on.
	let dir: string | null = base;
	let changed = false;
	let chainIntact = true;
	for (const segment of segments(command)) {
		if (changed && chainIntact && !(segment.gap.length === 1 && segment.gap[0] === "&&")) chainIntact = false;
		const here = changed && !chainIntact ? null : dir;
		const line = commandLine(segment.words);
		if (!line) continue;
		if (DIRECTORY_CHANGES.has(line.name)) {
			// `a || cd x && …` and `a | cd x && …` reach the rest without the change taking effect.
			const operator = segment.gap.at(-1);
			const target = directoryTarget(line, here);
			dir = operator === "||" || operator === "|" ? null : target;
			changed = true;
			chainIntact = true;
			continue;
		}
		const git = line.name === "git" ? gitCommand(line.args) : null;
		const flags = git?.subcommand === "branch" ? branchFlags(git.args) : null;
		const removal = line.name === "wt" || line.name === "worktrunk" ? wtRemoval(line.args) : null;
		const isDelete = flags?.forceDelete === true || removal?.forceDelete === true;
		if (!isDelete) {
			// A delete spelled where the parser cannot attribute it: a wrapper, a quoted script, an option this gate does not know.
			const parsed = flags !== null || removal !== null;
			if (!parsed && mentionsForceDelete(segment.words.map((word) => word.value).join(" "))) {
				return `\`${line.name}\` carries a branch force-delete this gate cannot attribute (a wrapper, a quoted script, or an option it does not know). Run the delete as its own literal \`git branch -D NAME\` or \`wt remove -D NAME\` command.`;
			}
			if (!leavesBranchesAlone(line)) unverified = true;
			continue;
		}
		const text = segment.words.map((word) => word.value).join(" ");
		if (segment.opaque || segment.words.some(untrusted)) {
			return `\`${text}\` builds its targets through expansion, substitution, globbing, or escapes, so the branches it deletes cannot be identified. Name each branch literally.`;
		}
		if (line.gitEnvironment) return `\`${text}\` sets a GIT_* variable that can point git at another repository. Run it without the override, using \`git -C DIR\`.`;
		if (here === null) {
			return `the directory \`${text}\` runs in cannot be determined (a URL working directory, or a directory change it cannot rely on). Use the bash cwd, \`cd DIR && …\`, or \`git -C DIR\`.`;
		}
		let target = here;
		for (const chdir of git?.chdirs ?? removal?.chdirs ?? []) target = resolve(target, pathOf(chdir));
		if (flags) {
			if (flags.remotes) return `\`${text}\` deletes remote-tracking refs, which this gate does not classify. Prune them with \`git fetch --prune\` instead.`;
			const invalid = flags.names.find((name) => !validBranchName(name.value));
			if (invalid) return `\`${invalid.value}\` is not a local branch name, so the delete cannot be resolved.`;
		}
		const targets = (flags?.names ?? removal?.targets ?? []).map((word) => removal ? pathOf(word) : word.value);
		requests.push({ tool: flags ? "git" : "wt", dir: target, targets, unverified, text });
	}
	return requests;
}

/** Where a `cd`/`pushd` leaves the shell, or null when that cannot be known. */
function directoryTarget(line: CommandLine, from: string | null): string | null {
	if (line.name === "popd") return null;
	if (line.args.length === 0) return line.name === "cd" ? homedir() : null;
	const word = line.args[0] as ShellToken;
	if (line.args.length > 1 || untrusted(word) || word.value === "" || word.value.startsWith("-")) return null;
	const path = pathOf(word);
	if (isAbsolute(path)) return path;
	// CDPATH can send a bare relative name elsewhere.
	if (process.env.CDPATH && !/^\.\.?(?:\/|$)/.test(path)) return null;
	return from === null ? null : resolve(from, path);
}

// --- Classification ----------------------------------------------------------------------------

type Git = {
	/** A finished git call; Refusal when git cannot start, ProbeTimeout when it outlives its bound. */
	run: (args: string[], dir: string) => SpawnResult;
	/** Output of a git call, or null when it exits non-zero. */
	out: (args: string[], dir: string) => string | null;
};

function gitIn(budget: SpawnBudget): Git {
	const run = (args: string[], dir: string): SpawnResult => {
		const result = budget.run(["git", ...args], dir);
		if (result === null) throw new Refusal(`git could not run in ${dir}.`);
		return result;
	};
	return {
		run,
		out: (args, dir) => {
			const result = run(args, dir);
			return result.exitCode === 0 ? result.stdout : null;
		},
	};
}

function lines(text: string): string[] {
	return text.split("\n").filter((line) => line !== "");
}

type Repo = {
	/** The common git directory, shared by every worktree of the repository. */
	key: string;
	defaultRemote: string | null;
	/** Full ref of the default remote branch, such as `refs/remotes/origin/main`. */
	defaultRef: string | null;
	urls: Map<string, string | null>;
};

function readRepo(git: Git, dir: string): Repo {
	const key = git.out(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
	if (key === null) throw new Refusal(`${dir} is not inside a git repository.`);
	const remotesOut = git.out(["remote"], dir);
	if (remotesOut === null) throw new Refusal(`\`git remote\` failed in ${dir}.`);
	const remotes = lines(remotesOut);
	const defaultRemote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? (remotes[0] as string) : null;
	let defaultRef: string | null = null;
	if (defaultRemote) {
		const prefix = `refs/remotes/${defaultRemote}`;
		const out = git.out(["for-each-ref", "--format=%(refname)%00%(symref)", `${prefix}/HEAD`, `${prefix}/main`, `${prefix}/master`], dir);
		if (out === null) throw new Refusal(`the default branch of ${dir} could not be read.`);
		const refs = new Map(lines(out).map((line) => line.split("\0") as [string, string]));
		const head = refs.get(`${prefix}/HEAD`);
		defaultRef = head || (refs.has(`${prefix}/main`) ? `${prefix}/main` : refs.has(`${prefix}/master`) ? `${prefix}/master` : null);
	}
	return { key: key.trim(), defaultRemote, defaultRef, urls: new Map() };
}

type Branch = { name: string; tip: string; upstreamRemote: string | null };

/** Tips of the named local branches that exist. */
function readBranches(git: Git, dir: string, names: string[]): Map<string, Branch> {
	const found = new Map<string, Branch>();
	if (names.length === 0) return found;
	const out = git.out(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream:remotename)", ...names.map((name) => `refs/heads/${name}`)], dir);
	if (out === null) throw new Refusal(`the branches in ${dir} could not be read.`);
	const wanted = new Set(names);
	for (const line of lines(out)) {
		const [ref = "", tip = "", remote = ""] = line.split("\0");
		const name = ref.slice("refs/heads/".length);
		if (!ref.startsWith("refs/heads/") || !wanted.has(name) || !/^[0-9a-f]{40,64}$/.test(tip)) continue;
		found.set(name, { name, tip, upstreamRemote: remote && remote !== "." ? remote : null });
	}
	return found;
}

function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The local branches a `wt remove` would delete: its targets' branches, or the current worktree's. */
function wtBranchNames(git: Git, request: DeleteRequest): string[] {
	const dir = request.dir;
	if (request.targets.length === 0 || (request.targets.length === 1 && request.targets[0] === "@")) {
		const head = git.run(["symbolic-ref", "-q", "HEAD"], dir);
		if (head.exitCode === 1) return []; // detached: wt deletes no branch
		const ref = head.exitCode === 0 ? head.stdout.trim() : "";
		if (!ref) throw new Refusal(`the current branch in ${dir} could not be read.`);
		return ref.startsWith("refs/heads/") ? [ref.slice("refs/heads/".length)] : [];
	}
	const listed = git.out(["worktree", "list", "--porcelain"], dir);
	if (listed === null) throw new Refusal(`\`git worktree list\` failed in ${dir}.`);
	const worktrees = parseWorktreeList(listed);
	const named = request.targets.filter(validBranchName);
	const existing = readBranches(git, dir, named);
	const names = new Set<string>();
	for (const target of request.targets) {
		const path = realpath(resolve(dir, target));
		// wt resolves a target as a branch name or a worktree path; every reading it could take counts.
		const matches = worktrees.filter((w) => realpath(w.path) === path || basename(w.path) === target || w.branch === target);
		for (const match of matches) if (!match.detached && match.branch) names.add(match.branch);
		if (existing.has(target)) names.add(target);
		if (matches.length === 0 && !existing.has(target)) throw new Refusal(`\`${target}\` names no branch or worktree in ${dir}.`);
	}
	return [...names];
}

const GITHUB = /^(?:https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/|ssh:\/\/(?:[^@/]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;

/** `owner/repo` for a GitHub remote URL, or null for any other host. */
export function githubRepo(url: string): string | null {
	const match = GITHUB.exec(url.trim());
	return match ? `${match[1]}/${match[2]}` : null;
}

type Landed = { branch: Branch; proof: string };

type Unlanded = {
	branch: Branch;
	dir: string;
	/** Short name of the default remote branch, or null when the repository has none. */
	defaultBranch: string | null;
	ahead: number;
	subjects: string[];
	remoteRefs: string[];
	localRefs: string[];
	unverified: boolean;
	prCheck: string;
	/** `owner/repo` to ask GitHub about, when the merged-PR signal is still open. */
	slug: string | null;
};

const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };

export const defaultGh: GhRunner = (args, cwd, timeoutMs) => {
	try {
		const result = spawnWithin(["gh", ...args], cwd, timeoutMs, GH_ENV);
		return result?.exitCode === 0 ? result.stdout : null;
	} catch {
		return null;
	}
};

function shortRef(ref: string): string {
	return ref.replace(/^refs\/(?:heads|remotes|tags)\//, "");
}

function readUnlanded(git: Git, repo: Repo, dir: string, branch: Branch, unverified: boolean, deleted: Set<string>): Unlanded {
	const not = repo.defaultRef ? [repo.defaultRef] : ["--remotes"];
	const count = git.out(["rev-list", "--count", branch.tip, "--not", ...not], dir);
	const log = git.out(["log", "--no-color", "--no-show-signature", "--format=%h %s", `--max-count=${SUBJECTS_SHOWN}`, branch.tip, "--not", ...not], dir);
	const containing = git.out(["for-each-ref", "--contains", branch.tip, "--format=%(refname)"], dir);
	if (count === null || log === null || containing === null) throw new Refusal(`the history of ${branch.name} in ${dir} could not be read.`);
	const refs = lines(containing);
	let prCheck = "skipped: an earlier command in this call can move the branch first.";
	let slug: string | null = null;
	if (!unverified) {
		const remote = branch.upstreamRemote ?? repo.defaultRemote;
		if (!remote) prCheck = "skipped: no remote to look a pull request up on.";
		else {
			if (!repo.urls.has(remote)) repo.urls.set(remote, /^\w[\w.\-/]*$/.test(remote) ? git.out(["remote", "get-url", remote], dir) : null);
			const url = repo.urls.get(remote);
			slug = url ? githubRepo(url) : null;
			prCheck = slug ? "pending" : url ? `skipped: remote ${remote} is not on GitHub.` : `skipped: remote ${remote} has no readable URL.`;
		}
	}
	return {
		branch,
		dir,
		defaultBranch: repo.defaultRef ? shortRef(repo.defaultRef) : null,
		ahead: Number.parseInt(count.trim(), 10) || 0,
		// biome-ignore lint/suspicious/noControlCharactersInRegex: a subject is shown in a dialog.
		subjects: lines(log).map((line) => line.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, SUBJECT_WIDTH)),
		remoteRefs: refs.filter((ref) => ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")).map(shortRef),
		localRefs: refs.filter((ref) => !ref.startsWith("refs/remotes/") && !deleted.has(ref)).map(shortRef),
		unverified,
		prCheck,
		slug,
	};
}

type MergedPr = { number?: unknown; headRefOid?: unknown; headRefName?: unknown };

/** The merged PR number proving the tip landed, or a reason the signal is absent. */
function mergedPr(gh: GhRunner, unlanded: Unlanded, timeoutMs: number): number | string {
	if (timeoutMs <= 0) return "skipped: this call's time budget is spent.";
	const { name, tip } = unlanded.branch;
	const slug = unlanded.slug as string;
	let out: string | null;
	try {
		out = gh(["pr", "list", "--repo", slug, "--state", "merged", "--head", name, "--json", "number,headRefOid,headRefName"], unlanded.dir, timeoutMs);
	} catch {
		out = null;
	}
	if (out === null) return `gh could not answer for ${slug} (not installed, not authenticated, or timed out).`;
	let prs: unknown;
	try {
		prs = JSON.parse(out);
	} catch {
		return `gh returned unreadable output for ${slug}.`;
	}
	if (!Array.isArray(prs)) return `gh returned unreadable output for ${slug}.`;
	const match = (prs as MergedPr[]).find((pr) => pr?.headRefOid === tip && pr?.headRefName === name && typeof pr?.number === "number");
	return match ? (match.number as number) : `no merged pull request on ${slug} has head ${name} at this tip.`;
}

function remoteState(unlanded: Unlanded): string {
	const { defaultBranch, remoteRefs, localRefs } = unlanded;
	if (defaultBranch && unlanded.ahead === 0) return `the tip is already in ${defaultBranch} as of this check.`;
	if (remoteRefs.length > 0) {
		const holders = remoteRefs.slice(0, 3).join(", ");
		return defaultBranch
			? `${holders} holds this tip, but it is not merged into ${defaultBranch}: recoverable from the remote, though the work is not in ${defaultBranch}.`
			: `${holders} holds this tip: recoverable from the remote. There is no default branch (origin/HEAD, main, master) to compare against.`;
	}
	if (localRefs.length > 0) return `no remote-tracking ref holds this tip; local ${localRefs.slice(0, 3).join(", ")} still reaches it.`;
	return "no other ref holds this tip. These commits exist nowhere else and would be lost.";
}

function describe(unlanded: Unlanded): string {
	const { branch, ahead, subjects } = unlanded;
	const base = unlanded.defaultBranch ?? "any remote-tracking branch";
	const out = [`Branch ${branch.name} in ${unlanded.dir}`, `  Tip: ${branch.tip}`];
	out.push(`  ${ahead} commit${ahead === 1 ? "" : "s"} not in ${base}${ahead > 0 ? ":" : "."}`);
	for (const subject of subjects) out.push(`    ${subject}`);
	if (ahead > subjects.length) out.push(`    … and ${ahead - subjects.length} more`);
	out.push(`  Remote: ${remoteState(unlanded)}`);
	out.push(`  Merged PR: ${unlanded.prCheck}`);
	if (unlanded.unverified) out.push("  Unverified: an earlier command in this call can move the branch before the delete runs.");
	out.push(`  Restore: git branch ${branch.name} ${branch.tip}`);
	return out.join("\n");
}

function classify(requests: DeleteRequest[], options: GateOptions): Verdict {
	const budget = spawnBudget({ timeoutMs: options.timeoutMs, budgetMs: options.budgetMs });
	const git = gitIn(budget);
	const repos = new Map<string, Repo>();
	const landed: Landed[] = [];
	const pending: Array<{ request: DeleteRequest; repo: Repo; branch: Branch }> = [];
	const deleted = new Map<string, Set<string>>();
	const seen = new Set<string>();
	for (const request of requests) {
		let repo = repos.get(request.dir);
		if (!repo) {
			repo = readRepo(git, request.dir);
			repos.set(request.dir, repo);
		}
		const names = request.tool === "git" ? request.targets : wtBranchNames(git, request);
		const branches = readBranches(git, request.dir, names);
		for (const name of names) {
			const branch = branches.get(name);
			if (!branch) throw new Refusal(`branch ${name} does not exist in ${request.dir}.`);
			const key = `${repo.key}\0${name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const set = deleted.get(repo.key) ?? new Set<string>();
			set.add(`refs/heads/${name}`);
			deleted.set(repo.key, set);
			const ancestor = !request.unverified && repo.defaultRef !== null &&
				git.run(["merge-base", "--is-ancestor", branch.tip, repo.defaultRef], request.dir).exitCode === 0;
			if (ancestor) landed.push({ branch, proof: `ancestor of ${shortRef(repo.defaultRef as string)}` });
			else pending.push({ request, repo, branch });
		}
	}
	// Every git read happens before any gh call, so a slow gh can only cost its own signal.
	const unlanded = pending.map(({ request, repo, branch }) =>
		readUnlanded(git, repo, request.dir, branch, request.unverified, deleted.get(repo.key) ?? new Set()));
	const gh = options.gh ?? defaultGh;
	const ghTimeoutMs = options.ghTimeoutMs ?? GH_TIMEOUT_MS;
	const remaining: Unlanded[] = [];
	for (const entry of unlanded) {
		if (entry.slug !== null) {
			const result = mergedPr(gh, entry, Math.min(ghTimeoutMs, budget.remainingMs()));
			if (typeof result === "number") {
				landed.push({ branch: entry.branch, proof: `merged PR #${result}` });
				continue;
			}
			entry.prCheck = result;
		}
		remaining.push(entry);
	}
	if (remaining.length === 0) return ALLOW;
	const names = remaining.map((entry) => entry.branch.name);
	const blocks = remaining.map(describe);
	if (landed.length > 0) blocks.push(`Landed, deleted without asking: ${landed.map((entry) => `${entry.branch.name} (${entry.proof})`).join(", ")}`);
	return {
		action: "confirm",
		title: names.length === 1 ? `Force-delete ${names[0]}? Its work is not proven landed.` : `Force-delete ${names.length} branches? Their work is not proven landed.`,
		message: blocks.join("\n\n"),
		branches: names,
	};
}

/** What a bash command's branch force-deletes earn: silence, a question for the owner, or a refusal. */
export function reviewCommand(command: string, cwd: string, options: GateOptions = {}): Verdict {
	if (!mentionsForceDelete(command)) return ALLOW;
	if (command.length > MAX_COMMAND_LENGTH) return refuse("the command exceeds the 64 KiB safety limit, so its deletes cannot be checked.");
	let requests: DeleteRequest[] | string;
	try {
		requests = deleteRequests(command, cwd);
	} catch {
		return refuse("parse failure while reading the command; its deletes could not be identified.");
	}
	if (typeof requests === "string") return refuse(requests);
	if (requests.length === 0) return ALLOW;
	try {
		return classify(requests, options);
	} catch (error) {
		if (error instanceof ProbeTimeout) {
			return refuse(`\`${error.message}\` timed out, so the branches' state cannot be proved. Re-run once git answers promptly.`);
		}
		if (error instanceof Refusal) return refuse(error.message);
		return refuse("the gate failed while classifying the branches; their state could not be proved.");
	}
}

// --- Wiring ------------------------------------------------------------------------------------

function inputOf(event: ToolCallEvent): Record<string, unknown> {
	return event.input as Record<string, unknown>;
}

function cwdOf(input: Record<string, unknown>, sessionCwd: string): string {
	const cwd = input.cwd;
	if (typeof cwd !== "string" || cwd === "") return sessionCwd;
	if (URL_CWD.test(cwd)) return cwd;
	const path = cwd === "~" || cwd.startsWith("~/") ? homedir() + cwd.slice(1) : cwd;
	return resolve(sessionCwd, path);
}

export function headlessReason(verdict: Extract<Verdict, { action: "confirm" }>): string {
	const one = verdict.branches.length === 1;
	return `${PREFIX}: ${verdict.branches.join(", ")} ${one ? "is" : "are"} not proven landed and ${one ? "needs" : "need"} the owner's confirmation, but this session has no interactive UI.\n\n${verdict.message}`;
}

export default function branchDeleteGate(pi: ExtensionAPI, options: GateOptions = {}): void {
	pi.on("tool_call", async (event, ctx) => {
		let command: string;
		let input: Record<string, unknown>;
		try {
			if (event.toolName !== "bash") return;
			input = inputOf(event);
			if (typeof input.command !== "string" || !mentionsForceDelete(input.command)) return;
			command = input.command;
		} catch {
			// Not a detected delete: an internal failure must not take bash down.
			return;
		}
		let verdict: Verdict;
		try {
			const env = input.env;
			const gitEnv = env !== null && typeof env === "object" && Object.keys(env).some((key) => key.startsWith("GIT_"));
			verdict = gitEnv
				? refuse("the call's env sets a GIT_* variable that can point git at another repository.")
				: reviewCommand(command, cwdOf(input, ctx.cwd || process.cwd()), options);
		} catch {
			verdict = refuse("the gate failed while checking this command; its deletes could not be proved safe.");
		}
		if (verdict.action === "allow") return;
		if (verdict.action === "refuse") return { block: true, reason: verdict.reason };
		if (!ctx.hasUI) return { block: true, reason: headlessReason(verdict) };
		let confirmed = false;
		try {
			confirmed = await ctx.ui.confirm(verdict.title, verdict.message);
		} catch {
			confirmed = false;
		}
		if (confirmed) return;
		return { block: true, reason: `Branch force-delete declined by the owner: ${verdict.branches.join(", ")}. Nothing was deleted.` };
	});
}
