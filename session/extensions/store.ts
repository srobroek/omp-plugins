/** Selective handoffs from persisted top-level sessions, using native read-only APIs. */
import { execFileSync } from "node:child_process";
import { type Dir, type Dirent, existsSync, opendirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	type FileEntry,
	FileSessionStorage,
	listSessionsReadOnly,
	visitEntriesFromFileStream,
} from "@oh-my-pi/pi-coding-agent";
import { getActiveProfile, getProfileRootDir, getSessionsDir, normalizeProfileName } from "@oh-my-pi/pi-utils";

interface FileSnapshot {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}
function isMissingFile(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { code?: unknown };
	return candidate.code === "ENOENT";
}
function snapshotFile(file: string): FileSnapshot {
	const info = statSync(file);
	if (!info.isFile()) throw new Error(`Transcript must be a regular file: ${file}`);
	return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

function assertUnchanged(file: string, before: FileSnapshot): void {
	const after = snapshotFile(file);
	if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
		throw new Error(
			`Transcript changed while being read: ${file}. Retry after the session stops writing; no partial result was returned.`,
		);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("The operation was aborted", "AbortError");
}

/** Approximate text tokens for handoff-size reporting, not provider cache metrics. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function clip(text: string, limit: number): string {
	const trimmed = (text ?? "").trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit).trimEnd()} …[+${trimmed.length - limit} chars]`;
}

/** Collapse to one line — `↳ left off:` rows must not break the listing. */
export function oneLine(text: string): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Resolve the native active store, or a named profile's store without
 * activating it. Native XDG profile roots are selected only once their
 * profile-specific directory exists; that is the resolver's migration boundary.
 */
export function sessionsRoot(profile?: string): string {
	if (profile === undefined) return getSessionsDir();

	const normalized = normalizeProfileName(profile);
	if (normalized === getActiveProfile()) return getSessionsDir();

	const profileRoot = getProfileRootDir(normalized);
	if (process.platform === "linux" || process.platform === "darwin") {
		const xdgDataHome = process.env.XDG_DATA_HOME;
		if (xdgDataHome) {
			const xdgProfileRoot = join(xdgDataHome, "omp", ...(normalized ? ["profiles", normalized] : []));
			try {
				if (existsSync(xdgProfileRoot)) return join(xdgProfileRoot, "sessions");
			} catch {}
		}
	}
	return getSessionsDir(join(profileRoot, "agent"));
}

export interface Worktree {
	path: string;
	head: string;
	branch: string;
	detached: boolean;
	isMain: boolean;
}

function git(args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch {
		return null;
	}
}

/**
 * Live worktrees of the repo containing `project`, main checkout first.
 *
 * A session for this project may live in ANY worktree of the same repo: each has
 * its own cwd, so each gets its own transcripts. `git worktree list` from
 * anywhere in the family returns the whole family, so enumerate once and accept
 * every member. Returns [] when `project` is not inside a git repo — the caller
 * then falls back to `project` alone.
 */
export function listWorktrees(project: string): Worktree[] {
	const out = git(["-C", project, "worktree", "list", "--porcelain"]);
	if (out === null) return [];
	const parsed: (Worktree & { prunable: boolean })[] = [];
	let current: (Worktree & { prunable: boolean }) | null = null;
	for (const line of out.split("\n")) {
		if (line.trim() === "") {
			if (current) parsed.push(current);
			current = null;
			continue;
		}
		if (line.startsWith("worktree ")) {
			current = {
				path: line.slice("worktree ".length),
				head: "",
				branch: "",
				detached: false,
				isMain: false,
				prunable: false,
			};
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length);
			// Keep multi-segment names intact: refs/heads/foo/bar -> foo/bar.
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		} else if (line === "detached") {
			current.detached = true;
		} else if (line.startsWith("prunable")) {
			current.prunable = true;
		}
	}
	if (current) parsed.push(current);
	const live: Worktree[] = [];
	parsed.forEach((w, index) => {
		if (w.prunable || !existsSync(w.path)) return;
		// `git worktree list --porcelain` always emits the main checkout first.
		live.push({ path: w.path, head: w.head, branch: w.branch, detached: w.detached, isMain: index === 0 });
	});
	return live;
}

