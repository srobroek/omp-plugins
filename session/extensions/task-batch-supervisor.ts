import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const WAKE_GRACE_MS = 20_000;
export const MAX_REARMS = 3;
export const STALL_MS = 5 * 60_000;
export const STALE_JOB_MS = 60_000;
export const SWEEP_MS = 60_000;
export const CUSTOM_TYPE_WAKE = "task-batch-wake";
export const CUSTOM_TYPE_STALL = "task-child-stalled";
export const CUSTOM_TYPE_STALE_JOB = "task-job-stale";
export const CUSTOM_TYPE_SETTLED = "task-child-settled";
/** Settled children are buffered until no new one settles for this long, then sent as one nudge. */
export const NUDGE_QUIET_MS = 3_000;
/** A steady trickle of settles never holds a nudge longer than this after the first buffered child. */
export const NUDGE_MAX_HOLD_MS = 20_000;

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
	retryState?: unknown;
}
interface Batch {
	toolCallId: string;
	expected: number;
	children: Map<string, Child>;
	jobId?: string;
	settledAt?: number;
	wakeTimer?: Timer;
	rearms: number;
	woken: boolean;
}
interface SessionState {
	ctx: ExtensionContext;
	batches: Map<string, Batch>;
	/** Terminal children awaiting the one-time stale-job check, kept past batch cleanup. */
	staleWatch: Map<string, Child>;
	/** Children that settled since this session last dispatched a `task` call. */
	settledSinceDispatch: Set<string>;
	lastTurnStartAt: number;
	/** Children whose results a `wait` call has already returned to the parent. */
	seenIds: Set<string>;
	sweep?: Timer;
	/** Settled children (id → settle time) buffered for the next nudge; flushed once settles go quiet. */
	pendingNudge: Map<string, number>;
	nudgeTimer?: Timer;
	nudgeFirstAt?: number;
}
type LifecyclePayload = { id: string; agent: string; status: ChildStatus; parentToolCallId?: string; index: number };
type ProgressPayload = {
	parentToolCallId?: string;
	index: number;
	progress?: { id?: string; currentToolStartMs?: number; recentTools?: Array<{ endMs?: number }>; retryState?: unknown };
};
type AsyncSnapshot = { running: Array<{ id: string; agentId?: string }>; delivery: { pendingJobIds: string[] } };

/**
 * Tracker-agnostic on purpose: the parent knows whether it works from an issue ledger, a tasks
 * file, or its todo list. One constant string also keeps every nudge byte-identical for caching.
 */
export const REFILL_DIRECTIVE =
	"Review each result, then check for available and unblocked work. Dispatch every ready independent item now, together in one task call; never hold ready work back to group it with work that is still running, and do not wait to be nudged.";

