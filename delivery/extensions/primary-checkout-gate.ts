import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { absoluteGitCwdTransition, extractCommand, findGitInvocations, hasUnsafeShellCwdOrGrouping, PRIMARY_INDEX_OPERATIONS, UNDECIDED_REASON, unreadableReason } from "./main-branch-gate.ts";
import { runGitProbe, steeringDirective, targetRepoAuthorizes, targetRepoCommonDir, targetRepoTrusts } from "./target-repo-steering.ts";

let worktreesDirOverride: string | undefined;


function resolveWorktreeBase(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	let path = trimmed;
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || path.startsWith("~\\")) path = homedir() + path.slice(1);
	return isAbsolute(path) ? resolve(path) : undefined;
}

/** Replace the configured worktree base for tests and host configuration. */
export function setWorktreesDir(path: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(path);
	return worktreesDirOverride;
}

function activeProfile(): string | undefined {
	const raw = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
	const profile = raw?.trim();
	if (!profile || profile === "default" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) return undefined;
	return profile;
}

/** Resolve the harness-owned worktree root without loading native OMP modules in child tests. */
export function getWorktreesDir(): string {
	const configured = resolveWorktreeBase(process.env.OMP_WORKTREE_DIR);
	if (configured) return configured;
	if (worktreesDirOverride) return worktreesDirOverride;
	const profile = activeProfile();
	const xdg = process.env.XDG_DATA_HOME;
	const dataRoot = xdg && (profile ? existsSync(join(xdg, "omp", "profiles", profile)) : existsSync(join(xdg, "omp")))
		? join(xdg, "omp")
		: join(homedir(), ".omp");
	return profile ? join(dataRoot, "profiles", profile, "wt") : join(dataRoot, "wt");
}

/**
 * Refuse edits and commits inside a repository's primary checkout.
 *
 * OMP redispatches repository work with `isolated: true` into standalone clones under its
 * configured isolation root. Agents use those clones instead of editing the checkout the human
 * keeps open. The primary checkout contains the human's branch, uncommitted work, and editor.
 *
 * Primary means: `git rev-parse --git-dir` and `--git-common-dir` name the same directory.
 * OMP-native isolated clones under the configured root can also report as primary to Git, so the
 * guard exempts them explicitly. Outside a repository nothing is gated.
 *
 * Fails open on purpose: when Git cannot answer (no Git, not a work tree, or spawn failure), a
 * guard that blocks what it cannot see is worse than the rule it enforces.
 * `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` is accepted only when the targeted repository itself
 * contains the exact affirmative steering directive. A bash-call override also grants later
 * `edit`/`write` calls in that same authorized primary checkout for the current session.
 * A commit from the primary checkout is separate: it requires command-local
 * `DELIVERY_ALLOW_MAIN_COMMIT=1` plus the trusted canonical-main directive; the primary
 * checkout env never authorizes a commit.
 * Index operations (`git add -- <files>`, `git restore --staged -- <files>`) are the only
 * repository mutations this gate reads. In a protected primary checkout they need the same two
 * factors as an `edit`: command-local `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` plus the committed
 * directive, on top of the unchanged origin anchor. They authorize no commit of their own.
 */

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };
const ALLOW_ENV = "DELIVERY_ALLOW_PRIMARY_CHECKOUT";
const MAIN_COMMIT_ENV = "DELIVERY_ALLOW_MAIN_COMMIT";