export interface CommitInfo {
	epochMs: number | null;
	subject: string;
}

/** HEAD sha -> (commit time, subject) for every worktree, in one git call. The
 * recency of the last commit is the second signal, alongside transcript
 * activity, for which worktree was last worked in. */
export function commitInfo(worktrees: Worktree[], project: string): Map<string, CommitInfo> {
	const out = new Map<string, CommitInfo>();
	const heads = [...new Set(worktrees.map((w) => w.head).filter(Boolean))].sort();
	if (heads.length === 0) return out;
	const raw = git(["-C", project, "show", "-s", "--format=%H%x00%ct%x00%s", ...heads]);
	if (raw === null) return out;
	for (const line of raw.split("\n")) {
		const parts = line.split("\0");
		if (parts.length !== 3) continue;
		const seconds = Number(parts[1]);
		const head = parts[0];
		const subject = parts[2];
		if (head === undefined || subject === undefined) continue;
		out.set(head, { epochMs: Number.isFinite(seconds) ? seconds * 1000 : null, subject });
	}
	return out;
}

/** Uncommitted changes are a strong "still active here" hint. */
export function isDirty(path: string): boolean {
	const out = git(["-C", path, "status", "--porcelain"]);
	return out !== null && out.trim() !== "";
}

export function repoRoot(cwd: string): string {
	const out = git(["-C", cwd, "rev-parse", "--show-toplevel"]);
	return out === null ? cwd : out.trim() || cwd;
}

// ---------------------------------------------------------------------------
// Branch recovery
//
// No record carries a git branch, so the branch a session worked on has to be
// recovered from what it ran, and the signals are not equally trustworthy. Only
// a switch confirmation states that THIS session moved onto a branch. Status
// output is genuine git output but describes whatever directory the command ran
// in, which for an orchestrating session may be a sibling worktree. A bare
// command is weaker still: it may have failed. The latest sighting in the
// strongest tier available wins, because a session ends on the branch it last
// moved to.
// ---------------------------------------------------------------------------

export type BranchTier = "switched" | "status" | "created" | "mentioned";

/**
 * `git` here tolerates global options before the subcommand (`git -C dir …`,
 * `dgit push …`), because that is how these commands are actually written.
 */
const GIT = String.raw`\b[a-z]*git(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+`;

