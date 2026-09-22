/**
 * Collect the worktrees of closed agent beads, once per session, in any session.
 *
 * Every agent's work happens in an `omp/agent/<bead-id>` linked worktree, and the party that
 * closes the bead is supposed to reclaim the tree. A session that dies between the close and the
 * reclaim leaves the tree registered forever, and nothing else collects it. This sweep does — and
 * it lives here, in `worktrunk`, rather than in an orchestration plugin, because the subject and
 * the action are both worktrees: a checkout accumulates these leftovers whether or not anything
 * is orchestrating it.
 *
 * What keeps it from destroying work, in the order the questions arise:
 *
 *   1. It addresses only linked worktrees whose branch is `omp/agent/<bead-id>` and which sit
 *      outside the canonical checkout. A human's `feature/...` tree is never named to `wt`.
 *   2. It removes only a tree whose bead the ledger reports `closed`, and the ledger read goes
 *      through an environment that drops an inherited `BEADS_DIR`: that pin outranks every other
 *      branch of bd's store discovery, so another project's database could otherwise report a
 *      bead closed that is open here, and the sweep would take a live tree.
 *   3. A closed bead is not an unused tree. Review happens after delivery and reads the delivered
 *      worktree to cite `path:line`, which is exactly the window in which a close-triggered sweep
 *      would take it, so a closed bead's tree is left alone for `GRACE_WINDOW_MS` after
 *      `closed_at`.
 *   4. An absent or unparseable `closed_at` counts as *inside* the window. The failures are
 *      asymmetric: removing a wanted tree is real loss, keeping one too long costs a line of
 *      notice. bd reports `closed_at`, so this is an anomaly path, not the normal one.
 *   5. `git worktree lock` is the mechanism for keeping a tree for longer than the window, and it
 *      works against this sweep by construction: a locked tree makes `git worktree remove` answer
 *      "fatal: cannot remove a locked working tree" and `wt remove -y` answer "Cannot remove <x>,
 *      worktree is locked". That only holds while removal carries no force flag, so removal is
 *      `wt remove -y --foreground <branch>` with neither `-f` nor `-D`, and every message about a
 *      tree that was kept names the lock, because that is the moment a reader needs to learn it.
 *   6. It is silent unless something was actually removed or actually kept. A stand-down — no
 *      candidates, an unreadable `git worktree list`, a cwd in no repository — says nothing at
 *      all: a fresh `omp -p` session has exactly one assistant turn, and a notice spends it
 *      reacting to housekeeping instead of the prompt.
 *
 * Three races are handled explicitly, because each one has a way to destroy the wrong tree:
 *
 *   - The listing is read with `-z`, so a record boundary is a fact of the stream rather than a
 *     guess about which bytes in a path might be a line break.
 *   - The bead status is re-read immediately before the removal. A review verdict can reopen a
 *     bead between the batched triage read and the removal, and a successor takes the same
 *     deterministic branch name, so the tree under that branch may no longer be the finished one.
 *   - The listing is re-read immediately before the removal too, because `wt remove` addresses a
 *     worktree *by branch*: a branch that has moved to another path would send the removal at a
 *     tree the sweep never judged.
 *
 * And `wt step prune` is never run: prune is repository-wide, and a checkout holds trees that
 * belong to other parties. Its dry run is used as a *precondition* — when it names anything at
 * all, some other tree is already due for collection, and this sweep stands down rather than
 * racing whoever is about to do that.
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@oh-my-pi/pi-coding-agent";

import { insideAny, type RepositoryTopology, realDeepest, repositoryTopology } from "./worktree-gate.ts";

/** Every probe must finish well inside the session-start budget. */
export const PROBE_TIMEOUT_MS = 5_000;
/** A removal deletes a directory and a branch, so it gets more room than a probe. */
export const REMOVE_TIMEOUT_MS = 15_000;
/** One `bd show` against an embedded store, which is slower than any git probe. */
export const LEDGER_TIMEOUT_MS = 10_000;
/** The sweep's whole share of session start. Past it, the loop stops where it is. */
export const SWEEP_BUDGET_MS = 25_000;
/** How long a closed bead's worktree is left alone, counted from `closed_at`. */
export const GRACE_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** The argv every worktree read uses. `-z` is load-bearing; see this module's header. */
export const WORKTREE_LIST_ARGV: readonly string[] = ["git", "worktree", "list", "--porcelain", "-z"];

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs one argv and waits. Injected so tests drive the sweep without a repository. */
export type CommandRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandResult>;

