import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { basename } from "node:path";
import {
	acceptedPaths,
	type Candidate,
	candidates,
	clip,
	commitInfo,
	EXACT_TIERS,
	estimateTokens,
	isDirty,
	listWorktrees,
	parseTranscript,
	pathKeys,
	repoRoot,
	type SessionMeta,
	sessionsRoot,
	type TodoPhase,
	type Transcript,
	type Turn,
	type Worktree,
} from "./store";

const LEFT_OFF_CHARS = 160;
const TURN_CHARS = 1600;
const DEFAULT_TURNS = 8;
const DEFAULT_MAX_CHARS = 14_000;
const DEFAULT_LIST_LIMIT = 12;

const TODO_GLYPH: Record<string, string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]", blocked: "[!]" };

export function relativeTime(ms: number | null, now = Date.now()): string {
	if (ms === null) return "unknown";
	const seconds = Math.max(0, Math.round((now - ms) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

export function absoluteTime(ms: number | null): string {
	if (ms === null) return "unknown";
	const d = new Date(ms);
	const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return `${date} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Short, human label for the worktree a session or commit belongs to. */
export function worktreeLabel(worktree: Worktree | undefined): string {
	if (!worktree) return "?";
	const name = basename(worktree.path) || worktree.path;
	return worktree.isMain ? `${name} (main)` : name;
}

export interface Row {
	meta: SessionMeta;
	worktree: Worktree | undefined;
}

/**
 * The branch label is the branch the session *worked on*, recovered from its
 * transcript — not the branch its checkout is on now. When those differ the row
 * carries the drift outright, because on-disk files no longer match that
 * session's work.
 */
export function branchLabel(meta: Pick<SessionMeta, "branch" | "branchTier">, worktree: Worktree | undefined): string {
	const now = worktree?.detached ? "detached" : (worktree?.branch ?? "");
	if (!meta.branch) return now ? `? [worktree now on ${now}]` : "?";
	const suffix = meta.branchTier && EXACT_TIERS[meta.branchTier] ? "" : " (inferred)";
	if (now && now !== meta.branch) return `${meta.branch}${suffix} [worked-on → worktree now on ${now}]`;
	return `${meta.branch}${suffix}`;
}

/**
 * The shortest prefix length at which every listed id is distinct, floored at 8.
 *
 * Session ids are UUIDv7, so sessions started close together share a long
 * leading run; printing a colliding prefix would hand the user an id that
 * `mode: "read"` then has to refuse as ambiguous.
 */
export function idPrefixLength(ids: string[], floor = 8): number {
	const longest = Math.max(floor, ...ids.map((id) => id.length));
	for (let length = floor; length < longest; length += 1) {
		if (new Set(ids.map((id) => id.slice(0, length))).size === ids.length) return length;
	}
	return longest;
}

export function renderRow(row: Row, index: number, now: number, idLength = 8): string[] {
	const { meta } = row;
	const flags: string[] = [];
	if (meta.compactions > 0) flags.push(`compacted×${meta.compactions}`);
	if (meta.continuedFrom > 0) flags.push("continued");
	if (meta.exitReason) flags.push(`exit:${meta.exitReason}`);
	const lines = [
		`${String(index).padStart(2)}. ${meta.id.slice(0, idLength)}  ${relativeTime(meta.lastActiveMs, now)}` +
			`  (${absoluteTime(meta.lastActiveMs)})  ${meta.turnCount} turn${meta.turnCount === 1 ? "" : "s"}` +
			`  ${(meta.bytes / 1024).toFixed(0)}KB${flags.length > 0 ? `  ${flags.join(" ")}` : ""}`,
		`    branch: ${branchLabel(meta, row.worktree)}`,
		`    worktree: ${worktreeLabel(row.worktree)} — ${meta.cwd}`,
	];
	if (meta.title) lines.push(`    title: ${meta.title}`);
	lines.push(`    ↳ left off: ${meta.leftOff ? clip(meta.leftOff, LEFT_OFF_CHARS) : "(no assistant prose recorded)"}`);
	return lines;
}

export function renderGitActivity(worktrees: Worktree[], project: string): string[] {
	if (worktrees.length < 2) return [];
	const commits = commitInfo(worktrees, project);
	const ranked = [...worktrees].sort((a, b) => (commits.get(b.head)?.epochMs ?? 0) - (commits.get(a.head)?.epochMs ?? 0));
	const lines = ["## Worktree git activity (most recently committed first)"];
	const now = Date.now();
	for (const worktree of ranked) {
		const commit = commits.get(worktree.head);
		const dirty = isDirty(worktree.path) ? "  ✎ dirty" : "";
		const branch = worktree.detached ? "(detached)" : worktree.branch || "(unknown)";
		lines.push(
			`  ${worktreeLabel(worktree).padEnd(24)} ${branch.padEnd(34)} ${relativeTime(commit?.epochMs ?? null, now)}${dirty}`,
		);
		if (commit?.subject) lines.push(`      ${clip(commit.subject, 100)}`);
	}
	return lines;
}

export interface ListOptions {
	path?: string;
	worktrees?: boolean;
	git?: boolean;
	limit?: number;
	profile?: string;
}

export function renderList(cwd: string, options: ListOptions): { text: string; count: number; ids: string[] } {
	const project = repoRoot(options.path ?? cwd);
	const root = sessionsRoot(options.profile);
	const family = options.worktrees === false ? [] : listWorktrees(project);
	const accept = acceptedPaths(family, project);
	const byPath = new Map(family.flatMap((w) => pathKeys(w.path).map((key) => [key, w] as const)));

	const found: Candidate[] = candidates(root, accept);
	const rows: Row[] = found
		.map((candidate) => ({
			meta: parseTranscript(candidate.file).meta,
			worktree: pathKeys(candidate.head.cwd)
				.map((key) => byPath.get(key))
				.find(Boolean),
		}))
		.filter((row) => row.meta.turnCount > 0)
		.sort((a, b) => (b.meta.lastActiveMs ?? 0) - (a.meta.lastActiveMs ?? 0));

	const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIST_LIMIT;
	const shown = rows.slice(0, limit);
	const now = Date.now();
	const out = [
		"# Prior sessions (newest first)",
		`project: ${project}`,
		`store: ${root}`,
		`worktrees scanned: ${family.length > 0 ? family.map((w) => worktreeLabel(w)).join(", ") : "current checkout only"}`,
		"",
	];
	if (shown.length === 0) {
		out.push(
			"No prior sessions recorded for this project.",
			"",
			"Nothing to resume. Say so and ask what to work on instead — do not guess a session.",
		);
	} else {
		const idLength = idPrefixLength(shown.map((row) => row.meta.id));
		shown.forEach((row, index) => out.push(...renderRow(row, index + 1, now, idLength), ""));
		if (rows.length > shown.length) out.push(`(${rows.length - shown.length} older session(s) not shown; raise \`limit\`)`);
		const activity = renderGitActivity(family, project);
		if (options.git !== false && activity.length > 0) out.push("", ...activity);
		out.push(
			"",
			"---",
			"STOP. Present these rows to the user and ask which session to resume. Do not pick for them,",
			'and do not read any transcript until they answer. Then call resume_session with mode "read".',
		);
	}
	const text = out.join("\n");
	return { text: withCost(text), count: rows.length, ids: shown.map((row) => row.meta.id) };
}

function withCost(text: string): string {
	return `${text}\n\nThis window: ~${estimateTokens(text).toLocaleString()} uncached tokens (${text.length.toLocaleString()} chars, estimated).`;
}

export function renderTodos(phases: TodoPhase[]): string[] {
	const lines: string[] = [];
	for (const phase of phases) {
		const done = phase.tasks.filter((task) => task.status === "completed").length;
		lines.push(`  ${phase.name || "(unnamed phase)"} — ${done}/${phase.tasks.length}`);
		for (const task of phase.tasks) {
			lines.push(`    ${TODO_GLYPH[task.status] ?? "[?]"} ${task.content}`);
		}
	}
	return lines;
}

export function renderTurn(turn: Turn, index: number): string {
	const role = turn.role === "user" ? "USER" : "ASSISTANT";
	const lines = [`### [${index}] ${role} — ${absoluteTime(turn.timestampMs)}`];
	const body = clip(turn.text, TURN_CHARS);
	if (body) lines.push(body);
	for (const tool of turn.tools) {
		lines.push(`  ⮑ ${tool.name}${tool.brief ? ` (${tool.brief})` : ""}`);
		if (tool.result) lines.push(`     ${tool.isError ? "✗" : "↳"} ${tool.result}`);
	}
	return lines.join("\n");
}

export interface ReadOptions {
	session?: string;
	file?: string;
	path?: string;
	turns?: number;
	offset?: number;
	maxChars?: number;
	includeThinking?: boolean;
	worktrees?: boolean;
	profile?: string;
}

/** Resolve a session id (full or prefix) to exactly one transcript file. */
export function resolveSession(cwd: string, options: ReadOptions): { file: string } | { error: string } {
	if (options.file) return { file: options.file };
	const wanted = (options.session ?? "").trim();
	if (!wanted) return { error: 'resume_session: mode "read" needs `session` (an id or id prefix) or `file`.' };
	const project = repoRoot(options.path ?? cwd);
	const root = sessionsRoot(options.profile);
	const family = options.worktrees === false ? [] : listWorktrees(project);
	const accept = acceptedPaths(family, project);
	const matches = candidates(root, accept).filter(
		(candidate) => candidate.head.id.startsWith(wanted) || basename(candidate.file).includes(wanted),
	);
	if (matches.length === 1) return { file: matches[0].file };
	if (matches.length === 0) {
		return { error: `resume_session: no session under ${root} for this project matches "${wanted}".` };
	}
	const ids = matches.map((candidate) => candidate.head.id.slice(0, 12)).join(", ");
	return { error: `resume_session: ${wanted} matches ${matches.length} sessions (${ids}). Use a longer prefix.` };
}

export function renderRead(transcript: Transcript, options: ReadOptions): string {
	const { meta, turns } = transcript;
	const perWindow = options.turns && options.turns > 0 ? options.turns : DEFAULT_TURNS;
	const offset = options.offset && options.offset > 0 ? options.offset : 0;
	const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_CHARS;
	const total = turns.length;
	const end = total - offset;
	if (end <= 0) {
		return withCost(`No turns at offset ${offset} (session ${meta.id.slice(0, 8)} has ${total} turns).`);
	}
	const start = Math.max(0, end - perWindow);

	// Render newest first, stopping when the char budget runs out rather than
	// truncating mid-turn: a partial turn reads as a complete one and misleads.
	const rendered: string[] = [];
	let used = 0;
	for (let i = end - 1; i >= start; i -= 1) {
		const block = renderTurn(turns[i], i + 1);
		if (used + block.length > maxChars && rendered.length > 0) break;
		if (transcript.compactionAfter.includes(i + 1)) {
			rendered.push("--- compaction: earlier turns were summarized away in the original run ---");
		}
		rendered.push(block);
		used += block.length;
	}
	const shown = rendered.filter((block) => block.startsWith("### ")).length;

	const out = [
		"# Session resume context",
		`session: ${meta.id}  |  branch: ${meta.branch || "?"}${meta.branchTier && !EXACT_TIERS[meta.branchTier] ? " (inferred)" : ""}  |  turns: ${total}`,
		`cwd: ${meta.cwd || "?"}`,
	];
	if (meta.title) out.push(`title: ${meta.title}`);
	out.push(`last active: ${absoluteTime(meta.lastActiveMs)} (${relativeTime(meta.lastActiveMs)})`);
	if (meta.exitReason) out.push(`session end: ${meta.exitReason}`);
	out.push(`window: turns ${end - shown + 1}..${end} of ${total} (newest first)`);
	if (meta.compactions > 0) {
		out.push(
			`compactions: ${meta.compactions} — turns before a compaction survive only as its summary.`,
			...transcript.compactionSummaries.map((summary) => `  · ${summary}`),
		);
	}
	out.push("");

	if (transcript.todoPhases.length > 0) {
		out.push("## Latest plan / todo state", ...renderTodos(transcript.todoPhases), "");
	}
	out.push("## Recent turns (newest first)", ...rendered);

	const older = offset + shown;
	out.push("", "---");
	if (older < total) {
		out.push(
			`Older context remains (${total - older} earlier turns). If the left-off state is still unclear, page back:`,
			`  resume_session mode="read" session="${meta.id.slice(0, 8)}" offset=${older} turns=${perWindow}`,
		);
	} else {
		out.push("Start of session reached — no older turns.");
	}
	out.push(
		"",
		"STOP. Summarize the goal, the last action, the todo state, branch/cwd, and what is incomplete;",
		"surface anything ambiguous, then wait for the user to confirm before resuming any work.",
	);
	return withCost(out.join("\n"));
}

export default function resumeSessionTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "resume_session",
		label: "Resume Session",
		description:
			'Read the OMP session store to resume a prior session. mode "list" prints worktree-aware, ' +
			'newest-first session summaries for a project (id, last active, turns, worked-on branch, ' +
			'drift against the checkout, title, and where it left off). mode "read" renders ONE session ' +
			"as turns, newest first, with the latest todo state and an estimated token cost. Read-only. " +
			"`history://` cannot address persisted sessions from earlier processes, which is why this " +
			"reads the store directly.",
		parameters: z.object({
			mode: z.enum(["list", "read"]),
			session: z.string().optional().describe('read: session id or id prefix, from a "list" row'),
			file: z.string().optional().describe("read: explicit transcript path, bypassing id lookup"),
			path: z.string().optional().describe("Project directory; defaults to the session cwd's repo root"),
			turns: z.number().optional().describe("read: turns per window (default 8)"),
			offset: z.number().optional().describe("read: skip this many newest turns to page older"),
			max_chars: z.number().optional().describe("read: hard cap on rendered window size (default 14000)"),
			include_thinking: z
				.boolean()
				.optional()
				.describe("read: keep thinking blocks — only when tool calls alone leave a logic gap"),
			limit: z.number().optional().describe("list: rows to print (default 12)"),
			worktrees: z.boolean().optional().describe("list/read: scan every worktree of the repo (default true)"),
			git: z.boolean().optional().describe("list: print the per-worktree git activity block (default true)"),
			profile: z.string().optional().describe("Named OMP profile whose store to read; defaults to the active one"),
		}),
		approval: "read",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				if (params.mode === "list") {
					const result = renderList(ctx.cwd, {
						path: params.path,
						worktrees: params.worktrees,
						git: params.git,
						limit: params.limit,
						profile: params.profile,
					});
					return {
						content: [{ type: "text" as const, text: result.text }],
						details: { mode: "list", sessions: result.count, ids: result.ids },
					};
				}
				const options: ReadOptions = {
					session: params.session,
					file: params.file,
					path: params.path,
					turns: params.turns,
					offset: params.offset,
					maxChars: params.max_chars,
					includeThinking: params.include_thinking,
					worktrees: params.worktrees,
					profile: params.profile,
				};
				const resolved = resolveSession(ctx.cwd, options);
				if ("error" in resolved) {
					return { content: [{ type: "text" as const, text: resolved.error }], details: { error: resolved.error } };
				}
				const transcript = parseTranscript(resolved.file, options.includeThinking === true);
				return {
					content: [{ type: "text" as const, text: renderRead(transcript, options) }],
					details: {
						mode: "read",
						session: transcript.meta.id,
						cwd: transcript.meta.cwd,
						branch: transcript.meta.branch,
						branchTier: transcript.meta.branchTier,
						turns: transcript.meta.turnCount,
						compactions: transcript.meta.compactions,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text" as const, text: `resume_session error: ${message}` }], details: { error: message } };
			}
		},
	});
}