const BRANCH_PATTERNS: Record<BranchTier, RegExp[]> = {
	switched: [/Switched to (?:a new )?branch '([^']+)'/g, /^branch '([^']+)' set up to track/gm],
	status: [/^On branch (\S+)$/gm, /Your branch is (?:up to date with|ahead of) '[^'/]+\/([^']+)'/g],
	created: [
		new RegExp(`${GIT}worktree\\s+add\\b[^\\n;&|]*?\\s-b\\s+(\\S+)`, "g"),
		new RegExp(`${GIT}(?:checkout|switch)\\s+(?:-b|-c|-B)\\s+(\\S+)`, "g"),
	],
	mentioned: [
		new RegExp(`${GIT}(?:checkout|switch)\\s+(?!-)(\\S+)`, "g"),
		new RegExp(`${GIT}push\\s+(?:--?\\S+\\s+)*\\S+\\s+(\\S+)`, "g"),
	],
};

/** Tiers below this are labelled `(inferred)`: git never confirmed them. */
export const EXACT_TIERS: Record<BranchTier, boolean> = {
	switched: true,
	status: true,
	created: false,
	mentioned: false,
};

const TIER_RANK: Record<BranchTier, number> = { switched: 4, status: 3, created: 2, mentioned: 1 };
const NOT_A_BRANCH: Record<string, true> = {
	HEAD: true,
	"--": true,
	"-": true,
	"@": true,
	FETCH_HEAD: true,
	ORIG_HEAD: true,
};

function cleanBranch(raw: string): string | null {
	// A `src:dst` push names the remote branch on the right.
	let value = raw.includes(":") ? (raw.split(":").pop() ?? "") : raw;
	value = value.replace(/["'`]/g, "").replace(/^refs\/heads\//, "");
	if (!value || NOT_A_BRANCH[value] || /^[-/~$]/.test(value)) return null;
	if (/\.[a-z]{1,5}$/.test(value)) return null; // `git checkout package.json`
	if (/^[0-9a-f]{7,40}$/.test(value)) return null; // a sha, not a branch
	if (!/^[A-Za-z0-9._/-]+$/.test(value)) return null;
	return value;
}

/**
 * Accumulates branch evidence across a transcript, keeping the latest sighting
 * from the strongest tier seen so far.
 */
export class BranchTracker {
	private best: { branch: string; tier: BranchTier } | null = null;

	offer(text: string, tier: BranchTier): void {
		if (this.best && TIER_RANK[this.best.tier] > TIER_RANK[tier]) return;
		let found: string | null = null;
		for (const pattern of BRANCH_PATTERNS[tier]) {
			for (const match of text.matchAll(pattern)) {
				const raw = match[1];
				if (raw === undefined) continue;
				const value = cleanBranch(raw);
				if (value) found = value; // later evidence within one text wins
			}
		}
		if (found) this.best = { branch: found, tier };
	}

	get(): { branch: string; tier: BranchTier } | null {
		return this.best;
	}
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

export interface TodoTask {
	content: string;
	status: string;
}
export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface ToolTrace {
	name: string;
	brief: string;
	result: string;
	isError: boolean;
}

export interface Turn {
	role: "user" | "assistant";
	timestampMs: number | null;
	text: string;
	tools: ToolTrace[];
}

export interface SessionMeta {
	id: string;
	file: string;
	cwd: string;
	title: string;
	lastActiveMs: number | null;
	turnCount: number;
	branch: string;
	branchTier: BranchTier | null;
	leftOff: string;
	exitReason: string;
	compactions: number;
	bytes: number;
	continuedFrom: number;
}

export interface Transcript {
	meta: SessionMeta;
	turns: Turn[];
	/** Global chronological index of the first retained turn. */
	windowStart: number;
	todoPhases: TodoPhase[];
	/** Turn indices a compaction landed after, so the render can mark the gap. */
	compactionAfter: number[];
	compactionSummaries: string[];
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || !value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const value = (block as { text?: unknown }).text;
			if (typeof value === "string") parts.push(value);
		}
	}
	return parts.join("\n");
}

const BRIEF_KEYS = ["path", "command", "pattern", "file", "query", "op", "task", "to", "url", "i"];

/** One short, honest argument echo per tool call — never the whole payload. */
export function briefArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of BRIEF_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return oneLine(clip(value, 120));
		if (typeof value === "number" || typeof value === "boolean") return String(value);
	}
	return "";
}

export interface HeadInfo {
	id: string;
	cwd: string;
	title: string;
	updatedAtMs: number | null;
	startedAtMs: number | null;
	continuedFrom: number;
}