/**
 * Environment for `git` and `wt`. Only the repository-selection variables are dropped: an
 * inherited `GIT_DIR` or `GIT_WORK_TREE` would make `git worktree list` answer for a different
 * repository than the one being swept. Everything else is left alone, because `wt` is a user
 * tool and reads the user's configuration.
 */
function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
		delete env[key];
	}
	// A credential prompt inside a session-start handler would hang the session, not ask anyone.
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

/** Spawn one argv under a bound. A failure to spawn is a result, never a throw. */
async function spawnProcess(argv: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<CommandResult> {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
	} catch {
		return { code: 127, stdout: "", stderr: `${argv[0]} is not installed or not executable in ${cwd}` };
	}
	const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
		([stdout, stderr, code]) => ({ code, stdout, stderr }),
	);
	const timeout = new Promise<CommandResult>(resolve => {
		const timer = setTimeout(() => {
			proc.kill();
			resolve({ code: 124, stdout: "", stderr: `${argv[0]} timed out after ${timeoutMs}ms in ${cwd}` });
		}, timeoutMs);
		void finished.finally(() => clearTimeout(timer));
	});
	return Promise.race([finished, timeout]);
}

export const spawnCommand: CommandRunner = (argv, cwd, timeoutMs) => spawnProcess(argv, cwd, timeoutMs, gitEnvironment());

/** One `git worktree list --porcelain -z` record: `branch` is `null` when detached or bare. */
export interface WorktreeEntry {
	path: string;
	branch: string | null;
}

/**
 * Every worktree the listing reports, canonical included, in order, each with the branch of *its
 * own* record. Path and branch are never read apart: a sweep that matched them across two records
 * would judge one tree and remove another.
 *
 * `-z` terminates every attribute with a NUL and closes each record with an empty attribute, so a
 * record boundary is a fact of the stream. An attribute that arrives outside a record is dropped
 * rather than attributed to the record before it.
 */
export function parseWorktreeEntries(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const attribute of stdout.split("\0")) {
		if (attribute.length === 0) {
			current = undefined;
			continue;
		}
		if (attribute.startsWith("worktree ")) {
			const value = attribute.slice("worktree ".length);
			current = value.length === 0 ? undefined : { path: value, branch: null };
			if (current !== undefined) entries.push(current);
			continue;
		}
		if (current === undefined || current.branch !== null || !attribute.startsWith("branch ")) continue;
		const ref = attribute.slice("branch ".length);
		const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		if (branch.length > 0) current.branch = branch;
	}
	return entries;
}

/** The bead an `omp/agent/<bead>` branch names, or `null` for any other branch. */
export function agentBeadOf(branch: string): string | null {
	const match = /^omp\/agent\/(?<bead>[^\s/]+(?:\/[^\s/]+)*)$/u.exec(branch);
	return match?.groups?.bead ?? null;
}

/**
 * How the sweep learns which checkout it is in. The gate's resolver is identity-checked and
 * cached, and it is what this package already judges containment with, so a sweep and a gate
 * cannot disagree about what canonical is.
 */
export type TopologyReader = (cwd: string) => RepositoryTopology;

/** What the ledger says about one candidate's bead. `closedAt` is bd's raw `closed_at`. */
export interface LedgerBead {
	status: string;
	closedAt: string | undefined;
}

/**
 * How the sweep reads its candidates' beads. Injected so tests drive the sweep without a store,
 * and deliberately *not* the runner that drives `git` and `wt`: the store this read resolves
 * decides whether a worktree is deleted, so it must be this checkout's store and no other.
 */
export type LedgerReader = (beads: readonly string[], canonical: string) => Promise<ReadonlyMap<string, LedgerBead>>;

/**
 * Environment for the ledger read. An inherited `BEADS_DIR` is dropped and replaced by this
 * checkout's own store when it has one: the pin is the highest-priority branch of bd's discovery,
 * so a session launched with another project's pin would otherwise answer for another project's
 * beads — where an id that is open here may be closed — and this sweep would remove a live tree.
 * An inherited shared-server override goes the same way, and auto-start stays off: a session-start
 * handler must never bring a database server up.
 */
