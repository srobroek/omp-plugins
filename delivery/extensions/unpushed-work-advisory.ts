import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { ledgerActive } from "./landing-receipt.ts";

const TIMEOUT_MS = 2000;

/**
 * Ceiling on what one Git read may hand back.
 *
 * Every child process this module starts is bounded the same way: the same
 * timeout and the same output ceiling. Bun kills a process that writes past the
 * ceiling, so its exit code is null and the read is reported as unreadable —
 * a truncated porcelain stream is never parsed into a claim about the tree.
 */
const MAX_GIT_OUTPUT_BYTES = 1 << 20;

/**
 * Volume at which the advisory speaks up about dirty paths touched this session.
 *
 * Neither number defines when a commit is *due* — a finished atomic chunk is due
 * immediately, whatever its size. These only decide when staying silent stops
 * being reasonable, so a stop is not interrupted over a one-line edit. Below
 * both, silence: a false demand is strictly worse than a missed reminder,
 * because it pressures the agent into committing whatever happens to sit in the
 * working tree, including a human's staged, in-flight work.
 *
 * Lines are `numstat` added plus deleted, so a modified line counts twice: 80 is
 * roughly 40 rewritten lines, or one substantial function.
 */
export const SIGNIFICANT_AGENT_DIRTY_FILES = 3;
export const SIGNIFICANT_AGENT_CHANGED_LINES = 80;

/**
 * Tools whose successful results identify a touched file. Membership is
 * tested with `=== true`, never for truthiness: a bare `WRITING_TOOLS[name]`
 * check would accept `"constructor"` through the prototype chain, the same bug
 * class that took a session's bash tool down entirely.
 */
const WRITING_TOOLS: Record<string, true> = { write: true, edit: true };

/**
 * Internal URI schemes the `write` tool accepts as tool-device invocations
 * (`xd://ast_edit`) or artifact handles rather than filesystem paths.
 */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export type AdvisoryState = {
	lastFired: boolean;
	reminderCount: number;
	agentPaths: Set<string>;
	sessionHead: string | null;
	/** False when the session cwd has a marker but Git cannot resolve a repository. */
	repositoryResolved: boolean;
};

export function createAdvisoryState(): AdvisoryState {
	return { lastFired: false, reminderCount: 0, agentPaths: new Set(), sessionHead: null, repositoryResolved: true };
}



function timeoutFor(deadline: number | undefined): number {
	return Math.max(1, deadline === undefined ? TIMEOUT_MS : Math.min(TIMEOUT_MS, deadline - Date.now()));
}

/**
 * One bounded, read-only Git read; null whenever the answer cannot be trusted.
 *
 * `--no-optional-locks` sits where Git accepts it — before the subcommand, as a
 * global option — so an observation never takes `index.lock` and never refreshes
 * the index on disk. An advisory that watches for residual work must not itself
 * write repository state, and it must not lose a race with a real command the
 * user or another agent is running in the same checkout.
 *
 * Both streams are capped and the call is bounded by the session-stop deadline.
 * A process killed for exceeding either is terminated rather than exited, so its
 * exit code is null, and its partial output is discarded rather than parsed.
 */
function gitRead(cwd: string, args: string[], deadline: number | undefined): string | null {
	try {
		const proc = Bun.spawnSync(["git", "--no-optional-locks", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutFor(deadline),
			maxBuffer: MAX_GIT_OUTPUT_BYTES,
		});
		if (proc.exitCode !== 0) return null;
		return proc.stdout.toString();
	} catch {
		return null;
	}
}

export function revParseHead(cwd: string, deadline?: number): string | null {
	const printed = gitRead(cwd, ["rev-parse", "HEAD"], deadline);
	if (printed === null) return null;
	const sha = printed.trim();
	return sha === "" ? null : sha;
}

/** Resolve repository membership without requiring an existing HEAD commit. */
export function revParseCommonDir(cwd: string, deadline?: number): string | null {
	const printed = gitRead(cwd, ["rev-parse", "--git-common-dir"], deadline);
	if (printed === null) return null;
	const common = printed.trim();
	return common === "" ? null : common;
}

