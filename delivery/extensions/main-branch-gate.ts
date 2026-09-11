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
 * blocks every attempt. `DELIVERY_ALLOW_MAIN_COMMIT=1` in the ENVIRONMENT, either
 * on the bash call or in the session, makes that decision explicit and auditable
 * instead of unavailable. Nothing written in the command grants it: matching that
 * text let a commit message disable the gate. This is advisory-strength, not a
 * security boundary.
 */
import { resolve } from "node:path";

import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 2000;

const PROTECTED_BRANCHES: Record<string, true> = { main: true, master: true };

/** `dgit` is the Git Defender wrapper this estate uses to reach github.com. */
const GIT_COMMANDS: Record<string, true> = { dgit: true, git: true };

/**
 * Tokens that end a command and return the walker to command position. All are equivalent for
 * that purpose: an earlier design distinguished them to decide whether a `cd` stayed in the same
 * shell, and that tracking was deleted for producing silent permits, so nothing now depends on
 * which separator was seen.
 *
 * The doubled forms are listed because `tokenize` emits `&&` and `||` as single tokens, so they
 * would not match the single-character entries. An unquoted newline is a separator too, but it
 * is recognised in `isSep` rather than here, since the tokenizer emits it as its own token.
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

/**
 * Environment names that point git at another repository. Set on the bash call or in the session,
 * they retarget every git command in it, and none of them names a directory this gate can read.
 */
const TARGET_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

/** Words that may stand before `git` and leave it at command position. */
const TRANSPARENT_PREFIX: Record<string, true> = {
	command: true,
	env: true,
	sudo: true,
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `env` options that consume the following argv word before its command. */
const ENV_VALUE_OPTIONS: Record<string, true> = {
	"-u": true,
	"-C": true,
	"-S": true,
	"-P": true,
	"--unset": true,
	"--chdir": true,
	"--split-string": true,
};

/** `sudo` options that consume the following argv word before its command. */
const SUDO_VALUE_OPTIONS: Record<string, true> = {
	"-u": true,
	"-g": true,
	"-p": true,
	"-h": true,
	"-C": true,
	"-D": true,
	"-R": true,
	"-T": true,
	"-U": true,
	"-r": true,
	"-t": true,
	"-a": true,
	"--user": true,
	"--group": true,
	"--prompt": true,
	"--host": true,
	"--chdir": true,
	"--role": true,
	"--type": true,
	"--authentication-type": true,
	"--other-user": true,
	"--askpass-type": true,
	"--command-timeout": true,
	"--close-from": true,
};

/** `sudo` options that do not consume an argv word. */
const SUDO_FLAG_OPTIONS: Record<string, true> = {
	"-A": true,
	"-b": true,
	"-E": true,
	"-e": true,
	"-H": true,
	"-K": true,
	"-k": true,
	"-n": true,
	"-P": true,
	"-S": true,
	"-V": true,
	"-v": true,
	"--askpass": true,
	"--background": true,
	"--preserve-env": true,
	"--edit": true,
	"--set-home": true,
	"--remove-timestamp": true,
	"--reset-timestamp": true,
	"--non-interactive": true,
	"--preserve-groups": true,
	"--stdin": true,
	"--validate": true,
	"--version": true,
};

/** Pre-verb git options that consume the following token. */
const PRE_VERB_VALUE_FLAGS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--exec-path": true,
	"--git-dir": true,
	"--namespace": true,
	"--config-env": true,
	"--work-tree": true,
};

/** Commit options that consume the following argv word. */
const COMMIT_VALUE_FLAGS: Record<string, true> = {
	"-m": true,
	"--message": true,
	"-F": true,
	"--file": true,
	"-C": true,
	"--reuse-message": true,
	"-c": true,
	"--reedit-message": true,
	"--author": true,
	"--date": true,
	"--cleanup": true,
	"-t": true,
	"--template": true,
	"--trailer": true,
	"--fixup": true,
	"--squash": true,
	"--pathspec-from-file": true,
};

function isOpaqueGitConfigKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return (
		normalized.startsWith("alias.") ||
		normalized === "include.path" ||
		(normalized.startsWith("includeif.") && normalized.endsWith(".path"))
	);
}

function envHasOpaqueGitConfig(env: NodeJS.ProcessEnv): boolean {
	if (
		env.GIT_CONFIG_PARAMETERS !== undefined &&
		env.GIT_CONFIG_PARAMETERS !== ""
	)
		return true;
	const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
	if (!Number.isFinite(count) || count <= 0) return false;
	for (let index = 0; index < count; index++) {
		const key = env[`GIT_CONFIG_KEY_${index}`];
		if (key !== undefined && isOpaqueGitConfigKey(key)) return true;
	}
	return false;
}

/**
 * A RAW-TEXT test on the whole command string, with no notion of command position: it asks only
 * whether `git` or `dgit` occurs between word boundaries. Any non-word character delimits, so a
 * hyphen, slash or dot counts and `/opt/git-notes.txt` matches; quoted prose, a comment, and a
 * filename all satisfy it. It never means a command is being run.
 *
 * Deliberately not verb-aware. Quoting can split a verb without changing argv, so
 * `git com'mit' -m x` carries no literal `commit`, and requiring one returned early on a real
 * commit.
 *
 * TWO USES, and only the first is free. In `decideCommit` it is a cheap reject before
 * tokenizing, where over-matching costs one wasted pass. In `findCommitInvocations` it is half
 * the condition for appending a synthetic candidate, which is POLICY-BEARING: over-matching
 * there blocks the call on a protected branch. So `echo 'the git tool'; echo "$(date)"` is
 * refused on main, with no git command anywhere in it. Anyone loosening this regex is changing
 * what gets blocked, not just what gets tokenized.
 */
const PREFILTER = /\bd?git\b/;

/**
 * A here-document delimiter must look like a shell name. This is a SAFETY guard, not tidiness:
 * skipping text can hide a real commit, so `1 << 1` must not be read as a here-document just
 * because an arithmetic shift shares the operator spelling.
 */
