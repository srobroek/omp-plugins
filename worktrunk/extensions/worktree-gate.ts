/**
 * Refuse a mutation whose target is not physically inside a linked worktree of
 * this project.
 *
 * OMP native isolation is retired: every agent — root, lead, or child, whether
 * orchestrated or not — works in its own Worktrunk-created git linked worktree,
 * and the canonical checkout's working tree is never mutated by anyone. A
 * relative path or a defaulted `cwd` is all it takes to land a write in the
 * canonical checkout, because `task` cannot hand a child another cwd and OMP
 * resolves an omitted `bash` cwd to the session cwd.
 *
 * Enforcement is MEMBERSHIP-based, which is what makes "work in a worktree" a
 * contract rather than advice: a mutation is allowed only when its target is
 * inside a worktree that `git worktree list --porcelain` reports for THIS
 * repository and that is not the canonical root. `git worktree list --porcelain`
 * is the fast path used on every tool call; `wt list --format json` is
 * authoritative and richer but takes tens of seconds on a repository with many
 * worktrees, so it belongs at lifecycle time, never here.
 *
 * This is an accident guardrail, NOT a sandbox. Agents are cooperative. A
 * process whose cwd is a worktree can still write any absolute path through
 * `git -C <canonical>`, a shell redirection, or `eval`, and this module never
 * claims otherwise. It is worth having anyway because canonical is never a merge
 * target — landing merges a pull request and refreshes canonical with `git fetch`
 * alone — so no agent has a sanctioned reason to write there.
 *
 * Uncertainty refuses. A `git` that does not answer — missing binary, timeout,
 * any unexpected failure — is not evidence that this directory is outside a
 * repository, so it refuses mutation instead of standing down, and such a
 * failure is never cached. Path inputs are derived with OMP's own normalization
 * and cwds with OMP's own `resolveToCwd`, never a second parser: a parser that
 * disagreed with the tool performing the write would guard a different file than
 * the one that changes.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import {
	hasGlobPathChars,
	isInternalUrlPath,
	isReadableUrlPath,
	normalizePathLikeInput,
	pathTargetsSsh,
	resolveToCwd,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { editInspect } from "@oh-my-pi/pi-natives";
import { trustedPrimaryPolicy } from "./trusted-primary-policy.ts";

/** Refusal shape the `tool_call` gate API understands. */
export interface GateRefusal {
	block: true;
	reason: string;
}

/**
 * Tools that only ever READ the filesystem. A read-only agent may read the
 * canonical checkout (the gate blocks mutation, not inspection), and these tools
 * routinely carry canonical paths in arguments and prose — a `task` brief, a
 * `hub` message, a `grep` root. Every other tool name, including an unenumerated
 * `xd://` device and any MCP tool, is treated as mutating: `toolName` is an
 * unrestricted string, so allow-by-omission is how a guardrail silently stops
 * guarding.
 *
 * The second group are the tools registered with read approval that default an
 * optional path — or take none at all — to the session cwd: every
 * `approval: "read"` registration these plugins ship. They have to be named,
 * because a mutating call that points at nothing is judged by the cwd it would
 * default to, and a scan that only inspects the checkout must not be refused for
 * doing exactly what the gate lets `read` and `grep` do.
 */
const READ_ONLY_TOOLS: Record<string, true> = {
	ask: true,
	ast_grep: true,
	context_notes: true,
	debug: true,
	github: true,
	glob: true,
	goal: true,
	grep: true,
	hub: true,
	lsp: true,
	new_context: true,
	read: true,
	recall: true,
	reflect: true,
	task: true,
	think: true,
	todo: true,
	web_search: true,
	yield: true,

	agentic_lint: true,
	chezmoi_status: true,
	dep_scan: true,
	find_tools_scan: true,
	headed_read: true,
	resume_session: true,
	sniff_read_analyzer_artifact: true,
	sniff_read_report_artifact: true,
	version_gap_scan: true,
};

/**
 * Tools whose approval depends on their arguments: reading in one mode, mutating
 * in another, so they cannot sit in the table above. Each predicate mirrors that
 * tool's own approval callback, and only the reading modes are exempt.
 *
 *   `bd_formula_check` — `beads/extensions/formula-check-tool.ts`: `deep` pours
 *   for real, everything else is a dry run.
 *   `journeys_index` — `project/extensions/journeys-tool.ts`: `lint` and a
 *   `prune` without `yes` read; `index` and a confirmed `prune` write.
 */
const CONDITIONAL_READ_ONLY: Record<string, (input: Record<string, unknown>) => boolean> = {
	bd_formula_check: input => input.deep !== true,
	journeys_index: input =>
		input.command === "lint" || (input.command === "prune" && input.yes !== true),
};

/** True when this call is one of the reading modes of a mode-dependent tool. */
function readsOnlyInThisMode(toolName: string, input: unknown): boolean {
	const predicate = CONDITIONAL_READ_ONLY[toolName];
	if (predicate === undefined) return false;
	const record = asRecord(input);
	return record !== null && predicate(record);
}

/**
 * The bead-ledger tool family: the device spelling of a `bd` command, which the
 * bootstrap allowlist already permits from the canonical checkout for the same
 * two reasons — the store lives in the canonical `.beads`, and an agent must
 * claim its bead BEFORE it has a worktree to work in. Only the pathless form is
 * exempt: a ledger call that does name a filesystem target is checked like any
 * other, so the exemption cannot reach the working tree.
 */
const LEDGER_TOOL = /^orc_[a-z0-9_]+$/;

/**
 * Argument keys that name a filesystem target on an unenumerated tool. A value
 * under one of these keys is checked even when it is relative, because a
 * relative path resolves against the session cwd — which for an agent that has
 * not yet moved into its worktree IS the canonical checkout.
 */
const PATH_KEYS: Record<string, true> = {
	cwd: true,
	dest: true,
	destination: true,
	dir: true,
	directory: true,
	file: true,
	file_path: true,
	filepath: true,
	files: true,
	knowledge_base_paths: true,
	out: true,
	outfile: true,
	output: true,
	output_path: true,
	output_root: true,
	path: true,
	paths: true,
	root: true,
	roots: true,
	source: true,
	sources: true,
	src: true,
	target: true,
	targets: true,
};

/** Depth bound on the recursive argument walk; deeper nesting is not a path argument. */
const MAX_SCAN_DEPTH = 6;

/** Shell token separators emitted by the shared tokenizer. */
const SHELL_SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, ")": true, "\n": true };

/** Non-mutating command companions allowed around a bootstrap invocation. */
const READ_ONLY_COMPANIONS: Record<string, true> = {
	cat: true,
	echo: true,
	false: true,
	printf: true,
	rg: true,
	sort: true,
	true: true,
	uniq: true,
	wc: true,
};