/** Count commits since the baseline, capped by ahead; null means Git was unreadable. */
export function sessionCommitsUnpushed(cwd: string, base: string | null, ahead: number, deadline?: number): number | null {
	if (base === null || ahead <= 0) return 0;
	const printed = gitRead(cwd, ["rev-list", "--count", `${base}..HEAD`], deadline);
	if (printed === null) return null;
	const made = Number(printed.trim());
	return Number.isFinite(made) ? Math.min(Math.max(0, made), ahead) : null;
}

/**
 * Is a Beads ledger active for the repository this checkout belongs to?
 *
 * The classification is recomputed at the canonical root, never at the directory
 * the session happens to run in: a linked worktree lives outside the checkout,
 * so the upward `.beads` walk started there finds nothing and would report every
 * ledger retired. `rev-parse --git-common-dir` names the canonical root — its
 * parent when it is the usual `.git` directory — exactly as delivery_land
 * observes it.
 *
 * When Git cannot answer, the walk falls back to the given directory so the
 * classifier keeps its own documented bias (a read error leaves the ledger
 * active) instead of this module inventing a second rule.
 */
export function canonicalLedgerActive(cwd: string, deadline?: number): boolean {
	const printed = gitRead(cwd, ["rev-parse", "--git-common-dir"], deadline);
	const trimmed = printed === null ? "" : printed.trim();
	if (trimmed === "") return ledgerActive(cwd);
	const common = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	return ledgerActive(basename(common) === ".git" ? dirname(common) : common);
}

export function hasGitDir(cwd: string): boolean {
	try {
		return existsSync(join(cwd, ".git"));
	} catch {
		return false;
	}
}

/**
 * Pull filesystem paths out of a `tool_result` for a writing tool.
 *
 * `write` carries its target in `input.path`. `edit` never does — it takes a
 * hashline patch blob — so its paths are only knowable from the result
 * `details`: `path` for a single-file edit, `perFileResults[].path` for a
 * multi-file one, and `sourcePath` plus the post-move `path`/`move` for a
 * rename. Failed calls contribute nothing: a blocked or rejected edit left no
 * dirty file behind, so recording it would produce a demand to commit a file
 * that is not modified.
 */
export function extractWrittenPaths(
	toolName: string,
	isError: boolean,
	input: Record<string, unknown> | undefined,
	details: unknown,
): string[] {
	if (WRITING_TOOLS[toolName] !== true) return [];
	if (isError) return [];

	const out: string[] = [];
	const take = (value: unknown): void => {
		if (typeof value === "string" && value !== "") out.push(value);
	};

	take(input?.path);

	if (details && typeof details === "object") {
		const d = details as Record<string, unknown>;
		take(d.path);
		take(d.move);
		take(d.sourcePath);
		if (Array.isArray(d.perFileResults)) {
			for (const entry of d.perFileResults) {
				if (entry && typeof entry === "object") take((entry as Record<string, unknown>).path);
			}
		}
	}

	return out;
}

/** Record one touched path, resolved absolute, ignoring non-file URIs. */
export function recordAgentPath(cwd: string, raw: string, into: Set<string>): void {
	if (!raw || NON_FILE_SCHEME.test(raw)) return;
	into.add(resolve(cwd, raw));
}

export type PorcelainStatus = {
	branch: string;
	ahead: number;
	behind: number;
	dirtyPaths: string[];
	untracked: number;
};

/**
 * Parse `git status --porcelain -b -z`.
 *
 * NUL termination is used rather than newlines so paths are never quoted or
 * escaped by `core.quotePath`. A rename or copy entry is followed by one extra
 * field holding the pre-rename path; both sides are recorded so an agent edit
 * to either name still attributes.
 *
 * Untracked paths are recorded alongside modified ones: a file the agent just
 * created is the clearest case of uncommitted work, and attribution — not the
 * tracked/untracked axis — is what keeps a human's own new files out of the
 * advisory.
 */