export default function taskBatchSupervisor(pi: ExtensionAPI): void {
	// Each session gets its own factory call and its own `pi.events` bus, which carries only that
	// session's direct children. State therefore lives in this closure, never in a module-wide map.
	const sessions = new Map<string, SessionState>();
	/** The session this factory's bus belongs to now; bus frames carry no ctx, so they route here. */
	let current: SessionState | undefined;
	type Delivery = { deliverAs: "followUp"; triggerTurn: true } | { deliverAs: "aside" | "nextTurn" };
	const sendMessage = pi.sendMessage.bind(pi) as (message: Record<string, unknown>, options: Delivery) => void;
	const events = (pi as unknown as { events: { on: (channel: string, handler: (payload: unknown) => void) => void } }).events;

	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const stateFor = (ctx: ExtensionContext): SessionState => {
		const id = sessionId(ctx);
		let state = sessions.get(id);
		if (!state) {
			state = { ctx, batches: new Map(), staleWatch: new Map(), settledSinceDispatch: new Set(), lastTurnStartAt: 0, seenIds: new Set(), pendingNudge: new Map() };
			sessions.set(id, state);
		}
		state.ctx = ctx;
		current = state;
		return state;
	};
	const notify = (customType: string, content: string, details: Record<string, unknown>): void => {
		sendMessage({ customType, display: true, details, content }, { deliverAs: "followUp", triggerTurn: true });
	};
	/** Task spawns register their job under the child's agent id, so pending delivery is matched by id. */
	const deliveryFor = (state: SessionState, ids: readonly string[]): Delivery => {
		if (!state.ctx.isIdle()) return { deliverAs: "aside" };
		const pending = (state.ctx.getAsyncJobSnapshot() as AsyncSnapshot | null)?.delivery.pendingJobIds ?? [];
		return ids.some((id) => pending.includes(id)) ? { deliverAs: "nextTurn" } : { deliverAs: "followUp", triggerTurn: true };
	};
	/**
	 * Per-child refill nudge, timed so it costs no extra turn when one is already coming:
	 * - parent streaming: `aside`, injected at the next step boundary of the live run;
	 * - parent idle with native delivery pending: `nextTurn`, appended so it rides in the turn
	 *   that delivery starts;
	 * - parent idle with nothing pending: the results were already handled and the parent
	 *   stopped, which is the case this nudge exists for, so it starts a turn itself.
	 */
	const flushNudge = (state: SessionState): void => {
		state.nudgeTimer = undefined;
		state.nudgeFirstAt = undefined;
		try {
			// Skip a child the parent provably has: a `wait` returned it, or its native delivery is done
			// and a turn started after it settled. The stop reminder still covers a parent that stops.
			const delivering = (state.ctx.getAsyncJobSnapshot() as AsyncSnapshot | null)?.delivery.pendingJobIds ?? [];
			const ids = [...state.pendingNudge]
				.filter(([id, at]) => !state.seenIds.has(id) && !(state.lastTurnStartAt > at && !delivering.includes(id)))
				.map(([id]) => id);
			for (const id of state.pendingNudge.keys()) state.seenIds.delete(id);
			state.pendingNudge.clear();
			if (ids.length === 0) return;
			sendMessage(
				{
					customType: CUSTOM_TYPE_SETTLED,
					display: true,
					details: { children: ids },
					content: `Subagent(s) settled: ${ids.map((id) => `agent://${id}`).join(", ")}. ${REFILL_DIRECTIVE}`,
				},
				deliveryFor(state, ids),
			);
		} catch {
			// Advisory: a lost nudge is covered by the batch wake and stop reminder.
		}
	};
	/** Re-arms the quiet timer on every settle, but never past the hold cap of the oldest buffered child. */
	const bufferNudge = (state: SessionState): void => {
		const now = Date.now();
		state.nudgeFirstAt ??= now;
		if (state.nudgeTimer !== undefined) state.ctx.clearTimer(state.nudgeTimer);
		const delay = Math.max(0, Math.min(NUDGE_QUIET_MS, state.nudgeFirstAt + NUDGE_MAX_HOLD_MS - now));
		state.nudgeTimer = state.ctx.setTimeout(() => flushNudge(state), delay);
	};
	const clearWakeTimer = (state: SessionState, batch: Batch): void => {
		if (batch.wakeTimer === undefined) return;
		try {
			state.ctx.clearTimer(batch.wakeTimer);
		} catch {
			// Advisory cleanup; the context may already be shutting down.
		}
		batch.wakeTimer = undefined;
	};
	const ensureSweep = (state: SessionState): void => {
		if (state.sweep === undefined) state.sweep = state.ctx.setInterval(() => sweep(state), SWEEP_MS);
	};

	const wake = (state: SessionState, batch: Batch): void => {
		batch.woken = true;
		clearWakeTimer(state, batch);
		const counts = { completed: 0, failed: 0, aborted: 0 };
		const lines: string[] = [];
		for (const child of batch.children.values()) {
			if (child.status !== "started") counts[child.status] += 1;
			lines.push(`- ${child.id} (${child.agent}): ${child.status} — agent://${child.id}`);
		}
		notify(
			CUSTOM_TYPE_WAKE,
			`Task batch ${batch.toolCallId} has settled: ${counts.completed} completed, ${counts.failed} failed, ${counts.aborted} aborted.\n${lines.join("\n")}\nRead each agent:// output now. ${REFILL_DIRECTIVE} Do not wait on job ids from this batch; they are settled.`,
			{ toolCallId: batch.toolCallId, jobId: batch.jobId, children: [...batch.children.values()] },
		);
	};
	/**
	 * Backup wake for a settled batch, sent only while it is still provably needed. OMP delivers
	 * async results itself, so a wake is redundant once any turn has started since settlement,
	 * while native delivery is still pending, or while the parent is busy. A busy parent is
	 * re-checked a few times and then left alone: a follow-up queued behind active work lands
	 * after that work is done and costs a turn for results already handled.
	 */
	const check = (state: SessionState, batch: Batch): void => {
		try {
			if (batch.woken || batch.settledAt === undefined) return;
			const snapshot = state.ctx.getAsyncJobSnapshot() as AsyncSnapshot | null;
			const handled = state.lastTurnStartAt > batch.settledAt || snapshot?.delivery.pendingJobIds.includes(batch.jobId ?? "") === true;
			if (!handled && !state.ctx.isIdle() && batch.rearms < MAX_REARMS) {
				batch.rearms += 1;
				batch.wakeTimer = state.ctx.setTimeout(() => check(state, batch), WAKE_GRACE_MS);
				return;
			}
			if (!handled && state.ctx.isIdle()) wake(state, batch);
		} catch {
			// Advisory: when delivery state is unknown, stay silent rather than risk a duplicate follow-up.
		}
		batch.woken = true;
		state.batches.delete(batch.toolCallId);
	};
	const settle = (state: SessionState, batch: Batch): void => {
		if (batch.settledAt !== undefined) return;
		batch.settledAt = Date.now();
		try {
			batch.wakeTimer = state.ctx.setTimeout(() => check(state, batch), WAKE_GRACE_MS);
		} catch {
			// Advisory extension: if scheduling fails, do not block the session.
		}
	};
	const sweep = (state: SessionState): void => {
		try {
			const now = Date.now();
			for (const batch of state.batches.values()) {
				for (const child of batch.children.values()) {
					if (child.status !== "started" || child.retryState !== undefined || child.stallNotified) continue;
					if (now - child.lastActivityAt <= STALL_MS) continue;
					child.stallNotified = true;
					notify(
						CUSTOM_TYPE_STALL,
						`Child ${child.id} (${child.agent}) in batch ${batch.toolCallId} has shown no tool activity for ${Math.floor((now - child.lastActivityAt) / 60_000)} min. Check it now with read proc:// and history://${child.id}; if it is stuck, cancel its job with write proc://<job id>/kill and re-dispatch or release its work.`,
						{ toolCallId: batch.toolCallId, child },
					);
				}
			}
			let snapshot: AsyncSnapshot | null | undefined;
			for (const [id, child] of state.staleWatch) {
				if (now - (child.terminalAt ?? now) <= STALE_JOB_MS) continue;
				state.staleWatch.delete(id);
				snapshot ??= state.ctx.getAsyncJobSnapshot() as AsyncSnapshot | null;
				const running = snapshot?.running.find((job) => job.agentId === id);
				if (!running) continue;
				notify(
					CUSTOM_TYPE_STALE_JOB,
					`Job ${running.id} for agent ${id} is still registered as running although the agent ended ${child.status} at ${new Date(child.terminalAt ?? now).toISOString()}. Do not wait on it; read agent://${id} for its output and continue.`,
					{ child, jobId: running.id },
				);
			}
			if (state.batches.size === 0 && state.staleWatch.size === 0 && state.sweep !== undefined) {
				state.ctx.clearTimer(state.sweep);
				state.sweep = undefined;
			}
		} catch {
			// Advisory sweep must never interrupt the host.
		}
	};

	pi.on("tool_call", (event, ctx: ExtensionContext) => {
		try {
			const typed = event as { toolName?: string; toolCallId: string; input?: { tasks?: unknown[] } };
			if (typed.toolName !== "task") return undefined;
			const state = stateFor(ctx);
			state.settledSinceDispatch.clear();
			const expected = Array.isArray(typed.input?.tasks) ? typed.input.tasks.length : 1;
			state.batches.set(typed.toolCallId, { toolCallId: typed.toolCallId, expected, children: new Map(), rearms: 0, woken: false });
			ensureSweep(state);
		} catch {
			// Advisory extension: never block task dispatch.
		}
		return undefined;
	});
	pi.on("tool_result", (event, ctx: ExtensionContext) => {
		try {
			const typed = event as { toolName?: string; toolCallId: string; isError?: boolean; details?: { async?: { jobId: string } } };
			if (typed.toolName === "wait") {
				const state = sessions.get(sessionId(ctx));
				const text = JSON.stringify((event as { content?: unknown }).content ?? "");
				// `wait` lists each settled job as `### <id> [task] — <status>`; only those count as seen.
				if (state) for (const match of text.matchAll(/###\s+([A-Za-z0-9._-]+)\s+\[task\]\s+—\s+(?:completed|failed|cancelled|aborted)/g)) state.seenIds.add(match[1] as string);
				return;
			}
			if (typed.toolName !== "task") return;
			const state = sessions.get(sessionId(ctx));
			const batch = state?.batches.get(typed.toolCallId);
			if (!state || !batch) return;
			if (typed.isError || typed.details?.async === undefined) {
				clearWakeTimer(state, batch);
				state.batches.delete(batch.toolCallId);
			} else batch.jobId = typed.details.async.jobId;
		} catch {
			// Advisory handler.
		}
	});
	pi.on("turn_start", (_event, ctx: ExtensionContext) => {
		try {
			const state = sessions.get(sessionId(ctx));
			if (state) state.lastTurnStartAt = Date.now();
		} catch {
			// Advisory handler.
		}
	});
	pi.on("session_stop", (event, ctx: ExtensionContext) => {
		try {
			if ((event as { stop_hook_active?: boolean }).stop_hook_active === true) return undefined;
			const state = sessions.get(sessionId(ctx));
			if (!state || state.settledSinceDispatch.size === 0) return undefined;
			const ids = [...state.settledSinceDispatch];
			state.settledSinceDispatch.clear();
			// The continuation names these children, so a still-buffered nudge for them would only repeat it.
			for (const id of ids) state.pendingNudge.delete(id);
			if (state.pendingNudge.size === 0 && state.nudgeTimer !== undefined) {
				state.ctx.clearTimer(state.nudgeTimer);
				state.nudgeTimer = undefined;
				state.nudgeFirstAt = undefined;
			}
			return {
				continue: true as const,
				additionalContext: `Before stopping: ${ids.length} subagent(s) settled since your last task dispatch (${ids.map((id) => `agent://${id}`).join(", ")}). ${REFILL_DIRECTIVE} Stop only when nothing is ready or the rest needs the user.`,
			};
		} catch {
			return undefined;
		}
	});
	events.on("task:subagent:lifecycle", (payload) => {
		try {
			const event = payload as LifecyclePayload;
			if (!event.parentToolCallId) return;
			const state = current;
			const batch = state?.batches.get(event.parentToolCallId);
			if (state && batch) {
				const now = Date.now();
				const child = batch.children.get(event.id) ?? { id: event.id, agent: event.agent, index: event.index, status: event.status, lastActivityAt: now, stallNotified: false };
				const wasTerminal = child.terminalAt !== undefined;
				child.status = event.status;
				child.lastActivityAt = now;
				batch.children.set(event.id, child);
				if (event.status !== "started" && !wasTerminal) {
					child.terminalAt = now;
					state.staleWatch.set(child.id, child);
					state.settledSinceDispatch.add(child.id);
					state.pendingNudge.set(child.id, now);
					bufferNudge(state);
					ensureSweep(state);
				}
				if (batch.children.size >= batch.expected && [...batch.children.values()].every((c) => c.status !== "started")) settle(state, batch);
			}
		} catch {
			// Advisory handler.
		}
	});
	events.on("task:subagent:progress", (payload) => {
		try {
			const event = payload as ProgressPayload;
			if (!event.parentToolCallId) return;
			const batch = current?.batches.get(event.parentToolCallId);
			if (batch) {
				const progress = event.progress;
				const child = progress?.id ? batch.children.get(progress.id) : [...batch.children.values()].find((candidate) => candidate.index === event.index);
				if (!child) return;
				child.lastActivityAt = Math.max(Date.now(), progress?.currentToolStartMs ?? 0, ...(progress?.recentTools ?? []).map((tool) => tool.endMs ?? 0));
				child.retryState = progress?.retryState;
			}
		} catch {
			// Advisory handler.
		}
	});
	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		try {
			const id = sessionId(ctx);
			const state = sessions.get(id);
			if (state?.sweep !== undefined) state.ctx.clearTimer(state.sweep);
			if (state?.nudgeTimer !== undefined) state.ctx.clearTimer(state.nudgeTimer);
			sessions.delete(id);
			if (current === state) current = undefined;
		} catch {
			// Advisory handler.
		}
	});
}