export function sweepBdEnvironment(canonical: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	delete env.BEADS_DIR;
	delete env.BEADS_DOLT_SHARED_SERVER;
	const store = path.join(canonical, ".beads");
	try {
		if (statSync(store).isDirectory()) env.BEADS_DIR = store;
	} catch {
		// No store here: bd's own discovery decides, from this checkout's cwd rather than a pin.
	}
	env.BD_NO_PAGER = "1";
	env.BD_NON_INTERACTIVE = "1";
	env.BD_DOLT_AUTO_START = "false";
	env.NO_COLOR = "1";
	return env;
}

/** Rows out of a `bd --json` payload, whether bd wrapped it in an envelope or not. */
function beadRows(stdout: string): Record<string, unknown>[] {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Warning text may precede the payload, so a complete final line is also accepted. A
		// JSON-looking substring anywhere else is not: a truncated read must fail, not half-parse.
		const lines = trimmed.split("\n");
		const last = lines[lines.length - 1]?.trim() ?? "";
		try {
			parsed = JSON.parse(last);
		} catch {
			return [];
		}
	}
	const unwrapped =
		parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed
			? (parsed as { data: unknown }).data
			: parsed;
	const rows = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
	return rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row));
}

/**
 * The real reader. One `bd show` takes every id: a session start holds a handler budget, and a
 * read per candidate costs seconds each against an embedded store. `show` is a read verb, the
 * same classification this package's bash gate applies to `bd` (see `worktree-gate.ts`), so this
 * handler writes nothing to the ledger.
 *
 * bd reports an id it does not know on stdout without failing, so an absent or unreadable bead is
 * simply missing from the map — and a candidate with no status keeps its tree.
 */
export const bdLedgerReader: LedgerReader = async (beads, canonical) => {
	const statuses = new Map<string, LedgerBead>();
	if (beads.length === 0) return statuses;
	const result = await spawnProcess(["bd", "show", ...beads, "--json"], canonical, LEDGER_TIMEOUT_MS, sweepBdEnvironment(canonical));
	if (result.code !== 0) return statuses;
	for (const row of beadRows(result.stdout)) {
		const id = row.id;
		const status = row.status;
		if (typeof id !== "string" || typeof status !== "string") continue;
		const closedAt = row.closed_at;
		statuses.set(id, { status, closedAt: typeof closedAt === "string" && closedAt.trim().length > 0 ? closedAt : undefined });
	}
	return statuses;
};

/** Where a closed bead sits relative to the grace window. Anything but `elapsed` keeps the tree. */
export type GraceState =
	| { kind: "elapsed"; closedAgoMs: number }
	| { kind: "inside"; closedAgoMs: number }
	| { kind: "unknown"; detail: string };

/** An absent or unparseable `closed_at` is `unknown`, and `unknown` protects the tree. */
export function graceState(closedAt: string | undefined, now: number): GraceState {
	if (closedAt === undefined) return { kind: "unknown", detail: "the ledger reports no closed_at" };
	const closed = Date.parse(closedAt);
	if (!Number.isFinite(closed)) return { kind: "unknown", detail: `closed_at ${JSON.stringify(closedAt)} is not a date this build can read` };
	const closedAgoMs = now - closed;
	return closedAgoMs >= GRACE_WINDOW_MS ? { kind: "elapsed", closedAgoMs } : { kind: "inside", closedAgoMs };
}

