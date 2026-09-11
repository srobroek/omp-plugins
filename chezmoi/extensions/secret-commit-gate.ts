import { accessSync, constants, statSync } from "node:fs";
import { basename } from "node:path";

import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

import { lexicalAbs, loadSourceDir, shellWords } from "./chezmoi-guard.ts";

/**
 * Block a `git commit` in the chezmoi repository when a staged source file is
 * named like a plaintext credential.
 *
 * Names, not contents: chezmoi's own naming is the signal. A secret handled the
 * sanctioned way is either a `.tmpl` that reads the value from 1Password at apply
 * time or an `encrypted_` file, and neither trips this gate. Anything else with a
 * credential name is a plaintext secret about to enter git history.
 *
 * This is a preflight read, not an atomic guard: the filesystem and index may
 * change before the shell runs. Only literal directory changes are resolved.
 */

/** A local `git` read cannot reach the network, so this bounds a hung binary, not a fetch. */
const GIT_TIMEOUT_MS = 2000;

/**
 * chezmoi source-name attributes. Stripping them recovers the target name, which
 * is what the secret patterns describe. `encrypted_` is the sanctioned outcome, so
 * it is read as a verdict rather than stripped away silently.
 */
const ATTRIBUTES: Record<string, true> = {
	after_: true,
	before_: true,
	create_: true,
	dot_: true,
	empty_: true,
	encrypted_: true,
	exact_: true,
	executable_: true,
	external_: true,
	literal_: true,
	modify_: true,
	once_: true,
	private_: true,
	readonly_: true,
	remove_: true,
	run_: true,
	symlink_: true,
};

/**
 * Target names that carry a credential rather than configuration. Kept as a list
 * because these are patterns over one string, not a lookup.
 */
const SECRET_NAMES: RegExp[] = [
	/\.pem$/i,
	/\.key$/i,
	/_rsa$/i,
	/\.p12$/i,
	/^id_ed25519/i,
	/token/i,
	/secret/i,
	/credential/i,
	/^\.env/i,
];

/** Shell separators that end one command. `2>&1` fragments cannot contain `commit`, so they fall out. */
const SEGMENTS = /^(?:\|\||&&|[;&|\n])$/;

/** Git global options that consume the following token, so a `commit` after one is not the subcommand. */
const VALUE_OPTIONS: Record<string, true> = {
	"--exec-path": true,
	"--git-dir": true,
	"--namespace": true,
	"--work-tree": true,
	"-C": true,
	"-c": true,
};

let testGit: ((args: string[]) => string | null) | null = null;
let repo: ChezmoiRepo | null = null;
let repoResolved = false;

export function setGitSpawnForTests(fn: ((args: string[]) => string | null) | null): void {
	testGit = fn;
}

export function resetSecretCommitGateForTests(): void {
	testGit = null;
	repo = null;
	repoResolved = false;
}

