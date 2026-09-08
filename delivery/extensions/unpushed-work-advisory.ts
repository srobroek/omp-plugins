import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 2000;

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
	agentPaths: Set<string>;
	sessionHead: string | null;
};

export function createAdvisoryState(): AdvisoryState {
	return { lastFired: false, agentPaths: new Set(), sessionHead: null };
}

export function revParseHead(cwd: string): string | null {
	try {
		const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return null;
		const sha = proc.stdout.toString().trim();
		return sha === "" ? null : sha;
	} catch {
		return null;
	}
}

/** Count commits since the baseline, capped by ahead; this does not identify their author. */
export function sessionCommitsUnpushed(cwd: string, base: string | null, ahead: number): number {
	if (base === null || ahead <= 0) return 0;
	try {
		const proc = Bun.spawnSync(["git", "rev-list", "--count", `${base}..HEAD`], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return 0;
		const made = Number(proc.stdout.toString().trim()) || 0;
		return Math.min(made, ahead);
	} catch {
		return 0;
	}
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
 * Returns an empty list when the diff cannot be taken — a repository with no
 * commits yet, for instance — leaving the file-count gate as the only signal.
 */
export function agentDiffStat(cwd: string, paths: string[]): FileStat[] {
	if (paths.length === 0) return [];
	try {
		const proc = Bun.spawnSync(["git", "diff", "--numstat", "HEAD", "--", ...paths], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return [];
		return parseNumstat(proc.stdout.toString());
	} catch {
		return [];
	}
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

export function gitStatusPorcelain(cwd: string): string | null {
	try {
		const proc = Bun.spawnSync(["git", "status", "--porcelain", "-b", "-z"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return null;
		return proc.stdout.toString();
	} catch {
		return null;
	}
}

type SessionStopEvent = {
	stop_hook_active?: boolean;
	stopHookActive?: boolean;
};

export function handleSessionStop(
	event: SessionStopEvent,
	cwd: string,
	statusText: string | null,
	authored: Set<string>,
	diffStat: (cwd: string, paths: string[]) => FileStat[] = agentDiffStat,
	ownCommits: (cwd: string, base: string | null, ahead: number) => number = sessionCommitsUnpushed,
	base: string | null = null,
	state: AdvisoryState = createAdvisoryState(),
): { continue: true; additionalContext: string } | undefined {
	if (event.stop_hook_active === true || event.stopHookActive === true) return;
	if (state.lastFired) return;
	if (!statusText) return;
	const status = parsePorcelain(statusText);
	const agentDirty = agentAuthoredDirty(status, cwd, authored);
	const stats = diffStat(cwd, agentDirty);
	const ownUnpushed = ownCommits(cwd, base, status.ahead);
	if (!shouldAdvise(agentDirty, totalChangedLines(stats), ownUnpushed)) return;
	state.lastFired = true;
	return {
		continue: true,
		additionalContext: formatAdvisory(status, agentDirty, stats, ownUnpushed),
	};
}

export default function unpushedWorkAdvisory(pi: ExtensionAPI): void {
	const states = new Map<string, AdvisoryState>();
	const stateFor = (cwd: string): AdvisoryState => {
		let state = states.get(cwd);
		if (!state) {
			state = createAdvisoryState();
			state.sessionHead = hasGitDir(cwd) ? revParseHead(cwd) : null;
			states.set(cwd, state);
		}
		return state;
	};
	pi.on("session_start", (_event, ctx) => {
		states.clear();
		stateFor(resolve(ctx?.cwd ?? process.cwd()));
	});
	pi.on("turn_start", () => {
		for (const state of states.values()) state.lastFired = false;
	});
	pi.on("tool_call", (event, ctx) => {
		if (WRITING_TOOLS[event.toolName] !== true &&
			(event.toolName !== "bash" || typeof event.input.command !== "string" ||
				!/\bd?git\b[\s\S]*\bcommit\b/.test(event.input.command))) return;
		try {
			const cwd = resolve(typeof event.input.cwd === "string" && event.input.cwd
				? event.input.cwd : ctx?.cwd || process.cwd());
			stateFor(cwd);
		} catch {
			// Advisory observation must never block a tool.
		}
	});
	pi.on("tool_result", (event, ctx: { cwd?: string }) => {
		try {
			const cwd = resolve(typeof event.input?.cwd === "string" && event.input.cwd
				? event.input.cwd : ctx?.cwd || process.cwd());
			const state = stateFor(cwd);
			const paths = extractWrittenPaths(event.toolName, event.isError, event.input, event.details);
			for (const path of paths) recordAgentPath(cwd, path, state.agentPaths);
		} catch {
			// Attribution is best-effort and must never disturb a tool result.
		}
	});
	pi.on("session_stop", (event: SessionStopEvent, ctx: { cwd?: string }) => {
		try {
			const cwd = resolve(ctx?.cwd || process.cwd());
			if (!hasGitDir(cwd)) return;
			const state = stateFor(cwd);
			return handleSessionStop(event, cwd, gitStatusPorcelain(cwd), state.agentPaths,
				agentDiffStat, sessionCommitsUnpushed, state.sessionHead, state);
		} catch {
			return;
		}
	});
}