/** Filters that consume stdin, with conservative argument shapes that exclude file operands. */
const STDIN_FILTERS: Record<string, true> = { cut: true, grep: true, head: true, jq: true, sed: true, sort: true, tail: true, tr: true, uniq: true, wc: true };

function stdinFilterAllowed(program: string, args: readonly string[]): boolean {
	if (!STDIN_FILTERS[program]) return false;
	const positionals = args.filter(token => !token.startsWith("-"));
	if (program === "sed" && args.some(token => token === "-i" || token === "--in-place")) return false;
	if (program === "grep" && args.some(token => token === "-f" || token === "--file")) return false;
	if (program === "tr") return positionals.length === 2;
	if (program === "grep" || program === "jq" || program === "sed") return positionals.length === 1;
	return positionals.length === 0;
}

/** Branch names an agent may create from the canonical checkout. */
const AGENT_BRANCH = /^omp\/[A-Za-z0-9._/-]+$/;

/** `wt switch pr:<N>` shorthand: a review worktree at a pull-request head. */
const PR_BRANCH = /^pr:\d+$/;

/** Edit payload wire modes whose target paths live in a single `input` string. */
const INPUT_EDIT_MODES = ["hashline", "sloppy", "apply_patch"] as const;

export const CREATE_HINT =
	"Claim your bead, then create your worktree with " +
	"`wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>`, " +
	"then work by absolute path under it (or pass `-C <worktree>` / `cwd: <worktree>`).";

export const SANDBOX_LIMIT =
	"This is an accident guardrail, not a sandbox: from a worktree cwd you can still " +
	"write any absolute path via `git -C <canonical>`, a redirection, or `eval`. " +
	"Canonical is never a merge target, so nothing legitimate writes there.";

/** The refusal a mutation outside every project worktree earns. */
export function containmentRefusal(target: string, canonical: string, worktrees: readonly string[]): string {
	const known =
		worktrees.length === 0
			? "This project currently has no linked worktree."
			: `Linked worktrees of this project: ${worktrees.join(", ")}.`;
	return (
		`worktrunk refused this call: it would mutate \`${target}\`, which is not inside a linked ` +
		`worktree of this project (canonical checkout: ${canonical}). ${known} ${CREATE_HINT} ${SANDBOX_LIMIT}`
	);
}

/**
 * The refusal an unclassifiable payload earns. Uncertainty refuses.
 *
 * `canonical` is `null` when the canonical root itself could not be resolved;
 * the refusal then says so rather than naming a directory it does not know.
 */
export function uncertaintyRefusal(what: string, canonical: string | null): string {
	const where =
		canonical === null
			? "the canonical checkout (which git could not name) or in a worktree"
			: `the canonical checkout (${canonical}) or in a worktree`;
	return `worktrunk refused this call: ${what}, so it cannot tell whether the mutation lands in ${where}. ${CREATE_HINT} ${SANDBOX_LIMIT}`;
}

/**
 * The refusal an undetermined project topology earns.
 *
 * `git` failing to answer proves nothing about where a write lands, so the gate
 * refuses rather than standing down: a gate that disables itself whenever the
 * command it depends on misbehaves is not a guardrail. The failure is not
 * cached, so the next call after git recovers is decided normally.
 */
export function topologyRefusal(detail: string): string {
	return (
		`worktrunk refused this call: ${detail}, so it cannot tell whether this mutation lands in the ` +
		`canonical checkout or in a linked worktree of this project. Uncertainty refuses; retry once ` +
		`\`git\` answers again. ${CREATE_HINT} ${SANDBOX_LIMIT}`
	);
}

/** The refusal a non-allowlisted command with a canonical effective cwd earns. */
export function bootstrapRefusal(command: string, cwd: string): string {
	return (
		`worktrunk refused this call: it would run in the canonical checkout ` +
		`(${cwd}) and \`${command.split("\n")[0]}\` is not one of the bootstrap commands allowed there ` +
		`(\`wt switch\`/\`wt list\`/\`wt config show\`/\`wt step prune --dry-run\`, read-only \`git\`, and \`bd\`). ` +
		`${CREATE_HINT} ${SANDBOX_LIMIT}`
	);
}

/**
 * Realpath of the deepest EXISTING ancestor, with the missing tail reattached.
 *
 * Never a lexical prefix comparison: `write` writes the supplied path and an
 * archive write replaces the realpath'd physical file, so a symlink inside a
 * worktree pointing at the canonical checkout defeats every lexical check. Both
 * sides of a containment test go through here, so the comparison is between
 * physical identities.
 */
