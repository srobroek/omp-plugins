import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	acceptedPaths,
	candidates,
	listWorktrees,
	repoRoot,
	type SessionMeta,
	scanTranscriptMeta,
	sessionsRoot,
	type Worktree,
} from "./store";

const execFileAsync = promisify(execFile);
export const STATUS_BUDGET_MS = 12_000;
const PROBE_TIMEOUT_MS = 2_500;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_SESSIONS = 64;
const MAX_ROWS = 40;

type JsonRecord = Record<string, unknown>;

export type StatusScope = "project" | "global";
export type TranscriptOutcome = "live" | "open" | "complete" | "aborted" | "unknown";

export interface LiveSession {
	id: string;
	cwd: string;
	status: string;
	kind: string;
	branch: string;
	lastActivityMs: number | null;
}

export interface TranscriptRow {
	id: string;
	cwd: string;
	branch: string;
	outcome: TranscriptOutcome;
	lastActiveMs: number | null;
	title: string;
	file: string;
}

export interface BeadRow {
	id: string;
	title: string;
	status: string;
	assignee: string;
	branch: string;
}

export interface WorktreeRow {
	path: string;
	branch: string;
	head: string;
	dirty: string;
}

export interface ChangeRow {
	kind: "PR" | "MR";
	id: string;
	branch: string;
	state: string;
	url: string;
	base: string;
}

export interface ReleaseRow {
	name: string;
	version: string;
	source: string;
}

export interface StatusSources {
	live: LiveSession[];
	transcripts: TranscriptRow[];
	beads: BeadRow[];
	worktrees: WorktreeRow[];
	changes: ChangeRow[];
	releases: ReleaseRow[];
	warnings: string[];
}

export interface ReconciledSession {
	transcript: TranscriptRow;
	live: LiveSession | null;
	bead: BeadRow | null;
	change: ChangeRow | null;
	worktree: WorktreeRow | null;
}

export interface ReconciledStatus extends StatusSources {
	scope: StatusScope;
	project: string;
	sessions: ReconciledSession[];
	maxRows: number;
}
export interface StatusOptions {
	scope?: StatusScope;
	path?: string;
	maxRows?: number;
	profile?: string;
}