interface LegacyTitleRecord {
	type: "title";
	title?: unknown;
	updatedAt?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedBytes(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * Identity from the leading records only: the `title` header (rewritten in
 * place, which is what its `pad` field is for, so `updatedAt` is the live
 * last-active time) and the `session` record that names the cwd. Returns null
 * when no `session` record is in the window — the file is not a usable session.
 */
export async function readHead(file: string, maxBytes = 16 * 1024): Promise<HeadInfo | null> {
	let snapshot: FileSnapshot;
	try {
		snapshot = snapshotFile(file);
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
	const info: HeadInfo = {
		id: basename(file)
			.replace(/\.jsonl$/, "")
			.replace(/^[^_]*_/, ""),
		cwd: "",
		title: "",
		updatedAtMs: null,
		startedAtMs: null,
		continuedFrom: 0,
	};
	const limit = boundedBytes(maxBytes, 16 * 1024);
	const titleSlot = await visitEntriesFromFileStream(
		file,
		(entry: FileEntry | LegacyTitleRecord) => {
			if (!isRecord(entry)) return;
			if (entry.type === "title") {
				if (typeof entry.title === "string") info.title = entry.title;
				info.updatedAtMs = parseTimestamp(entry.updatedAt);
				return;
			}
			if (entry.type !== "session") return;
			if (typeof entry.cwd === "string") info.cwd = entry.cwd;
			if (typeof entry.id === "string") info.id = entry.id;
			info.startedAtMs = parseTimestamp(entry.timestamp);
			if (Array.isArray(entry.previousSessionFiles)) info.continuedFrom = entry.previousSessionFiles.length;
			if (typeof entry.title === "string") info.title = entry.title;
		},
		{
			maxBytes: limit,
		},
	);
	if (titleSlot) {
		if (typeof titleSlot.title === "string") info.title = titleSlot.title;
		info.updatedAtMs = parseTimestamp(titleSlot.updatedAt);
	}
	assertUnchanged(file, snapshot);
	return info.cwd ? info : null;
}

/**
 * Parse one transcript into turns. `toolResult` records are folded into the
 * assistant turn that called them, so a window is conversation-shaped rather
 * than record-shaped. Thinking blocks are dropped unless asked for: they are
 * the bulk of the bytes and rarely the evidence needed.
 *
 * The native visitor streams each pass from a bounded file snapshot. The first
 * pass computes exact filtered metadata; the second retains only the requested
 * turn window and tool ids belonging to that window.
 */
interface ParsedTurn {
	turn: Turn;
	toolCalls: Array<{ id: string; trace: ToolTrace }>;
	branchCommands: string[];
}

interface ScanState {
	head: HeadInfo;
	lastMs: number | null;
	turnCount: number;
	leftOff: string;
	branch: BranchTracker;
	todoPhases: TodoPhase[];
	exitReason: string;
	compactions: number;
	compactionAfter: number[];
	compactionSummaries: string[];
}

function newScanState(file: string): ScanState {
	return {
		head: {
			id: basename(file)
				.replace(/\.jsonl$/, "")
				.replace(/^[^_]*_/, ""),
			cwd: "",
			title: "",
			updatedAtMs: null,
			startedAtMs: null,
			continuedFrom: 0,
		},
		lastMs: null,
		turnCount: 0,
		leftOff: "",
		branch: new BranchTracker(),
		todoPhases: [],
		exitReason: "",
		compactions: 0,
		compactionAfter: [],
		compactionSummaries: [],
	};
}

function updateHead(state: ScanState, record: Record<string, unknown>): void {
	if (record.type === "title") {
		if (typeof record.title === "string") state.head.title = record.title;
		state.head.updatedAtMs = parseTimestamp(record.updatedAt);
		return;
	}
	if (record.type !== "session") return;
	if (typeof record.cwd === "string") state.head.cwd = record.cwd;
	if (typeof record.id === "string") state.head.id = record.id;
	state.head.startedAtMs = parseTimestamp(record.timestamp);
	if (Array.isArray(record.previousSessionFiles)) state.head.continuedFrom = record.previousSessionFiles.length;
	if (typeof record.title === "string") state.head.title = record.title;
}

function updateLastTimestamp(state: ScanState, record: Record<string, unknown>): void {
	const timestamp = parseTimestamp(record.timestamp);
	if (timestamp !== null && (state.lastMs === null || timestamp > state.lastMs)) state.lastMs = timestamp;
}

function parseTurn(record: Record<string, unknown>, includeThinking: boolean): ParsedTurn | null {
	if (record.type !== "message" || !isRecord(record.message)) return null;
	const message = record.message;
	if (message.role !== "user" && message.role !== "assistant") return null;
	const parts: string[] = [];
	const tools: ToolTrace[] = [];
	const toolCalls: Array<{ id: string; trace: ToolTrace }> = [];
	const branchCommands: string[] = [];
	if (typeof message.content === "string") {
		parts.push(message.content);
	} else if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			} else if (block.type === "thinking" && includeThinking && typeof block.thinking === "string") {
				parts.push(`[thinking] ${block.thinking}`);
			} else if (block.type === "toolCall") {
				const name = typeof block.name === "string" ? block.name : "?";
				const trace: ToolTrace = {
					name,
					brief: typeof block.intent === "string" && block.intent ? oneLine(block.intent) : briefArgs(block.arguments),
					result: "",
					isError: false,
				};
				const argumentsRecord = isRecord(block.arguments) ? block.arguments : undefined;
				const command = typeof argumentsRecord?.command === "string" ? argumentsRecord.command : undefined;
				if (name === "bash" && command) branchCommands.push(command);
				tools.push(trace);
				if (typeof block.id === "string") toolCalls.push({ id: block.id, trace });
			}
		}
	}