export function spawnGit(args: string[]): string | null {
	if (testGit) return testGit(args);
	try {
		const proc = Bun.spawnSync(["git", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: GIT_TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return null;
		return new TextDecoder().decode(proc.stdout);
	} catch {
		return null;
	}
}

/**
 * The chezmoi source tree as git sees it: the repository top level, and the
 * source dir's path below it.
 *
 * Both come from git so that both are normalized the same way. Comparing a
 * lexically built path against `rev-parse` output silently fails wherever a
 * parent is a symlink (`/tmp` on macOS), which reads as "not the chezmoi repo"
 * and lets the commit through. `--show-prefix` is empty when the source dir IS
 * the repository root, and `dotfiles/` when `.chezmoiroot` moves it down.
 */
export type ChezmoiRepo = { top: string; prefix: string };

export function chezmoiRepo(): ChezmoiRepo | null {
	if (repoResolved) return repo;
	repoResolved = true;
	repo = null;
	const source = loadSourceDir();
	if (!source) return null;
	const top = spawnGit(["-C", source, "rev-parse", "--show-toplevel"]);
	const prefix = spawnGit(["-C", source, "rev-parse", "--show-prefix"]);
	if (top === null || prefix === null || top.trim() === "") return null;
	repo = { top: top.trim(), prefix: prefix.trim() };
	return repo;
}

function unquote(token: string): string {
	const first = token.at(0);
	return (first === '"' || first === "'") && token.at(-1) === first ? token.slice(1, -1) : token;
}

export type CommitCall = { cwd: string | null; all: boolean; paths?: string[] };
type ShellStatus = "success" | "failure" | "unknown";

const COMMIT_VALUES: Record<string, true> = {
	"-m": true, "--message": true, "-F": true, "--file": true,
	"-C": true, "--reuse-message": true, "-c": true, "--reedit-message": true,
	"--author": true, "--date": true, "--cleanup": true, "-t": true,
	"--template": true, "--trailer": true, "--fixup": true, "--squash": true,
};

/**
 * The `git commit` calls in a shell command line, each with the directory it runs
 * in. `cd` is followed across sequential segments, while failed conditionals and
 * pipeline stages retain their shell scope. A null cwd means the shell's directory
 * cannot be resolved safely, so the caller must refuse the commit.
 */
export function gitCommits(command: string, cwd: string): CommitCall[] {
	const out: CommitCall[] = [];
	let here: string | null = cwd;
	let sequential = cwd;
	let sequentialUnknownCd = false;
	// The directory the CURRENT list runs in, which is not the same as `sequential`.
	// A backgrounded list's `cd` cannot escape to the parent shell, so `sequential`
	// must not see it -- but a later pipeline stage in that same job still runs in
	// it. Resetting a pipeline stage to `sequential` discarded the job's own `cd`,
	// which sent a real commit to be inspected against the parent's directory:
	// `cd secrets && printf x | git commit & git commit` put BOTH commits outside.
	let listCwd = cwd;
	let listUnknownCd = false;
	let unknownCd = false;
	let inPipeline = false;
	let pipelineStatus: ShellStatus = "unknown";
	let status: ShellStatus = "success";
	const segments: { tokens: string[]; separator: string }[] = [{ tokens: [], separator: "" }];
	for (const word of shellWords(command)) {
		if (SEGMENTS.test(word)) segments.push({ tokens: [], separator: word });
		else segments[segments.length - 1]!.tokens.push(word);
	}
	// `&` backgrounds the ENTIRE preceding list, so a `cd` inside it runs in a subshell
	// and cannot escape to the parent: `cd /tmp && git commit & git commit` runs the
	// foreground commit in the original directory. Each separator arrives attached to
	// the segment that FOLLOWS it, so membership is computed up front — discovering the
	// `&` while walking left to right is already too late, and a leaked directory would
	// send the real foreground commit to be inspected against the wrong one.
	const backgrounded: boolean[] = segments.map(() => false);
	for (let first = 0; first < segments.length; first++) {
		let last = first;
		// A list continues across `&&`, `||` and `|`; only `;` and `&` end the job.
		while (last + 1 < segments.length && ![";", "&"].includes(segments[last + 1]!.separator)) last++;
		if (segments[last + 1]?.separator === "&") for (let i = first; i <= last; i++) backgrounded[i] = true;
		first = last;
	}
	for (let slot = 0; slot < segments.length; slot++) {
		const { tokens, separator } = segments[slot]!;
		if (separator === "|") {
			if (!inPipeline) pipelineStatus = status;
			here = listUnknownCd ? null : listCwd;
			unknownCd = listUnknownCd;
			inPipeline = true;
		} else if (separator === "&") {
			here = sequentialUnknownCd ? null : sequential;
			unknownCd = sequentialUnknownCd;
			listCwd = sequential;
			listUnknownCd = sequentialUnknownCd;
			inPipeline = false;
			status = "unknown";
		} else if (inPipeline) {
			status = pipelineStatus;
			here = listUnknownCd ? null : listCwd;
			unknownCd = listUnknownCd;
			inPipeline = false;
		} else {
			// Publish what the PREVIOUS segment left behind. `listCwd` follows this
			// list even when it is backgrounded; `sequential` advances only for a
			// foreground segment, since a backgrounded `cd` never reaches the parent.
			// Testing this segment rather than the previous one would discard a
			// foreground `cd` that ran before a background job: in
			// `cd /tmp; cd /other & git commit` the parent really is left in /tmp.
			if (here !== null) listCwd = here;
			listUnknownCd = unknownCd;
			if (!backgrounded[slot - 1]) {
				if (here !== null) sequential = here;
				sequentialUnknownCd = unknownCd;
			}
		}
		const shouldRun = separator === "&&" ? status !== "failure" :
			separator === "||" ? status !== "success" : true;
		const conditional = separator === "&&" || separator === "||";
		if (tokens.length === 0 || !shouldRun) continue;
		if (tokens[0] === "cd") {
			const targetIndex = tokens[1] === "--" ? 2 : 1;
			const target = tokens[targetIndex] ?? "~";
			const invalid = tokens.length > targetIndex + 1 || target.startsWith("-") ||
				/[$`*?[\]]/.test(target) || /^~[^/]/.test(target) ||
				(here === null && !target.startsWith("/") && !target.startsWith("~"));
			if (invalid) {
				here = null;
				unknownCd = true;
				status = "unknown";
				if (inPipeline) pipelineStatus = status;
				continue;
			}
			const destination = lexicalAbs(unquote(target), here ?? cwd);
			try {
				if (!statSync(destination).isDirectory()) {
					status = "failure";
					if (inPipeline) pipelineStatus = status;
					continue;
				}
				accessSync(destination, constants.X_OK);
				if (!conditional) unknownCd = false;
				here = unknownCd ? null : destination;
				status = "success";
			} catch {
				status = "failure";
			}
			if (inPipeline) pipelineStatus = status;
			continue;
		}

		let start = 0;
		while (tokens[start] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!) ||
			["env", "command", "exec", "--"].includes(tokens[start]!))) start++;
		if (!["git", "dgit"].includes(basename(tokens[start] ?? ""))) {
			status = tokens[start] === "true" || tokens[start] === ":" ? "success" :
				tokens[start] === "false" ? "failure" : "unknown";
			if (inPipeline) pipelineStatus = status;
			continue;
		}

		let where = here;
		let index = start + 1;
		while (index < tokens.length) {
			const token = tokens[index]!;
			if (!token.startsWith("-")) break;
			// `-C<path>`, attached, as git also accepts it.
			if (token.startsWith("-C") && token.length > 2) {
				const target = unquote(token.slice(2));
				where = where === null && !target.startsWith("/") && !target.startsWith("~") ? null :
					lexicalAbs(target, where ?? cwd);
				index += 1;
				continue;
			}
			if (token.includes("=")) {
				index += 1;
				continue;
			}
			if (token === "-C") {
				const value = tokens[index + 1];
				if (!value) where = null;
				else {
					const target = unquote(value);
					where = where === null && !target.startsWith("/") && !target.startsWith("~") ? null :
						lexicalAbs(target, where ?? cwd);
				}
				index += 2;
				continue;
			}
			index += Object.hasOwn(VALUE_OPTIONS, token) ? 2 : 1;
		}

		if (tokens[index] !== "commit") {
			status = "unknown";
			if (inPipeline) pipelineStatus = status;
			continue;
		}
		const rest = tokens.slice(index + 1).map(unquote);
		let all = false;
		let boundary = false;
		let uncertain = false;
		const paths: string[] = [];
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i]!;
			if (!boundary && arg === "--") { boundary = true; continue; }
			if (!boundary && arg.startsWith("-")) {
				if (arg === "--dry-run") { uncertain = true; break; }
				if (arg.startsWith("--pathspec-from-file") || arg === "--interactive" ||
					arg === "--patch" || arg === "-p" || arg === "--include" || arg === "-i") {
					uncertain = true; break;
				}
				if (COMMIT_VALUES[arg] === true) { i++; continue; }
				if (arg === "--all") all = true;
				if (/^-[^-]/.test(arg)) {
					for (let k = 1; k < arg.length; k++) {
						if (COMMIT_VALUES[`-${arg[k]}`] === true) {
							if (k === arg.length - 1) i++;
							break;
						}
						if (arg[k] === "a") all = true;
						if (arg[k] === "i" || arg[k] === "p") uncertain = true;
					}
				}
				continue;
			}
			if (/[$`*?[\]]/.test(arg) || arg.startsWith(":")) uncertain = true;
			paths.push(arg);
		}
		if (where === null) out.push({ cwd: null, all, ...(paths.length ? { paths } : {}) });
		else if (!uncertain) out.push({ cwd: where, all, ...(paths.length ? { paths } : {}) });
		status = "unknown";
		if (inPipeline) pipelineStatus = status;
	}
	return out;
}

/**
 * The chezmoi target name a source name renders to, and whether chezmoi encrypts it.
 */
export function targetName(sourceBase: string): { name: string; encrypted: boolean } {
	let rest = sourceBase;
	let dotted = false;
	let encrypted = false;
	for (;;) {
		const underscore = rest.indexOf("_");
		if (underscore === -1) break;
		const prefix = rest.slice(0, underscore + 1);
		if (!Object.hasOwn(ATTRIBUTES, prefix)) break;
		if (prefix === "dot_") dotted = true;
		if (prefix === "encrypted_") encrypted = true;
		rest = rest.slice(underscore + 1);
	}
	return { name: dotted ? `.${rest}` : rest, encrypted };
}

/**
 * Staged source-tree paths named like a plaintext credential.
 *
 * Only the source tree: the rest of the repository is its own tooling (`scripts/`,
 * `docs/`), where a name like `check-secret-resolution.sh` is a script, not a key.
 * Paths arrive relative to the repository root, so the source dir is a string
 * prefix -- empty, and therefore matching everything, when they are the same dir.
 */
export function secretStagedPaths(staged: string[], prefix: string): string[] {
	const out: string[] = [];
	for (const path of staged) {
		if (path === "" || !path.startsWith(prefix)) continue;
		const base = basename(path);
		// A template holds the reference, never the value: it renders from 1Password
		// (or another vault) at apply time.
		if (base.endsWith(".tmpl")) continue;
		const { name, encrypted } = targetName(base);
		if (encrypted) continue;
		if (SECRET_NAMES.some((pattern) => pattern.test(name))) out.push(path);
	}
	return out;
}

/** Root-relative, NUL-delimited candidate names; null means Git could not establish them. */
export function committedPaths(top: string, all: boolean, paths: string[] = [], cwd = top): string[] | null {
	const scope = paths.length ? ["--", ...paths] : [];
	const args = ["--literal-pathspecs", "-C", paths.length ? cwd : top];
	let output: string | null;
	if (!all && paths.length === 0) {
		output = spawnGit([...args, "diff", "--cached", "--no-relative", "--no-renames",
			"--diff-filter=d", "--name-only", "-z"]);
	} else {
		output = spawnGit([...args, "diff", "--no-relative", "--no-renames",
			"--diff-filter=d", "--name-only", "-z", "HEAD", ...scope]);
		if (output === null) {
			// An unborn repository has no HEAD: its tracked, present files are additions.
			if (spawnGit([...args, "rev-parse", "--verify", "HEAD"]) !== null) return null;
			const tracked = spawnGit([...args, "ls-files", "--cached", "--full-name", "-z", ...scope]);
			const deleted = spawnGit([...args, "ls-files", "--deleted", "--full-name", "-z", ...scope]);
			if (tracked === null || deleted === null) return null;
			const removed = new Set(deleted.split("\0"));
			return [...new Set(tracked.split("\0").filter(path => path !== "" && !removed.has(path)))];
		}
	}
	return output === null ? null : output.split("\0").filter(path => path !== "");
}

export const SECRET_ADVICE =
	"Never commit a raw credential to the chezmoi source tree -- it is rendered into $HOME and kept " +
	"in git history. Template it instead, so the value is read at apply time " +
	'(`{{ onepasswordRead "op://<vault>/<item>/<field>" }}` in a `.tmpl` file), or store it with ' +
	"`chezmoi add --encrypt <target>`, which writes an `encrypted_` copy. A `.tmpl` or `encrypted_` " +
	"file commits cleanly. Unstage the file, convert it, then commit.";

export function decideCommit(command: string, cwd: string): { block: true; reason: string } | undefined {
	if (!/\bcommit\b/.test(command) || !/\bd?git\b/.test(command)) return;
	const chezmoi = chezmoiRepo();
	if (!chezmoi) return;
	for (const call of gitCommits(command, cwd)) {
		if (call.cwd === null) {
			return { block: true, reason: "Cannot determine the commit's working directory safely; refusing to allow a possible secret commit." };
		}
		// git answers where the commit lands, so a symlinked path still compares equal.
		const top = spawnGit(["-C", call.cwd, "rev-parse", "--show-toplevel"]);
		if (top === null || top.trim() !== chezmoi.top) continue;
		const candidates = committedPaths(chezmoi.top, call.all, call.paths, call.cwd);
		if (candidates === null) continue;
		const offenders = secretStagedPaths(candidates, chezmoi.prefix);
		if (offenders.length > 0) {
			return {
				block: true,
				reason: `This commit stages plaintext secrets: ${offenders.join(", ")}. ${SECRET_ADVICE}`,
			};
		}
	}
	return;
}

export default function secretCommitGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: { cwd?: string }) => {
		try {
			if (event.toolName !== "bash" || !("command" in event.input)) return;
			const input = event.input;
			const command = typeof input.command === "string" ? input.command : "";
			if (command === "") return;
			const sessionCwd = ctx?.cwd || process.cwd();
			// `bash` takes a per-call `cwd` that overrides the session's.
			const cwd = typeof input.cwd === "string" && input.cwd !== "" ? lexicalAbs(input.cwd, sessionCwd) : sessionCwd;
			return decideCommit(command, cwd);
		} catch {
			// Uncertainty is safety-critical: do not allow a commit we could not inspect.
			return { block: true, reason: "The secret commit guard could not resolve this command safely; refusing to allow it." };
		}
	});
}