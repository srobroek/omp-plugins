import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const WAKE_GRACE_MS = 20_000;
export const MAX_REARMS = 3;
export const STALL_MS = 10 * 60_000;
export const STALE_JOB_MS = 60_000;
export const SWEEP_MS = 60_000;
export const CUSTOM_TYPE_WAKE = "task-batch-wake";
export const CUSTOM_TYPE_STALL = "task-child-stalled";
export const CUSTOM_TYPE_STALE_JOB = "task-job-stale";

type Timer = ReturnType<ExtensionContext["setTimeout"]>;
type ChildStatus = "started" | "completed" | "failed" | "aborted";
interface Child {
	id: string;
	agent: string;
	index: number;
	status: ChildStatus;
	lastActivityAt: number;
	terminalAt?: number;
	stallNotified: boolean;
	staleJobNotified: boolean;
	retryState?: unknown;
}
interface Batch {
	toolCallId: string;
	sessionId: string;
	expected: number;
	children: Map<string, Child>;
	startedAt: number;
	jobId?: string;
	settledAt?: number;
	wakeTimer?: Timer;
	rearms: number;
	woken: boolean;
}
interface SessionState {
	ctx: ExtensionContext;
	sendMessage: (message: Record<string, unknown>, options: { deliverAs: "followUp"; triggerTurn: true }) => void;
	batches: Map<string, Batch>;
	lastTurnStartAt: number;
	sweep?: Timer;
}

const sessions = new Map<string, SessionState>();

type LifecyclePayload = {
	id: string;
	agent: string;
	status: ChildStatus;
	parentToolCallId?: string;
	index: number;
};
type ProgressPayload = {
	parentToolCallId?: string;
	index: number;
	progress?: {
		id?: string;
		status?: string;
		currentToolStartMs?: number;
		recentTools?: Array<{ endMs?: number }>;
		retryState?: unknown;
	};
};
type AsyncSnapshot = { running: Array<{ id: string; agentId?: string; status?: string; startTime?: number }>; delivery: { pendingJobIds: string[] } };

function getSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}
function stateFor(ctx: ExtensionContext, pi: ExtensionAPI): SessionState {
	const sessionId = getSessionId(ctx);
	let state = sessions.get(sessionId);
	if (!state) {
		state = { ctx, sendMessage: pi.sendMessage.bind(pi), batches: new Map(), lastTurnStartAt: 0 };
		sessions.set(sessionId, state);
	}
	state.ctx = ctx;
	state.sendMessage = pi.sendMessage.bind(pi);
	return state;
}
function clearWakeTimer(batch: Batch): void {
	if (batch.wakeTimer !== undefined) {
		try {
			sessions.get(batch.sessionId)?.ctx.clearTimer(batch.wakeTimer);
		} catch {
			// Advisory cleanup; the context may already be shutting down.
		}
		batch.wakeTimer = undefined;
	}
}
function settle(batch: Batch): void {
	if (batch.settledAt !== undefined) return;
	batch.settledAt = Date.now();
	const state = sessions.get(batch.sessionId);
	if (!state) return;
	try {
		batch.wakeTimer = state.ctx.setTimeout(() => check(batch), WAKE_GRACE_MS);
	} catch {
		// Advisory extension: if scheduling fails, do not block the session.
	}
}
function check(batch: Batch): void {
	try {
		if (batch.woken || batch.settledAt === undefined) return;
		const state = sessions.get(batch.sessionId);
		if (!state) return;
		if (state.lastTurnStartAt > batch.settledAt) {
			batch.woken = true;
			state.batches.delete(batch.toolCallId);
			return;
		}
		const snapshot = state.ctx.getAsyncJobSnapshot() as AsyncSnapshot | null;
		if (!state.ctx.isIdle() || snapshot?.delivery.pendingJobIds.includes(batch.jobId ?? "")) {
			if (batch.rearms < MAX_REARMS) {
				batch.rearms += 1;
				batch.wakeTimer = state.ctx.setTimeout(() => check(batch), WAKE_GRACE_MS);
				return;
			}
		}
		wake(batch);
	} catch {
		// Advisory: uncertainty should result in a nudge rather than silence.
		try {
			wake(batch);
		} catch {
			// Never allow an advisory hook to take down the session.
		}
	}
}
function wake(batch: Batch): void {
	if (batch.woken) return;
	const state = sessions.get(batch.sessionId);
	if (!state) return;
	batch.woken = true;
	clearWakeTimer(batch);
	const completed = [...batch.children.values()].filter((child) => child.status === "completed").length;
	const failed = [...batch.children.values()].filter((child) => child.status === "failed").length;
	const aborted = [...batch.children.values()].filter((child) => child.status === "aborted").length;
	const lines = [...batch.children.values()].map((child) => `- ${child.id} (${child.agent}): ${child.status} — agent://${child.id}`);
state.sendMessage(
		{
			customType: CUSTOM_TYPE_WAKE,
			display: true,
			details: { toolCallId: batch.toolCallId, jobId: batch.jobId, children: [...batch.children.values()] },
			content: `Task batch ${batch.toolCallId} has settled: ${completed} completed, ${failed} failed, ${aborted} aborted.\n${lines.join("\n")}\nProcess these results now: integrate the completed work, re-check your remaining work and status, then dispatch the next batch or finish. Do not wait on job ids from this batch; they are settled.`,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
	state.batches.delete(batch.toolCallId);
}
function sweep(sessionId: string): void {
	try {
		const state = sessions.get(sessionId);
		if (!state) return;
		const now = Date.now();
		for (const batch of state.batches.values()) {
			for (const child of batch.children.values()) {
				if (child.status === "started") {
					if (child.retryState !== undefined) continue;
					if (now - child.lastActivityAt > STALL_MS && !child.stallNotified) {
						child.stallNotified = true;
state.sendMessage({ customType: CUSTOM_TYPE_STALL, display: true, details: { toolCallId: batch.toolCallId, child }, content: `Child ${child.id} (${child.agent}) in batch ${batch.toolCallId} has shown no tool activity for ${Math.floor((now - child.lastActivityAt) / 60_000)} min. Check it with hub jobs / history://${child.id}; if it is stuck, hub cancel its job and re-dispatch or release its work.` }, { deliverAs: "followUp", triggerTurn: true });
					}
				} else if (child.terminalAt !== undefined && now - child.terminalAt > STALE_JOB_MS && !child.staleJobNotified) {
					const snapshot = state.ctx.getAsyncJobSnapshot() as AsyncSnapshot | null;
					const running = snapshot?.running.find((job) => job.agentId === child.id);
					if (running) {
						child.staleJobNotified = true;
state.sendMessage({ customType: CUSTOM_TYPE_STALE_JOB, display: true, details: { toolCallId: batch.toolCallId, child, jobId: running.id }, content: `Job ${running.id} for agent ${child.id} is still registered as running although the agent ended ${child.status} at ${new Date(child.terminalAt).toISOString()}. Do not hub wait on it; read agent://${child.id} for its output and continue.` }, { deliverAs: "followUp", triggerTurn: true });
					}
				}
			}
		}
		if (state.batches.size === 0) {
			if (state.sweep !== undefined) state.ctx.clearTimer(state.sweep);
			state.sweep = undefined;
		}
	} catch {
		// Advisory sweep must never interrupt the host.
	}
}
export default function taskBatchSupervisor(pi: ExtensionAPI): void {
	const events = (pi as unknown as { events: { on: (channel: string, handler: (payload: unknown) => void) => void } }).events;
	pi.on("tool_call", (event, ctx: ExtensionContext) => {
		try {
			const state = stateFor(ctx, pi);
			const typed = event as { toolName?: string; toolCallId: string; input?: { tasks?: unknown[] } };
			if (typed.toolName === "task") {
				const taskCount = Array.isArray(typed.input?.tasks) ? typed.input.tasks.length : 1;
				const batch: Batch = { toolCallId: typed.toolCallId, sessionId: getSessionId(ctx), expected: taskCount, children: new Map(), startedAt: Date.now(), rearms: 0, woken: false };
				state.batches.set(batch.toolCallId, batch);
				if (state.sweep === undefined) state.sweep = ctx.setInterval(() => sweep(batch.sessionId), SWEEP_MS);
			}
		} catch {
			// Advisory extension: never block task dispatch.
		}
		return undefined;
	});
	pi.on("tool_result", (event) => {
		try {
			const typed = event as { toolName?: string; toolCallId: string; isError?: boolean; details?: { async?: { jobId: string } } };
			if (typed.toolName !== "task") return;
			for (const state of sessions.values()) {
				const batch = state.batches.get(typed.toolCallId);
				if (!batch) continue;
				if (typed.isError || typed.details?.async === undefined) {
					clearWakeTimer(batch);
					state.batches.delete(batch.toolCallId);
				} else batch.jobId = typed.details.async.jobId;
			}
		} catch {
			// Advisory handler.
		}
	});
	pi.on("turn_start", (_event, ctx: ExtensionContext) => {
		try {
			stateFor(ctx, pi).lastTurnStartAt = Date.now();
		} catch {
			// Advisory handler.
		}
	});
	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		try {
			if ((event as { willContinue?: boolean }).willContinue) return;
			const state = stateFor(ctx, pi);
			for (const batch of state.batches.values()) if (batch.settledAt !== undefined && !batch.woken && batch.settledAt > state.lastTurnStartAt) wake(batch);
		} catch {
			// Advisory handler.
		}
	});
	events.on("task:subagent:lifecycle", (payload) => {
		try {
			const event = payload as LifecyclePayload;
			for (const state of sessions.values()) {
				const batch = event.parentToolCallId ? state.batches.get(event.parentToolCallId) : undefined;
				if (!batch) continue;
				const child = batch.children.get(event.id) ?? { id: event.id, agent: event.agent, index: event.index, status: event.status, lastActivityAt: Date.now(), stallNotified: false, staleJobNotified: false };
				child.status = event.status;
				child.lastActivityAt = Date.now();
				if (event.status !== "started") child.terminalAt = Date.now();
				batch.children.set(event.id, child);
				if (batch.children.size >= batch.expected && [...batch.children.values()].every((c) => c.status !== "started")) settle(batch);
			}
		} catch {
			// Advisory handler.
		}
	});
	events.on("task:subagent:progress", (payload) => {
		try {
			const event = payload as ProgressPayload;
			for (const state of sessions.values()) {
				const batch = event.parentToolCallId ? state.batches.get(event.parentToolCallId) : undefined;
				const child = batch === undefined ? undefined : (event.progress?.id
					? batch.children.get(event.progress.id)
					: [...batch.children.values()].find((candidate) => candidate.index === event.index));
				if (!child) continue;
				const progress = event.progress;
				child.lastActivityAt = Math.max(Date.now(), progress?.currentToolStartMs ?? 0, ...(progress?.recentTools ?? []).map((tool) => tool.endMs ?? 0));
				child.retryState = progress?.retryState;
			}
		} catch {
			// Advisory handler.
		}
	});
	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		try {
			const id = getSessionId(ctx);
			const state = sessions.get(id);
			if (state?.sweep !== undefined) state.ctx.clearTimer(state.sweep);
			sessions.delete(id);
		} catch {
			// Advisory handler.
		}
	});
}
