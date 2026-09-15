import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { extractCommand, findGitInvocations, unreadableReason } from "./main-branch-gate.ts";
import { steeringDirective, targetRepoAuthorizes } from "./target-repo-steering.ts";

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
 */

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };
const ALLOW_ENV = "DELIVERY_ALLOW_PRIMARY_CHECKOUT";
const MAIN_COMMIT_ENV = "DELIVERY_ALLOW_MAIN_COMMIT";
const TIMEOUT_MS = 2000;

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
	const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

export type Checkout = { primary: boolean; topLevel: string };

/**
 * The checkout that contains `dir`, or `null` when git cannot say. `primary` is true when
 * the git dir and the common dir coincide.
 */
export function checkoutOf(dir: string): Checkout | null {
	const run = injectedRun ?? defaultRun;
	let result: { exitCode: number; stdout: string };
	try {
		result = run(["git", "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], dir);
	} catch {
		return null;
	}
	if (result.exitCode !== 0) return null;
	const [topLevel, gitDir, commonDir] = result.stdout.split("\n").map((line) => line.trim());
	if (!topLevel || !gitDir || !commonDir) return null;
	const primary = resolve(dir, gitDir) === resolve(dir, commonDir);
	return { primary, topLevel: resolve(topLevel) };
}

/** The nearest existing ancestor of a path that may not exist yet (a `write` creates files). */
function existingDir(path: string): string {
	let cursor = path;
	while (!existsSync(cursor) || !statSync(cursor).isDirectory()) {
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

type AuthorizedPrimaryCheckouts = ReadonlySet<string>;

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
				? "Checkout, switch, and merge cannot target a primary checkout; push remains governed by the push router and pre-push gates."
				: `Set ${ALLOW_ENV}=1 only when this repository contains the exact line ` +
				  `\`${steeringDirective(ALLOW_ENV)}\` and the user authorized the exception. ` +
				  `For a follow-up edit/write, put that flag in a bash call's \`env\` while its cwd is ` +
				  `this checkout; the session grant is limited to this repository.`;
	return `${what} is inside the primary checkout of ${topLevel}. Redispatch repository work with ` +
		`\`isolated: true\` so OMP places the change in its configured isolation root. ` +
		`Make the change in that isolated clone. ${authorization}`;
}

/** Runtime-created isolated roots are harness-owned even though Git sees them as primary. */
export function isRuntimeCheckout(topLevel: string, worktreesDir = getWorktreesDir()): boolean {
	const path = relative(resolve(worktreesDir), resolve(topLevel));
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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
	if (!absolute.startsWith(`${checkout.topLevel}/`)) return undefined;
	if (authorizedPrimaryCheckouts?.has(checkout.topLevel)) return undefined;
	if (isStatePath(absolute, checkout.topLevel)) return undefined;
	return { block: true, reason: reasonFor(checkout.topLevel, `\`${path}\``) };
}

export function decideEdit(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	worktreesDir = getWorktreesDir(),
	authorizedPrimaryCheckouts?: AuthorizedPrimaryCheckouts,
): { block: true; reason: string } | undefined {
	if (EDIT_TOOLS[toolName] !== true) return undefined;
	const run = injectedRun ?? defaultRun;
	for (const path of editedPaths(input)) {
		const decision = decidePath(path, cwd, worktreesDir, authorizedPrimaryCheckouts);
		if (!decision) continue;
		const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, expandHome(path));
		const checkout = checkoutOf(existingDir(absolute));
		if (
			env[ALLOW_ENV] === "1" &&
			checkout?.primary === true &&
			!isRuntimeCheckout(checkout.topLevel, worktreesDir) &&
			targetRepoAuthorizes(checkout.topLevel, ALLOW_ENV, run)
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
): { block: true; reason: string } | undefined {
	const run = injectedRun ?? defaultRun;
	for (const invocation of findGitInvocations(command, env)) {
		if (invocation.operation === "opaque" || invocation.retargeted === true)
			return { block: true, reason: unreadableReason("an opaque Git invocation") };
		if (invocation.operation === "push" || invocation.operation === "read" || invocation.dryRun === true) continue;
		const target = invocation.repoDir === null ? cwd : resolve(cwd, invocation.repoDir);
		const checkout = checkoutOf(target);
		if (invocation.operation === "checkout" || invocation.operation === "switch" || invocation.operation === "merge") {
			if (checkout?.primary && !isRuntimeCheckout(checkout.topLevel, worktreesDir))
				return { block: true, reason: reasonFor(checkout.topLevel, "This repository mutation") };
			continue;
		}
		if (invocation.operation !== "commit" || !checkout?.primary || isRuntimeCheckout(checkout.topLevel, worktreesDir)) continue;
		if (authorizationEnv[MAIN_COMMIT_ENV] === "1" && targetRepoAuthorizes(checkout.topLevel, MAIN_COMMIT_ENV, run)) continue;
		return { block: true, reason: reasonFor(checkout.topLevel, "This commit") };
	}
	return undefined;
}
type SessionContext = { sessionManager?: { getSessionId?: () => string } };

function sessionKey(ctx: SessionContext | undefined): string {
	return ctx?.sessionManager?.getSessionId?.() ?? "default";
}

export default function primaryCheckoutGate(pi: ExtensionAPI): void {
	const authorizations = new Map<string, Set<string>>();
	const grantsFor = (ctx: SessionContext | undefined): Set<string> => {
		const key = sessionKey(ctx);
		let grants = authorizations.get(key);
		if (grants === undefined) {
			grants = new Set<string>();
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
			const input = event.input as Record<string, unknown>;
			const base = ctx?.cwd ?? process.cwd();
			const cwd = typeof input.cwd === "string" && input.cwd ? resolve(base, input.cwd) : base;
			const inputEnv = inputEnvironment(input);
			const env = inputEnv ? { ...process.env, ...inputEnv } : process.env;
			const worktreesDir = getWorktreesDir();
			const authorizedPrimaryCheckouts = grantsFor(ctx);
			if (event.toolName === "bash") {
				if (inputEnv?.[ALLOW_ENV] === "1") {
					const checkout = checkoutOf(cwd);
					if (
						checkout?.primary &&
						!isRuntimeCheckout(checkout.topLevel, worktreesDir) &&
						targetRepoAuthorizes(checkout.topLevel, ALLOW_ENV, injectedRun ?? defaultRun)
					)
						authorizedPrimaryCheckouts.add(checkout.topLevel);
				}
				const command = extractCommand(event.input);
				if (!command) return;
				return decideCommit(command, cwd, env, worktreesDir, inputEnv ?? {});
			}
			if (EDIT_TOOLS[event.toolName] === true) {
				return decideEdit(event.toolName, input, cwd, env, worktreesDir, authorizedPrimaryCheckouts);
			}
			return;
		} catch {
			return;
		}
	});
}
