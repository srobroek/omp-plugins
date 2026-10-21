import { describe, expect, test } from "bun:test";
import supervisor, { CUSTOM_TYPE_SETTLED, CUSTOM_TYPE_STALE_JOB, CUSTOM_TYPE_STALL, CUSTOM_TYPE_WAKE, MAX_REARMS, NUDGE_MAX_HOLD_MS, NUDGE_QUIET_MS, REFILL_DIRECTIVE, STALE_JOB_MS, STALL_MS, WAKE_GRACE_MS } from "./task-batch-supervisor";

type Handler = (...args: unknown[]) => unknown;
type Fixture = ReturnType<typeof makeFixture>;

let sessionNumber = 0;
function makeFixture(options: { sessionId?: string } = {}) {
	const handlers: Record<string, Handler> = {};
	const bus: Record<string, Handler> = {};
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const timeouts: Array<{ fn: Handler; ms: number; cancelled?: boolean }> = [];
	const intervals: Handler[] = [];
	let idle = true;
	let snapshot: unknown = { running: [], delivery: { pendingJobIds: [] } };
	const sessionId = options.sessionId ?? `test-session-${++sessionNumber}`;
	const ctx = {
		setTimeout: (fn: Handler, ms: number) => { timeouts.push({ fn, ms }); return timeouts.length; },
		setInterval: (fn: Handler) => { intervals.push(fn); return intervals.length; },
		clearTimer: (timer: unknown) => { const entry = typeof timer === "number" ? timeouts[timer - 1] : undefined; if (entry) entry.cancelled = true; },
		isIdle: () => idle,
		getAsyncJobSnapshot: () => snapshot,
		sessionManager: { getSessionId: () => sessionId },
	};
	const pi = {
		on: (name: string, handler: Handler) => { handlers[name] = handler; },
		events: { on: (name: string, handler: Handler) => { bus[name] = handler; } },
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => sent.push({ message, options }),
	};
	supervisor(pi as never);
	return { handlers, bus, sent, timeouts, intervals, ctx, setIdle: (value: boolean) => { idle = value; }, setSnapshot: (value: unknown) => { snapshot = value; } };
}
function startAsync(f: Fixture, toolCallId = "batch-1", count = 2) {
	f.handlers.tool_call!({ toolName: "task", toolCallId, input: { tasks: Array.from({ length: count }, () => ({})) } }, f.ctx);
	f.handlers.tool_result!({ toolName: "task", toolCallId, details: { async: { jobId: "job-1" } } }, f.ctx);
}
function finish(f: Fixture, id: string, status: string, index: number) {
	f.bus["task:subagent:lifecycle"]!({ id, agent: `agent-${id}`, index, status, parentToolCallId: "batch-1" });
}
const timersOf = (f: Fixture, ms: number) => f.timeouts.filter((t) => t.ms === ms);
/** Run every scheduled wake check, including re-armed ones queued while running. */
function drainWakeChecks(f: Fixture) {
	for (let i = 0; i < f.timeouts.length; i += 1) if (f.timeouts[i]!.ms === WAKE_GRACE_MS) f.timeouts[i]!.fn();
}
/** Nudge timers are the short ones (≤ quiet window); fire every one still armed. */
const nudgeTimers = (f: Fixture) => f.timeouts.filter((t) => !t.cancelled && t.ms <= NUDGE_QUIET_MS);
const flushNudges = (f: Fixture) => { for (const t of nudgeTimers(f)) { t.cancelled = true; t.fn(); } };
function later<T>(ms: number, fn: () => T): T {
	const original = Date.now;
	Date.now = () => original() + ms;
	try {
		return fn();
	} finally {
		Date.now = original;
	}
}
const ofType = (f: Fixture, type: string) => f.sent.filter((x) => x.message.customType === type);
const wakes = (f: Fixture) => ofType(f, CUSTOM_TYPE_WAKE);
const nudges = (f: Fixture) => ofType(f, CUSTOM_TYPE_SETTLED);
const stop = (f: Fixture, active = false) => f.handlers.session_stop!({ stop_hook_active: active }, f.ctx) as { continue?: boolean; additionalContext?: string } | undefined;
const DIRECTIVE = REFILL_DIRECTIVE;