export function parsePorcelain(out: string): PorcelainStatus {
	const fields = out.split("\0");
	let branch = "HEAD";
	let ahead = 0;
	let behind = 0;
	const dirtyPaths: string[] = [];
	let untracked = 0;

	for (let i = 0; i < fields.length; i++) {
		const line = fields[i];
		if (!line) continue;

		if (line.startsWith("## ")) {
			const rest = line.slice(3);
			ahead = Number(rest.match(/ahead (\d+)/)?.[1] ?? 0);
			behind = Number(rest.match(/behind (\d+)/)?.[1] ?? 0);
			const name = (rest.split("...")[0] ?? rest).trim().replace(/\s+\[.*$/, "");
			if (name) branch = name;
			continue;
		}

		if (line.length < 3) continue;
		const xy = line.slice(0, 2);
		const path = line.slice(3);

		if (xy === "??") {
			untracked += 1;
			dirtyPaths.push(path);
			continue;
		}
		if (xy === "  ") continue;

		dirtyPaths.push(path);
		if (xy[0] === "R" || xy[0] === "C") {
			const original = fields[++i];
			if (original) dirtyPaths.push(original);
		}
	}

	return { branch, ahead, behind, dirtyPaths, untracked };
}

/**
 * Intersect dirty paths — modified, staged, and untracked — with paths touched
 * this session. Path observation establishes no ownership of individual hunks.
 *
 * `hasGitDir` guarantees `cwd` is the repository root, so porcelain's
 * repo-relative paths and the recorded absolute paths share one space with no
 * extra `rev-parse` call. Files the agent wrote outside the repository drop out
 * here for free: they never appear in porcelain.
 */
export function agentAuthoredDirty(
	status: PorcelainStatus,
	cwd: string,
	authored: Set<string>,
): string[] {
	const hits = new Set<string>();
	for (const path of status.dirtyPaths) {
		if (authored.has(resolve(cwd, path))) hits.add(path);
	}
	return [...hits];
}

export type FileStat = { path: string; added: number; deleted: number };

/**
 * Parse `git diff --numstat` output into per-file counts.
 *
 * Each line is `added\tdeleted\tpath`, so the path is the trailing field and
 * needs no unquoting. Binary files report `-\t-`, which yields zero on both
 * counts while still listing the file.
 */
export function parseNumstat(out: string): FileStat[] {
	const stats: FileStat[] = [];
	for (const line of out.split(/\r?\n/)) {
		if (!line) continue;
		const fields = line.split("\t");
		if (fields.length < 3) continue;
		stats.push({
			path: fields[2] ?? "",
			added: Number(fields[0]) || 0,
			deleted: Number(fields[1]) || 0,
		});
	}
	return stats;
}

export function totalChangedLines(stats: FileStat[]): number {
	let total = 0;
	for (const stat of stats) total += stat.added + stat.deleted;
	return total;
}

/**
 * Per-file diff stat for touched paths, staged and unstaged.
 *
 * Counts include concurrent edits in the same file; they do not identify authorship.
 * Null means Git could not provide the stat, while an empty list is a real no-change result.
 */
export function agentDiffStat(cwd: string, paths: string[], deadline?: number): FileStat[] | null {
	if (paths.length === 0) return [];
	const printed = gitRead(cwd, ["diff", "--numstat", "HEAD", "--", ...paths], deadline);
	return printed === null ? null : parseNumstat(printed);
}

export function shouldAdvise(
	agentDirty: string[],
	changedLines: number,
	ownUnpushed: number,
): boolean {
	if (ownUnpushed > 0) return true;
	if (agentDirty.length === 0) return false;
	return (
		agentDirty.length >= SIGNIFICANT_AGENT_DIRTY_FILES ||
		changedLines >= SIGNIFICANT_AGENT_CHANGED_LINES
	);
}

/**
 * Render the advisory, largest change first.
 *
 * Per-file counts show magnitude, not ownership or atomicity. Hunk inspection
 * remains necessary before staging.
 */
export function formatAdvisory(
	status: PorcelainStatus,
	agentDirty: string[],
	stats: FileStat[],
	ownUnpushed = 0,
): string {
	const parts: string[] = [];

	if (agentDirty.length > 0) {
		const byPath = new Map(stats.map(stat => [stat.path, stat]));
		const magnitude = (path: string): number => {
			const stat = byPath.get(path);
			return stat ? stat.added + stat.deleted : 0;
		};
		const ranked = [...agentDirty].sort((a, b) => magnitude(b) - magnitude(a));
		const shown = ranked.slice(0, 8);
		const listing = shown
			.map(path => {
				const stat = byPath.get(path);
				return stat ? `${path} (+${stat.added}/-${stat.deleted})` : `${path} (diff stat unavailable)`;
			})
			.join(", ");
		const more = ranked.length > shown.length ? `, +${ranked.length - shown.length} more` : "";
		const total = totalChangedLines(stats);
		const summary = total > 0 ? `, ~${total} changed line(s)` : "";
		parts.push(
			`${agentDirty.length} file(s) touched this session are uncommitted on branch ` +
				`${status.branch}${summary}: ${listing}${more}. ` +
				`These paths and counts can include pre-existing or concurrent human edits; they do not ` +
				`establish hunk ownership. Inspect both staged and unstaged diffs before staging, ` +
				`identify your own finished hunks, and preserve unrelated staged and working-tree changes. ` +
				`Group only owned, finished hunks into atomic commits when repository/user authority permits. ` +
				`Do not stage or commit whole paths merely because they appear here. Leave unfinished or ` +
				`uncertain-ownership work uncommitted and report it. This reminder grants no authority ` +
				`to commit or publish.`,
		);
	}

	if (ownUnpushed > 0) {
		parts.push(
			`${ownUnpushed} commit(s) since the session baseline are unpushed on ${status.branch}. ` +
				`This range does not establish authorship: concurrent human commits may be included. ` +
				`Inspect ownership and repository/user authority before proposing a push; this advisory ` +
				`does not grant approval to publish.`,
		);
	}

	return parts.join(" ");
}

export function gitStatusPorcelain(cwd: string, deadline?: number): string | null {
	return gitRead(cwd, ["status", "--porcelain", "-b", "-z"], deadline);
}

type SessionStopEvent = {
	stop_hook_active?: boolean;
	stopHookActive?: boolean;
};
const MAX_REMINDERS = 3;

type StopResult = { continue: true; additionalContext: string };

/**
 * The escalation the last reminder carries, and nothing the earlier two do.
 *
 * Two surfaces are named because they are the only sanctioned ones, and both are
 * named with their limits: the worktree-reaper agent reports and removes nothing,
 * and removal happens through delivery_cleanup after a landing is proved. The
 * ledger tool is named only when a ledger is actually active, in the order
 * decision omp-plugins-9ej3.45 fixes — bd_reconcile, then delivery_cleanup — so
 * this text never states the unconditional form.
 */
function escalation(ledgerIsActive: boolean): string {
	const lifecycle = ledgerIsActive
		? "When the ledger is active the order is fixed: run bd_reconcile to write the ledger from the landing receipt, then delivery_cleanup to remove the worktree and its local branch."
		: "The canonical root carries no active ledger, so nothing is reconciled first: removal runs through delivery_cleanup alone.";
	return (
		" Escalation: dispatch the report-only worktree-reaper to inspect and report the residual; the main agent or the run lead invokes it, and it removes nothing. " +
		`${lifecycle} ` +
		"This reminder grants no removal, merge, or publish authority."
	);
}

function reminder(
	state: AdvisoryState,
	context: string,
	ambiguous: boolean,
	ledger: () => boolean,
): StopResult | undefined {
	if (state.reminderCount >= MAX_REMINDERS) return;
	state.reminderCount += 1;
	state.lastFired = true;
	const number = state.reminderCount;
	let additionalContext = `Reminder ${number} of ${MAX_REMINDERS}: ${context}`;
	if (number === MAX_REMINDERS) {
		if (ambiguous) {
			additionalContext +=
				" Ambiguity remains after two reminders: the residual could not be measured, so report it rather than act on it.";
		}
		// The classification costs a Git read, so it is paid for only here, on the
		// one reminder that names a lifecycle.
		additionalContext += escalation(ledger());
		additionalContext +=
			" Final residual warning: residual work may remain at session end; no further hygiene reminders will be emitted this session.";
	}
	return { continue: true, additionalContext };
}

function resetAfterProgress(state: AdvisoryState): void {
	state.reminderCount = 0;
}

export function handleSessionStop(
	event: SessionStopEvent,
	cwd: string,
	statusText: string | null,
	authored: Set<string>,
	diffStat: (cwd: string, paths: string[], deadline?: number) => FileStat[] | null = agentDiffStat,
	ownCommits: (cwd: string, base: string | null, ahead: number, deadline?: number) => number | null = sessionCommitsUnpushed,
	base: string | null = null,
	state: AdvisoryState = createAdvisoryState(),
	deadline = Date.now() + TIMEOUT_MS,
	ledger: () => boolean = () => canonicalLedgerActive(cwd, deadline),
): StopResult | undefined {
	if (!state.repositoryResolved) return;
	if (event.stop_hook_active === true || event.stopHookActive === true) return;
	if (state.lastFired) return;
	if (statusText === null) {
		return reminder(
			state,
			"Could not determine unpushed work because git status failed or timed out. Obtain a fresh git status and inspect any residual paths before ending the session. This is advisory only; no tool call is blocked.",
			true,
			ledger,
		);
	}
	const status = parsePorcelain(statusText);
	const agentDirty = agentAuthoredDirty(status, cwd, authored);
	const stats = diffStat(cwd, agentDirty, deadline);
	if (stats === null) {
		return reminder(
			state,
			"Could not determine unpushed work because git diff failed or timed out. Obtain a fresh diff and inspect any residual paths before ending the session. This is advisory only; no tool call is blocked.",
			true,
			ledger,
		);
	}
	const ownUnpushed = ownCommits(cwd, base, status.ahead, deadline);
	if (ownUnpushed === null) {
		return reminder(
			state,
			"Could not determine unpushed work because git rev-list failed or timed out. Obtain a fresh commit range and inspect any residual commits before ending the session. This is advisory only; no tool call is blocked.",
			true,
			ledger,
		);
	}
	if (!shouldAdvise(agentDirty, totalChangedLines(stats), ownUnpushed)) {
		resetAfterProgress(state);
		return;
	}
	return reminder(state, formatAdvisory(status, agentDirty, stats, ownUnpushed), false, ledger);
}

export default function unpushedWorkAdvisory(pi: ExtensionAPI): void {
	const states = new Map<string, AdvisoryState>();
	const stateFor = (cwd: string, deadline?: number): AdvisoryState => {
		let state = states.get(cwd);
		if (!state) {
			state = createAdvisoryState();
			const marker = hasGitDir(cwd);
			state.sessionHead = marker ? revParseHead(cwd, deadline) : null;
			state.repositoryResolved = !marker || revParseCommonDir(cwd, deadline) !== null;
			states.set(cwd, state);
		}
		return state;
	};
	pi.on("session_start", (_event, ctx) => {
		states.clear();
		stateFor(resolve(ctx?.cwd ?? process.cwd()), Date.now() + TIMEOUT_MS);
	});
	pi.on("turn_start", () => {
		for (const state of states.values()) state.lastFired = false;
	});
	pi.on("tool_call", (event, ctx) => {
		let isGitCommit = false;
		if (event.toolName === "bash") {
			const command = event.input.command;
			isGitCommit = typeof command === "string" && /\bd?git\b[\s\S]*\bcommit\b/.test(command);
		}
		if (WRITING_TOOLS[event.toolName] !== true && !isGitCommit) return;
		try {
			const rawCwd = "cwd" in event.input ? event.input.cwd : undefined;
			const cwd = resolve(typeof rawCwd === "string" && rawCwd ? rawCwd : ctx?.cwd || process.cwd());
			stateFor(cwd);
		} catch {
			// Advisory observation must never block a tool.
		}
	});
	pi.on("tool_result", (event, ctx: { cwd?: string }) => {
		try {
			const input = event.input as Record<string, unknown> | undefined;
			const rawCwd = input?.cwd;
			const cwd = resolve(typeof rawCwd === "string" && rawCwd ? rawCwd : ctx?.cwd || process.cwd());
			const state = stateFor(cwd);
			const paths = extractWrittenPaths(event.toolName, event.isError, input, event.details);
			const before = state.agentPaths.size;
			for (const path of paths) recordAgentPath(cwd, path, state.agentPaths);
			if (state.agentPaths.size > before) resetAfterProgress(state);
		} catch {
			// Attribution is best-effort and must never disturb a tool result.
		}
	});
	pi.on("session_stop", (event: SessionStopEvent, ctx: { cwd?: string }) => {
		try {
			const cwd = resolve(ctx?.cwd || process.cwd());
			if (!hasGitDir(cwd)) return;
			const deadline = Date.now() + TIMEOUT_MS;
			const state = stateFor(cwd, deadline);
			return handleSessionStop(event, cwd, gitStatusPorcelain(cwd, deadline), state.agentPaths,
				agentDiffStat, sessionCommitsUnpushed, state.sessionHead, state, deadline);
		} catch {
			return;
		}
	});
}