export interface CurrentSessionHint {
	id: string;
	cwd: string;
	file?: string;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type CommandRunner = (
	file: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<CommandResult>;

export interface StatusDependencies {
	run?: CommandRunner;
	readJson?: (file: string) => Promise<unknown>;
	live?: () => LiveSession[];
}

function record(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}


function oneLine(value: unknown): string {
	return text(value).replace(/\s+/g, " ");
}

function cell(value: unknown): string {
	return oneLine(value).replaceAll("|", "\\|") || "—";
}

function idOf(value: JsonRecord): string {
	return text(value.id ?? value.number ?? value.i ?? value.issue_id);
}

function nestedText(value: JsonRecord, keys: string[]): string {
	for (const key of keys) {
		const direct = text(value[key]);
		if (direct) return direct;
	}
	for (const key of ["metadata", "meta", "fields", "custom_fields"]) {
		const nested = record(value[key]);
		if (!nested) continue;
		for (const nestedKey of keys) {
			const found = text(nested[nestedKey]);
			if (found) return found;
		}
	}
	return "";
}

function parseJsonOutput(output: string): unknown {
	const trimmed = output.trim();
	if (!trimmed) return [];
	try {
		return JSON.parse(trimmed);
	} catch {
		const rows: unknown[] = [];
		for (const line of trimmed.split(/\r?\n/)) {
			try {
				rows.push(JSON.parse(line));
			} catch {
				// Human fallback output is handled by the caller as an unavailable source.
			}
		}
		return rows;
	}
}

function arrayPayload(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const object = record(value);
	if (!object) return [];
	for (const key of ["data", "items", "issues", "worktrees", "merge_requests", "pull_requests", "results"]) {
		if (Array.isArray(object[key])) return object[key] as unknown[];
	}
	return [];
}

function branchOf(value: JsonRecord): string {
	return nestedText(value, ["branch", "headRefName", "head_branch", "source_branch", "head"]);
}

function outcomeOf(meta: SessionMeta, liveIds: Set<string>): TranscriptOutcome {
	if (liveIds.has(meta.id)) return "live";
	if (meta.exitReason.startsWith("normal/")) return "complete";
	if (meta.exitReason.startsWith("signal/") || meta.exitReason.startsWith("fatal/") || meta.exitReason.startsWith("process_exit/")) return "aborted";
	if (!meta.exitReason) return "open";
	return "unknown";
}

function transcriptRow(meta: SessionMeta, liveIds: Set<string>): TranscriptRow {
	return {
		id: meta.id,
		cwd: meta.cwd,
		branch: meta.branch,
		outcome: outcomeOf(meta, liveIds),
		lastActiveMs: meta.lastActiveMs,
		title: meta.title,
		file: meta.file,
	};
}

function byBranch<T extends { branch: string }>(rows: T[], branch: string): T | null {
	if (!branch) return null;
	return rows.find(row => row.branch === branch) ?? null;
}

function byCwd(rows: WorktreeRow[], cwd: string): WorktreeRow | null {
	if (!cwd) return null;
	return rows.find(row => row.path === cwd) ?? null;
}

/** Pure reconciliation: source rows are never mutated and every join is explicit. */
export function reconcileStatus(scope: StatusScope, project: string, sources: StatusSources): ReconciledStatus {
	const liveById = new Map(sources.live.map(row => [row.id, row]));
	const transcriptIds = new Set(sources.transcripts.map(row => row.id));
	const sessionRows = [
		...sources.transcripts,
		...sources.live
			.filter(row => !transcriptIds.has(row.id))
			.map(row => ({
				id: row.id,
				cwd: row.cwd,
				branch: row.branch,
				outcome: "live" as const,
				lastActiveMs: row.lastActivityMs,
				title: `${row.kind} session`,
				file: "",
			})),
	];
	const sessions = sessionRows
		.slice()
		.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0))
		.map(transcript => ({
			transcript,
			live: liveById.get(transcript.id) ?? null,
			bead: byBranch(sources.beads, transcript.branch),
			change: byBranch(sources.changes, transcript.branch),
			worktree: byCwd(sources.worktrees, transcript.cwd),
		}));
	return {
		...sources,
		live: sources.live.slice(),
		transcripts: sources.transcripts.slice(),
		beads: sources.beads.slice(),
		worktrees: sources.worktrees.slice(),
		changes: sources.changes.slice(),
		releases: sources.releases.slice(),
		warnings: sources.warnings.slice(),
		scope,
		project,
		sessions,
		maxRows: MAX_ROWS,
	};
}

function rowLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return MAX_ROWS;
	return Math.max(1, Math.min(MAX_ROWS, Math.floor(value)));
}

function controllerFor(parent: AbortSignal | undefined, budgetMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("session_status budget expired")), budgetMs);
	const abort = () => controller.abort(parent?.reason ?? new Error("session_status aborted"));
	parent?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
}

const defaultRun: CommandRunner = async (file, args, options) => {
	try {
		const child = execFileAsync(file, args, {
			cwd: options.cwd,
			encoding: "utf8",
			timeout: options.timeoutMs,
			maxBuffer: MAX_BUFFER,
			windowsHide: true,
			signal: options.signal,
		});
		const result = await child;
		return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: 0 };
	} catch (error) {
		const failed = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
		return {
			stdout: String(failed.stdout ?? ""),
			stderr: String(failed.stderr ?? error),
			exitCode: typeof failed.code === "number" ? failed.code : 1,
		};
	}
};