/** Internal URIs (`xd://…`, `artifact://…`, `memory://…`) are not filesystem paths. */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HASHLINE_HEADER = /^\s*\[([^#\r\n]+)#[0-9a-fA-F]{4}\]\s*$/;

/** Agent state that lives beside the code and is written by the harness, not by the human. */
const STATE_DIRS: Record<string, true> = { ".omp": true, ".beads": true };

export type GitRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string };

let injectedRun: GitRun | null = null;

/** Replace the `git rev-parse` seam. Pass `null` to restore it. */
export function setGitRunForTests(fn: GitRun | null): void {
	injectedRun = fn;
}

function defaultRun(argv: string[], cwd: string): { exitCode: number; stdout: string } {
	return runGitProbe(argv, cwd);
}

export type Checkout = { primary: boolean; topLevel: string };

/**
 * The checkout that contains `dir`, or `null` when git cannot say. `primary` is true when
 * the git dir and the common dir coincide. Reading the probe's own answer stays inside the
 * guard: a runner that returns a shape this gate did not ask for is git failing to say, not a
 * question to skip.
 *
 * The two answers can spell one directory differently. Git prints `--git-dir` with symlinks
 * already resolved and `--git-common-dir` relative to the directory the probe ran in, so a probe
 * directory carrying a symlinked component — `/var` and `/tmp` on macOS, or any repository reached
 * through a symlink — made them compare unequal: from `<symlink>/repo/sub`, `--git-dir` reads
 * `/private/var/…/repo/.git` while `../.git` resolved against the probe directory reads
 * `/var/…/repo/.git`. A subdirectory of a primary checkout then reported itself as a linked
 * worktree and every primary-checkout refusal was skipped for a call that named one, including
 * `git -C sub add -- file`. Unequal text is therefore re-asked of the filesystem, which is the
 * only thing that can say whether two paths are one directory. A path it cannot answer for stays
 * unequal, exactly as the text comparison left it.
 */
export function checkoutOf(dir: string): Checkout | null {
	const run = injectedRun ?? defaultRun;
	try {
		const result = run(["git", "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], dir);
		if (result.exitCode !== 0) return null;
		const [topLevel, gitDir, commonDir] = result.stdout.split("\n").map((line) => line.trim());
		if (!topLevel || !gitDir || !commonDir) return null;
		const gitDirPath = resolve(dir, gitDir);
		const commonDirPath = resolve(dir, commonDir);
		let primary = gitDirPath === commonDirPath;
		if (!primary)
			try {
				primary = realpathSync.native(gitDirPath) === realpathSync.native(commonDirPath);
			} catch {
				primary = false;
			}
		return { primary, topLevel: resolve(topLevel) };
	} catch {
		return null;
	}
}

/**
 * The tracked paths Git's index would expand one literal operand to, relative to `dir`, or `null`
 * when the index cannot be read. `--literal-pathspecs` keeps Git from reading the operand as a
 * pathspec pattern, and `-z` keeps unusual names verbatim. One entry equal to the operand is the
 * file the command names; anything else — several entries, or one entry below it — is a subtree.
 * A runner that answers with a shape this gate did not ask for is an unreadable index.
 */
function indexEntriesFor(path: string, dir: string, run: GitRun): string[] | null {
	try {
		const result = run(["git", "--literal-pathspecs", "ls-files", "-z", "--cached", "--", path], dir);
		if (result.exitCode !== 0) return null;
		return result.stdout.split("\0").filter((entry) => entry !== "");
	} catch {
		return null;
	}
}

/**
 * What the filesystem says about one path, without letting a failed question become an allow.
 * `throwIfNoEntry: false` covers only a missing entry: a segment under a file (`ENOTDIR`), a
 * symlink loop (`ELOOP`), a name the platform rejects, and a path the caller cannot search all
 * still throw, and a NUL byte is a `TypeError` before any syscall runs.
 */
type PathKind = "directory" | "file" | "absent" | "unreadable";

function pathKind(path: string): PathKind {
	try {
		const entry = statSync(path, { throwIfNoEntry: false });
		if (entry === undefined) return "absent";
		return entry.isDirectory() ? "directory" : "file";
	} catch {
		return "unreadable";
	}
}

/** The nearest existing ancestor of a path that may not exist yet (a `write` creates files). */
function existingDir(path: string): string {
	let cursor = path;
	while (pathKind(cursor) !== "directory") {
		const parent = dirname(cursor);
		if (parent === cursor) return cursor;
		cursor = parent;
	}
	return cursor;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

/** Section paths of a hashline `edit` payload; the headers are its only target list. */
export function hashlinePaths(payload: string): string[] {
	const out: string[] = [];
	for (const raw of payload.split("\n")) {
		const match = HASHLINE_HEADER.exec(raw.replace(/\r$/, ""));
		if (!match) continue;
		let path = (match[1] ?? "").trim();
		const first = path[0];
		if (path.length > 1 && (first === '"' || first === "'") && path.endsWith(first)) {
			path = path.slice(1, -1);
		}
		if (path) out.push(path);
	}
	return out;
}

export function editedPaths(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["path", "file_path", "_path"] as const) {
		const value = input[key];
		if (typeof value === "string" && value) out.push(value);
	}
	const paths = input.paths;
	if (Array.isArray(paths)) {
		for (const value of paths) if (typeof value === "string" && value) out.push(value);
	}
	for (const key of ["input", "_input"] as const) {
		const value = input[key];
		if (typeof value === "string" && value) out.push(...hashlinePaths(value));
	}
	return [...new Set(out)];
}

function inputEnvironment(input: Record<string, unknown>): NodeJS.ProcessEnv | undefined {
	const value = input.env;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const env: NodeJS.ProcessEnv = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") env[key] = entry;
	}
	return env;
}

type PrimaryGrant = { directive: typeof ALLOW_ENV; commonDir: string };
type AuthorizedPrimaryCheckouts = Map<string, PrimaryGrant>;

function isStatePath(absolute: string, topLevel: string): boolean {
	const relative = absolute.slice(topLevel.length + 1);
	const head = relative.split("/")[0] ?? "";
	return STATE_DIRS[head] === true;
}

export function reasonFor(topLevel: string, what: string): string {
	const authorization =
		what === "This commit"
			? `For a commit, put ${MAIN_COMMIT_ENV}=1 in the command's structured env only when this repository contains ` +
			  `the exact line \`${steeringDirective(MAIN_COMMIT_ENV)}\` and the user authorized the exception.`
		: what === "This repository mutation"
			? "Checkout, switch, merge, and local ref or worktree mutations (`git branch -D`, `git worktree remove`, " +
			  "a `git fetch` refspec, a `git symbolic-ref` write) cannot target a primary checkout; push remains " +
			  "governed by the push router and pre-push gates."
				: `Set ${ALLOW_ENV}=1 only when this repository contains the exact line ` +
				  `\`${steeringDirective(ALLOW_ENV)}\` and the user authorized the exception. ` +
				  `For a follow-up edit/write, put that flag in a bash call's \`env\` while its cwd is ` +
				  `this checkout; the session grant is limited to this repository.`;
	return `${what} is inside the primary checkout of ${topLevel}. Redispatch repository work with ` +
		`\`isolated: true\` so OMP places the change in its configured isolation root. ` +
		`Make the change in that isolated clone. ${authorization}`;
}

function revokeStaleGrants(grants: Map<string, PrimaryGrant> | undefined, run: GitRun, scope: string): void {
	if (grants === undefined) return;
	for (const [topLevel, grant] of grants) {
		try {
			const commonDir = targetRepoCommonDir(topLevel, run);
			if (commonDir === null || commonDir !== grant.commonDir || !targetRepoAuthorizes(topLevel, grant.directive, run, scope)) grants.delete(topLevel);
		} catch {
			grants.delete(topLevel);
		}
	}
}

/**
 * `absolute` with its EXISTING prefix resolved through symlinks and its not-yet-existing tail
 * appended unchanged (a `write` creates files, and may create several segments at once), or `null`
 * when the filesystem cannot answer for that prefix.
 */
function canonicalPath(absolute: string): string | null {
	const existing = existingDir(absolute);
	try {
		const real = realpathSync.native(existing);
		return existing === absolute ? real : join(real, relative(existing, absolute));
	} catch {
		return null;
	}
}

/** Runtime-created isolated roots are harness-owned even though Git sees them as primary. */
export function isRuntimeCheckout(topLevel: string, worktreesDir = getWorktreesDir()): boolean {
	const root = resolve(worktreesDir);
	const clone = resolve(topLevel);
	// Compared BOTH as given and through symlinks. One directory has several spellings — a `/var/…`
	// harness root against the `/private/var/…` top level Git reports for the same clone on macOS,
	// or either reached through a symlink — and a runtime clone that failed this test was treated as
	// a human's primary checkout and refused, so the harness could not write in its own isolation.
	for (const [parent, child] of [
		[root, clone],
		[canonicalPath(root), canonicalPath(clone)],
	] as const) {
		if (parent === null || child === null) continue;
		const path = relative(parent, child);
		if (path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return true;
	}
	return false;
}

export function decidePath(
	path: string,
	cwd: string,
	worktreesDir = getWorktreesDir(),
	authorizedPrimaryCheckouts?: AuthorizedPrimaryCheckouts,
): { block: true; reason: string } | undefined {
	if (NON_FILE_SCHEME.test(path)) return undefined;
	const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, expandHome(path));
	const checkout = checkoutOf(existingDir(absolute));
	if (!checkout?.primary || isRuntimeCheckout(checkout.topLevel, worktreesDir)) return undefined;
	// Compared through CANONICAL spellings on BOTH sides. Git reports a top level as a REAL path, so
	// a symlinked spelling of a file inside the checkout failed a raw prefix test and slipped an edit
	// or write past this gate while the canonical spelling of the same file was refused.
	// Canonicalizing one side only moves the mismatch: on macOS a `/var/…` tmpdir realpaths to
	// `/private/var/…`, so a canonical target compared against a raw top level stops matching its
	// own checkout.
	const canonicalAbsolute = canonicalPath(absolute);
	const canonicalTopLevel = canonicalPath(checkout.topLevel);
	// The checkout is already known to be a protected primary one, so a path this gate cannot
	// canonicalize is refused rather than allowed: an unreadable spelling must not be the way past it.
	if (canonicalAbsolute === null || canonicalTopLevel === null) return { block: true, reason: reasonFor(checkout.topLevel, `\`${path}\``) };
	const canonicallyInside = canonicalAbsolute.startsWith(`${canonicalTopLevel}/`);
	if (!absolute.startsWith(`${checkout.topLevel}/`) && !canonicallyInside) return undefined;
	if (authorizedPrimaryCheckouts?.has(checkout.topLevel)) return undefined;
	// State is identified by where the write LANDS, never by how it is spelled. A `.omp` or `.beads`
	// entry that is a symlink out into the source tree is not agent state: the lexical head read
	// `.omp` while the write reached a tracked file, so the exemption is measured canonically.
	if (canonicallyInside && isStatePath(canonicalAbsolute, canonicalTopLevel)) return undefined;
	return { block: true, reason: reasonFor(checkout.topLevel, `\`${path}\``) };
}

export function decideEdit(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	worktreesDir = getWorktreesDir(),
	authorizedPrimaryCheckouts?: AuthorizedPrimaryCheckouts,
	scope: string = "default",
): { block: true; reason: string } | undefined {
	if (EDIT_TOOLS[toolName] !== true) return undefined;
	const run = injectedRun ?? defaultRun;
	revokeStaleGrants(authorizedPrimaryCheckouts, run, scope);
	for (const path of editedPaths(input)) {
		const decision = decidePath(path, cwd, worktreesDir, authorizedPrimaryCheckouts);
		if (!decision) continue;
		const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, expandHome(path));
		const checkout = checkoutOf(existingDir(absolute));
		if (
			env[ALLOW_ENV] === "1" &&
			checkout?.primary === true &&
			!isRuntimeCheckout(checkout.topLevel, worktreesDir) &&
			targetRepoAuthorizes(checkout.topLevel, ALLOW_ENV, run, scope)
		)
			continue;
		return decision;
	}
	return undefined;
}
export function decideCommit(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	worktreesDir = getWorktreesDir(),
	authorizationEnv: NodeJS.ProcessEnv = env,
	scope: string = "default",
): { block: true; reason: string } | undefined {
	const run = injectedRun ?? defaultRun;
	if (hasUnsafeShellCwdOrGrouping(command)) return { block: true, reason: unreadableReason("shell cwd mutation or grouping") };
	const invocations = findGitInvocations(command, env);
	const transitionedCwd = absoluteGitCwdTransition(command);
	// The shell runs `cd /human && /abs/git -C . add -- f` with its cwd already moved, so BOTH the
	// absent `-C` and a relative one name the directory the `cd` reached, not the caller's. Filling
	// in only the absent case left `-C .` resolving against this checkout, and an index operation
	// aimed at a human's primary checkout read as one aimed at the harness's own isolated clone.
	if (transitionedCwd !== undefined) {
		for (const invocation of invocations) {
			invocation.repoDir = invocation.repoDir === null ? transitionedCwd : resolve(transitionedCwd, invocation.repoDir);
		}
	}
	for (const invocation of invocations) {
		if (invocation.operation === "opaque" || invocation.retargeted === true)
			return { block: true, reason: unreadableReason("an opaque Git invocation") };
		const target = invocation.repoDir === null ? cwd : resolve(cwd, invocation.repoDir);
		const checkout = checkoutOf(target);
		if (checkout?.primary && !isRuntimeCheckout(checkout.topLevel, worktreesDir) && invocation.operation === "push" && !targetRepoTrusts(checkout.topLevel, run, scope))
			return { block: true, reason: unreadableReason("unpinned repository origin") };
		if (invocation.operation === "push" || invocation.operation === "read") continue;
		if (PRIMARY_INDEX_OPERATIONS[invocation.operation] === true) {
			// Git resolves a pathspec against the command's own directory, the same base this gate
			// resolved. A directory operand stages or unstages a whole subtree the command never
			// names, so it is not the readable file list this gate accepted. A path that is absent
			// from the worktree is not automatically one file either: a tracked directory whose
			// copy is gone, or a file that replaced one, still expands to every index entry
			// beneath it, so the index decides what each operand really covers. An operand the
			// filesystem refuses to answer for is not a readable file list either, so it is
			// refused instead of skipped.
			for (const path of invocation.paths ?? []) {
				const kind = pathKind(resolve(target, path));
				if (kind === "unreadable") return { block: true, reason: unreadableReason("an operand this gate cannot inspect") };
				if (kind === "directory") return { block: true, reason: unreadableReason("a directory operand") };
				const tracked = indexEntriesFor(path, target, run);
				if (tracked === null) return { block: true, reason: unreadableReason("an unreadable index") };
				if (tracked.length > 1 || (tracked.length === 1 && tracked[0] !== path))
					return { block: true, reason: unreadableReason("a tracked subtree operand") };
				if (tracked.length === 0 && kind === "absent") return { block: true, reason: unreadableReason("an operand no file or index entry matches") };
			}
			// An index mutation is a protected action, so it stays pinned: reads are advisory
			// without an anchor, but staging into an unpinned primary checkout is not.
			if (!checkout?.primary || isRuntimeCheckout(checkout.topLevel, worktreesDir)) continue;
			if (!targetRepoTrusts(checkout.topLevel, run, scope)) return { block: true, reason: unreadableReason("unpinned repository origin") };
			if (authorizationEnv[ALLOW_ENV] === "1" && targetRepoAuthorizes(checkout.topLevel, ALLOW_ENV, run, scope)) continue;
			return { block: true, reason: reasonFor(checkout.topLevel, "This index mutation") };
		}
		if (invocation.dryRun === true) continue;
		if (invocation.operation === "checkout" || invocation.operation === "switch" || invocation.operation === "merge" || invocation.operation === "ref-mutation") {
			if (checkout?.primary && !isRuntimeCheckout(checkout.topLevel, worktreesDir))
				return { block: true, reason: reasonFor(checkout.topLevel, "This repository mutation") };
			continue;
		}
		if (invocation.operation !== "commit" || !checkout?.primary || isRuntimeCheckout(checkout.topLevel, worktreesDir)) continue;
		if (authorizationEnv[MAIN_COMMIT_ENV] === "1" && targetRepoAuthorizes(checkout.topLevel, MAIN_COMMIT_ENV, run, scope)) continue;
		return { block: true, reason: reasonFor(checkout.topLevel, "This commit") };
	}
	return undefined;
}
type SessionContext = { sessionManager?: { getSessionId?: () => string } };
function sessionKey(ctx: SessionContext | undefined): string {
	return ctx?.sessionManager?.getSessionId?.() ?? "default";
}

export default function primaryCheckoutGate(pi: ExtensionAPI): void {
	const authorizations = new Map<string, Map<string, PrimaryGrant>>();
	const grantsFor = (ctx: SessionContext | undefined): Map<string, PrimaryGrant> => {
		const key = sessionKey(ctx);
		let grants = authorizations.get(key);
		if (grants === undefined) {
			grants = new Map<string, PrimaryGrant>();
			authorizations.set(key, grants);
		}
		return grants;
	};
	pi.on("session_start", (_event, ctx) => {
		authorizations.delete(sessionKey(ctx));
	});
	pi.on("session_shutdown", (_event, ctx) => {
		authorizations.delete(sessionKey(ctx));
	});
	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		try {
			// Read ONCE, and inside the guard. A property that throws on first access cannot be
			// treated as a pass-through, and a stateful one that answers `write` and then `read`
			// must not launder a governed call into an ungoverned one.
			const toolName = event.toolName;
			// A tool this gate never governs stays a pass-through, and no input, filesystem, or Git
			// question is asked about it. For the tools it does govern, a question that cannot be
			// answered is a refusal: an error raised while classifying the call once meant "no
			// decision", which the harness reads as an allow, so one malformed operand laundered
			// every later verb in the same command.
			if (toolName !== "bash" && EDIT_TOOLS[toolName] !== true) return;
			const input = event.input as Record<string, unknown>;
			const base = ctx?.cwd ?? process.cwd();
			const cwd = typeof input.cwd === "string" && input.cwd ? resolve(base, input.cwd) : base;
			const inputEnv = inputEnvironment(input);
			const env = inputEnv ? { ...process.env, ...inputEnv } : process.env;
			const worktreesDir = getWorktreesDir();
			const authorizedPrimaryCheckouts = grantsFor(ctx);
			if (toolName === "bash") {
				if (inputEnv?.[ALLOW_ENV] === "1") {
					const checkout = checkoutOf(cwd);
					const run = injectedRun ?? defaultRun;
					const commonDir = checkout?.primary === true ? targetRepoCommonDir(checkout.topLevel, run) : null;
					if (
						checkout?.primary &&
						!isRuntimeCheckout(checkout.topLevel, worktreesDir) &&
						commonDir !== null &&
						targetRepoAuthorizes(checkout.topLevel, ALLOW_ENV, run, sessionKey(ctx))
					)
						authorizedPrimaryCheckouts.set(checkout.topLevel, { directive: ALLOW_ENV, commonDir });
				}
				const command = extractCommand(event.input);
				if (!command) return;
				return decideCommit(command, cwd, env, worktreesDir, inputEnv ?? {}, sessionKey(ctx));
			}
			return decideEdit(toolName, input, cwd, env, worktreesDir, authorizedPrimaryCheckouts, sessionKey(ctx));
		} catch {
			return { block: true, reason: UNDECIDED_REASON };
		}
	});
}
