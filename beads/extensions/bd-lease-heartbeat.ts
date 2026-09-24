import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import { environmentForInput } from "./bd-actor-gate.ts";
import { claimedIds } from "./bd-lease-gate.ts";
import {
	type CommandPosition,
	leadingCdCwd,
	type ParsedCommand,
	parse,
} from "./shell-command.ts";

/** Beads keeps a claim lease for five minutes; renew at one fifth of that TTL. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** A heartbeat must not occupy the event loop for most of its next tick. */
const HEARTBEAT_TIMEOUT_MS = 10_000;
const PREFILTER = /\bbd\b[\s\S]{0,400}?--claim\b/;
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

type BdResult = { exitCode: number; stdout: string; stderr?: string };
export type BdHeartbeatRun = (
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline?: number,
) => Promise<BdResult> | BdResult;

/** A small seam keeps cadence and runner behavior deterministic in unit tests. */
export type HeartbeatClock = {
	setInterval(callback: () => void | Promise<void>, milliseconds: number): unknown;
	setTimeout?: (callback: () => void, milliseconds: number) => unknown;
	clearTimer(timer: unknown): void;
};

let injectedRun: BdHeartbeatRun | null = null;
let injectedClock: HeartbeatClock | null = null;

export function setHeartbeatRunForTests(run: BdHeartbeatRun | null): void {
	injectedRun = run;
}

export function setHeartbeatClockForTests(clock: HeartbeatClock | null): void {
	injectedClock = clock;
}

interface PendingClaim {
	toolCallId: string;
	session: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	ctx: ExtensionContext;
	/** Bead ids named by the claim command; bd exits non-zero when any claim fails. */
	ids: string[];
}

interface ActiveHeartbeat {
	id: string;
	session: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	clock: HeartbeatClock;
	timer: unknown;
	running: boolean;
	stopped: boolean;
	noticed: boolean;
}

const pendingClaims = new Map<string, PendingClaim>();
const activeBySession = new Map<string, Map<string, ActiveHeartbeat>>();
const toolSessions = new Map<string, string>();
const contextKeys = new WeakMap<object, string>();
let nextContextKey = 0;

function sessionKey(ctx: ExtensionContext | undefined): string {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) return `session:${id}`;
	} catch {
		// A lifecycle handler must remain advisory when a host has no session id.
	}
	const manager = ctx?.sessionManager;
	if (manager !== null && typeof manager === "object") {
		const existing = contextKeys.get(manager);
		if (existing !== undefined) return existing;
		const key = `manager:${++nextContextKey}`;
		contextKeys.set(manager, key);
		return key;
	}
	return "session:unknown";
}

function pendingKey(session: string, toolCallId: string): string {
	return `${session}\u0000${toolCallId}`;
}

function timerClock(ctx: ExtensionContext): HeartbeatClock | undefined {
	if (injectedClock !== null) return injectedClock;
	if (typeof ctx.setInterval !== "function" || typeof ctx.clearTimer !== "function") return undefined;
	return {
		setInterval: (callback, milliseconds) => ctx.setInterval(callback, milliseconds),
		setTimeout: typeof ctx.setTimeout === "function" ? (callback, milliseconds) => ctx.setTimeout(callback, milliseconds) : undefined,
		clearTimer: timer => ctx.clearTimer(timer as never),
	};
}

function commandPositions(parsed: ParsedCommand): CommandPosition[] {
	const positions = [...parsed.commands];
	for (const child of parsed.nested) positions.push(...commandPositions(child));
	return positions;
}

function executableIndex(position: CommandPosition): number {
	if ((position.executable?.split("/").pop() ?? position.executable) !== "bd") return -1;
	return position.words.findIndex(word => !word.quoted && (word.value.split("/").pop() ?? word.value) === "bd");
}