export function realDeepest(target: string): string | null {
	let current = path.resolve(target);
	const missing: string[] = [];
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return missing.length === 0 ? real : path.join(real, ...missing.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return null;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

/** Resolve the deepest existing ancestor of a possibly missing target. */
function existingAncestor(target: string): string | null {
	let current = path.resolve(target);
	for (;;) {
		try {
			return realpathSync.native(current);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

/**
 * The deepest existing DIRECTORY at or above `target`: the directory a `git`
 * question about `target` has to run in.
 *
 * A write commonly names a file — one that exists, or one under directories that
 * do not exist yet — and `git -C` needs a directory either way. Asking from the
 * deepest existing directory asks about the same repository.
 */
function existingAncestorDir(target: string): string | null {
	let current = existingAncestor(target);
	while (current !== null) {
		try {
			if (lstatSync(current).isDirectory()) return current;
		} catch {
			// Raced away between the realpath and here: keep walking up.
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * The root in `roots` that physically contains (or equals) `target`, or `null`.
 * Physical identities on both sides, for the reason `realDeepest` explains.
 */
export function enclosingRoot(target: string, roots: readonly string[]): string | null {
	const real = realDeepest(target);
	if (real === null) return null;
	for (const root of roots) {
		const realRoot = realDeepest(root);
		if (realRoot === null) continue;
		if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) return root;
	}
	return null;
}

/** True when `target` is physically inside (or equal to) one of `roots`. */
export function insideAny(target: string, roots: readonly string[]): boolean {
	return enclosingRoot(target, roots) !== null;
}

/** What a `git` invocation established: an answer, a refusal to be in a repository, or nothing. */
type GitOutcome =
	| { ok: true; stdout: string }
	| { ok: false; kind: "no-repository" }
	| { ok: false; kind: "unavailable"; detail: string };

/**
 * `git` said this directory is in no repository at all — a definite answer, not
 * a failure. Deliberately narrow: a `cwd` git cannot even enter ("No such file
 * or directory") is an unknown, not a licence to stand down.
 */
const NOT_A_REPOSITORY = /not a git repository|not a working tree/i;

/**
 * Run `git` and classify the outcome, distinguishing a definite "no repository
 * here" from a `git` that did not answer.
 *
 * `spawnSync` rather than `execFileSync` because the distinction lives in
 * `error` (ENOENT when git is not on PATH, ETIMEDOUT), in `signal` (the timeout
 * kill), and in `stderr` (git's own diagnosis) — an exception collapses all
 * three into one indistinguishable failure, which is how a gate ends up
 * standing down when its own toolchain breaks.
 */
type RepositoryMetadata = "present" | "absent" | "unknown";

/**
 * Inspect repository metadata without opening it. An existing `.git` entry is
 * evidence that a failed `git` lookup may be a repository whose metadata is
 * unreadable; an absent entry is evidence of no repository only when the
 * lookup itself ran and reported the usual no-repository diagnosis.
 */
function repositoryMetadata(cwd: string): RepositoryMetadata {
	let current: string;
	try {
		current = realpathSync.native(cwd);
	} catch {
		return "unknown";
	}
	for (;;) {
		try {
			lstatSync(path.join(current, ".git"));
			return "present";
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return "unknown";
		}
		const parent = path.dirname(current);
		if (parent === current) return "absent";
		current = parent;
	}
}

function runGit(cwd: string, args: string[]): GitOutcome {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_SYSTEM = "/dev/null";
	env.GIT_CONFIG_COUNT = "0";
	env.GIT_NO_REPLACE_OBJECTS = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	const result = spawnSync("git", ["-C", cwd, ...args], {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 5000,
	});
	if (result.error) return { ok: false, kind: "unavailable", detail: `\`git\` did not run (${result.error.message})` };
	if (result.signal !== null && result.signal !== undefined) {
		return { ok: false, kind: "unavailable", detail: `\`git ${args[0]}\` was killed by ${result.signal} (timeout)` };
	}
	if (result.status !== 0) {
		const stderr = (result.stderr ?? "").trim();
		// The diagnosis is only a no-repository answer when the filesystem also
		// shows no metadata entry. A present or unreadable entry keeps this an
		// unknown; git's status 128 and wording cannot distinguish those cases.
		if (NOT_A_REPOSITORY.test(stderr) && repositoryMetadata(cwd) === "absent") {
			return { ok: false, kind: "no-repository" };
		}
		return {
			ok: false,
			kind: "unavailable",
			detail: `\`git ${args[0]}\` exited ${result.status}${stderr.length > 0 ? `: ${stderr.split("\n")[0]}` : ""}`,
		};
	}
	return { ok: true, stdout: result.stdout ?? "" };
}

/** What resolving the canonical root established. `unknown` is a refusal state, not an inert one. */
export type CanonicalResolution =
	| { state: "repository"; canonical: string; commonDir: string }
	| { state: "no-repository" }
	| { state: "unknown"; detail: string };

/**
 * Resolve the absolute canonical root of the repository `cwd` belongs to — its
 * MAIN worktree — together with the common git directory that identifies the
 * repository.
 *
 * In the main worktree `--git-dir` and `--git-common-dir` are the same path, so
 * the working-tree root git reports IS the canonical root. In a linked worktree
 * they differ, and the main worktree is the directory whose `.git` entry is that
 * common directory — checked on the filesystem rather than assumed, because
 * `dirname(--git-common-dir)` is wrong wherever the git directory does not sit
 * beside its working tree. Inside a checked-out submodule the common directory is
 * `<super>/.git/modules/<name>`, whose parent is `<super>/.git/modules`: a
 * directory where `git worktree list` reports the SUPERPROJECT's checkout, so
 * mutations of the superproject's canonical files read as "inside a linked
 * worktree" and were permitted. `--separate-git-dir` breaks it the same way, and
 * for both git itself can name the working tree through `core.worktree`.
 *
 * Three outcomes, because two would be a fail-open bug: `no-repository` is git
 * saying there is nothing to protect, while `unknown` is git not saying
 * anything, and only the first may make the gate inert.
 */
export function resolveCanonicalRoot(cwd: string): CanonicalResolution {
	const outcome = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"]);
	if (!outcome.ok) {
		return outcome.kind === "no-repository" ? { state: "no-repository" } : { state: "unknown", detail: outcome.detail };
	}
	const [rawCommon, rawGitDir, rawToplevel] = outcome.stdout.trim().split("\n");
	const commonDir = realDeepest((rawCommon ?? "").trim());
	const gitDir = realDeepest((rawGitDir ?? "").trim());
	if (commonDir === null || gitDir === null) {
		return { state: "unknown", detail: "`git rev-parse` named no git directory that resolves on disk" };
	}
	if (gitDir === commonDir) {
		// The main worktree: git already named its root. A bare repository prints no
		// toplevel, and a mutation there is not a working-tree write to permit.
		const toplevel = realDeepest((rawToplevel ?? "").trim());
		if (toplevel === null || (rawToplevel ?? "").trim().length === 0) {
			return { state: "unknown", detail: `\`git rev-parse --show-toplevel\` named no working tree in ${cwd}` };
		}
		return { state: "repository", canonical: toplevel, commonDir };
	}
	const sibling = realDeepest(path.dirname(commonDir));
	if (sibling !== null && realDeepest(path.join(sibling, ".git")) === commonDir) {
		return { state: "repository", canonical: sibling, commonDir };
	}
	// A git directory that does not sit beside its working tree. Ask git from that
	// directory: it reads `core.worktree`, which is how a submodule names its
	// checkout.
	const fromCommon = runGit(commonDir, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
	const named = fromCommon.ok ? realDeepest(fromCommon.stdout.trim()) : null;
	if (named !== null) return { state: "repository", canonical: named, commonDir };
	// `git init --separate-git-dir` sets no `core.worktree`, and the registration
	// names the git directory rather than the checkout, so from a linked worktree the
	// main working tree cannot be named at all. Verified against git 2.55.0. Use the
	// git directory as the repository's identity root: nothing inside it is a place
	// to work, so a mutation there is refused, linked worktrees still verify against
	// it, and a target inside the real main worktree is resolved from its own
	// directory — where `--git-dir` equals `--git-common-dir` and git does name the
	// root. Refusing outright instead would refuse every write in a valid worktree.
	return { state: "repository", canonical: commonDir, commonDir };
}

/**
 * Canonical root, or `null` for both "no repository" and "git did not answer".
 *
 * Informational only: the gate decides on `resolveCanonicalRoot`, because this
 * `null` conflates a directory that needs no guarding with one whose topology is
 * merely unknown, and treating the second as the first is what disables a gate.
 */
export function canonicalRoot(cwd: string): string | null {
	const resolution = resolveCanonicalRoot(cwd);
	return resolution.state === "repository" ? resolution.canonical : null;
}

/**
 * Linked, non-canonical worktrees of the repository whose main worktree is
 * `canonical` and whose common git directory is `commonDir`, as physical paths,
 * or `null` when the answer could not be established.
 *
 * Every entry is verified against that identity, not merely listed. `git worktree
 * list` reports what is registered, and registration outlives the directory: an
 * agent that deletes a worktree without unregistering it, and then initialises a
 * NEW repository at the same path, leaves the old repository still naming it —
 * and writes there would land in the replacement's canonical checkout. A path
 * counts only when its `.git` gitfile points inside `commonDir`, which is also
 * what drops the git-directory entry git reports as a submodule's main worktree.
 */
export function projectWorktrees(canonical: string, commonDir?: string | null): string[] | null {
	let identity = commonDir ?? null;
	if (identity === null) {
		const resolution = resolveCanonicalRoot(canonical);
		identity = resolution.state === "repository" ? resolution.commonDir : null;
	}
	if (identity === null) return null;
	const outcome = runGit(canonical, ["worktree", "list", "--porcelain"]);
	if (!outcome.ok) return null;
	const realCanonical = realDeepest(canonical);
	const found: string[] = [];
	for (const line of outcome.stdout.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const real = realDeepest(line.slice("worktree ".length).trim());
		if (real === null || real === realCanonical || !stillLinkedWorktree(real, identity)) continue;
		found.push(real);
	}
	return found;
}

/** One repository's topology: its canonical root, its identity, and its linked worktrees. */
export interface RepositoryTopology {
	/** Canonical root, or `null` when this directory is in no repository or the answer is unknown. */
	canonical: string | null;
	/** The common git directory identifying the repository, when one was resolved. */
	commonDir?: string | null;
	/**
	 * Why the topology could not be determined, or `null`/absent when it was.
	 * Non-null means mutation refuses: a `null` canonical alone cannot say
	 * whether there is nothing to guard or nothing was learned.
	 */
	uncertainty?: string | null;
	/** Cached non-canonical worktrees; empty when the list could not be read. */
	worktrees: readonly string[];
	/** Re-read the worktree list and return it. */
	refresh(): readonly string[];
}

/**
 * Topology the decision runs against: the session's own repository, plus the
 * repository that owns any given directory. Injectable so tests need no
 * repository.
 *
 * A target is judged against ITS OWN repository, never the session's. A run
 * dispatches workers into more than one repository, and a worker sent into a
 * second repository works in a linked worktree of that repository from a session
 * whose cwd is still the first one. Judging by the session's worktree list either
 * refuses all of that work or, if the gate stands down instead, leaves the second
 * repository's canonical checkout unguarded from here.
 */
export interface GateTopology {
	/** The repository the session's cwd belongs to. Decides whether the gate applies at all. */
	session: RepositoryTopology;
	/** The repository owning `dir`, which must be an existing directory. */
	forTarget(dir: string): RepositoryTopology;
}

const canonicalCache = new Map<string, CanonicalResolution>();
const worktreeCache = new Map<string, string[]>();

/**
 * Forget the cached worktree list. Called when a worktree-creating command is
 * observed, so the very next check sees the new worktree rather than refusing
 * work in it.
 */
export function invalidateWorktreeCache(): void {
	worktreeCache.clear();
}

/** Forget every cached lookup. Tests and a repository change use this. */
export function resetTopologyCache(): void {
	canonicalCache.clear();
	worktreeCache.clear();
}

/**
 * True when `dir` still belongs to the repository whose common git directory is
 * `commonDir`, judged from the filesystem: the nearest `.git` entry at or above it
 * must resolve inside that directory — the directory itself for a main worktree,
 * an admin directory under it for a linked one.
 *
 * `false` means "no longer confidently this repository", never "refuse": the
 * caller re-asks git. A path can change hands — a worktree removed from one
 * repository and re-added to another, a directory that becomes a submodule — and a
 * cached owner that outlives the change either guards the wrong tree or refuses
 * legitimate work in the new one for the rest of the session.
 */
function stillInRepository(dir: string, commonDir: string): boolean {
	let current = realDeepest(dir);
	while (current !== null) {
		const pointer = path.join(current, ".git");
		let gitDirEntry: boolean | null = null;
		try {
			gitDirEntry = lstatSync(pointer).isDirectory();
		} catch {
			gitDirEntry = null;
		}
		if (gitDirEntry !== null) {
			// A directory `.git` is this repository's own git directory; a file is a
			// gitfile, which `stillLinkedWorktree` resolves against the same identity.
			return gitDirEntry ? realDeepest(pointer) === commonDir : stillLinkedWorktree(current, commonDir);
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
	return false;
}

/** The topology of the repository owning `cwd`. */
export function repositoryTopology(cwd: string): RepositoryTopology {
	let resolution = canonicalCache.get(cwd);
	// A cached `no-repository` holds only while the filesystem still shows no
	// repository above this directory. Another agent's `git init` is a command this
	// session never sees, and trusting the stale negative would walk later writes
	// straight into a brand-new canonical checkout. The metadata walk is a few
	// `lstat` calls, and anything but a confirmed absence re-asks git.
	if (resolution?.state === "no-repository" && repositoryMetadata(cwd) !== "absent") {
		canonicalCache.delete(cwd);
		resolution = undefined;
	}
	// A cached repository holds only while this directory still belongs to it. A
	// worktree removed from one repository and re-added to another keeps its path,
	// and a cached owner that outlived the change refuses legitimate work in the new
	// repository for the rest of the session.
	if (resolution?.state === "repository" && !stillInRepository(cwd, resolution.commonDir)) {
		canonicalCache.delete(cwd);
		resolution = undefined;
	}
	if (resolution === undefined) {
		resolution = resolveCanonicalRoot(cwd);
		// A failure is never cached. Caching it would let one transient `git`
		// failure disable the gate for the rest of the session, which is exactly
		// the shape a guardrail must not have.
		if (resolution.state !== "unknown") canonicalCache.set(cwd, resolution);
	}
	if (resolution.state === "unknown") {
		return { canonical: null, uncertainty: resolution.detail, worktrees: [], refresh: () => [] };
	}
	if (resolution.state === "no-repository") {
		return { canonical: null, uncertainty: null, worktrees: [], refresh: () => [] };
	}
	const root = resolution.canonical;
	const commonDir = resolution.commonDir;
	let listFailure: string | null = null;
	const read = (): readonly string[] => {
		const fresh = projectWorktrees(root, commonDir);
		if (fresh === null) {
			listFailure = `\`git worktree list\` did not answer in ${root}`;
			return [];
		}
		listFailure = null;
		worktreeCache.set(root, fresh);
		return fresh;
	};
	return {
		canonical: root,
		commonDir,
		get uncertainty(): string | null {
			return listFailure;
		},
		get worktrees(): readonly string[] {
			return worktreeCache.get(root) ?? read();
		},
		refresh: read,
	};
}

export function defaultTopology(sessionCwd: string): GateTopology {
	return { session: repositoryTopology(sessionCwd), forTarget: repositoryTopology };
}

/**
 * Still a linked worktree of the repository whose common git directory is
 * `commonDir`, judged from the filesystem alone: a linked worktree's `.git` is a
 * FILE holding `gitdir: <admin dir>`, and that admin dir lives inside the common
 * directory.
 *
 * `false` means "not confidently linked", never "refuse": the caller falls back to
 * `git worktree list`, which is authoritative. So an unusual layout cannot turn
 * into a false refusal, while the case this exists for is caught — a worktree
 * removed and an ordinary directory recreated at its path, which git no longer
 * reports at all.
 */
export function stillLinkedWorktree(worktree: string, commonDir: string | null | undefined): boolean {
	if (commonDir === null || commonDir === undefined) return false;
	const pointer = path.join(worktree, ".git");
	let raw: string;
	try {
		if (!lstatSync(pointer).isFile()) return false;
		raw = readFileSync(pointer, "utf8");
	} catch {
		return false;
	}
	const admin = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(raw)?.[1];
	if (admin === undefined) return false;
	const real = realDeepest(path.isAbsolute(admin) ? admin : path.resolve(worktree, admin));
	return real !== null && insideAny(real, [commonDir]);
}

/** Where a target sits relative to the repository that owns it. */
type Containment =
	| { inside: true }
	| { inside: false; uncertainty: string; repository: null }
	| { inside: false; uncertainty: null; repository: RepositoryTopology };

/**
 * Whether `target` is inside a linked worktree of the repository that OWNS it.
 *
 * The owner is resolved from the target, not from the session, so a worker
 * dispatched into a second repository works there while that repository's own
 * canonical checkout stays guarded. The worktree list is re-read once before
 * concluding a target is outside, because a worktree created by a command this
 * gate never saw is otherwise a false refusal, and that costs one `git` call only
 * on the path that was about to refuse.
 *
 * A cached positive is not trusted on its own. Removals are not commands this gate
 * can recognize — another agent, or an allowed command in a sibling worktree, may
 * run `wt remove` or `git worktree remove` — so a cache entry whose path is no
 * longer a linked worktree would keep a recreated ordinary directory trusted for
 * the rest of the session. The `.git` pointer check is two syscalls, cheap enough
 * for every tool call, and anything it cannot confirm falls through to git.
 */
function containment(target: string, topology: GateTopology): Containment {
	const dir = existingAncestorDir(target);
	if (dir === null) {
		return {
			inside: false,
			uncertainty: `no existing directory above \`${target}\` to resolve a repository from`,
			repository: null,
		};
	}
	const repository = topology.forTarget(dir);
	const early = repository.uncertainty ?? null;
	if (early !== null) return { inside: false, uncertainty: early, repository: null };
	const cached = enclosingRoot(target, repository.worktrees);
	if (cached !== null && stillLinkedWorktree(cached, repository.commonDir)) return { inside: true };
	if (insideAny(target, repository.refresh())) return { inside: true };
	const late = repository.uncertainty ?? null;
	// The re-read is what failed: the honest refusal names that, rather than a
	// claim about which worktrees hold the target.
	if (late !== null) return { inside: false, uncertainty: late, repository: null };
	return { inside: false, uncertainty: null, repository };
}

/**
 * The absolute filesystem path this argument names, or `null` when it names no
 * filesystem path at all (an internal URL, a web URL, an `ssh://` target, or an
 * unresolvable string). Resolution goes through OMP's own `resolveToCwd`, which
 * expands `~` — a hand-rolled `path.resolve` does not, and would guard the wrong
 * file for every `~`-spelled target.
 */
export function resolveTarget(raw: string, sessionCwd: string): string | null {
	const normalized = normalizePathLikeInput(unwrapHashlineHeaderPath(raw));
	if (normalized.length === 0) return null;
	if (isInternalUrlPath(normalized) || isReadableUrlPath(normalized) || pathTargetsSsh(normalized)) return null;
	try {
		return resolveToCwd(normalized, sessionCwd);
	} catch {
		return null;
	}
}

/** `xd://<tool>` device target, or `null`. */
function xdDeviceTool(raw: string): string | null {
	const normalized = normalizePathLikeInput(unwrapHashlineHeaderPath(raw));
	const match = /^xd:\/\/([^?#]+)/i.exec(normalized);
	const name = match?.[1]?.trim();
	return name === undefined || name.length === 0 ? null : name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The longest leading path segment run that contains no glob magic. */
export function globBase(pattern: string): string {
	if (!hasGlobPathChars(pattern)) return pattern;
	const segments = pattern.split("/");
	const plain: string[] = [];
	for (const segment of segments) {
		if (hasGlobPathChars(segment)) break;
		plain.push(segment);
	}
	const base = plain.join("/");
	return base.length === 0 ? "." : base;
}

/**
 * Target paths of an `edit` call, or `null` when the payload will not parse.
 *
 * The `input`-string modes are parsed with OMP's own `editInspect`, in mode
 * order, taking the first mode that yields any path: unioning every mode's
 * output would fold one parser's misreading of another mode's payload into the
 * result and refuse legitimate work.
 */
export function editTargets(input: unknown): string[] | null {
	const record = asRecord(input);
	if (record === null) return null;
	if (typeof record.path === "string") {
		const targets = [record.path];
		const edits = Array.isArray(record.edits) ? record.edits : [];
		for (const entry of edits) {
			const rename = asRecord(entry)?.rename;
			if (typeof rename === "string") targets.push(rename);
		}
		return targets;
	}
	if (typeof record.input !== "string") return null;
	const payload = JSON.stringify({ input: record.input });
	for (const mode of INPUT_EDIT_MODES) {
		let inspection: { paths: string[]; fileOps: { to?: string | null }[] };
		try {
			inspection = editInspect(mode, payload);
		} catch {
			continue;
		}
		if (inspection.paths.length === 0) continue;
		const targets = [...inspection.paths];
		for (const op of inspection.fileOps) {
			if (typeof op.to === "string" && op.to.length > 0) targets.push(op.to);
		}
		return targets;
	}
	return null;
}

/**
 * Package-local copy of the tokenizer shape from beads/extensions/bd-close-gate.ts.
 * The plugins install separately and worktrunk declares no beads dependency; keep
 * this small copy until the shared parser gets its own released package.
 */
export function tokenize(command: string): string[] | null {
	const out: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | null = null;
	const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
	const flush = (): void => {
		if (started) { out.push(current); current = ""; started = false; }
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote !== null) { if (ch === quote) quote = null; else { current += ch; started = true; } continue; }
		if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
		if (ch === "\\" && i + 1 < command.length) { current += command[++i] as string; started = true; continue; }
		if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") { flush(); out.push("<<<"); i += 2; continue; }
		if (ch === "<" && command[i + 1] === "<") {
			const operator = hereDocumentOperator(command, i);
			if (operator !== null) { flush(); pending.push(operator); i = operator.end - 1; continue; }
		}
		if (ch === "\n") {
			flush(); out.push(ch);
			while (pending.length) { const document = pending.shift(); if (document === undefined) break; i = hereDocumentBodyEnd(command, i + 1, document); }
			continue;
		}
		if (/\s/.test(ch)) { flush(); continue; }
		if ({ ";": true, "&": true, "|": true, "(": true, ")": true }[ch] === true) { flush(); out.push(ch); continue; }
		current += ch; started = true;
	}
	flush();
	return quote === null ? out : null;
}

function hereDocumentOperator(command: string, start: number): { delimiter: string; stripTabs: boolean; end: number } | null {
	let i = start + 2;
	const stripTabs = command[i] === "-";
	if (stripTabs) i++;
	while (command[i] === " " || command[i] === "\t") i++;
	const quote = command[i];
	let delimiter = "";
	if (quote === '"' || quote === "'") { const close = command.indexOf(quote, i + 1); if (close === -1) return null; delimiter = command.slice(i + 1, close); i = close + 1; }
	else while (i < command.length && !/[\s;&|<>()]/.test(command[i] as string)) delimiter += command[i++];
	return delimiter ? { delimiter, stripTabs, end: i } : null;
}

function hereDocumentBodyEnd(command: string, from: number, document: { delimiter: string; stripTabs: boolean }): number {
	let cursor = from;
	while (cursor < command.length) { let next = command.indexOf("\n", cursor); if (next === -1) next = command.length; let line = command.slice(cursor, next); if (document.stripTabs) line = line.replace(/^\t+/, ""); if (line === document.delimiter) return next; cursor = next + 1; }
	return command.length;
}

/**
 * Separators only, with redirections consumed. `null` when the command cannot be
 * judged: an unbalanced quote, or a redirection whose target is a real file.
 *
 * A redirection is how a read-only companion mutates. `commandTokens` drops the
 * operator and its target, so `printf x > <canonical>/f` would otherwise reduce
 * to a `printf` segment and pass as safe. Discarding the target means the
 * allowlist cannot see what is written, so a file target disqualifies the
 * command and only the discard device and descriptor duplications stay.
 */
function commandTokens(command: string): string[] | null {
	const raw = tokenize(command);
	if (raw === null) return null;
	const out: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const token = raw[i] as string;
		if (!/^(?:\d+)?(?:<<<|<<|>>|>|<)/.test(token)) {
			out.push(token);
			continue;
		}
		const next = raw[++i];
		if (next === "&") {
			const target = raw[++i];
			if (target !== undefined && SHELL_SEPARATORS[target] === true) out.push(target);
			continue;
		}
		if (next === undefined) continue;
		if (SHELL_SEPARATORS[next] === true) {
			out.push(next);
			continue;
		}
		if (next !== "/dev/null") return null;
	}
	return out;
}

/** Consume `wt`'s global options, returning the subcommand tokens. */
function afterWtGlobals(tokens: readonly string[]): string[] | null {
	const rest = [...tokens];
	for (;;) {
		const head = rest[0];
		if (head === undefined) return null;
		if (head === "-y" || head === "--yes" || head === "-v" || head === "--verbose") {
			rest.shift();
			continue;
		}
		if (head === "-C" || head === "--config" || head === "--config-set") {
			if (rest[1] === undefined) return null;
			rest.splice(0, 2);
			continue;
		}
		return rest;
	}
}

/** Consume `git`'s global options, returning the subcommand tokens. */
function afterGitGlobals(tokens: readonly string[]): string[] | null {
	const rest = [...tokens];
	for (;;) {
		const head = rest[0];
		if (head === undefined) return null;
		if (head === "--no-pager" || head === "--no-replace-objects") {
			rest.shift();
			continue;
		}
		if (head === "-C" || head === "-c") {
			if (rest[1] === undefined) return null;
			rest.splice(0, 2);
			continue;
		}
		return rest;
	}
}

function wtSwitchAllowed(args: readonly string[]): boolean {
	let yes = false;
	let create = false;
	let noCd = false;
	let formatJson = false;
	let base: string | undefined;
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (token === undefined) return false;
		switch (token) {
			case "-y":
			case "--yes":
				yes = true;
				continue;
			case "-c":
			case "--create":
				create = true;
				continue;
			case "--no-cd":
				noCd = true;
				continue;
			case "--base":
			case "-b": {
				base = args[++index];
				if (base === undefined) return false;
				continue;
			}
			case "--format": {
				if (args[++index] !== "json") return false;
				formatJson = true;
				continue;
			}
			default:
				if (token.startsWith("-")) return false;
				positionals.push(token);
		}
	}
	if (!yes || !noCd || !formatJson || positionals.length !== 1) return false;
	const branch = positionals[0] as string;
	if (create) return AGENT_BRANCH.test(branch) && base !== undefined;
	return PR_BRANCH.test(branch);
}

const GH_READ_VERBS: Record<string, Record<string, true>> = {
	pr: { view: true, checks: true, list: true, diff: true },
	issue: { view: true, list: true },
	run: { view: true, list: true },
	repo: { view: true },
};

function ghReadAllowed(args: readonly string[]): boolean {
	const sub = args[0];
	if (sub === "api") {
		let method = "GET";
		for (let i = 1; i < args.length; i++) {
			const token = args[i] as string;
			if (token === "-X" || token === "--method") method = args[++i] ?? "";
			else if (token.startsWith("--method=")) method = token.slice("--method=".length);
		}
		return method.toUpperCase() === "GET";
	}
	const verb = args[1];
	return sub !== undefined && verb !== undefined && GH_READ_VERBS[sub]?.[verb] === true;
}

function invocationKind(segment: readonly string[]): "allowed" | "safe" | "other" {
	let index = 0;
	while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(segment[index] as string)) index++;
	const program = segment[index];
	if (program === undefined) return "safe";
	const rest = segment.slice(index + 1);
	if (program === "env") {
		let envIndex = 0;
		while (envIndex < rest.length) {
			const option = rest[envIndex];
			if (option === undefined) return "other";
			if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(option)) { envIndex++; continue; }
			if (option === "-i" || option === "--ignore-environment") { envIndex++; continue; }
			if (option === "-u" || option === "--unset") { if (rest[envIndex + 1] === undefined) return "other"; envIndex += 2; continue; }
			break;
		}
		if (envIndex >= rest.length) return "other";
		return invocationKind(rest.slice(envIndex));
	}
	if (program === "bd") return "allowed";
	if (program === "wt") {
		const args = afterWtGlobals(rest);
		if (args === null) return "other";
		const sub = args[0];
		const tail = args.slice(1);
		if (sub === "switch") return wtSwitchAllowed(tail) ? "allowed" : "other";
		if (sub === "list") return tail.length === 0 || (tail.length === 2 && tail[0] === "--format" && tail[1] === "json") ? "allowed" : "other";
		if (sub === "config") return tail.length === 1 && tail[0] === "show" ? "allowed" : "other";
		if (sub === "step") return tail.length === 2 && tail[0] === "prune" && tail[1] === "--dry-run" ? "allowed" : "other";
		return "other";
	}
	if (program === "git") {
		const args = afterGitGlobals(rest);
		if (args === null) return "other";
		const sub = args[0];
		if (sub === "rev-parse" || sub === "status" || sub === "fetch" || sub === "log") return "allowed";
		if (sub === "worktree") return args[1] === "list" ? "allowed" : "other";
		if (sub === "branch") return args[1] === "--list" ? "allowed" : "other";
		return "other";
	}
	if (program === "gh") return ghReadAllowed(rest) ? "allowed" : "other";
	if (stdinFilterAllowed(program, rest)) return "safe";
	return READ_ONLY_COMPANIONS[program] === true ? "safe" : "other";
}

/** True when every command is a permitted bootstrap/read companion and one is a bootstrap invocation. */
export function bootstrapAllowed(command: string): boolean {
	if (/\$\(|`/.test(command)) return false;
	const tokens = commandTokens(command);
	if (tokens === null) return false;
	let segment: string[] = [];
	let found = false;
	const finish = (): boolean => {
		if (segment.length === 0) return true;
		const kind = invocationKind(segment);
		segment = [];
		if (kind === "allowed") {
			found = true;
			return true;
		}
		return kind === "safe";
	};
	for (const token of tokens) {
		if (SHELL_SEPARATORS[token] === true) {
			if (!finish()) return false;
		} else segment.push(token);
	}
	return finish() && found;
}

/** True when the command creates a worktree, so the cached list is stale. */
export function createsWorktree(command: string): boolean {
	return /\bwt\s+(?:[^\n]*\s)?(?:switch|new)\b[^\n]*(?:--create|\s-c\b)|\bgit\s+(?:[^\n]*\s)?worktree\s+add\b/.test(
		command,
	);
}

/**
 * True when the command can change whether this directory is in a repository at
 * all, or which repository it belongs to, so every cached lookup is stale.
 *
 * A cached `no-repository` is a definite answer only until someone creates a
 * repository under the session cwd. An unknown is never cached, so a `git` that
 * comes back on PATH needs no invalidation — availability recovers by itself.
 */
export function changesRepositoryTopology(command: string): boolean {
	return /\bgit\s+(?:[^\n]*\s)?(?:init|clone)\b/.test(command);
}

/** The bash call's command string, whatever spelling the input uses. */
export function extractCommand(input: unknown): string {
	const record = asRecord(input);
	const command = record?.command;
	return typeof command === "string" ? command : "";
}

/** Every string in `input` that names a filesystem path on an unenumerated tool. */
export function scanPathArguments(input: unknown, depth = 0): string[] {
	if (depth > MAX_SCAN_DEPTH) return [];
	if (Array.isArray(input)) {
		return input.flatMap(entry => scanPathArguments(entry, depth + 1));
	}
	const record = asRecord(input);
	if (record === null) return [];
	const found: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === "string") {
			const normalized = normalizePathLikeInput(value);
			if (normalized.length === 0) continue;
			if (PATH_KEYS[key] === true || path.isAbsolute(normalized) || normalized.startsWith("~/")) {
				found.push(normalized);
			}
			continue;
		}
		if (PATH_KEYS[key] === true && Array.isArray(value)) {
			for (const entry of value) if (typeof entry === "string") found.push(entry);
			continue;
		}
		found.push(...scanPathArguments(value, depth + 1));
	}
	return found;
}

function canonicalAuthorization(input: unknown, effectiveCwd: string, canonical: string, authorize: (canonical: string) => boolean): boolean {
	const env = asRecord(input)?.env;
	const realCwd = realDeepest(effectiveCwd);
	const realCanonical = realDeepest(canonical);
	return realCwd !== null && realCanonical !== null && realCwd === realCanonical && env !== null && typeof env === "object" && !Array.isArray(env) && (env as Record<string, unknown>).DELIVERY_ALLOW_PRIMARY_CHECKOUT === "1" && authorize(canonical);
}

/**
 * The refusal this tool call earns, or `undefined` when it may run.
 *
 * The gate is inert only when git has confirmed the SESSION is in no repository:
 * there is then no project to protect and no worktree anyone could be asked to
 * occupy. An undetermined session topology is not that state and refuses.
 *
 * Once it applies, each target is judged against the repository that OWNS that
 * target, which need not be the session's: a worker dispatched into a second
 * repository works in a linked worktree of that repository, and its canonical
 * checkout deserves the same protection as this one's. A target inside no
 * repository at all — a scratch file under `/tmp` — belongs to no worktree and to
 * no canonical checkout, so there is nothing there to guard. Anything the gate
 * cannot classify refuses.
 */
export function decideWorktreeCall(
	toolName: string,
	input: unknown,
	sessionCwd: string,
	topology: GateTopology = defaultTopology(sessionCwd),
	authorizePrimary: (canonical: string) => boolean = trustedPrimaryPolicy,
): GateRefusal | undefined {
	if (READ_ONLY_TOOLS[toolName] === true || readsOnlyInThisMode(toolName, input)) return undefined;
	const session = topology.session;
	const uncertainty = session.uncertainty ?? null;
	if (uncertainty !== null) return { block: true, reason: topologyRefusal(uncertainty) };
	const canonical = session.canonical;
	if (canonical === null) return undefined;

	const refuseTarget = (target: string): GateRefusal | undefined => {
		const where = containment(target, topology);
		if (where.inside) return undefined;
		if (where.repository === null) return { block: true, reason: topologyRefusal(where.uncertainty) };
		// Outside every repository: no canonical checkout to protect and no worktree
		// to occupy, so scratch space stays writable.
		const owner = where.repository.canonical;
		if (owner === null) return undefined;
		return {
			block: true,
			// The physical target, so it is comparable with the realpath'd roots
			// beside it: `/tmp` vs `/private/tmp` otherwise reads as a bug.
			reason: containmentRefusal(realDeepest(target) ?? target, owner, where.repository.worktrees),
		};
	};
	const refuseAll = (raws: readonly string[]): GateRefusal | undefined => {
		for (const raw of raws) {
			const target = resolveTarget(raw, sessionCwd);
			if (target === null) continue;
			const refusal = refuseTarget(target);
			if (refusal) return refusal;
		}
		return undefined;
	};

	switch (toolName) {
		case "write": {
			const record = asRecord(input);
			if (record === null || typeof record.path !== "string") {
				return { block: true, reason: uncertaintyRefusal("this `write` call has no `path` string", canonical) };
			}
			const device = xdDeviceTool(record.path);
			if (device !== null) {
				// A device call carries the real arguments in `content`; classify it by
				// the device's own rule. A payload that is not JSON names no path and
				// the device rejects it before anything is written.
				if (typeof record.content !== "string") return undefined;
				let nested: unknown;
				try {
					nested = JSON.parse(record.content);
				} catch {
					return undefined;
				}
				return decideWorktreeCall(device, nested, sessionCwd, topology, authorizePrimary);
			}
			return refuseAll([record.path]);
		}
		case "edit": {
			const targets = editTargets(input);
			if (targets === null) {
				return {
					block: true,
					reason: uncertaintyRefusal("this `edit` payload names no parseable `[PATH#TAG]` target", canonical),
				};
			}
			return refuseAll(targets);
		}
		case "ast_edit": {
			const record = asRecord(input);
			const paths = record?.paths;
			if (!Array.isArray(paths) || paths.length === 0) {
				return { block: true, reason: uncertaintyRefusal("this `ast_edit` call names no `paths`", canonical) };
			}
			const bases: string[] = [];
			for (const entry of paths) {
				if (typeof entry !== "string") {
					return { block: true, reason: uncertaintyRefusal("an `ast_edit` path is not a string", canonical) };
				}
				bases.push(globBase(normalizePathLikeInput(entry)));
			}
			return refuseAll(bases);
		}
		case "bash": {
			const record = asRecord(input);
			const rawCwd = record?.cwd;
			const effective =
				typeof rawCwd === "string" && rawCwd.length > 0 ? resolveTarget(rawCwd, sessionCwd) : sessionCwd;
			if (effective === null) {
				return { block: true, reason: uncertaintyRefusal("this `bash` call's `cwd` does not resolve", canonical) };
			}
			const where = containment(effective, topology);
			if (where.inside) return undefined;
			if (where.repository === null) return { block: true, reason: topologyRefusal(where.uncertainty) };
			// A cwd outside every repository has no canonical checkout to protect, so
			// scratch directories stay usable.
			if (where.repository.canonical === null) return undefined;
			if (typeof rawCwd === "string" && rawCwd.length > 0 && canonicalAuthorization(input, effective, where.repository.canonical, authorizePrimary)) return undefined;
			const command = extractCommand(input);
			if (command.length === 0) {
				return { block: true, reason: uncertaintyRefusal("this `bash` call has no `command` string", canonical) };
			}
			// The bootstrap allowlist is what an agent runs before it has a worktree,
			// in whichever repository it is bootstrapping — the second repository of a
			// multi-repository run included.
			if (bootstrapAllowed(command)) return undefined;
			return { block: true, reason: bootstrapRefusal(command, effective) };
		}
		case "eval": {
			const record = asRecord(input);
			const rawCwd = record?.cwd;
			const effective =
				typeof rawCwd === "string" && rawCwd.length > 0 ? resolveTarget(rawCwd, sessionCwd) : sessionCwd;
			if (effective === null) {
				return { block: true, reason: uncertaintyRefusal("this `eval` call's `cwd` does not resolve", canonical) };
			}
			return refuseTarget(effective);
		}
		default: {
			const targets: string[] = [];
			for (const raw of scanPathArguments(input)) {
				const target = resolveTarget(raw, sessionCwd);
				if (target !== null) targets.push(target);
			}
			if (targets.length > 0) {
				for (const target of targets) {
					const refusal = refuseTarget(target);
					if (refusal) return refusal;
				}
				return undefined;
			}
			// No target named at all. A mutating tool whose path argument is optional
			// writes wherever it defaults, and OMP defaults it to the session cwd —
			// which for an agent that has not moved into its worktree is the canonical
			// checkout. `typescript_quality({mode:"fix"})` and `speckit_setup` are
			// exactly this shape, so allowing an empty target list is how the gate
			// stops guarding. Read-approved tools are exempt by name above; the ledger
			// family is exempt here, for the reason the allowlist already permits `bd`.
			if (LEDGER_TOOL.test(toolName)) return undefined;
			return refuseTarget(sessionCwd);
		}
	}
}

export default function worktreeGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		const sessionCwd = ctx?.cwd ?? process.cwd();
		// A topology-changing call is judged BEFORE it runs, so its answer describes
		// a repository that is about to stop being the truth. Caching that answer
		// pins a pre-`git init` "no repository" and leaves the gate inert for the
		// rest of the session, hence the clear on both sides of the decision.
		const topologyChange = event.toolName === "bash" && changesRepositoryTopology(extractCommand(event.input));
		if (topologyChange) resetTopologyCache();
		try {
			if (event.toolName === "bash" && !topologyChange && createsWorktree(extractCommand(event.input))) {
				invalidateWorktreeCache();
			}
			return decideWorktreeCall(event.toolName, event.input, sessionCwd);
		} catch (error) {
			// A thrown classification is an unknown, and an unknown refuses. Only a
			// confirmed non-repository session stands down here — confirmed against the
			// filesystem as well as the cache, since a repository may have appeared
			// under that directory since the answer was stored.
			if (READ_ONLY_TOOLS[event.toolName] === true || readsOnlyInThisMode(event.toolName, event.input)) {
				return undefined;
			}
			const cached = canonicalCache.get(sessionCwd);
			if (cached?.state === "no-repository" && repositoryMetadata(sessionCwd) === "absent") return undefined;
			return {
				block: true,
				reason: uncertaintyRefusal(
					`this call could not be classified (${error instanceof Error ? error.message : String(error)})`,
					cached?.state === "repository" ? cached.canonical : null,
				),
			};
		} finally {
			if (topologyChange) resetTopologyCache();
		}
	});
}