function describeAge(ms: number): string {
	if (ms < 0) return "in the future by the ledger's clock";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

/** Named in every message about a tree that was kept: it is how a reader keeps one deliberately. */
function lockHint(worktreePath: string): string {
	return `keep it past the window with \`git worktree lock ${worktreePath}\``;
}

export interface SweepResult {
	/** `<branch>` of every worktree this sweep released, tree and branch both confirmed gone. */
	swept: string[];
	/** `<branch>: <why>` for a closed bead's tree that was deliberately or unavoidably kept. */
	retained: string[];
	/** Why the sweep did nothing. Diagnostic only: a stand-down produces no session notice. */
	stoodDown?: string;
}

export interface SweepDeps {
	run?: CommandRunner;
	readLedger?: LedgerReader;
	/** Wall clock for the grace window, injected so a test can place a bead either side of it. */
	now?: number;
	/** The session's own working directory. The tree it sits in is never collected. */
	sessionCwd?: string;
	/** How the handler finds the canonical checkout; the sweep itself is told one. */
	readTopology?: TopologyReader;
}

interface Candidate {
	path: string;
	branch: string;
	bead: string;
}

/** What `wt step prune` would remove, as a precondition probe. Never a removal; see the header. */
async function pruneCandidates(canonical: string, run: CommandRunner): Promise<{ clear: boolean; named: string[] }> {
	const argv = ["wt", "-C", canonical, "step", "prune", "--dry-run", "--format", "json"];
	const result = await run(argv, canonical, PROBE_TIMEOUT_MS);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		return { clear: false, named: [`wt step prune --dry-run failed in ${canonical}: ${detail}`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout.trim() || "[]");
	} catch {
		return { clear: false, named: [`wt step prune --dry-run printed output this build cannot parse: ${result.stdout.trim().slice(0, 200)}`] };
	}
	if (!Array.isArray(parsed)) return { clear: false, named: ["wt step prune --dry-run printed a non-array payload"] };
	const named = parsed.map(entry => {
		if (entry !== null && typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			for (const key of ["branch", "path", "worktree", "name"]) {
				const value = record[key];
				if (typeof value === "string" && value.length > 0) return value;
			}
		}
		return JSON.stringify(entry);
	});
	return { clear: named.length === 0, named };
}

/** What a removal left behind. Either half is `true` when it could not be proven gone. */
interface RemovalResidue {
	worktree: boolean;
	branch: boolean;
}

/** Read both halves of a removal back, treating a probe that failed as a tree still there. */
async function removalResidue(canonical: string, worktreePath: string, branch: string, run: CommandRunner): Promise<RemovalResidue> {
	const listing = await run(WORKTREE_LIST_ARGV, canonical, PROBE_TIMEOUT_MS);
	// A path whose physical identity cannot be resolved at all is treated as still registered:
	// a removal is only proven by a positive answer, never by an unanswerable one.
	const target = realDeepest(worktreePath);
	const worktree = listing.code !== 0 || target === null || parseWorktreeEntries(listing.stdout).some(entry => realDeepest(entry.path) === target);
	const branches = await run(["git", "-C", canonical, "branch", "--list", branch], canonical, PROBE_TIMEOUT_MS);
	return { worktree, branch: branches.code !== 0 || branches.stdout.trim().length > 0 };
}

/**
 * A `wt` or `git` refusal that names a lock: the tree survived, and that is the documented
 * mechanism doing its job rather than a fault to remediate.
 */
const LOCK_REFUSAL = /worktree is locked|cannot remove a locked working tree/iu;

function retainedForResidue(canonical: string, candidate: Candidate, failure: string | undefined, residue: RemovalResidue): string {
	if (failure !== undefined && LOCK_REFUSAL.test(failure)) {
		return (
			`${candidate.branch}: ${failure} — a \`git worktree lock\` is holding it, which is the supported way to keep a tree ` +
			`past the window; release it with \`git -C ${canonical} worktree unlock ${candidate.path}\` when you are done with it`
		);
	}
	const steps: string[] = [];
	if (residue.worktree) {
		steps.push(`the worktree ${candidate.path} is still registered: commit or discard its changes, then \`wt -C ${canonical} remove -y --foreground ${candidate.branch}\``);
	}
	if (residue.branch) {
		steps.push(`the branch ${candidate.branch} survives because it is unmerged: merge it, or drop it deliberately with \`wt -C ${canonical} remove -y -D ${candidate.branch}\``);
	}
	const remediation = steps.join("; ");
	const prefix = failure === undefined ? "" : `${failure} — `;
	return `${candidate.branch}: ${prefix}${remediation}; ${lockHint(candidate.path)}`;
}

/**
 * Collect the worktrees of closed agent beads. `canonical` is the canonical checkout: the parent
 * of the git common directory, which is where `wt`, `bd` and the ledger all resolve.
 */
export async function sweepStaleWorktrees(canonical: string, deps: SweepDeps = {}): Promise<SweepResult> {
	const run = deps.run ?? spawnCommand;
	const readLedger = deps.readLedger ?? bdLedgerReader;
	const now = deps.now ?? Date.now();
	// The budget is measured on the real clock even when `now` is injected: one is the ledger's
	// notion of time, the other is how long this handler has been holding up session start.
	const startedAt = Date.now();
	const remainingMs = (): number => SWEEP_BUDGET_MS - (Date.now() - startedAt);

	const listing = await run(WORKTREE_LIST_ARGV, canonical, PROBE_TIMEOUT_MS);
	if (listing.code !== 0) {
		const detail = listing.stderr.trim() || listing.stdout.trim() || `exit ${listing.code}`;
		return { swept: [], retained: [], stoodDown: `git worktree list failed in ${canonical}: ${detail}` };
	}
	// A detached or bare entry carries no branch, and this sweep addresses a worktree by branch.
	const candidates = parseWorktreeEntries(listing.stdout)
		.filter(entry => !insideAny(entry.path, [canonical]))
		.map(entry => ({ path: entry.path, branch: entry.branch, bead: entry.branch === null ? null : agentBeadOf(entry.branch) }))
		.filter((entry): entry is Candidate => entry.bead !== null)
		// The tree this session is working in is never collected, whatever its bead says: a
		// removal under a live session's feet is the one failure no message can repair. It is
		// skipped silently, because a notice about it would only invite the agent to react.
		.filter(candidate => deps.sessionCwd === undefined || !insideAny(deps.sessionCwd, [candidate.path]));
	if (candidates.length === 0) return { swept: [], retained: [] };

	const prune = await pruneCandidates(canonical, run);
	if (!prune.clear) {
		return {
			swept: [],
			retained: [],
			stoodDown: `wt step prune --dry-run names ${prune.named.join(", ")}; a sweep here could race another party's worktree, so ${candidates.length} agent worktree(s) were left alone`,
		};
	}

	const triage = await readLedger(
		candidates.map(candidate => candidate.bead),
		canonical,
	);
	const result: SweepResult = { swept: [], retained: [] };
	for (const candidate of candidates) {
		// Anything but a closed bead keeps its tree, including a status the read could not get.
		// Silently: an open bead's tree is in use, and there is nothing for a reader to do.
		const bead = triage.get(candidate.bead);
		if (bead === undefined || bead.status !== "closed") continue;

		const window = graceState(bead.closedAt, now);
		if (window.kind === "unknown") {
			result.retained.push(
				`${candidate.branch}: its bead is closed but ${window.detail}, so it counts as inside the grace window and stays; ${lockHint(candidate.path)}`,
			);
			continue;
		}
		if (window.kind === "inside") {
			result.retained.push(
				`${candidate.branch}: its bead closed ${describeAge(window.closedAgoMs)}, inside the ${GRACE_WINDOW_MS / 3_600_000}h window that review reads the delivered tree in, so it stays; ${lockHint(candidate.path)}`,
			);
			continue;
		}
		if (remainingMs() <= PROBE_TIMEOUT_MS) {
			result.stoodDown = `the sweep ran out of its ${SWEEP_BUDGET_MS}ms session-start budget with ${candidate.branch} still to consider`;
			break;
		}

		// The status is re-read here, not reused: a review verdict can reopen a bead between the
		// batched read above and this removal, and a successor adopts the same deterministic
		// branch name, so the tree this branch names may no longer be the finished one.
		const confirmed = (await readLedger([candidate.bead], canonical)).get(candidate.bead);
		if (confirmed === undefined || confirmed.status !== "closed") continue;
		const confirmedWindow = graceState(confirmed.closedAt, now);
		if (confirmedWindow.kind !== "elapsed") {
			result.retained.push(
				`${candidate.branch}: its bead's closure moved while the sweep was running (${confirmedWindow.kind === "unknown" ? confirmedWindow.detail : `now closed ${describeAge(confirmedWindow.closedAgoMs)}`}), so it stays; ${lockHint(candidate.path)}`,
			);
			continue;
		}

		// `wt remove` addresses a worktree by branch, so the branch must still name the same path
		// as the entry that was judged. A re-list is one cheap probe against removing another tree.
		const recheck = await run(WORKTREE_LIST_ARGV, canonical, PROBE_TIMEOUT_MS);
		if (recheck.code !== 0) {
			const detail = recheck.stderr.trim() || recheck.stdout.trim() || `exit ${recheck.code}`;
			result.retained.push(`${candidate.branch}: the listing could not be re-read before removing it (${detail}), so it stays; ${lockHint(candidate.path)}`);
			continue;
		}
		const named = parseWorktreeEntries(recheck.stdout).filter(entry => entry.branch === candidate.branch);
		const still = named.length === 1 ? named[0] : undefined;
		const stillPath = still === undefined ? null : realDeepest(still.path);
		const judgedPath = realDeepest(candidate.path);
		if (stillPath === null || judgedPath === null || stillPath !== judgedPath) {
			result.retained.push(
				`${candidate.branch}: it now names ${still === undefined ? `${named.length} worktrees` : still.path} rather than ${candidate.path}, and \`wt remove\` addresses a worktree by branch, so it stays; ${lockHint(candidate.path)}`,
			);
			continue;
		}

		// Neither `-f` nor `-D`. Both halves of that are load-bearing: force would delete a dirty
		// tree and a lock would stop mattering, and `-D` would drop an unmerged branch.
		const removal = await run(["wt", "-C", canonical, "remove", "-y", "--foreground", candidate.branch], canonical, Math.min(REMOVE_TIMEOUT_MS, Math.max(1, remainingMs())));
		const residue = removal.code === 0 ? await removalResidue(canonical, candidate.path, candidate.branch, run) : { worktree: true, branch: true };
		if (!residue.worktree && !residue.branch) {
			result.swept.push(candidate.branch);
			continue;
		}
		// Flattened: `wt` answers a refusal over several lines, and the notice is read as one.
		const failure = removal.code === 0 ? undefined : (removal.stderr.trim() || removal.stdout.trim() || `wt remove exited ${removal.code}`).replace(/\s+/gu, " ");
		result.retained.push(retainedForResidue(canonical, candidate, failure, residue));
	}
	return result;
}

/**
 * The session notice, or `undefined` when there is nothing to say.
 *
 * A stand-down is deliberately not a notice. A fresh `omp -p` session has exactly one assistant
 * turn, and a line about housekeeping that needs no action spends it: the only things worth that
 * turn are a tree that is gone and a tree that is still there.
 */
export function sweepNotice(result: SweepResult): string | undefined {
	const parts: string[] = [];
	if (result.swept.length > 0) {
		parts.push(`worktrunk reclaimed ${result.swept.length} stale agent worktree(s), closed longer than ${GRACE_WINDOW_MS / 3_600_000}h: ${result.swept.join(", ")}.`);
	}
	if (result.retained.length > 0) {
		parts.push(`worktrunk kept ${result.retained.length} closed bead's worktree(s) — ${result.retained.join("; ")}.`);
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * Where the sweep runs, or `null` when it must not run at all. Uncertainty is a stand-down and
 * never a guess: sweeping a root git could not confirm is how a sweep removes someone else's tree.
 */
export function sweepRoot(cwd: string, readTopology: TopologyReader = repositoryTopology): string | null {
	const topology = readTopology(cwd);
	if (topology.uncertainty !== undefined && topology.uncertainty !== null) return null;
	return topology.canonical;
}

export const SWEEP_MESSAGE_TYPE = "com.srobroek.worktrunk.stale-worktree-sweep";

/**
 * `deps` is the same injection seam the sweep itself takes, so a test can drive the whole handler
 * — root resolution, sweep, and the decision to speak or stay quiet — without a repository.
 */
export default function staleWorktreeSweep(pi: ExtensionAPI, deps: SweepDeps = {}): void {
	pi.on("session_start", async (_event: SessionStartEvent, ctx?: ExtensionContext) => {
		const cwd = ctx?.cwd ?? process.cwd();
		try {
			const canonical = sweepRoot(cwd, deps.readTopology);
			if (canonical === null) return;
			const notice = sweepNotice(await sweepStaleWorktrees(canonical, { ...deps, sessionCwd: deps.sessionCwd ?? cwd }));
			if (notice === undefined) return;
			// A message rather than a UI notification: the agent is who acts on a tree that was
			// kept, and a notification reaches neither it nor a `--print` session.
			pi.sendMessage({ customType: SWEEP_MESSAGE_TYPE, content: notice, display: true, attribution: "user" }, { triggerTurn: false });
		} catch (error) {
			// Housekeeping must never take a session start down with it.
			pi.logger.warn?.(`worktrunk stale-worktree sweep failed in ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