/** Bead ids a `bd update ... --claim` invocation names, or none when the command claims nothing. */
function claimInvocationIds(parsed: ParsedCommand): string[] {
	if (parsed.unknown) return [];
	const ids = new Set<string>();
	for (const position of commandPositions(parsed)) {
		const start = executableIndex(position);
		if (start < 0) continue;
		let update = false;
		let claim = false;
		const named: string[] = [];
		for (const token of position.words.slice(start + 1)) {
			if (!update) {
				if (!token.quoted && token.value === "update") update = true;
				continue;
			}
			if (!token.quoted && token.value === "--claim") claim = true;
			if (!token.value.startsWith("-") && BEAD_ID.test(token.value)) named.push(token.value);
		}
		if (update && claim) for (const id of named) ids.add(id);
	}
	return [...ids];
}

function resultOutput(event: ToolResultEvent): string {
	const content = (event.content ?? [])
		.map(part => ("text" in part && typeof part.text === "string" ? part.text : ""))
		.join("\n");
	const details = event.details;
	const stdout = details !== null && typeof details === "object" && "stdout" in details && typeof details.stdout === "string" ? details.stdout : "";
	return [content, stdout].filter(Boolean).join("\n");
}

function exitCode(event: ToolResultEvent): number {
	const details = event.details;
	if (details !== null && typeof details === "object" && "exitCode" in details && typeof details.exitCode === "number") return details.exitCode;
	return event.isError ? 1 : 0;
}
function claimPending(ctx: ExtensionContext | undefined, toolCallId: string): PendingClaim | undefined {
	return pendingClaims.get(pendingKey(sessionKey(ctx), toolCallId));
}
export function decideLeaseHeartbeatClaim(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext): void {
	try {
		if (event.toolName !== "bash") return;
		const session = sessionKey(ctx);
		toolSessions.set(event.toolCallId, session);
		if (!PREFILTER.test(parsed.command)) return;
		const ids = claimInvocationIds(parsed);
		if (ids.length === 0) return;
		const input = event.input as { cwd?: unknown };
		const inputCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx.cwd ?? process.cwd());
		pendingClaims.set(pendingKey(session, event.toolCallId), {
			toolCallId: event.toolCallId,
			session,
			cwd: leadingCdCwd(parsed.command, inputCwd),
			env: environmentForInput(event.input),
			ctx,
			ids,
		});
	} catch {
		// Tool-call handlers are advisory; a parser failure must never block bash.
}
}

const GLOBAL_VALUE_FLAGS: Record<string, true> = {
	"--database": true,
	"--db": true,
	"--directory": true,
	"-C": true,
};
function idsChangedBy(command: string): string[] {
	const parsed = parse(command);
	if (parsed.unknown) return [];
	const changed = new Set<string>();
	for (const position of commandPositions(parsed)) {
		const start = executableIndex(position);
		if (start < 0) continue;
		const ids = new Set<string>();
		let verb: string | undefined;
		let status: string | undefined;
		let statusNeedsValue = false;
		const args = position.words.slice(start + 1);
		for (let i = 0; i < args.length; i++) {
			const token = args[i];
			if (!token) continue;
			if (verb === undefined) {
				if (!token.quoted && GLOBAL_VALUE_FLAGS[token.value] === true) {
					if (!token.value.includes("=")) i++;
					continue;
				}
				if (!token.quoted && !token.value.startsWith("-")) verb = token.value.toLowerCase();
				continue;
			}
			if (statusNeedsValue) {
				if (!token.quoted) status = token.value.toLowerCase();
				statusNeedsValue = false;
				continue;
			}
			if (!token.quoted && token.value === "--status") {
				statusNeedsValue = true;
				continue;
			}
			if (!token.quoted && token.value.startsWith("--status=")) {
				status = token.value.slice("--status=".length).toLowerCase();
				continue;
			}
			if (!token.value.startsWith("-") && BEAD_ID.test(token.value)) ids.add(token.value);
		}
		if (verb === "close" || verb === "done" || verb === "unclaim" || (verb === "update" && status !== undefined && status !== "in_progress")) {
			for (const id of ids) changed.add(id);
		}
	}
	return [...changed];
}
function stateFor(session: string): Map<string, ActiveHeartbeat> {
	let state = activeBySession.get(session);
	if (state === undefined) {
		state = new Map();
		activeBySession.set(session, state);
	}
	return state;
}

