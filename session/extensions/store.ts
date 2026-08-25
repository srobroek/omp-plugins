/**
 * Reading the OMP session store.
 *
 * `history://<id>` cannot address these sessions: it resolves only agents
 * registered in the *current* process, so a persisted top-level session from a
 * previous `omp` run is invisible to it. Reading the raw store is therefore
 * required — but the output is rendered as a normalized transcript (turn-shaped,
 * newest-first), never as a jsonl dump.
 *
 * See ../skills/resume-session/references/transcript-format.md for the record
 * schema this module relies on.
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** ~4 chars per token for an English/code mix. Reported cost is uncached: the
 * window is generated fresh on every call, so none of it is a cache hit. */
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
 * Where the store lives: `<config>/agent/sessions`, or
 * `<config>/profiles/<profile>/agent/sessions` under a named profile. The
 * harness resolves the config root as `$HOME/${PI_CONFIG_DIR:-.omp}` and takes
 * the profile from `$OMP_PROFILE`/`$PI_PROFILE`; this mirrors that.
 */
export function sessionsRoot(profile?: string, env: NodeJS.ProcessEnv = process.env): string {
	// POSIX `$HOME` first: `os.homedir()` reads the passwd entry under Bun and so
	// ignores a relocated HOME, which both tests and `HOME`-scoped runs rely on.
	const config = join(env.HOME || homedir(), env.PI_CONFIG_DIR ?? ".omp");
	const name = profile ?? env.OMP_PROFILE ?? env.PI_PROFILE;
	return name ? join(config, "profiles", name, "agent", "sessions") : join(config, "agent", "sessions");
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
		} else if (!current) {
			continue;
		} else if (line.startsWith("HEAD ")) {
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
		out.set(parts[0], { epochMs: Number.isFinite(seconds) ? seconds * 1000 : null, subject: parts[2] });
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
// recovered from what it ran. Signals are tiered: git's own output is ground
// truth, an explicit branch-creating command is next, and a bare checkout or
// push argument is weakest. The last match in the strongest available tier wins,
// because a session ends on the branch it last moved to.
// ---------------------------------------------------------------------------

export type BranchTier = "observed" | "created" | "mentioned";

/**
 * `git` here tolerates global options before the subcommand (`git -C dir …`,
 * `dgit push …`), because that is how these commands are actually written.
 */
const GIT = String.raw`\b[a-z]*git(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+`;

const BRANCH_PATTERNS: Record<BranchTier, RegExp[]> = {
	observed: [
		/Switched to (?:a new )?branch '([^']+)'/g,
		/^On branch (\S+)$/gm,
		/^branch '([^']+)' set up to track/gm,
		/Your branch is (?:up to date with|ahead of) '[^'/]+\/([^']+)'/g,
	],
	created: [
		new RegExp(`${GIT}worktree\\s+add\\b[^\\n;&|]*?\\s-b\\s+(\\S+)`, "g"),
		new RegExp(`${GIT}(?:checkout|switch)\\s+(?:-b|-c|-B)\\s+(\\S+)`, "g"),
	],
	mentioned: [
		new RegExp(`${GIT}(?:checkout|switch)\\s+(?!-)(\\S+)`, "g"),
		new RegExp(`${GIT}push\\s+(?:--?\\S+\\s+)*\\S+\\s+(\\S+)`, "g"),
	],
};

const TIER_RANK: Record<BranchTier, number> = { observed: 3, created: 2, mentioned: 1 };
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
				const value = cleanBranch(match[1]);
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

/**
 * Identity from the leading records only: the `title` header (rewritten in
 * place, which is what its `pad` field is for, so `updatedAt` is the live
 * last-active time) and the `session` record that names the cwd. Returns null
 * when no `session` record is in the window — the file is not a usable session.
 */