describe("task batch supervisor", () => {
	test("wakes once after a two-item async batch settles, with the refill directive", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); drainWakeChecks(f);
		expect(wakes(f)).toHaveLength(1);
		const content = String(wakes(f)[0]?.message.content);
		expect(content).toContain("agent://a"); expect(content).toContain("agent://b"); expect(content).toContain(DIRECTIVE);
		expect(wakes(f)[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});
	test("does not wake when a turn starts after settlement", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1);
		later(1, () => f.handlers.turn_start!({}, f.ctx)); drainWakeChecks(f); expect(wakes(f)).toHaveLength(0);
	});
	test("ignores synchronous task calls", () => {
		const f = makeFixture(); f.handlers.tool_call!({ toolName: "task", toolCallId: "sync", input: { tasks: [{}] } }, f.ctx); f.handlers.tool_result!({ toolName: "task", toolCallId: "sync", details: {} }, f.ctx);
		finish(f, "a", "completed", 0); f.timeouts.forEach((t) => { t.fn(); }); expect(f.sent).toHaveLength(0);
	});
	test("debounces duplicate terminal frames", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); finish(f, "b", "completed", 1); drainWakeChecks(f); flushNudges(f);
		expect(wakes(f)).toHaveLength(1); expect(nudges(f)).toHaveLength(1); expect(nudges(f)[0]?.message.details).toEqual({ children: ["a", "b"] });
	});
	test("notifies once for a child stalled past five minutes", () => {
		expect(STALL_MS).toBe(5 * 60_000);
		const f = makeFixture(); startAsync(f); finish(f, "a", "started", 0); finish(f, "b", "completed", 1);
		later(STALL_MS - 1_000, () => f.intervals[0]!()); expect(ofType(f, CUSTOM_TYPE_STALL)).toHaveLength(0);
		later(STALL_MS + 1, () => { f.intervals[0]!(); f.intervals[0]!(); }); expect(ofType(f, CUSTOM_TYPE_STALL)).toHaveLength(1);
	});
	test("matches real progress frames by child index", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "started", 0); finish(f, "b", "completed", 1);
		later(STALL_MS + 1, () => {
			f.bus["task:subagent:progress"]!({ index: 0, agent: "agent-a", parentToolCallId: "batch-1", progress: { status: "working", recentTools: [{ endMs: Date.now() }] } });
			f.intervals[0]!();
		});
		expect(ofType(f, CUSTOM_TYPE_STALL)).toHaveLength(0);
	});
	test("session shutdown only clears its own session", () => {
		const a = makeFixture({ sessionId: "shutdown-a" }); const b = makeFixture({ sessionId: "shutdown-b" });
		startAsync(a); startAsync(b); a.handlers.session_shutdown!({}, a.ctx);
		finish(b, "b-a", "completed", 0); finish(b, "b-b", "completed", 1); drainWakeChecks(b);
		expect(wakes(b)).toHaveLength(1);
	});
	test("a lifecycle frame on one session's bus never reaches another session", () => {
		const a = makeFixture(); const b = makeFixture(); startAsync(a); startAsync(b);
		finish(a, "x", "completed", 0); finish(a, "y", "completed", 1);
		expect(b.timeouts).toHaveLength(0); expect(stop(b)).toBeUndefined();
	});
	test("notifies when a terminal child job remains registered", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); f.setSnapshot({ running: [{ id: "job-1", agentId: "a" }], delivery: { pendingJobIds: [] } });
		later(STALE_JOB_MS + 1, () => f.intervals[0]!()); expect(ofType(f, CUSTOM_TYPE_STALE_JOB)).toHaveLength(1);
	});
	test("stale-job check still runs after the settled batch was handled and released", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1);
		later(1, () => f.handlers.turn_start!({}, f.ctx)); drainWakeChecks(f);
		f.setSnapshot({ running: [{ id: "job-1", agentId: "b" }], delivery: { pendingJobIds: [] } });
		later(STALE_JOB_MS + 1, () => { f.intervals[0]!(); f.intervals[0]!(); });
		expect(ofType(f, CUSTOM_TYPE_STALE_JOB)).toHaveLength(1); expect(wakes(f)).toHaveLength(0);
	});
	test("agent_end does not wake a settled batch", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); f.handlers.agent_end?.({ willContinue: false }, f.ctx); expect(wakes(f)).toHaveLength(0);
	});
	test("a parent that stays busy never receives a late wake", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); f.setIdle(false); drainWakeChecks(f);
		expect(timersOf(f, WAKE_GRACE_MS)).toHaveLength(1 + MAX_REARMS); expect(wakes(f)).toHaveLength(0);
	});
	test("pending native delivery suppresses the wake", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); f.setSnapshot({ running: [], delivery: { pendingJobIds: ["job-1"] } }); drainWakeChecks(f); expect(wakes(f)).toHaveLength(0);
	});
	test("stall alert still fires after the parent's turn ends", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "started", 0); finish(f, "b", "completed", 1); f.handlers.agent_end?.({ willContinue: false }, f.ctx);
		later(STALL_MS + 1, () => f.intervals[0]!());
		expect(ofType(f, CUSTOM_TYPE_STALL)).toHaveLength(1); expect(wakes(f)).toHaveLength(0);
	});
	test("each settled child gets a refill nudge before the batch settles, timed to the parent's state", () => {
		const f = makeFixture(); startAsync(f, "batch-1", 4); f.setIdle(false);
		finish(f, "a", "completed", 0); flushNudges(f);
		expect(nudges(f)).toHaveLength(1); expect(String(nudges(f)[0]?.message.content)).toContain("agent://a"); expect(String(nudges(f)[0]?.message.content)).toContain(DIRECTIVE);
		expect(nudges(f)[0]?.options).toEqual({ deliverAs: "aside" });
		f.setIdle(true); f.setSnapshot({ running: [], delivery: { pendingJobIds: ["b"] } }); finish(f, "b", "failed", 1); flushNudges(f);
		expect(nudges(f)[1]?.options).toEqual({ deliverAs: "nextTurn" });
		f.setSnapshot({ running: [], delivery: { pendingJobIds: ["unrelated"] } }); finish(f, "c", "completed", 2); flushNudges(f);
		expect(nudges(f)[2]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(nudges(f)).toHaveLength(3); expect(wakes(f)).toHaveLength(0);
	});
	test("settles keep buffering while they arrive and release together once quiet", () => {
		const f = makeFixture(); startAsync(f, "batch-1", 4);
		finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); finish(f, "c", "failed", 2);
		expect(nudgeTimers(f)).toHaveLength(1); expect(nudgeTimers(f)[0]?.ms).toBe(NUDGE_QUIET_MS);
		flushNudges(f);
		expect(nudges(f)).toHaveLength(1); expect(nudges(f)[0]?.message.details).toEqual({ children: ["a", "b", "c"] });
	});
	test("a steady trickle is scheduled to release at the hold cap, not postponed forever", () => {
		const f = makeFixture(); startAsync(f, "batch-1", 4);
		finish(f, "a", "completed", 0);
		later(NUDGE_MAX_HOLD_MS - 1_000, () => finish(f, "b", "completed", 1));
		expect(nudgeTimers(f)).toHaveLength(1); expect(nudgeTimers(f)[0]?.ms).toBeLessThanOrEqual(1_000);
		later(NUDGE_MAX_HOLD_MS + 5_000, () => finish(f, "c", "completed", 2));
		expect(nudgeTimers(f)[0]?.ms).toBe(0);
		flushNudges(f); expect(nudges(f)).toHaveLength(1); expect(nudges(f)[0]?.message.details).toEqual({ children: ["a", "b", "c"] });
		finish(f, "d", "completed", 3); expect(nudgeTimers(f)[0]?.ms).toBe(NUDGE_QUIET_MS);
	});
	test("a child the parent already has gets no nudge", () => {
		const viaWait = makeFixture(); startAsync(viaWait, "batch-1", 3);
		finish(viaWait, "a", "completed", 0); finish(viaWait, "b", "completed", 1);
		viaWait.handlers.tool_result!({ toolName: "wait", toolCallId: "w1", content: [{ type: "text", text: "### a [task] — completed" }] }, viaWait.ctx);
		flushNudges(viaWait); expect(nudges(viaWait)[0]?.message.details).toEqual({ children: ["b"] });
		const viaTurn = makeFixture(); startAsync(viaTurn, "batch-1", 3);
		finish(viaTurn, "a", "completed", 0);
		later(1, () => viaTurn.handlers.turn_start!({}, viaTurn.ctx));
		flushNudges(viaTurn); expect(nudges(viaTurn)).toHaveLength(0);
	});
	test("a turn does not count as seen while that child's native delivery is still pending", () => {
		const f = makeFixture(); startAsync(f, "batch-1", 3);
		finish(f, "a", "completed", 0);
		later(1, () => f.handlers.turn_start!({}, f.ctx));
		f.setSnapshot({ running: [], delivery: { pendingJobIds: ["a"] } });
		flushNudges(f); expect(nudges(f)).toHaveLength(1);
	});
	test("the refill directive stays tracker-agnostic", () => {
		expect(REFILL_DIRECTIVE).toContain("check for available and unblocked work");
		expect(REFILL_DIRECTIVE).not.toMatch(/\bbd\b|beads|tasks\.md/i);
	});
	test("session stop continues once for children settled since the last dispatch", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "failed", 1);
		expect(stop(f, true)).toBeUndefined();
		const first = stop(f); expect(first?.continue).toBe(true); expect(first?.additionalContext).toContain("agent://a"); expect(first?.additionalContext).toContain("agent://b");
		expect(stop(f)).toBeUndefined();
	});
	test("a new dispatch clears the stop reminder", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1);
		f.handlers.tool_call!({ toolName: "task", toolCallId: "batch-2", input: { tasks: [{}] } }, f.ctx);
		expect(stop(f)).toBeUndefined();
	});
	test("a stop reminder consumes still-buffered nudges for the same children", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1);
		expect(stop(f)?.continue).toBe(true);
		flushNudges(f);
		expect(nudges(f)).toHaveLength(0);
	});
});