	const text = parts.join("\n").trim();
	if (text === "" && tools.length === 0) return null;
	return {
		turn: {
			role: message.role,
			timestampMs: parseTimestamp(record.timestamp),
			text,
			tools,
		},
		toolCalls,
		branchCommands,
	};
}

function applyTodoResult(state: ScanState, message: Record<string, unknown>): void {
	if (message.toolName !== "todo" || !isRecord(message.details) || !Array.isArray(message.details.phases)) return;
	const phases: TodoPhase[] = [];
	for (const phase of message.details.phases) {
		if (!isRecord(phase)) continue;
		const tasks: TodoTask[] = [];
		if (Array.isArray(phase.tasks)) {
			for (const task of phase.tasks) {
				if (!isRecord(task)) continue;
				tasks.push({
					content: typeof task.content === "string" ? task.content : "",
					status: typeof task.status === "string" ? task.status : "",
				});
			}
		}
		if (tasks.length > 0) phases.push({ name: typeof phase.name === "string" ? phase.name : "", tasks });
	}
	state.todoPhases = phases;
}

function applyToolResult(
	state: ScanState | undefined,
	message: Record<string, unknown>,
	pendingTools?: Map<string, ToolTrace>,
): void {
	const toolCallId = String(message.toolCallId ?? "");
	const trace = pendingTools?.get(toolCallId);
	if (trace) {
		trace.result = clip(oneLine(textOf(message.content)), 240);
		trace.isError = message.isError === true;
	}
	if (!state) return;
	if (message.toolName === "bash") {
		const output = textOf(message.content);
		state.branch.offer(output, "switched");
		state.branch.offer(output, "status");
	}
	applyTodoResult(state, message);
}

function applyToolBranches(state: ScanState, parsed: ParsedTurn): void {
	for (const command of parsed.branchCommands) {
		state.branch.offer(command, "created");
		state.branch.offer(command, "mentioned");
	}
}

function scanRecord(state: ScanState, value: unknown, includeThinking: boolean): void {
	if (!isRecord(value)) return;
	updateHead(state, value);
	updateLastTimestamp(state, value);

	if (value.type === "compaction") {
		state.compactions += 1;
		state.compactionAfter.push(state.turnCount);
		if (typeof value.shortSummary === "string" && value.shortSummary) {
			state.compactionSummaries.push(oneLine(clip(value.shortSummary, 400)));
		}
		return;
	}
	if (value.type === "custom" && value.customType === "session_exit") {
		const data = isRecord(value.data) ? value.data : undefined;
		const kind = typeof data?.kind === "string" ? data.kind : "";
		const reason = typeof data?.reason === "string" ? data.reason : "";
		state.exitReason = [kind, reason].filter(Boolean).join("/");
		return;
	}
	if (value.type !== "message" || !isRecord(value.message)) return;
	const message = value.message;
	if (message.role === "toolResult") {
		applyToolResult(state, message);
		return;
	}
	const parsed = parseTurn(value, includeThinking);
	if (!parsed) return;
	applyToolBranches(state, parsed);
	state.turnCount += 1;
	if (parsed.turn.role === "assistant" && parsed.turn.text) state.leftOff = oneLine(parsed.turn.text);
}

