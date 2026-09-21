import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { type BdInvocation, bdInvocations, environmentForInput, extractCommand } from "./bd-actor-gate.ts";
import { withEmbeddedWriteLock } from "./bd-embedded-write-lock.ts";
import { leadingCdCwd } from "./shell-command.ts";

export const CLAIM_POOLS_KEY = "claim.pools";
export const PHASE_METADATA_KEY = "phase";
export const INTEGRATION_OWNER_METADATA_KEY = "integration_owner";
export const DECLARED_POOL_ALIASES = [
	"pool:orc-implementer",
	"pool:orc-implementer-deep",
	"pool:orc-implementer-max",
	"pool:orc-reviewer",
	"pool:orc-researcher",
	"pool:orc-shepherd",
	"pool:orc-merger",
	"pool:orc-lead",
] as const;
export const DECLARED_POOL_SET = DECLARED_POOL_ALIASES.join(",");

/** A tool_call has a 30,000 ms budget; leave 5,000 ms for all pool work and dispatch. */
const TIMEOUT_MS = 25_000;
const PREFILTER = /\bbd\b[\s\S]{0,400}?(?:--claim\b|\bclaim\b|\breclaim\b)/;
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
const POOLS_FAILURE = "bd pool discipline refused: cannot establish claim.pools in the client's database for this store";
const NO_PHASE_ADVISORY = (id: string) => `bd pool discipline advisory: reclaimed work bead ${id} has no recorded \`phase\` metadata; it remains unassigned and needs an explicit phase before it can re-enter a pool.`;
const NO_OWNER_ADVISORY = (id: string) => `bd pool discipline advisory: reclaimed merge slot ${id} has no recorded \`integration_owner\` metadata; it remains unassigned and needs an explicit owner before it can serialize a target.`;
const RESTAMP_FAILURE = (id: string, detail: string) => `bd pool discipline advisory: could not restore phase for reclaimed work bead ${id} (${detail}); it remains unassigned.`;
const OWNER_RESTORE_FAILURE = (id: string, detail: string) => `bd pool discipline advisory: could not restore integration owner for reclaimed merge slot ${id} (${detail}); it remains unassigned.`;

export type BdRunResult = { exitCode: number; stdout: string; stderr?: string };
export type BdRun = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, deadline?: number) => Promise<BdRunResult> | BdRunResult;

let injectedRun: BdRun | null = null;

export function setBdRunForTests(fn: BdRun | null): void {
	injectedRun = fn;
}

export type PoolConfig = { value: string; source: string } | undefined;