function stopHeartbeat(active: ActiveHeartbeat): void {
	if (active.stopped) return;
	active.stopped = true;
	try {
		active.clock.clearTimer(active.timer);
	} catch {
		// A host may already have cleared managed timers during shutdown.
	}
	const state = activeBySession.get(active.session);
	if (state?.get(active.id) === active) {
		state.delete(active.id);
		if (state.size === 0) activeBySession.delete(active.session);
	}
}

function unrefTimer(timer: unknown): void {
	if (timer === null || (typeof timer !== "object" && typeof timer !== "function")) return;
	try {
		const unref = (timer as { unref?: unknown }).unref;
		if (typeof unref === "function") unref.call(timer);
	} catch {
		// Managed timers may not expose unref, and unref is only a liveness hint.
	}
}

function noticeFailure(active: ActiveHeartbeat, reason: string): void {
	if (active.noticed) return;
	active.noticed = true;
	try {
		const message = {
			customType: "com.srobroek.beads.lease-heartbeat",
			content: `Beads lease heartbeat failed for ${active.id}; the claim may no longer be held (${reason}).`,
			display: true,
			attribution: "user" as const,
		};
		void Promise.resolve(active.pi.sendMessage(message, { deliverAs: "aside", triggerTurn: false })).catch(() => undefined);
	} catch {
		// A session can shut down between the heartbeat result and this notice.
	}
}

async function heartbeat(active: ActiveHeartbeat): Promise<void> {
	if (active.stopped || active.running) return;
	active.running = true;
	let timeoutTimer: unknown;
	try {
		const deadline = Date.now() + HEARTBEAT_TIMEOUT_MS;
		const run = injectedRun ?? defaultRun;
		const command = Promise.resolve().then(() => run(["bd", "heartbeat", active.id, "--json"], active.cwd, active.env, deadline));
		let result: BdResult;
		if (active.clock.setTimeout === undefined) {
			result = await command;
		} else {
			const timeout = Promise.withResolvers<BdResult>();
			timeoutTimer = active.clock.setTimeout?.(() => timeout.resolve({ exitCode: 124, stdout: "", stderr: "bd heartbeat timed out" }), HEARTBEAT_TIMEOUT_MS);
			unrefTimer(timeoutTimer);
			result = await Promise.race([command, timeout.promise]);
		}
		if (timeoutTimer !== undefined) active.clock.clearTimer(timeoutTimer);
		if (active.stopped) return;
		const output = result.stdout.trim();
		let jsonError: string | undefined;
		if (output.length > 0) {
			try {
				const parsed: unknown = JSON.parse(output);
				if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
					const error = (parsed as { error?: unknown }).error;
					if (error !== undefined && error !== null && String(error).trim() !== "") jsonError = `bd heartbeat returned an error: ${String(error)}`;
				}
			} catch {
				jsonError = "bd heartbeat returned invalid JSON";
			}
		}
		if (Date.now() >= deadline || result.exitCode === 124) {
			noticeFailure(active, "bd heartbeat timed out");
			stopHeartbeat(active);
		} else if (result.exitCode !== 0) {
			noticeFailure(active, result.stderr?.replace(/\s+/g, " ").trim() || `bd exited ${result.exitCode}`);
			stopHeartbeat(active);
		} else if (jsonError !== undefined) {
			noticeFailure(active, jsonError);
			stopHeartbeat(active);
		}
	} catch (error) {
		if (timeoutTimer !== undefined) active.clock.clearTimer(timeoutTimer);
		if (!active.stopped) {
			noticeFailure(active, error instanceof Error ? error.message : String(error));
			stopHeartbeat(active);
		}
	} finally {
		active.running = false;
	}
}