function applyTitleSlot(state: ScanState, titleSlot: { title?: string; updatedAt: string } | undefined): void {
	if (!titleSlot) return;
	if (typeof titleSlot.title === "string") state.head.title = titleSlot.title;
	const updatedAt = parseTimestamp(titleSlot.updatedAt);
	if (updatedAt !== null) {
		state.head.updatedAtMs = updatedAt;
		if (state.lastMs === null || updatedAt > state.lastMs) state.lastMs = updatedAt;
	}
}

async function scanMetadataPass(
	file: string,
	snapshot: FileSnapshot,
	includeThinking: boolean,
	signal?: AbortSignal,
): Promise<ScanState> {
	throwIfAborted(signal);
	const state = newScanState(file);
	const titleSlot = await visitEntriesFromFileStream(
		file,
		(entry) => {
			throwIfAborted(signal);
			scanRecord(state, entry, includeThinking);
		},
		{
			maxBytes: snapshot.size,
			shouldContinue: () => {
				throwIfAborted(signal);
				return true;
			},
		},
	);
	throwIfAborted(signal);
	applyTitleSlot(state, titleSlot);
	assertUnchanged(file, snapshot);
	return state;
}

async function collectWindowPass(
	file: string,
	snapshot: FileSnapshot,
	includeThinking: boolean,
	start: number,
	end: number,
	signal?: AbortSignal,
): Promise<Turn[]> {
	throwIfAborted(signal);
	const turns: Turn[] = [];
	const pendingTools = new Map<string, ToolTrace>();
	let filteredIndex = 0;
	await visitEntriesFromFileStream(
		file,
		(entry) => {
			throwIfAborted(signal);
			if (!isRecord(entry)) return;
			if (entry.type !== "message" || !isRecord(entry.message)) return;
			const message = entry.message;
			if (message.role === "toolResult") {
				applyToolResult(undefined, message, pendingTools);
				return;
			}
			const parsed = parseTurn(entry, includeThinking);
			if (!parsed) return;
			const index = filteredIndex++;
			if (index < start || index >= end) return;
			turns.push(parsed.turn);
			for (const { id, trace } of parsed.toolCalls) pendingTools.set(id, trace);
		},
		{
			maxBytes: snapshot.size,
			shouldContinue: () => {
				throwIfAborted(signal);
				return true;
			},
		},
	);
	throwIfAborted(signal);
	assertUnchanged(file, snapshot);
	return turns;
}

function toMeta(file: string, snapshot: FileSnapshot, state: ScanState): SessionMeta {
	const best = state.branch.get();
	const headTime = state.head.updatedAtMs;
	const lastActiveMs =
		state.lastMs === null ? headTime : headTime === null ? state.lastMs : Math.max(state.lastMs, headTime);
	return {
		id: state.head.id,
		file,
		cwd: state.head.cwd,
		title: state.head.title,
		lastActiveMs,
		turnCount: state.turnCount,
		branch: best?.branch ?? "",
		branchTier: best?.tier ?? null,
		leftOff: state.leftOff,
		exitReason: state.exitReason,
		compactions: state.compactions,
		bytes: snapshot.size,
		continuedFrom: state.head.continuedFrom,
	};
}

function requestedWindow(
	count: number,
	window: { offset?: number; turns?: number } | undefined,
): { start: number; end: number } {
	const rawOffset = window?.offset ?? 0;
	const rawTurns = window?.turns ?? 8;
	const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
	const turns = Number.isFinite(rawTurns) && rawTurns > 0 ? Math.max(1, Math.floor(rawTurns)) : 8;
	const end = Math.max(0, count - offset);
	return { start: Math.max(0, end - turns), end };
}