export function readHead(file: string, maxBytes = 16 * 1024): HeadInfo | null {
	let window: string;
	try {
		const length = Math.min(statSync(file).size, maxBytes);
		if (length === 0) return null;
		const buffer = Buffer.alloc(length);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buffer, 0, length, 0);
		} finally {
			closeSync(fd);
		}
		window = buffer.toString("utf8");
	} catch {
		return null;
	}
	const info: HeadInfo = {
		id: basename(file).replace(/\.jsonl$/, "").replace(/^[^_]*_/, ""),
		cwd: "",
		title: "",
		updatedAtMs: null,
		startedAtMs: null,
		continuedFrom: 0,
	};
	// Identity records lead the file; a truncated final line of the window is
	// expected, not a defect, so a parse failure just skips that line.
	for (const line of window.split("\n").slice(0, 12)) {
		if (!line.startsWith("{")) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type === "title") {
			if (typeof record.title === "string") info.title = record.title;
			info.updatedAtMs = parseTimestamp(record.updatedAt);
		} else if (record.type === "session") {
			if (typeof record.cwd === "string") info.cwd = record.cwd;
			if (typeof record.id === "string") info.id = record.id;
			info.startedAtMs = parseTimestamp(record.timestamp);
			if (Array.isArray(record.previousSessionFiles)) info.continuedFrom = record.previousSessionFiles.length;
		}
	}
	return info.cwd ? info : null;
}

/**
 * Parse one transcript into turns. `toolResult` records are folded into the
 * assistant turn that called them, so a window is conversation-shaped rather
 * than record-shaped. Thinking blocks are dropped unless asked for: they are the
 * bulk of the bytes and rarely the evidence needed.
 *
 * The whole file is read: the largest real transcript on record (21 MB, 6.2k
 * records) parses in ~40 ms, so windowing the read would buy nothing and would
 * make the turn count a guess.
 */