function startHeartbeat(pi: ExtensionAPI, claim: PendingClaim, id: string): void {
	const clock = timerClock(claim.ctx);
	if (clock === undefined) return;
	const state = stateFor(claim.session);
	if (state.has(id)) return;
	const active = {} as ActiveHeartbeat;
	active.id = id;
	active.session = claim.session;
	active.cwd = claim.cwd;
	active.env = claim.env;
	active.ctx = claim.ctx;
	active.pi = pi;
	active.clock = clock;
	active.running = false;
	active.stopped = false;
	active.noticed = false;
	try {
		active.timer = clock.setInterval(() => heartbeat(active), HEARTBEAT_INTERVAL_MS);
		unrefTimer(active.timer);
		state.set(id, active);
	} catch {
		active.stopped = true;
	}
}

function stopSession(session: string): void {
	const state = activeBySession.get(session);
	if (state === undefined) return;
	for (const active of [...state.values()]) stopHeartbeat(active);
}

function stopAllSessions(): void {
	for (const session of [...activeBySession.keys()]) stopSession(session);
}

async function onToolResult(pi: ExtensionAPI, event: ToolResultEvent, ctx?: ExtensionContext): Promise<{ content: ToolResultEvent["content"] } | undefined> {
	try {
		const claim = claimPending(ctx, event.toolCallId);
		if (claim === undefined) return undefined;
		pendingClaims.delete(pendingKey(claim.session, claim.toolCallId));
		if (event.isError || exitCode(event) !== 0) return undefined;
		// Plain `bd update ID --claim` prints no JSON, so the command's ids are the source;
		// `--json` output, when present, names the same beads.
		const ids = new Set([...claim.ids, ...claimedIds(resultOutput(event))]);
		for (const id of ids) startHeartbeat(pi, claim, id);
		return undefined;
	} catch {
		return undefined;
	}
}
async function onStopResult(event: ToolResultEvent, ctx?: ExtensionContext): Promise<void> {
	try {
		const recordedSession = toolSessions.get(event.toolCallId);
		toolSessions.delete(event.toolCallId);
		if (event.toolName !== "bash" || event.isError || exitCode(event) !== 0) return;
		const input = event.input as { command?: unknown };
		if (typeof input.command !== "string") return;
		const session = recordedSession ?? sessionKey(ctx);
		const state = activeBySession.get(session);
		if (state === undefined) return;
		for (const id of idsChangedBy(input.command)) {
			const active = state.get(id);
			if (active !== undefined) stopHeartbeat(active);
		}
	} catch {
		// Stop detection is advisory and must not affect a completed tool result.
	}
}

export default function bdLeaseHeartbeat(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input as { command?: unknown };
			if (typeof input.command !== "string") return;
			decideLeaseHeartbeatClaim(parse(input.command), event, ctx);
		} catch {
			// Never block or rewrite a tool call.
		}
	});
	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		await onToolResult(pi, event, ctx);
		await onStopResult(event, ctx);
	});
	pi.on("agent_end", (_event, ctx: ExtensionContext) => {
		try { stopSession(sessionKey(ctx)); } catch { /* lifecycle is best effort */ }
	});
	pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => {
		try {
			stopAllSessions();
			pendingClaims.clear();
		} catch { /* managed timers are also cleared by the host */ }
	});
}

async function defaultRun(
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline = Date.now() + HEARTBEAT_TIMEOUT_MS,
): Promise<BdResult> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return { exitCode: 124, stdout: "", stderr: "bd heartbeat timed out" };
	const proc = Bun.spawn(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: remaining,
		killSignal: "SIGKILL",
		env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if (Date.now() >= deadline) return { exitCode: 124, stdout: "", stderr: "bd heartbeat timed out" };
	return { exitCode: (await proc.exited) ?? 1, stdout, stderr };
}