export async function scanTranscriptMeta(file: string, signal?: AbortSignal): Promise<SessionMeta> {
	const snapshot = snapshotFile(file);
	const state = await scanMetadataPass(file, snapshot, false, signal);
	return toMeta(file, snapshot, state);
}

export async function parseTranscript(
	file: string,
	includeThinking = false,
	window?: { offset?: number; turns?: number },
	signal?: AbortSignal,
): Promise<Transcript> {
	const snapshot = snapshotFile(file);
	const state = await scanMetadataPass(file, snapshot, includeThinking, signal);
	const page = requestedWindow(state.turnCount, window);
	const turns =
		page.start < page.end ? await collectWindowPass(file, snapshot, includeThinking, page.start, page.end, signal) : [];
	throwIfAborted(signal);
	assertUnchanged(file, snapshot);
	return {
		meta: toMeta(file, snapshot, state),
		turns,
		windowStart: page.start,
		todoPhases: state.todoPhases,
		compactionAfter: state.compactionAfter,
		compactionSummaries: state.compactionSummaries,
	};
}

// ---------------------------------------------------------------------------
// Store enumeration
// ---------------------------------------------------------------------------

/**
 * Every transcript file in the store. A sibling directory named like a
 * transcript stem holds that session's spilled tool output (`<n>.<tool>.log`),
 * so only `*.jsonl` one level under the root counts.
 */
export function storeFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const dirs = opendirSync(root);
	try {
		for (let entry = dirs.readSync(); entry; entry = dirs.readSync()) {
			if (!entry.isDirectory()) continue;
			const dir = join(root, entry.name);
			let children: Dir;
			try {
				children = opendirSync(dir);
			} catch {
				continue;
			}
			try {
				for (let child = children.readSync(); child; child = children.readSync()) {
					if (child.isFile() && child.name.endsWith(".jsonl")) out.push(join(dir, child.name));
				}
			} finally {
				children.closeSync();
			}
		}
	} finally {
		dirs.closeSync();
	}
	return out;
}

export interface Candidate {
	file: string;
	head: HeadInfo;
}

/**
 * Every distinct spelling of `path` a recorded cwd might use.
 *
 * A session records the cwd it was started in, which on macOS is commonly the
 * symlinked spelling (`/tmp/x`), while `git rev-parse --show-toplevel` answers
 * with the resolved one (`/private/tmp/x`). Accepting both spellings is what
 * keeps those two views of the same directory from silently missing each other.
 */
export function pathKeys(path: string): string[] {
	const keys = [path.replace(/\/+$/, "")];
	try {
		const resolved = realpathSync(path).replace(/\/+$/, "");
		if (resolved !== keys[0]) keys.push(resolved);
	} catch {
		// The directory is gone; the literal spelling is all we have.
	}
	return keys;
}

/** Match native session metadata against accepted worktree paths, not encoded directory names. */
export async function candidates(root: string, accept: Set<string>): Promise<Candidate[]> {
	if (!existsSync(root)) return [];
	const out: Candidate[] = [];
	const storage = new FileSessionStorage();
	let directories: Dirent[];
	try {
		directories = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const sessions = await listSessionsReadOnly(join(root, directory.name), storage);
		for (const session of sessions) {
			if (!pathKeys(session.cwd).some((key) => accept.has(key))) continue;
			const head = await readHead(session.path);
			if (head) out.push({ file: session.path, head });
		}
	}
	return out;
}

/** The accept-set for a project: every live worktree of it, or the project alone. */
export function acceptedPaths(worktrees: Worktree[], project: string): Set<string> {
	const paths = worktrees.length > 0 ? worktrees.map((w) => w.path) : [project];
	return new Set(paths.flatMap((path) => pathKeys(path)));
}
