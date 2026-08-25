import { basename } from "node:path";

import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

import { lexicalAbs, loadSourceDir } from "./chezmoi-guard.ts";

/**
 * Block a `git commit` in the chezmoi repository when a staged source file is
 * named like a plaintext credential.
 *
 * Names, not contents: chezmoi's own naming is the signal. A secret handled the
 * sanctioned way is either a `.tmpl` that reads the value from 1Password at apply
 * time or an `encrypted_` file, and neither trips this gate. Anything else with a
 * credential name is a plaintext secret about to enter git history.
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
const SEGMENTS = /\|\||&&|[;&|\n]/;

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

export type CommitCall = { cwd: string; all: boolean };

/**
 * The `git commit` calls in a shell command line, each with the directory it runs
 * in. `cd` is followed across segments: without that, `cd ~/.local/share/chezmoi
 * && git commit` reads as a commit in the session cwd.
 */
export function gitCommits(command: string, cwd: string): CommitCall[] {
	const out: CommitCall[] = [];
	let here = cwd;
	for (const segment of command.split(SEGMENTS)) {
		const tokens = segment.split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;

		if (tokens[0] === "cd") {
			const target = tokens[1];
			// A `$var` or command substitution names a directory only the shell knows.
			if (target && !/[$`]/.test(target)) here = lexicalAbs(unquote(target), here);
			continue;
		}

		const start = tokens.indexOf("git");
		if (start === -1) continue;

		let where = here;
		let index = start + 1;
		while (index < tokens.length) {
			const token = tokens[index]!;
			if (!token.startsWith("-")) break;
			// `-C<path>`, attached, as git also accepts it.
			if (token.startsWith("-C") && token.length > 2) {
				where = lexicalAbs(unquote(token.slice(2)), where);
				index += 1;
				continue;
			}
			if (token.includes("=")) {
				index += 1;
				continue;
			}
			if (token === "-C") {
				const value = tokens[index + 1];
				if (value) where = lexicalAbs(unquote(value), where);
				index += 2;
				continue;
			}
			index += Object.hasOwn(VALUE_OPTIONS, token) ? 2 : 1;
		}

		if (tokens[index] !== "commit") continue;
		const rest = tokens.slice(index + 1);
		const all = rest.some((t) => t === "--all" || /^-[a-zA-Z]*a/.test(t));
		out.push({ cwd: where, all });
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

/**
 * Paths a commit would carry: the index, plus tracked modifications when `-a` is
 * passed. Read from the repository root, so the names are root-relative whatever
 * `diff.relative` is set to.
 */
export function committedPaths(top: string, all: boolean): string[] {
	const staged = spawnGit(["-C", top, "diff", "--cached", "--name-only"]) ?? "";
	const tracked = all ? (spawnGit(["-C", top, "diff", "--name-only"]) ?? "") : "";
	return `${staged}\n${tracked}`.split("\n").map((line) => line.trim());
}

export const SECRET_ADVICE =
	"Never commit a raw credential to the chezmoi source tree -- it is rendered into $HOME and kept " +
	"in git history. Template it instead, so the value is read at apply time " +
	'(`{{ onepasswordRead "op://<vault>/<item>/<field>" }}` in a `.tmpl` file), or store it with ' +
	"`chezmoi add --encrypt <target>`, which writes an `encrypted_` copy. A `.tmpl` or `encrypted_` " +
	"file commits cleanly. Unstage the file, convert it, then commit.";

export function decideCommit(command: string, cwd: string): { block: true; reason: string } | undefined {
	if (!/\bcommit\b/.test(command) || !/\bgit\b/.test(command)) return;
	const chezmoi = chezmoiRepo();
	if (!chezmoi) return;
	for (const call of gitCommits(command, cwd)) {
		// git answers where the commit lands, so a symlinked path still compares equal.
		const top = spawnGit(["-C", call.cwd, "rev-parse", "--show-toplevel"]);
		if (top === null || top.trim() !== chezmoi.top) continue;
		const offenders = secretStagedPaths(committedPaths(chezmoi.top, call.all), chezmoi.prefix);
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
	pi.on("tool_call", (event: ExtensionToolCallEvent, ctx: { cwd?: string }) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input as Record<string, unknown>;
			const command = typeof input.command === "string" ? input.command : "";
			if (command === "") return;
			const sessionCwd = ctx?.cwd || process.cwd();
			// `bash` takes a per-call `cwd` that overrides the session's.
			const cwd = typeof input.cwd === "string" && input.cwd !== "" ? lexicalAbs(input.cwd, sessionCwd) : sessionCwd;
			return decideCommit(command, cwd);
		} catch {
			// Uncertainty allows the commit: a throwing tool_call handler is an outage.
			return;
		}
	});
}