export function parseTranscript(file: string, includeThinking = false): Transcript {
	const raw = readFileSync(file, "utf8");
	const head = readHead(file);
	const turns: Turn[] = [];
	const pendingTools = new Map<string, ToolTrace>();
	const branch = new BranchTracker();
	let todoPhases: TodoPhase[] = [];
	let lastMs: number | null = head?.updatedAtMs ?? null;
	let exitReason = "";
	let compactions = 0;
	const compactionAfter: number[] = [];
	const compactionSummaries: string[] = [];

	for (const line of raw.split("\n")) {
		if (!line.startsWith("{")) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const ts = parseTimestamp(record.timestamp);
		if (ts !== null && (lastMs === null || ts > lastMs)) lastMs = ts;

		if (record.type === "compaction") {
			compactions += 1;
			compactionAfter.push(turns.length);
			const summary = typeof record.shortSummary === "string" ? record.shortSummary : "";
			if (summary) compactionSummaries.push(oneLine(clip(summary, 400)));
			continue;
		}
		if (record.type === "custom" && record.customType === "session_exit") {
			const data = record.data as { reason?: string; kind?: string } | undefined;
			exitReason = [data?.kind, data?.reason].filter(Boolean).join("/");
			continue;
		}
		if (record.type !== "message") continue;

		const message = record.message as Record<string, unknown> | undefined;
		if (!message) continue;
		const role = message.role;

		if (role === "toolResult") {
			const trace = pendingTools.get(String(message.toolCallId ?? ""));
			if (trace) {
				trace.result = clip(oneLine(textOf(message.content)), 240);
				trace.isError = message.isError === true;
			}
			if (message.toolName === "bash") branch.offer(textOf(message.content), "observed");
			if (message.toolName === "todo") {
				// The todo result carries the whole board, so the newest one is the
				// authoritative plan state; reconstructing it from ops is not needed.
				const phases = (message.details as { phases?: unknown } | undefined)?.phases;
				if (Array.isArray(phases)) {
					const rebuilt = (phases as Record<string, unknown>[]).map((phase) => ({
						name: typeof phase.name === "string" ? phase.name : "",
						tasks: (Array.isArray(phase.tasks) ? (phase.tasks as Record<string, unknown>[]) : []).map(
							(task) => ({
								content: typeof task.content === "string" ? task.content : "",
								status: typeof task.status === "string" ? task.status : "",
							}),
						),
					}));
					const usable = rebuilt.filter((phase) => phase.tasks.length > 0);
					if (usable.length > 0) todoPhases = usable;
				}
			}
			continue;
		}

		if (role !== "user" && role !== "assistant") continue; // developer/system noise

		const tools: ToolTrace[] = [];
		const parts: string[] = [];
		const content = message.content;
		if (typeof content === "string") {
			parts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					parts.push(b.text);
				} else if (b.type === "thinking" && includeThinking && typeof b.thinking === "string") {
					parts.push(`[thinking] ${b.thinking}`);
				} else if (b.type === "toolCall") {
					const name = typeof b.name === "string" ? b.name : "?";
					const trace: ToolTrace = {
						name,
						brief: typeof b.intent === "string" && b.intent ? oneLine(b.intent) : briefArgs(b.arguments),
						result: "",
						isError: false,
					};
					tools.push(trace);
					if (typeof b.id === "string") pendingTools.set(b.id, trace);
					const command = (b.arguments as { command?: unknown } | undefined)?.command;
					if (name === "bash" && typeof command === "string") {
						branch.offer(command, "created");
						branch.offer(command, "mentioned");
					}
				}
			}
		}

		turns.push({ role, timestampMs: ts, text: parts.join("\n").trim(), tools });
	}

	// Turns with neither prose nor a tool call are protocol artefacts; rendering
	// them would spend the window budget on nothing.
	const kept = turns.filter((turn) => turn.text !== "" || turn.tools.length > 0);
	let leftOff = "";
	for (let i = kept.length - 1; i >= 0; i -= 1) {
		if (kept[i].role === "assistant" && kept[i].text) {
			leftOff = oneLine(kept[i].text);
			break;
		}
	}
	const best = branch.get();

	return {
		meta: {
			id: head?.id ?? basename(file).replace(/\.jsonl$/, ""),
			file,
			cwd: head?.cwd ?? "",
			title: head?.title ?? "",
			lastActiveMs: lastMs,
			turnCount: kept.length,
			branch: best?.branch ?? "",
			branchTier: best?.tier ?? null,
			leftOff,
			exitReason,
			compactions,
			bytes: raw.length,
			continuedFrom: head?.continuedFrom ?? 0,
		},
		turns: kept,
		todoPhases,
		compactionAfter,
		compactionSummaries,
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
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		let children: string[];
		try {
			children = readdirSync(dir);
		} catch {
			continue;
		}
		for (const child of children) {
			if (child.endsWith(".jsonl")) out.push(join(dir, child));
		}
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

/**
 * Store files whose recorded `cwd` is one of `accept`.
 *
 * Matching on the recorded cwd rather than on a reversed directory-name encoding
 * is what makes this worktree-safe: the store's `<escaped-cwd>` directory names
 * are lossy (`~/tmp` and `/tmp` both flatten toward `-tmp`-shaped names), while
 * the `session` record states the cwd outright.
 */
export function candidates(root: string, accept: Set<string>): Candidate[] {
	const out: Candidate[] = [];
	for (const file of storeFiles(root)) {
		const head = readHead(file);
		if (!head) continue;
		if (!pathKeys(head.cwd).some((key) => accept.has(key))) continue;
		out.push({ file, head });
	}
	return out;
}

/** The accept-set for a project: every live worktree of it, or the project alone. */
export function acceptedPaths(worktrees: Worktree[], project: string): Set<string> {
	const paths = worktrees.length > 0 ? worktrees.map((w) => w.path) : [project];
	return new Set(paths.flatMap((path) => pathKeys(path)));
}