const HEREDOC_DELIMITER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export type GitRun = (
	argv: string[],
	cwd: string,
) => { exitCode: number; stdout: string };

let injectedRun: GitRun | null = null;

/** Replace the `git branch --show-current` seam. Pass `null` to restore it. */
export function setGitRunForTests(fn: GitRun | null): void {
	injectedRun = fn;
}

function defaultRun(
	argv: string[],
	cwd: string,
): { exitCode: number; stdout: string } {
	const proc = Bun.spawnSync(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: TIMEOUT_MS,
	});
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

export function extractCommand(input: ToolCallEvent["input"]): string {
	if ("command" in input && typeof input.command === "string") return input.command;
	if ("cmd" in input && typeof input.cmd === "string") return input.cmd;
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
	/**
	 * This word begins with an UNQUOTED redirection operator, so the shell reads it as syntax and
	 * the command keeps its own argv. Only PRESENT when set. `quoted` cannot answer this: it is
	 * word-wide, so `git >'out' commit` marked the whole redirection an operand and the commit
	 * after it went unseen.
	 */
	redirection?: true;
};

/** A redirection operator, anchored at the start of what remains of the command. */
const REDIRECTION_OPERATOR = /^(?:<<<|>>|>\||<>|>&|<&|>|<)/;

/**
 * Words and separators, with quoting recorded. A quoted region is inert here: finding where a
 * substitution inside one ENDS needs a real parser, so nothing tries. `findCommitInvocations`
 * covers that case without reading it, by appending one candidate when the command both holds a
 * substitution AND matches `PREFILTER`.
 */
