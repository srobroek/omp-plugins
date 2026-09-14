import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { getWorktreesDir as upstreamGetWorktreesDir } from "@oh-my-pi/pi-utils";

import { extractCommand, findCommitInvocations } from "./main-branch-gate.ts";

/**
 * Refuse edits and commits inside a repository's primary checkout.
 *
 * An agent works in a Worktrunk worktree of the project (`wt switch --create`), never in
 * the checkout the human keeps open. That is true whether or not the run is orchestrated:
 * the primary checkout is where the human's branch, uncommitted work, and editor live, and
 * two actors in one tree lose work in ways neither can see.
 *
 * Primary means: `git rev-parse --git-dir` and `--git-common-dir` name the same directory.
 * A linked worktree (Worktrunk or `git worktree add`) has its own `.git` file pointing at
 * `<common>/worktrees/<name>`, so the two differ. Outside a repository nothing is gated.
 *
 * Fails open on purpose: when git cannot answer (no git, not a work tree, spawn failure),
 * a guard that blocks what it cannot see is worse than the rule it enforces.
 *
 * `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` in the ENVIRONMENT (session or bash-call `env`) is the
 * sanctioned override for the case where the user asked for the primary checkout. A bash-call
 * override also grants later `edit`/`write` calls in that same primary checkout for this session,
 * because those tool schemas have no `env` field.
 */

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };
const ALLOW_ENV = "DELIVERY_ALLOW_PRIMARY_CHECKOUT";
const TIMEOUT_MS = 2000;

/** Internal URIs (`xd://…`, `artifact://…`, `memory://…`) are not filesystem paths. */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HASHLINE_HEADER = /^\s*\[([^#\r\n]+)#[0-9a-fA-F]{4}\]\s*$/;

/** Agent state that lives beside the code and is written by the harness, not by the human. */
const STATE_DIRS: Record<string, true> = { ".omp": true, ".beads": true };

/** Resolve the harness-owned worktree root using the host's configured path semantics. */
export function getWorktreesDir(): string {
	return upstreamGetWorktreesDir();
}


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
	return (
		`${what} is inside the primary checkout of ${topLevel}. Agents work in a Worktrunk ` +
		`worktree of the project: run \`wt switch --create <branch> --base origin/main --no-cd ` +
		`--format json\` (in that repository) and make the change there. Set ` +
		`${ALLOW_ENV}=1 in the environment only when the user asked for the primary checkout. ` +
		`For a follow-up edit/write, put that flag in a bash call's \`env\` while its cwd is ` +
		`this checkout; that session grant is limited to this repository.`
	);
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
	if (env[ALLOW_ENV] === "1") return undefined;
	for (const path of editedPaths(input)) {
		const decision = decidePath(path, cwd, worktreesDir, authorizedPrimaryCheckouts);
		if (decision) return decision;
	}
	return undefined;
}

export function decideCommit(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	worktreesDir = getWorktreesDir(),
): { block: true; reason: string } | undefined {
	if (env[ALLOW_ENV] === "1") return undefined;
	for (const invocation of findCommitInvocations(command, false)) {
		if (invocation.dryRun || invocation.retargeted) continue;
		const target = invocation.repoDir === null ? cwd : resolve(cwd, invocation.repoDir);
		const checkout = checkoutOf(target);
		if (!checkout?.primary || isRuntimeCheckout(checkout.topLevel, worktreesDir)) continue;
		return { block: true, reason: reasonFor(checkout.topLevel, "This commit") };
	}
	return undefined;
}

/** Bash-call environment grants are session-scoped and keyed by canonical primary checkout roots. */
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
					if (checkout?.primary && !isRuntimeCheckout(checkout.topLevel, worktreesDir)) {
						authorizedPrimaryCheckouts.add(checkout.topLevel);
					}
				}
				const command = extractCommand(event.input);
				if (!command) return;
				return decideCommit(command, cwd, env, worktreesDir);
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