/** Parse bd config's effective value and provenance without reading config.yaml. */
export function parsePoolConfig(output: string): PoolConfig {
	try {
		const parsed: unknown = JSON.parse(output);
		const found = findPoolRecord(parsed);
		if (found !== undefined) return found;
	} catch {
		// Text output is still bd's own provenance report; use it as a fallback.
	}
	const line = output.split(/\r?\n/).find(value => value.includes(CLAIM_POOLS_KEY));
	if (line === undefined) return undefined;
	const source = line.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ?? "unknown";
	const valuePart = line
		.replace(new RegExp(`^.*${CLAIM_POOLS_KEY}\\s*(?:=|:)\\s*`), "")
		.replace(/\s*\([^)]*\)\s*$/, "")
		.trim()
		.replace(/^['"]|['"]$/g, "");
	return { value: valuePart, source };
}

function findPoolRecord(value: unknown): PoolConfig {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findPoolRecord(item);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (value === null || typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	const direct = object[CLAIM_POOLS_KEY];
	if (typeof direct === "string") return { value: direct, source: stringField(object, "source", "provenance") ?? "unknown" };
	if (direct !== null && typeof direct === "object") {
		const record = direct as Record<string, unknown>;
		const directValue = stringField(record, "value", "effective", "raw");
		if (directValue !== undefined) return { value: directValue, source: stringField(record, "source", "provenance") ?? stringField(object, "source", "provenance") ?? "unknown" };
	}
	if (object.key === CLAIM_POOLS_KEY || object.name === CLAIM_POOLS_KEY) {
		const recordValue = stringField(object, "value", "effective", "raw");
		if (recordValue !== undefined) return { value: recordValue, source: stringField(object, "source", "provenance") ?? "unknown" };
	}
	for (const child of Object.values(object)) {
		const found = findPoolRecord(child);
		if (found !== undefined) return found;
	}
	return undefined;
}

function stringField(object: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		if (typeof object[name] === "string") return object[name] as string;
	}
	return undefined;
}

export function isClaimOperation(invocation: BdInvocation): boolean {
	return invocation.verb === "claim" || ((invocation.verb === "update" || invocation.verb === "ready") && invocation.args.includes("--claim"));
}

export function isReclaimOperation(invocation: BdInvocation): boolean {
	return invocation.verb === "reclaim";
}

function claimIds(invocation: BdInvocation): string[] {
	if (invocation.verb !== "claim" && invocation.verb !== "update") return [];
	return invocation.args.filter(argument => BEAD_ID.test(argument));
}

function assigneeFromShow(output: string, id: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(output);
		const rows = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && "data" in parsed && Array.isArray(parsed.data) ? parsed.data : [parsed];
		const row = rows.find(item => item !== null && typeof item === "object" && (item as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
		return typeof row?.assignee === "string" ? row.assignee : undefined;
	} catch {
		return undefined;
	}
}
async function isPooledClaim(invocation: BdInvocation, cwd: string, env: NodeJS.ProcessEnv, deadline: number): Promise<boolean> {
	const ids = claimIds(invocation);
	if (ids.length === 0) return false;
	const run = injectedRun ?? defaultRun;
	for (const id of ids) {
		const shown = await runWithDeadline(run, ["bd", ...invocation.globals, "show", id, "--json"], cwd, env, deadline);
		if (shown.exitCode !== 0) continue;
		const assignee = assigneeFromShow(shown.stdout, id);
		if (assignee !== undefined && DECLARED_POOL_ALIASES.includes(assignee as (typeof DECLARED_POOL_ALIASES)[number])) return true;
	}
	return false;
}

async function establishPool(invocation: BdInvocation, cwd: string, env: NodeJS.ProcessEnv, deadline: number): Promise<{ ok: true } | { ok: false; reason: string }> {
	const run = injectedRun ?? defaultRun;
	const read = await runWithDeadline(run, ["bd", ...poolConfigArgs(invocation)], cwd, env, deadline);
	if (Date.now() >= deadline) return { ok: false, reason: `${POOLS_FAILURE}: handler deadline expired before the database pool set could be verified.` };
	const existing = read.exitCode === 0 ? parsePoolConfig(read.stdout) : undefined;
	if (existing?.source === "database" && existing.value.trim() !== "") return { ok: true };
	const store = storeName(cwd, env, invocation);
	const written = await withEmbeddedWriteLock(cwd, `pool-discipline-${Date.now()}`, () => runWithDeadline(run, ["bd", ...poolSetArgs(invocation)], cwd, env, deadline), env, deadline);
	if (written.kind === "failed" || written.value.exitCode !== 0) {
		const detail = written.kind === "failed" ? written.reason : written.value.stderr?.trim();
		return { ok: false, reason: `${POOLS_FAILURE}: key ${CLAIM_POOLS_KEY}, store ${store}${detail ? ` (${detail})` : ""}.` };
	}
	const verify = await runWithDeadline(run, ["bd", ...poolConfigArgs(invocation)], cwd, env, deadline);
	if (Date.now() >= deadline) return { ok: false, reason: `${POOLS_FAILURE}: handler deadline expired before the database pool set could be verified.` };
	const after = verify.exitCode === 0 ? parsePoolConfig(verify.stdout) : undefined;
	if (after?.source === "database" && after.value.trim() !== "") return { ok: true };
	return { ok: false, reason: `${POOLS_FAILURE}: key ${CLAIM_POOLS_KEY}, store ${store}. Readback did not show a database value.` };
}

export function poolConfigArgs(invocation: BdInvocation): string[] {
	return [...invocation.globals, "config", "show", "--json"];
}

export function poolSetArgs(invocation: BdInvocation): string[] {
	return [...invocation.globals, "config", "set", CLAIM_POOLS_KEY, DECLARED_POOL_SET];
}

export function phaseArgs(invocation: BdInvocation, id: string, phase: string): string[] {
	return [...invocation.globals, "update", id, "--assignee", phase, "--json"];
}

export function ownerArgs(invocation: BdInvocation, id: string, owner: string): string[] {
	return [...invocation.globals, "update", id, "--assignee", owner, "--json"];
}

function invocationIds(invocation: BdInvocation): string[] {
	if (invocation.verb !== "reclaim") return [];
	const ids = new Set<string>();
	for (let i = 0; i < invocation.args.length; i++) {
		if (invocation.args[i] === "--id" || invocation.args[i] === "-i") {
			const id = invocation.args[++i];
			if (id !== undefined && BEAD_ID.test(id)) ids.add(id);
		}
	}
	return [...ids];
}

export function reclaimedIds(output: string, invocation?: BdInvocation): string[] {
	const ids = new Set(invocation === undefined ? [] : invocationIds(invocation));
	for (const match of output.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
		if (BEAD_ID.test(match[1] ?? "")) ids.add(match[1] as string);
	}
	for (const match of output.matchAll(/\b(?:reclaimed|reclaiming|recovered)\s+(?:bead|issue)?\s*([A-Za-z][A-Za-z0-9-]+)/gi)) {
		if (BEAD_ID.test(match[1] ?? "")) ids.add(match[1] as string);
	}
	return [...ids];
}

function rowForId(output: string, id: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return undefined;
	}
	const rows = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && "data" in parsed && Array.isArray(parsed.data) ? parsed.data : [parsed];
	return rows.find(row => row !== null && typeof row === "object" && (row as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
}

function metadataString(output: string, id: string, key: string): string | undefined {
	const row = rowForId(output, id);
	const metadata = row?.metadata;
	if (metadata !== null && typeof metadata === "object" && typeof (metadata as Record<string, unknown>)[key] === "string") return (metadata as Record<string, string>)[key];
	return undefined;
}

export function readPhase(output: string, id: string): string | undefined {
	return metadataString(output, id, PHASE_METADATA_KEY);
}

export function readIntegrationOwner(output: string, id: string): string | undefined {
	return metadataString(output, id, INTEGRATION_OWNER_METADATA_KEY);
}

function isMergeSlot(output: string, id: string): boolean {
	const row = rowForId(output, id);
	const labels = row?.labels;
	return Array.isArray(labels) && labels.includes("pr:merge");
}

function hasUnassignedAssignee(output: string, id: string): boolean {
	try {
		const parsed: unknown = JSON.parse(output);
		const rows = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && "data" in parsed && Array.isArray(parsed.data) ? parsed.data : [parsed];
		const row = rows.find(item => item !== null && typeof item === "object" && (item as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
		return row !== undefined && (row.assignee === undefined || row.assignee === null || row.assignee === "");
	} catch {
		return false;
	}
}

function storeName(cwd: string, env: NodeJS.ProcessEnv, invocation: BdInvocation): string {
	const db = valueAfter(invocation.globals, ["--db", "--database"]);
	if (db !== undefined) return db;
	const directory = valueAfter(invocation.globals, ["-C", "--directory"]);
	if (directory !== undefined) return directory;
	return env.BEADS_DIR || `${cwd}/.beads`;
}

function valueAfter(args: string[], flags: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const flag = flags.find(name => arg === name || arg.startsWith(`${name}=`));
		if (flag === undefined) continue;
		if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
		return args[i + 1];
	}
	return undefined;
}

async function defaultRun(argv: string[], cwd: string, env: NodeJS.ProcessEnv, deadline = Date.now() + TIMEOUT_MS): Promise<BdRunResult> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return { exitCode: 124, stdout: "", stderr: "bd command timed out" };
	const child = Bun.spawn(argv, { cwd, env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" }, stdout: "pipe", stderr: "pipe", timeout: remaining, killSignal: "SIGKILL" });
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (Date.now() >= deadline) return { exitCode: 124, stdout: "", stderr: "bd command timed out" };
	return { stdout, stderr, exitCode: exitCode ?? 1 };
}

async function runWithDeadline(run: BdRun, argv: string[], cwd: string, env: NodeJS.ProcessEnv, deadline: number): Promise<BdRunResult> {
	if (Date.now() >= deadline) return { exitCode: 124, stdout: "", stderr: "bd command timed out" };
	const result = await run(argv, cwd, env, deadline);
	return Date.now() >= deadline ? { exitCode: 124, stdout: "", stderr: "bd command timed out" } : result;
}

function advisoryResult(event: ToolResultEvent, text: string): { content: ToolResultEvent["content"] } {
	return { content: [{ type: "text", text: `${text}\n\n` }, ...(event.content ?? [])] };
}

export default function bdPoolDiscipline(pi: ExtensionAPI): void {
	const pendingReclaims = new Map<string, { cwd: string; env: NodeJS.ProcessEnv; invocations: BdInvocation[] }>();
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command || !PREFILTER.test(command)) return;
			const deadline = Date.now() + TIMEOUT_MS;
			const invocations = bdInvocations(command);
			const input = event.input as { cwd?: unknown };
			const inputCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ctx?.cwd ?? process.cwd();
			const cwd = leadingCdCwd(command, inputCwd);
			const env = environmentForInput(event.input);
			const claims = invocations.filter(isClaimOperation);
			for (const invocation of claims) {
				if (!(await isPooledClaim(invocation, cwd, env, deadline))) {
					if (Date.now() >= deadline) return { block: true, reason: `${POOLS_FAILURE}: handler deadline expired before the claim's pool could be verified.` };
					continue;
				}
				const decision = await establishPool(invocation, cwd, env, deadline);
				if (!decision.ok) return { block: true, reason: decision.reason };
			}
			const reclaims = invocations.filter(isReclaimOperation);
			if (reclaims.length > 0) pendingReclaims.set(event.toolCallId, { cwd, env, invocations: reclaims });
		} catch (error) {
			if (PREFILTER.test(extractCommand(event.input))) return { block: true, reason: `${POOLS_FAILURE}: ${error instanceof Error ? error.message : String(error)}` };
		}
	});
	pi.on("tool_result", async (event: ToolResultEvent) => {
		const reclaim = pendingReclaims.get(event.toolCallId);
		if (reclaim === undefined) return;
		pendingReclaims.delete(event.toolCallId);
		try {
			const output = (event.content ?? []).map(part => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
			const ids = [...new Set(reclaim.invocations.flatMap(invocation => reclaimedIds(output, invocation)))];
			if (ids.length === 0) return;
			const deadline = Date.now() + TIMEOUT_MS;
			const run = injectedRun ?? defaultRun;
			const notices: string[] = [];
			for (const id of ids) {
				const invocation = reclaim.invocations[0];
				if (invocation === undefined) continue;
				if (Date.now() >= deadline) {
					notices.push(`bd pool discipline advisory: reclaim restoration deadline expired before reclaimed bead ${id} could be verified; it remains unassigned.`);
					continue;
				}
				const shown = await runWithDeadline(run, ["bd", ...invocation.globals, "show", id, "--json"], reclaim.cwd, reclaim.env, deadline);
				if (shown.exitCode === 124) {
					notices.push(`bd pool discipline advisory: reclaim restoration deadline expired before reclaimed bead ${id} could be verified; it remains unassigned.`);
					continue;
				}
				if (shown.exitCode !== 0 || !hasUnassignedAssignee(shown.stdout, id)) continue;
				if (isMergeSlot(shown.stdout, id)) {
					const owner = readIntegrationOwner(shown.stdout, id);
					if (owner === undefined || owner.trim() === "") {
						notices.push(NO_OWNER_ADVISORY(id));
						continue;
					}
					const restored = await withEmbeddedWriteLock(reclaim.cwd, event.toolCallId, () => runWithDeadline(run, ["bd", ...ownerArgs(invocation, id, owner)], reclaim.cwd, reclaim.env, deadline), reclaim.env, deadline);
					if (restored.kind === "failed" || restored.value.exitCode !== 0) notices.push(OWNER_RESTORE_FAILURE(id, restored.kind === "failed" ? restored.reason : restored.value.stderr?.trim() ?? `bd exited ${restored.value.exitCode}`));
					continue;
				}
				const phase = readPhase(shown.stdout, id);
				if (phase === undefined || phase.trim() === "") {
					notices.push(NO_PHASE_ADVISORY(id));
					continue;
				}
				const restored = await withEmbeddedWriteLock(reclaim.cwd, event.toolCallId, () => runWithDeadline(run, ["bd", ...phaseArgs(invocation, id, phase)], reclaim.cwd, reclaim.env, deadline), reclaim.env, deadline);
				if (restored.kind === "failed" || restored.value.exitCode !== 0) notices.push(RESTAMP_FAILURE(id, restored.kind === "failed" ? restored.reason : restored.value.stderr?.trim() ?? `bd exited ${restored.value.exitCode}`));
			}
			if (notices.length > 0) return advisoryResult(event, notices.join("\n"));
		} catch (error) {
			return advisoryResult(event, `bd pool discipline advisory: reclaim restoration was not verified (${error instanceof Error ? error.message : String(error)}).`);
		}
	});
}