export function tokenize(command: string): Token[] {
	const out: Token[] = [];
	let cur = "";
	let started = false;
	let wasQuoted = false;
	let redirection = false;
	let quote: string | null = null;
	// Here-document bodies queued by operators on the current line, consumed in order once that
	// line ends. `cat <<A <<B` queues two.
	const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
	const flush = (): void => {
		if (started)
			out.push(
				redirection
					? { text: cur, quoted: wasQuoted, redirection: true }
					: { text: cur, quoted: wasQuoted },
			);
		cur = "";
		started = false;
		wasQuoted = false;
		redirection = false;
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
		// A backslash before a newline is a LINE CONTINUATION: bash removes both and joins the
		// words, inside double quotes and outside them alike. Appending the newline instead split
		// `git com\<newline>mit` into a token no verb matched, so the commit was never reported.
		if (
			ch === "\\" &&
			(command[i + 1] === "\n" ||
				(command[i + 1] === "\r" && command[i + 2] === "\n"))
		) {
			i += command[i + 1] === "\r" ? 2 : 1;
			// NOT `started`: between words the continuation joins nothing, and flushing an empty
			// token there put a word no verb matched where `commit` should have been.
			continue;
		}
		if (quote === '"') {
			// Inside double quotes a backslash escapes only these, and bash keeps it literal
			// otherwise. Missing this closed the string on `\"`, so the real closing quote read as
			// an opener and swallowed the separator and the commit after it: a silent permit.
			if (
				ch === "\\" &&
				i + 1 < command.length &&
				/["$`\\]/.test(command[i + 1] as string)
			) {
				cur += command[i + 1] as string;
				started = true;
				i++;
				continue;
			}
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
			// NOT `wasQuoted`: a backslash removes syntax meaning exactly as quotes do, and
			// `g\it commit` runs git, so command identity must still see this word.
			i++;
			continue;
		}
		// A here-document body is DATA, not commands. Without this the body's newlines reset
		// command position and its lines were scanned as a shell.
		//
		// Skipping text is the DANGEROUS direction here: text wrongly skipped may hold a real
		// commit. So every uncertainty falls back to NOT skipping, which at worst scans data and
		// over-blocks. Three guards, each closing a permit an earlier version had:
		//   - `<<<` is a here-STRING. Reached at its SECOND `<`, the old test saw `<<` followed by
		//     a non-`<` and skipped a body that does not exist, hiding the commit after it.
		//   - `1 << 1` is an arithmetic shift, so the delimiter must look like a delimiter: a
		//     shell name. `1` is not one.
		//   - a `<<` inside a `#` comment is text, handled by the comment branch below.
		if (
			ch === "<" &&
			command[i + 1] === "<" &&
			command[i + 2] !== "<" &&
			command[i - 1] !== "<"
		) {
			let k = i + 2;
			// Only `<<-` strips indentation from the closing delimiter, and only TABS.
			const stripTabs = command[k] === "-";
			if (stripTabs) k++;
			while (k < command.length && /[ \t]/.test(command[k] as string)) k++;
			let delimiter = "";
			let delimiterQuote: string | null = null;
			for (; k < command.length; k++) {
				const d = command[k] as string;
				if (delimiterQuote !== null) {
					if (d === delimiterQuote) delimiterQuote = null;
					else delimiter += d;
					continue;
				}
				// `<<\EOF` quotes the delimiter exactly as `<<'EOF'` does, so the backslash is not
				// part of the name. Keeping it made the terminator unmatchable, and the body then
				// ran to the end of the string and swallowed a real commit after it.
				if (d === "\\" && k + 1 < command.length) {
					delimiter += command[k + 1] as string;
					k++;
					continue;
				}
				if (d === '"' || d === "'") {
					delimiterQuote = d;
					continue;
				}
				if (/[\s;&|<>()]/.test(d)) break;
				delimiter += d;
			}
			if (HEREDOC_DELIMITER.test(delimiter)) {
				// QUEUED, not consumed here. `cat <<A <<B` has two bodies, in operator order,
				// after the line ends. Recursing on the rest of the line consumed only the first
				// and then re-read the second body as commands.
				pending.push({ delimiter, stripTabs });
				flush();
				i = k - 1;
				continue;
			}
			// Not a here-document. Fall through and let `<` tokenize as ordinary text.
		}
		// An unquoted `#` at the START of a word begins a comment. Mid-word it is literal, as in
		// `foo#bar`. Without this, `# <<EOF` started a body skip that hid the commit after it.
		if (ch === "#" && !started) {
			const lineEnd = command.indexOf("\n", i);
			i = (lineEnd === -1 ? command.length : lineEnd) - 1;
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
				// Every body queued on this line begins now, in order.
				if (pending.length > 0) {
					let pos = i + 1;
					for (const { delimiter, stripTabs } of pending) {
						for (;;) {
							const next = command.indexOf("\n", pos);
							const raw = command.slice(
								pos,
								next === -1 ? command.length : next,
							);
							// A CRLF body leaves `\r` on every line, which made the terminator
							// unmatchable and ran the body to the end of the string.
							const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
							// `<<` needs the delimiter line EXACTLY; `<<-` allows leading tabs
							// only. Trailing whitespace never counts, so trimming both ends would
							// end the body early.
							if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
								pos = next === -1 ? command.length : next + 1;
								break;
							}
							if (next === -1) {
								pos = command.length;
								break;
							}
							pos = next + 1;
						}
					}
					pending.length = 0;
					i = pos - 1;
				}
				continue;
			}
			flush();
			continue;
		}
		// A redirection ENDS the word before it and forms its own, because bash reads it as syntax
		// wherever it sits: `git>/dev/null commit` and `git >&2 commit` both run that commit. Only
		// a file-descriptor prefix stays attached, so `2>&1` remains one operator.
		if (ch === "&" && command[i + 1] === ">") {
			flush();
			cur = command[i + 2] === ">" ? "&>>" : "&>";
			started = true;
			redirection = true;
			i += cur.length - 1;
			continue;
		}
		if (ch === ">" || ch === "<") {
			// `<<` is a here-document and was consumed above, so what remains is an operator whose
			// text is known here. Recording it on the token keeps the operator's own quote state,
			// which `quoted` cannot: it is word-wide, so `git >'out' commit` hid that commit.
			const operator = REDIRECTION_OPERATOR.exec(command.slice(i));
			if (operator === null) continue;
			const text = operator[0] as string;
			if (!/^(?:\d+|&|\{[A-Za-z_][A-Za-z0-9_]*\})?$/.test(cur)) flush();
			cur += text;
			started = true;
			redirection = true;
			i += text.length - 1;
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
 * Shell reserved words and grouping that INTRODUCE a command rather than being one. They leave
 * the command slot open, so `if :; then git commit; fi` and `{ git commit; }` are seen.
 */
const RESERVED_WORD: Record<string, true> = {
	"!": true,
	"{": true,
	"}": true,
	case: true,
	do: true,
	done: true,
	elif: true,
	else: true,
	esac: true,
	fi: true,
	for: true,
	if: true,
	in: true,
	select: true,
	time: true,
	until: true,
	while: true,
};

export type CommitInvocation = {
	/** Repository the commit targets, relative to the bash call's cwd. */
	repoDir: string | null;
	/** `--dry-run` writes no commit, so the branch does not matter. */
	dryRun: boolean;
	/**
	 * `--git-dir` or `--work-tree` sent this commit to a repository no directory here describes.
	 * Reading the call's cwd would clear a commit landing elsewhere, so it is refused instead.
	 */
	retargeted?: boolean;
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
 * the list it belongs to, and `pushd` moves the directory with no `cd` token at all. Each
 * produced a SILENT permit, so `-C` and the bash call's `cwd` are the only directories read.
 */
export function findCommitInvocations(command: string): CommitInvocation[] {
	const out = scanInvocations(command);
	// A substitution runs commands the quote-aware scan reads as data, and which substitutions
	// are inert cannot be decided here: a quoted here-document delimiter makes its body inert
	// while an unquoted one does not, an apostrophe in a body or a comment is literal text yet
	// poisons quote tracking, and a backtick nests through backslashes.
	//
	// So no attempt is made to read inside one. When the command holds a substitution and
	// `PREFILTER` matches, one candidate is APPENDED aimed at the call's cwd, and the ordinary
	// branch decision applies to it. On a feature branch that allows the call; on a protected one
	// it blocks.
	//
	// `PREFILTER` and not a literal `commit`, because quoting splits a verb without changing
	// argv, so `"$(git com'mit' -m x)"` carries no such word. Read that regex for what it does
	// and does not imply; every paraphrase of it written here has so far been wrong.
	//
	// Appended unconditionally, not only when the scan found nothing. `git commit --dry-run -m
	// "$(git commit -m x)"` yields one dry-run invocation from the outer command, and the real
	// nested commit would be skipped along with it. The outer `--dry-run` says nothing about
	// what the substitution runs, so the candidate is never dry.
	//
	// KNOWN GAP, accepted. A `-C /elsewhere` inside the substitution is invisible, so from a
	// feature cwd `echo "$(git -C /protected commit -m x)"` is allowed. Blocking every
	// substitution regardless of branch closes it, and was tried: it refuses `echo "$(git
	// status)"` on any branch, which is not this gate's job and makes it the kind of control
	// people switch off. This module fails open wherever it cannot see (no work tree, detached
	// HEAD, no git binary), and an unreadable substitution is that same case.
	//
	// An earlier version re-scanned with quotes stripped instead. That lossy pass weakened
	// decisions the first scan had made correctly, splitting `git com'mit'` into two words,
	// deleting an empty `-C` operand so the flag swallowed the verb, and promoting `--dry-run`
	// out of a message. Appending a candidate cannot weaken anything.
	//
	// THE COST, stated exactly, because three earlier comments here got it wrong. This candidate
	// is appended when the command holds a substitution AND `PREFILTER` (`\bd?git\b`) hits its raw
	// text. That second half is NOT a command: prose, a comment, or a path satisfies it, so
	// `echo 'the git tool'; echo "$(date)"` gets a candidate with no git command present.
	//
	// Neither half needs anything to do with the other, so ON A PROTECTED BRANCH any such
	// command is refused whatever either part is doing: `echo "$(date)"; git status`,
	// `git log --format="$(cat f)"`, and `dgit push origin b && echo "$(date)"` all block.
	//
	// Dropping either half AVOIDS THIS CANDIDATE, which is not the same as passing the gate: a
	// plain `git commit -m x` has no substitution and still blocks, on the scan above. On a
	// feature branch none of this applies.
	//
	// Narrowing it means deciding which substitutions matter, which is the parser problem this
	// function exists to avoid: reading `$(` to the next `)` mis-ends on `$(f "x)y"; git commit)`
	// and permits it, and reading to end of command changes nothing. Every narrowing tried in
	// this file became a permit, so the breadth stands until someone measures a safe cut.
	//
	// The remedy depends on where the substitution sits, and `denyReason` states both. One
	// UNRELATED to the git command is fixed by sending it as a separate call. One that is PART
	// of the git command survives that, and has to be replaced by its value.
	if (
		(command.includes("$(") || command.includes("`")) &&
		PREFILTER.test(command)
	)
		out.push({ repoDir: null, dryRun: false });
	return out;
}

/** Shells that run a script argument, so `-c` hides whatever the script does. */
const SHELL_COMMANDS = ["bash", "sh", "zsh", "dash", "ksh"];

/** `xargs` options that consume the following argv word before its payload command. */
const XARGS_VALUE_OPTIONS: Record<string, true> = {
	"-a": true,
	"-d": true,
	"-E": true,
	"-I": true,
	"-L": true,
	"-n": true,
	"-P": true,
	"-s": true,
	"--arg-file": true,
	"--delimiter": true,
	"--max-lines": true,
	"--max-args": true,
	"--max-procs": true,
	"--max-chars": true,
	"--process-slot-var": true,
};

/**
 * `xargs` options that name no following word.
 *
 * Both tables model the wider GNU grammar, so a command written for it resolves to the same
 * payload here. `-i`, `--replace`, and `--eof` are listed here because their value is optional
 * and attached: reading one as consuming the NEXT word would take the word that names the
 * payload, which is how a payload command goes unseen.
 *
 * The `xargs` on PATH is `/usr/bin/xargs`. Probed directly, it takes `-E EOF` and `-I {}`,
 * clusters short flags such as `-0t`, and rejects `-i`, `--replace`, and `--eof` outright. A
 * command using a form it rejects runs nothing, so reading these as flags costs at most a refusal
 * of a command that could not have committed.
 */
const XARGS_FLAG_OPTIONS: Record<string, true> = {
	"-0": true,
	"-i": true,
	"-o": true,
	"-p": true,
	"-r": true,
	"-t": true,
	"-x": true,
	"--null": true,
	"--no-run-if-empty": true,
	"--open-tty": true,
	"--interactive": true,
	"--verbose": true,
	"--exit": true,
	"--eof": true,
	"--replace": true,
	"--help": true,
	"--version": true,
};

/**
 * Where the command `xargs` would execute begins, resolved past its own options. Only that word
 * decides what runs: every later word is data appended to it, so `xargs echo git` runs `echo`.
 *
 * `-1` means xargs runs its default `echo`. `"unreadable"` means its position cannot be found,
 * because an unknown option may consume the word that would name it.
 */
function xargsPayloadIndex(remaining: Token[]): number | "unreadable" {
	for (let i = 0; i < remaining.length; i++) {
		const operand = remaining[i] as Token;
		if (operand.text === "--") continue;
		const eq = operand.text.indexOf("=");
		const name = eq === -1 ? operand.text : operand.text.slice(0, eq);
		// A redirection inside the xargs segment is grammar, so it never names the payload.
		const skip = redirectionWidth(operand, remaining[i + 1], false);
		if (skip !== 0) {
			i += skip - 1;
			continue;
		}
		if (XARGS_FLAG_OPTIONS[name] === true) continue;
		if (XARGS_VALUE_OPTIONS[name] === true) {
			// A separated value (`-n 1`, `--max-args 1`) takes the next word; `--name=value` does not.
			if (eq === -1) i++;
			continue;
		}
		// A short option may carry its value attached, as in `-n1`, `-I{}`, or `-d,`.
		const attached = operand.text.slice(0, 2);
		if (
			operand.text.length > 2 &&
			!operand.text.startsWith("--") &&
			XARGS_VALUE_OPTIONS[attached] === true
		)
			continue;
		// Short flags cluster, as in `-0t`. A cluster is only readable when every letter in it
		// names no value: `-0n1` would need this scan to parse where the value begins, and a wrong
		// guess there skips the word that names the payload.
		if (/^-[^-]+$/.test(operand.text)) {
			const letters = operand.text.slice(1).split("");
			if (letters.every((letter) => XARGS_FLAG_OPTIONS[`-${letter}`] === true))
				continue;
		}
		if (operand.text.startsWith("-")) return "unreadable";
		return i;
	}
	return -1;
}

/** Whether this word names a Git command, path-qualified or not, including the direct helper. */
function isGitWord(token: Token): boolean {
	const base = token.text.split("/").at(-1) ?? "";
	return GIT_COMMANDS[base] === true || base === "git-commit";
}

/**
 * Whether this payload command can reach Git without stating it. A shell runs any script, the
 * transparent prefixes and argv forwarders pass their tail on, and an expansion hides the name.
 * An ordinary utility cannot, so `xargs echo git` stays an ordinary command.
 */
function isUnreadablePayload(payload: Token): boolean {
	const base = payload.text.split("/").at(-1) ?? "";
	return (
		SHELL_COMMANDS.includes(base) ||
		TRANSPARENT_PREFIX[base] === true ||
		FORWARDING_COMMANDS.includes(base) ||
		payload.text.includes("$") ||
		payload.text.includes("`")
	);
}

/** Programs that execute an argv they are given, so a Git call can hide behind them. */
const FORWARDING_COMMANDS = ["exec", "nice", "nohup", "time", "xargs", "xcrun"];

/**
 * How many words this redirection occupies: 0 when the word is argv, 1 when it carries its own
 * target, and 2 when the target is the next word. A bare operator claims no word across a
 * separator, because the target belongs to the same simple command.
 *
 * The decision reads the operator's own provenance from `tokenize`. Matching the token text
 * instead let a quoted target speak for the operator, and `git >'out' commit -m x` passed.
 */
function redirectionWidth(
	token: Token,
	next: Token | undefined,
	nextIsSeparator: boolean,
): 0 | 1 | 2 {
	if (token.redirection !== true) return 0;
	if (!REDIRECTION_BARE.test(token.text)) return 1;
	return next !== undefined && !nextIsSeparator ? 2 : 1;
}

/**
 * A redirection word that is only its operator, so its target is the next word. The prefix may
 * name a descriptor: a number, `&`, or bash's dynamic `{fd}` form.
 */
const REDIRECTION_BARE =
	/^(?:\d+|&|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|>>|>\||<>|>&|<&|>|<)$/;

function scanInvocations(command: string): CommitInvocation[] {
	const out: CommitInvocation[] = [];
	const tokens = tokenize(command);
	const isSep = (t: Token | undefined): boolean =>
		t !== undefined &&
		!t.quoted &&
		(SEPARATOR[t.text] === true || t.text === "\n");
	let atCommand = true;
	// A shell prefix assignment applies to the command that follows it in the same simple
	// command, so `GIT_DIR=/other/.git git commit` retargets that commit. It arrives as a
	// transparent token, never in the call's environment, so it has to be tracked here.
	let prefixRetarget = false;
	let exportedRetarget = false;
	let commandGitConfig = false;
	const targetAssignments = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as Token;
		if (isSep(token)) {
			atCommand = true;
			prefixRetarget = false;
			continue;
		}
		if (!atCommand) continue;
		const leadingRedirection = redirectionWidth(
			token,
			tokens[i + 1],
			isSep(tokens[i + 1]),
		);
		if (leadingRedirection !== 0) {
			// A redirection before the command leaves the slot open: `>/dev/null git commit` commits.
			i += leadingRedirection - 1;
			continue;
		}
		// A reserved word introduces a command rather than being one, so it leaves the slot open.
		if (token.text === "env") {
			let k = i + 1;
			for (; k < tokens.length && !isSep(tokens[k]); k++) {
				const operand = tokens[k] as Token;
				if (operand.text === "--") {
					// The next argv word is env's command even when it starts with `-`.
					k++;
					break;
				}
				if (ENV_ASSIGNMENT.test(operand.text)) {
					const name = operand.text.slice(0, operand.text.indexOf("="));
					if (TARGET_ENV.includes(name)) prefixRetarget = true;
					if (name.startsWith("GIT_CONFIG_")) commandGitConfig = true;
					continue;
				}
				const optionName = operand.text.includes("=")
					? operand.text.slice(0, operand.text.indexOf("="))
					: operand.text;
				const attachedShortSplit =
					operand.text.startsWith("-S") && operand.text !== "-S";
				if (operand.text.startsWith("-C") && operand.text !== "-C") {
					prefixRetarget = true;
					out.push({ repoDir: null, dryRun: false, retargeted: true });
					continue;
				}
				if (operand.text.startsWith("-u") && operand.text !== "-u") continue;
				if (
					attachedShortSplit ||
					optionName === "-S" ||
					optionName === "--split-string"
				) {
					// `env -S` performs quote removal and argv splitting with grammar this scanner
					// does not implement. Refuse every split payload rather than inspect raw text.
					out.push({ repoDir: null, dryRun: false, retargeted: true });
					if (!attachedShortSplit && !operand.text.includes("=")) k++;
					continue;
				}
				if (
					optionName === "-C" ||
					optionName === "--chdir" ||
					("--chdir".startsWith(optionName) && optionName.length >= 4)
				) {
					// GNU env accepts unambiguous long-option abbreviations such as `--ch`.
					prefixRetarget = true;
					out.push({ repoDir: null, dryRun: false, retargeted: true });
					if (!operand.text.includes("=")) k++;
					continue;
				}
				if (ENV_VALUE_OPTIONS[optionName] === true) {
					if (!operand.text.includes("=")) k++;
					continue;
				}
				if (operand.text.startsWith("-")) {
					// GNU env accepts abbreviations and bundled short options. If this scanner does
					// not recognise one exactly, it cannot know where the wrapped command starts.
					out.push({ repoDir: null, dryRun: false, retargeted: true });
					k = tokens.length;
					break;
				}
				break;
			}
			i = k - 1;
			continue;
		}
		if (token.text === "sudo") {
			let k = i + 1;
			for (; k < tokens.length && !isSep(tokens[k]); k++) {
				const operand = tokens[k] as Token;
				if (operand.text === "--") continue;
				const optionName = operand.text.includes("=")
					? operand.text.slice(0, operand.text.indexOf("="))
					: operand.text;
				if (
					optionName === "-C" ||
					optionName === "-D" ||
					optionName === "--chdir"
				) {
					prefixRetarget = true;
					out.push({ repoDir: null, dryRun: false, retargeted: true });
					if (!operand.text.includes("=")) k++;
					continue;
				}
				if (SUDO_VALUE_OPTIONS[optionName] === true) {
					if (!operand.text.includes("=")) k++;
					continue;
				}
				if (SUDO_FLAG_OPTIONS[optionName] === true) continue;
				if (/^-[AAbEeEHKknPSVv]+$/.test(operand.text)) continue;
				if (operand.text.startsWith("-")) {
					// An unrecognised sudo option may consume a value. Guessing where its command
					// starts can hide git, so fail closed rather than advance past the wrong word.
					out.push({ repoDir: null, dryRun: false, retargeted: true });
					k = tokens.length;
					break;
				}
				break;
			}
			i = k - 1;
			continue;
		}
		if (token.text === "command") {
			let k = i + 1;
			for (; k < tokens.length && !isSep(tokens[k]); k++) {
				const operand = tokens[k] as Token;
				if (operand.text === "--") continue;
				if (
					operand.text === "-p" ||
					operand.text === "-v" ||
					operand.text === "-V"
				)
					continue;
				break;
			}
			i = k - 1;
			continue;
		}
		// `time` keeps the command slot open, but its own options stand before that command.
		if (token.text === "time") {
			let k = i + 1;
			for (; k < tokens.length && !isSep(tokens[k]); k++) {
				const operand = tokens[k] as Token;
				if (operand.text === "--") {
					k++;
					break;
				}
				if (operand.text === "-p") continue;
				if (operand.text.startsWith("-")) {
					// An unrecognised option may consume the next word, so the command is unreadable.
					out.push({ repoDir: null, dryRun: false, retargeted: true });
					k = tokens.length;
					break;
				}
				break;
			}
			i = k - 1;
			continue;
		}
		// A reserved word introduces a command rather than being one, so it leaves the slot open.
		if (
			TRANSPARENT_PREFIX[token.text] === true ||
			token.text === "then" ||
			RESERVED_WORD[token.text] === true
		)
			continue;
		if (ENV_ASSIGNMENT.test(token.text)) {
			const name = token.text.slice(0, token.text.indexOf("="));
			if (TARGET_ENV.includes(name)) {
				prefixRetarget = true;
				targetAssignments.add(name);
			}
			if (name.startsWith("GIT_CONFIG_")) commandGitConfig = true;
			continue;
		}
		const commandBase = token.text.split("/").at(-1) ?? "";
		if (SHELL_COMMANDS.includes(commandBase)) {
			const shellArgs = tokens
				.slice(i + 1)
				.filter((candidate) => !isSep(candidate));
			if (
				shellArgs.some(
					(candidate) =>
						candidate.text === "-c" || /^-[^-]*c/.test(candidate.text),
				)
			)
				out.push({ repoDir: null, dryRun: false, retargeted: true });
			atCommand = false;
			continue;
		}
		if (
			token.text === "nice" ||
			token.text === "nohup" ||
			token.text === "exec"
		) {
			let k = i + 1;
			for (; k < tokens.length && !isSep(tokens[k]); k++) {
				const operand = tokens[k] as Token;
				if (operand.text === "--") continue;
				if (
					token.text === "nice" &&
					(operand.text === "-n" || operand.text === "--adjustment")
				) {
					k++;
					continue;
				}
				if (
					token.text === "exec" &&
					(operand.text === "-a" || operand.text === "--argv0")
				) {
					k++;
					continue;
				}
				if (
					token.text === "exec" &&
					((operand.text.startsWith("-a") && operand.text !== "-a") ||
						operand.text.startsWith("--argv0="))
				)
					continue;
				if (operand.text.startsWith("-")) continue;
				break;
			}
			i = k - 1;
			continue;
		}
		if (token.text === "export") {
			for (let j = i + 1; j < tokens.length && !isSep(tokens[j]); j++) {
				const operand = tokens[j] as Token;
				const name = ENV_ASSIGNMENT.test(operand.text)
					? operand.text.slice(0, operand.text.indexOf("="))
					: operand.text;
				if (name.startsWith("GIT_CONFIG_")) commandGitConfig = true;
				if (
					TARGET_ENV.includes(name) &&
					(ENV_ASSIGNMENT.test(operand.text) || targetAssignments.has(name))
				)
					exportedRetarget = true;
			}
			continue;
		}
		atCommand = false;
		const opaqueCommand = token.text.includes("$") || token.text.includes("`");
		const unquotedWordSplitting = opaqueCommand && !token.quoted;
		const separatorOffset = tokens
			.slice(i + 1)
			.findIndex((candidate) => isSep(candidate));
		const segmentEnd =
			separatorOffset === -1 ? tokens.length : i + 1 + separatorOffset;
		const remaining = tokens.slice(i + 1, segmentEnd);
		if (
			opaqueCommand &&
			(unquotedWordSplitting ||
				commandGitConfig ||
				remaining.some((candidate) => candidate.text === "commit") ||
				remaining.some(
					(candidate) =>
						candidate.text.includes("$") || candidate.text.includes("`"),
				) ||
				remaining.some(
					(candidate) =>
						candidate.text === "-c" ||
						candidate.text.startsWith("-c=") ||
						candidate.text === "--config-env" ||
						candidate.text.startsWith("--config-env="),
				))
		) {
			out.push({ repoDir: null, dryRun: false, retargeted: true });
			continue;
		}
		const wrapperCandidate = ["xcrun", "xargs"].includes(commandBase);
		// Accepted advisory boundary: arbitrary programs may forward argv to Git. This gate handles
		// the wrappers agents use in this estate (`xcrun` and `xargs`) but does not claim coverage
		// for every executable such as timeout, parallel, or watch.
		//
		// `xargs` runs the one command named after its own options, and every later word is data
		// appended to that command, so `xargs echo git` runs `echo`. `xcrun` passes its whole tail
		// through, so any Git word in it is a real command.
		const xargsCommand =
			commandBase === "xargs" ? xargsPayloadIndex(remaining) : -1;
		if (xargsCommand === "unreadable") {
			out.push({ repoDir: null, dryRun: false, retargeted: true });
			continue;
		}
		// For `xargs` the payload command and everything after it are the argv that runs; for
		// `xcrun` the whole tail is. Both are analysed as one array so the index stays meaningful.
		const wrapperTail =
			commandBase === "xargs"
				? xargsCommand === -1
					? []
					: remaining.slice(xargsCommand)
				: remaining;
		const payload = wrapperTail[0];
		const wrappedGitIndex =
			commandBase === "xargs"
				? payload !== undefined && isGitWord(payload)
					? 0
					: -1
				: wrapperCandidate
					? wrapperTail.findIndex((candidate) => isGitWord(candidate))
					: -1;
		if (
			commandBase === "xargs" &&
			wrappedGitIndex === -1 &&
			payload !== undefined &&
			isUnreadablePayload(payload)
		) {
			out.push({ repoDir: null, dryRun: false, retargeted: true });
			continue;
		}
		// For `xargs` only the payload word decides what runs, so an expansion after it is data.
		// `xcrun` passes its whole tail through, where an expansion can still become the command.
		const opaqueTail =
			commandBase === "xargs"
				? payload === undefined
					? []
					: [payload]
				: wrapperTail;
		if (
			wrapperCandidate &&
			opaqueTail.some(
				(candidate) =>
					candidate.text.includes("$") || candidate.text.includes("`"),
			)
		) {
			out.push({ repoDir: null, dryRun: false, retargeted: true });
			continue;
		}
		if (
			wrappedGitIndex !== -1 &&
			(wrapperTail[wrappedGitIndex]?.text.endsWith("git-commit") ||
				wrapperTail
					.slice(wrappedGitIndex + 1)
					.some((candidate) => candidate.text === "commit") ||
				wrapperTail
					.slice(wrappedGitIndex + 1)
					.some(
						(candidate) =>
							candidate.text === "-c" ||
							candidate.text.startsWith("-c=") ||
							candidate.text.startsWith("--config-env"),
					))
		) {
			out.push({ repoDir: null, dryRun: false, retargeted: true });
			continue;
		}
		// Quoting removes syntax meaning, not argv meaning. Path-qualified executables retain
		// their basename; Git also exposes the direct `git-commit` plumbing helper.
		const gitCommand = token.text.split("/").at(-1) ?? "";
		const directCommit = gitCommand === "git-commit";
		if (!directCommit && GIT_COMMANDS[gitCommand] !== true) continue;

		let repoDir: string | null = null;
		let verb: string | null = directCommit ? "commit" : null;
		let dryRun = false;
		let retargeted = prefixRetarget || exportedRetarget;
		let aliasOpaque = false;
		let j = i + 1;
		let commitOptions = true;
		for (; j < tokens.length; j++) {
			const arg = tokens[j] as Token;
			if (isSep(arg)) break;
			const argRedirection = redirectionWidth(
				arg,
				tokens[j + 1],
				isSep(tokens[j + 1]),
			);
			if (argRedirection !== 0) {
				// Redirections stand anywhere in a simple command without changing its argv.
				j += argRedirection - 1;
				continue;
			}
			if (
				verb === null &&
				(arg.text.includes("$") || arg.text.includes("`")) &&
				!arg.text.startsWith("-")
			) {
				// This word decides the verb, and quoting does not make an expansion readable.
				aliasOpaque = true;
				continue;
			}
			if (verb === "commit") {
				if (!commitOptions) continue;
				if (arg.text === "--") {
					commitOptions = false;
					continue;
				}
				if (arg.text === "--dry-run") {
					dryRun = true;
					continue;
				}
				const eq = arg.text.indexOf("=");
				const name = eq === -1 ? arg.text : arg.text.slice(0, eq);
				if (eq === -1 && COMMIT_VALUE_FLAGS[name] === true) j++;
				continue;
			}
			if (arg.text.startsWith("-") && arg.text !== "-") {
				// An option VALUE is consumed below before the verb rule sees it, so an expansion
				// there is checked here. A `-C` value hides which repository the commit reaches; a
				// `-c` value can define the alias that turns a later word into `commit`.
				if (
					verb === null &&
					(arg.text.includes("$") || arg.text.includes("`"))
				) {
					const optionName =
						arg.text.indexOf("=") === -1
							? arg.text
							: arg.text.slice(0, arg.text.indexOf("="));
					if (optionName === "-c" || optionName === "--config-env")
						aliasOpaque = true;
					else retargeted = true;
					continue;
				}
				if (verb === null && arg.text.startsWith("-C") && arg.text !== "-C") {
					const value = arg.text.slice(2);
					repoDir =
						repoDir === null || value.startsWith("/")
							? value
							: `${repoDir}/${value}`;
					continue;
				}
				const eq = arg.text.indexOf("=");
				const name = eq === -1 ? arg.text : arg.text.slice(0, eq);
				if (verb === null && (name === "--git-dir" || name === "--work-tree"))
					retargeted = true;
				if (verb === null && name === "-c" && eq !== -1) {
					const config = arg.text.slice(eq + 1);
					const keyEnd = config.indexOf("=");
					if (keyEnd !== -1 && isOpaqueGitConfigKey(config.slice(0, keyEnd)))
						aliasOpaque = true;
				}
				if (verb === null && name === "--config-env" && eq !== -1) {
					const configEnv = arg.text.slice(eq + 1);
					const keyEnd = configEnv.indexOf("=");
					if (keyEnd !== -1 && isOpaqueGitConfigKey(configEnv.slice(0, keyEnd)))
						aliasOpaque = true;
				}
				if (eq === -1 && verb === null && PRE_VERB_VALUE_FLAGS[name] === true) {
					const value = tokens[j + 1];
					if (value !== undefined && !isSep(value)) {
						// The value is consumed here, so the verb rule never sees it. An expansion
						// in it hides the repository, or the alias that renames the verb.
						if (value.text.includes("$") || value.text.includes("`")) {
							if (name === "-c" || name === "--config-env") aliasOpaque = true;
							else retargeted = true;
							j++;
							continue;
						}
						if (name === "-c") {
							const keyEnd = value.text.indexOf("=");
							if (
								keyEnd !== -1 &&
								isOpaqueGitConfigKey(value.text.slice(0, keyEnd))
							)
								aliasOpaque = true;
						}
						if (name === "--config-env") {
							const keyEnd = value.text.indexOf("=");
							if (
								keyEnd !== -1 &&
								isOpaqueGitConfigKey(value.text.slice(0, keyEnd))
							)
								aliasOpaque = true;
						}
						if (name === "-C")
							repoDir =
								repoDir === null || value.text.startsWith("/")
									? value.text
									: `${repoDir}/${value.text}`;
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
		// The flag is only PRESENT when set, so an ordinary invocation stays two fields wide and
		// the many `toEqual` assertions over this shape keep saying what they meant.
		if (commandGitConfig || aliasOpaque)
			out.push({ repoDir, dryRun: false, retargeted: true });
		else if (verb === "commit")
			out.push(
				retargeted
					? { repoDir, dryRun, retargeted: true }
					: { repoDir, dryRun },
			);
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

export function denyReason(branch: string, readDir: string): string {
	return (
		`blocked by delivery (work lands on a branch, never on ${branch}): \`${readDir}\` has ` +
		`\`${branch}\` checked out. Create or switch to a feature branch first (\`git switch -c ` +
		"<type>/<slug>`, or `git switch <existing>` when the branch was made for this task), " +
		"then commit there and open a PR.\n\n" +
		"If this command writes no commit of its own, something in its TEXT read as one anyway. " +
		"The usual cause is a SUBSTITUTION: this gate does not read inside `$(...)` or backticks, " +
		"so on a protected branch it refuses any command containing one that also mentions `git` " +
		"or `dgit` anywhere in its text. Anywhere means anywhere: prose, a comment, or a path " +
		"counts, so this can fire with no git command present at all. A function definition body " +
		"is scanned too, since a definition and a definition followed by a call cannot be told " +
		"apart here.\n\n" +
		"Which remedy applies depends on where the substitution sits. When it is UNRELATED to " +
		'any git work, as in `echo "$(date)"; git status`, send the two parts as separate ' +
		'calls. When it is PART of the git command, as in `git log --format="$(cat f)"`, ' +
		"splitting changes nothing and the substitution itself has to go: read the value in one " +
		"call, then pass the result literally in the next. When the mention is only prose, " +
		"rewrite it without backticks or `$(`.\n\n" +
		"If the commit was meant for a DIFFERENT repository, name it: pass the bash tool's " +
		"`cwd`, or use an absolute `git -C <path> commit`. Both are read directly. A `cd` in " +
		"the command is NOT followed, because the walker cannot tell a `cd` that ran from one " +
		"that did not, and inferring it cleared commits onto protected branches.\n\n" +
		`Only when the user explicitly asked for a commit on ${branch}, in a repository with ` +
		`no PR flow or under an instruction to land directly, set \`${ALLOW_ENV}=1\` in the ` +
		"ENVIRONMENT, either on the bash call or in the session. There is no command-text " +
		"form: a commit message mentioning that flag used to disable this gate, so nothing " +
		"written in the command grants it."
	);
}

/**
 * This command names no repository this gate can read, so no branch was checked. The cause is
 * either a target selector pointing elsewhere or a construct whose real argv is not visible.
 */
export function unreadableReason(selector: string): string {
	return (
		"blocked by delivery (work lands on a branch, never on main/master): this command " +
		`carries \`${selector}\`, so which repository a commit would reach is not readable here. ` +
		"A bare repository, a linked worktree, a `.git` outside its own tree, and an argv this " +
		"gate cannot see each break the guess, so NOTHING was read and no branch was checked.\n\n" +
		"State the repository and the command in a form that is read directly: pass the bash " +
		"tool's `cwd`, use an absolute `git -C <path> commit`, and write the git call out rather " +
		"than wrapping it in a shell, a split string, or an expansion. Then the branch is " +
		"knowable and an ordinary commit on a feature branch passes.\n\n" +
		`Only when the user explicitly asked for a commit on a protected branch set \`${ALLOW_ENV}=1\` ` +
		"in the ENVIRONMENT, either on the bash call or in the session."
	);
}

function hasOpaqueCommandPosition(command: string): boolean {
	const tokens = tokenize(command);
	let atCommand = true;
	for (const token of tokens) {
		const separator =
			!token.quoted && (SEPARATOR[token.text] === true || token.text === "\n");
		if (separator) {
			atCommand = true;
			continue;
		}
		if (!atCommand) continue;
		if (
			ENV_ASSIGNMENT.test(token.text) ||
			TRANSPARENT_PREFIX[token.text] === true
		)
			continue;
		return token.text.includes("$") || token.text.includes("`");
	}
	return false;
}

export function decideCommit(
	command: string,
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): { block: true; reason: string } | undefined {
	if (env[ALLOW_ENV] === "1") return;
	// `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` in the CALL's environment retarget every
	// git command in it, exactly as the flags do, and are just as unreadable from here.
	const envSelector = TARGET_ENV.find(
		(name) => env[name] !== undefined && env[name] !== "",
	);
	const opaqueEnvConfig = envHasOpaqueGitConfig(env);
	const invocations = findCommitInvocations(command);
	if (
		opaqueEnvConfig &&
		invocations.length === 0 &&
		(/\bd?git\b/.test(command) || hasOpaqueCommandPosition(command))
	)
		return {
			block: true,
			reason: unreadableReason("structured Git configuration"),
		};
	for (const invocation of invocations) {
		if (opaqueEnvConfig)
			return {
				block: true,
				reason: unreadableReason("structured Git configuration"),
			};
		if (invocation.dryRun) continue;
		if (invocation.retargeted === true)
			return {
				block: true,
				reason: unreadableReason("a command-level target selector"),
			};
		if (envSelector !== undefined)
			return { block: true, reason: unreadableReason(envSelector) };
		// `-C` is the only directory the command states outright, so it is the only one applied.
		// A `cd` is not followed, for the reasons on `findCommitInvocations`.
		const target =
			invocation.repoDir === null ? cwd : resolve(cwd, invocation.repoDir);
		const branch = currentBranch(target);
		if (branch === null) continue;
		if (PROTECTED_BRANCHES[branch] === true)
			return { block: true, reason: denyReason(branch, target) };
	}
	return;
}

export default function mainBranchGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
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
			return decideCommit(
				command,
				cwd,
				callEnv ? { ...process.env, ...callEnv } : process.env,
			);
		} catch {
			return;
		}
	});
}