async function readJsonDefault(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

async function probeJson(
	run: CommandRunner,
	file: string,
	args: string[],
	cwd: string,
	signal: AbortSignal,
): Promise<{ value: unknown; warning?: string }> {
	const result = await run(file, args, { cwd, timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (result.exitCode !== 0) {
		return { value: [], warning: `${file} unavailable (${oneLine(result.stderr) || `exit ${result.exitCode}`})` };
	}
	const value = parseJsonOutput(result.stdout);
	return { value };
}

export function dirtyFromStatus(result: CommandResult): "yes" | "no" | "unknown" {
	if (result.exitCode !== 0) return "unknown";
	return result.stdout.trim() ? "yes" : "no";
}

async function probeWorktreeDirty(run: CommandRunner, path: string, signal: AbortSignal): Promise<{ value: "yes" | "no" | "unknown"; warning?: string }> {
	const result = await run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: path, timeoutMs: PROBE_TIMEOUT_MS, signal });
	const value = dirtyFromStatus(result);
	if (value === "unknown") return { value, warning: `git status unavailable for ${path} (${oneLine(result.stderr) || `exit ${result.exitCode}`})` };
	return { value };
}

async function probeText(
	run: CommandRunner,
	file: string,
	args: string[],
	cwd: string,
	signal: AbortSignal,
): Promise<{ value: string; warning?: string }> {
	const result = await run(file, args, { cwd, timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (result.exitCode !== 0) {
		return { value: "", warning: `${file} unavailable (${oneLine(result.stderr) || `exit ${result.exitCode}`})` };
	}
	return { value: result.stdout.trim() };
}

function parseBeads(value: unknown): BeadRow[] {
	return arrayPayload(value)
		.map(item => record(item))
		.filter((item): item is JsonRecord => item !== null)
		.map(item => ({
			id: idOf(item),
			title: oneLine(item.title ?? item.name ?? item.description),
			status: text(item.status ?? item.state),
			assignee: nestedText(item, ["assignee", "assigned_to", "owner"]),
			branch: nestedText(item, ["branch", "git_branch", "head"]),
		}))
		.filter(row => row.id);
}

function parseWorktrees(value: unknown): WorktreeRow[] {
	return arrayPayload(value)
		.map(item => record(item))
		.filter((item): item is JsonRecord => item !== null)
		.map(item => ({
			path: text(item.path ?? item.worktree ?? item.directory),
			branch: branchOf(item),
			head: text(item.head ?? item.sha ?? item.commit),
			dirty: item.dirty === true || item.status === "dirty" ? "dirty" : "clean",
		}))
		.filter(row => row.path);
}

function parseChanges(value: unknown, kind: "PR" | "MR"): ChangeRow[] {
	return arrayPayload(value)
		.map(item => record(item))
		.filter((item): item is JsonRecord => item !== null)
		.map(item => ({
			kind,
			id: idOf(item),
			branch: branchOf(item),
			state: text(item.state ?? item.status),
			url: text(item.url ?? item.web_url ?? item.html_url),
			base: text(item.baseRefName ?? item.target_branch ?? item.base_branch),
		}))
		.filter(row => row.id || row.branch);
}

async function collectLiveSessions(current: CurrentSessionHint | undefined): Promise<LiveSession[]> {
	const rows: LiveSession[] = [];
	try {
		for (const ref of AgentRegistry.global().list()) {
			if (ref.kind === "advisor" || (ref.status !== "running" && ref.status !== "idle")) continue;
			const manager = (ref.session as { sessionManager?: { getCwd?: () => string } } | null)?.sessionManager;
			const cwd = manager?.getCwd?.() ?? "";
			rows.push({
				id: ref.id,
				cwd,
				status: ref.status,
				kind: ref.kind,
				branch: "",
				lastActivityMs: ref.lastActivity || null,
			});
		}
	} catch {
		// A host may load an older OMP build without a usable registry; current hint still works.
	}
	if (current && !rows.some(row => row.id === current.id)) {
		rows.push({ id: current.id, cwd: current.cwd, status: "running", kind: "main", branch: "", lastActivityMs: Date.now() });
	}
	return rows;
}

function inScope(cwd: string, accepted: Set<string>): boolean {
	return [...accepted].some(path => cwd === path || cwd.startsWith(`${path}/`));
}

async function collectReleases(project: string, readJson: (file: string) => Promise<unknown>): Promise<ReleaseRow[]> {
	const paths = [
		[join(project, "package.json"), "package.json"],
		[join(project, ".omp-plugin", "plugin.json"), ".omp-plugin/plugin.json"],
		[join(project, ".release-please-manifest.json"), ".release-please-manifest.json"],
	] as const;
	const rows: ReleaseRow[] = [];
	for (const [file, source] of paths) {
		if (!existsSync(file)) continue;
		const parsed = record(await readJson(file));
		if (!parsed) continue;
		if (source === ".release-please-manifest.json") {
			for (const [name, version] of Object.entries(parsed)) if (typeof version === "string") rows.push({ name, version, source });
			continue;
		}
		const version = text(parsed.version);
		if (version) rows.push({ name: text(parsed.name) || basename(project), version, source });
	}
	return rows;
}

function filterByScope<T extends { branch?: string; path?: string; cwd?: string }>(rows: T[], branches: Set<string>, accepted: Set<string>): T[] {
	return rows.filter(row => {
		if (row.branch) return branches.size === 0 || branches.has(row.branch);
		const path = row.path ?? row.cwd;
		return !path || inScope(path, accepted);
	});
}

export async function collectStatus(
	cwd: string,
	options: StatusOptions = {},
	signal?: AbortSignal,
	current?: CurrentSessionHint,
	dependencies: StatusDependencies = {},
): Promise<ReconciledStatus> {
	const scoped = options.scope !== "global";
	const requested = resolve(options.path ?? cwd);
	const project = repoRoot(requested);
	const budget = controllerFor(signal, STATUS_BUDGET_MS);
	const run = dependencies.run ?? defaultRun;
	const readJson = dependencies.readJson ?? readJsonDefault;
	const warnings: string[] = [];
	try {
		let worktreeFamily: Worktree[] | undefined;
		if (scoped) worktreeFamily = listWorktrees(project);
		if (scoped && worktreeFamily === undefined) warnings.push(`could not enumerate Git worktrees for ${project}; exact-path results only`);
		const accepted = scoped ? acceptedPaths(worktreeFamily ?? [], project) : new Set<string>();
		const found = await candidates(sessionsRoot(options.profile), scoped ? accepted : undefined, budget.signal, MAX_SESSIONS);
		const live = dependencies.live ? dependencies.live() : await collectLiveSessions(current);
		const liveIds = new Set(live.map(row => row.id));
		const transcripts: TranscriptRow[] = [];
		for (const candidate of found) {
			if (budget.signal.aborted) break;
			try {
				const meta = await scanTranscriptMeta(candidate.file, budget.signal);
				if (meta.turnCount > 0) transcripts.push(transcriptRow(meta, liveIds));
			} catch (error) {
				if (!budget.signal.aborted) warnings.push(`transcript ${candidate.head.id} unavailable: ${oneLine(error)}`);
			}
		}
		if (budget.signal.aborted) warnings.push("session scan reached its time budget; results are partial");
		const worktrees = (worktreeFamily ?? []).map(row => ({
			path: row.path,
			branch: row.detached ? "(detached)" : row.branch,
			head: row.head,
			dirty: "unknown" as const,
		}));
		const branches = new Set([...transcripts.map(row => row.branch), ...worktrees.map(row => row.branch)].filter(Boolean));
		const [beadsProbe, wtProbe, remoteProbe, releaseRows] = await Promise.all([
			probeJson(run, "bd", ["list", "--json"], project, budget.signal),
			probeJson(run, "wt", ["list", "--json"], project, budget.signal),
			probeText(run, "git", ["remote", "get-url", "origin"], project, budget.signal),
			collectReleases(project, readJson),
		]);
		for (const probe of [beadsProbe, wtProbe]) if (probe.warning) warnings.push(probe.warning);
		const beads = filterByScope(parseBeads(beadsProbe.value), branches, accepted);
		const inventory = parseWorktrees(wtProbe.value);
		const inventoryRows = inventory.length > 0 ? inventory : worktrees;
		const dirtyProbes = await Promise.all(inventoryRows.map(row => probeWorktreeDirty(run, row.path, budget.signal)));
		for (const probe of dirtyProbes) if (probe.warning) warnings.push(probe.warning);
		const statusWorktrees = inventoryRows.map((row, index) => ({ ...row, dirty: dirtyProbes[index]?.value ?? "unknown" }));
		const remote = remoteProbe.value;
		if (remoteProbe.warning) warnings.push(remoteProbe.warning);
		let changes: ChangeRow[] = [];
		if (remote.includes("gitlab")) {
			const probe = await probeJson(run, "glab", ["mr", "list", "--all", "--output", "json"], project, budget.signal);
			if (probe.warning) warnings.push(probe.warning);
			changes = parseChanges(probe.value, "MR");
		} else if (remote) {
			const probe = await probeJson(run, "gh", ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,state,headRefName,baseRefName,url,mergedAt"], project, budget.signal);
			if (probe.warning) warnings.push(probe.warning);
			changes = parseChanges(probe.value, "PR");
		}
		return {
			...reconcileStatus(options.scope ?? "project", project, {
				live: scoped ? live.filter(row => !row.cwd || inScope(row.cwd, accepted)) : live,
				transcripts: scoped ? transcripts.filter(row => inScope(row.cwd, accepted)) : transcripts,
				beads,
				worktrees: scoped ? statusWorktrees.filter(row => inScope(row.path, accepted)) : statusWorktrees,
				changes: filterByScope(changes, branches, accepted),
				releases: releaseRows,
				warnings,
			}),
			maxRows: rowLimit(options.maxRows),
		};
	} finally {
		budget.dispose();
	}
}

function ago(ms: number | null): string {
	if (ms === null) return "unknown";
	const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
	return minutes < 1 ? "now" : `${minutes}m ago`;
}

function table(headers: string[], rows: string[][]): string[] {
	const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
	for (const row of rows) lines.push(`| ${row.map(cell).join(" | ")} |`);
	return lines;
}

export function renderStatus(report: ReconciledStatus): string {
	const lines = ["# Session status", `scope: ${report.scope}`, `project: ${report.project}`, "", "## Sessions"];
	lines.push(
		...table(
			["session", "state", "branch", "cwd", "last active", "bead", "PR/MR"],
			report.sessions.slice(0, report.maxRows).map(row => [
				row.transcript.id.slice(0, 12),
				row.live ? `live/${row.live.status}` : row.transcript.outcome,
				row.transcript.branch,
				row.transcript.cwd,
				ago(row.transcript.lastActiveMs),
				row.bead?.id ?? "",
				row.change ? `${row.change.kind} ${row.change.id} ${row.change.state}` : "",
			]),
		),
	);
	lines.push("", "## Worktrees", ...table(["path", "branch", "head", "dirty"], report.worktrees.slice(0, report.maxRows).map(row => [row.path, row.branch, row.head.slice(0, 12), row.dirty])));
	lines.push("", "## Beads", ...table(["id", "status", "owner", "branch", "title"], report.beads.slice(0, report.maxRows).map(row => [row.id, row.status, row.assignee, row.branch, row.title])));
	lines.push("", "## PR/MR", ...table(["kind", "id", "state", "branch", "base", "url"], report.changes.slice(0, report.maxRows).map(row => [row.kind, row.id, row.state, row.branch, row.base, row.url])));
	lines.push("", "## Releases", ...table(["name", "version", "source"], report.releases.slice(0, report.maxRows).map(row => [row.name, row.version, row.source])));
	if (report.warnings.length > 0) lines.push("", "## Unavailable or partial sources", ...report.warnings.map(warning => `- ${cell(warning)}`));
	lines.push("", "Read-only snapshot; source rows are reconciled by session id, branch, and worktree path.");
	return lines.join("\n");
}

export default function sessionStatusTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	const parameters = z.object({
		scope: z.enum(["project", "global"]).optional().describe("project (default) or global session scope"),
		path: z.string().optional().describe("project directory; defaults to the current project"),
		max_rows: z.number().int().positive().optional().describe("maximum rows per table (default 40)"),
		profile: z.string().optional().describe("named OMP profile store to inspect"),
	});
	pi.registerTool({
		name: "session_status",
		label: "Session Status",
		description:
			"Read-only, bounded snapshot of sessions, transcript outcomes, Beads ownership, Worktrunk worktrees, PR/MR lifecycle, and release versions. Defaults to the current project; use scope=global for all sessions. Missing commands degrade to warnings.",
		parameters,
		approval: "read",
		async execute(_id, input, signal, _onUpdate, ctx) {
			try {
				const params = parameters.parse(input);
				const manager = ctx.sessionManager as { getSessionId?: () => string; getCwd?: () => string; getSessionFile?: () => string | null };
				const current: CurrentSessionHint | undefined = manager.getSessionId?.()
					? { id: manager.getSessionId(), cwd: manager.getCwd?.() ?? ctx.cwd, file: manager.getSessionFile?.() ?? undefined }
					: undefined;
				const report = await collectStatus(ctx.cwd, { scope: params.scope, path: params.path, maxRows: params.max_rows, profile: params.profile }, signal, current);
				const rendered = renderStatus(report);
				return {
					content: [{ type: "text" as const, text: rendered }],
					details: { readOnly: true, scope: report.scope, project: report.project, sessions: report.sessions.length, warnings: report.warnings },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text" as const, text: `session_status error: ${message}` }], details: { error: message, readOnly: true } };
			}
		},
	});
}
