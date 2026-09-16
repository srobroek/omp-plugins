import { describe, expect, test } from "bun:test";
import supervisor, { CUSTOM_TYPE_STALE_JOB, CUSTOM_TYPE_STALL, CUSTOM_TYPE_WAKE, STALE_JOB_MS, STALL_MS } from "./task-batch-supervisor";

type Handler = (...args: unknown[]) => unknown;
type Fixture = ReturnType<typeof makeFixture>;
let sessionNumber = 0;
function makeFixture(sessionIdOverride?: string) {
	const handlers: Record<string, Handler> = {};
	const bus: Record<string, Handler> = {};
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const timeouts: Handler[] = [];
	const intervals: Handler[] = [];
	let idle = true;
	let snapshot: unknown = { running: [], delivery: { pendingJobIds: [] } };
	const sessionId = sessionIdOverride ?? `test-session-${++sessionNumber}`;
	const ctx = {
		setTimeout: (fn: Handler) => { timeouts.push(fn); return timeouts.length; },
		setInterval: (fn: Handler) => { intervals.push(fn); return intervals.length; },
		clearTimer: (_timer: unknown) => undefined,
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
function startAsync(f: Fixture, toolCallId = "batch-1") {
	f.handlers.tool_call!({ toolName: "task", toolCallId, input: { tasks: [{}, {}] } }, f.ctx);
	f.handlers.tool_result!({ toolName: "task", toolCallId, details: { async: { jobId: "job-1" } } });
}
function finish(f: Fixture, id: string, status: string, index: number) {
	f.bus["task:subagent:lifecycle"]!({ id, agent: `agent-${id}`, index, status, parentToolCallId: "batch-1" });
}

describe("task batch supervisor", () => {
	test("wakes once after a two-item async batch settles", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); f.timeouts[0]!();
		expect(f.sent).toHaveLength(1); expect(f.sent[0]?.message.customType).toBe(CUSTOM_TYPE_WAKE); expect(f.sent[0]?.message.content).toContain("agent://a"); expect(f.sent[0]?.message.content).toContain("agent://b"); expect(f.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});
	test("does not wake when a turn starts after settlement", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); const original = Date.now; Date.now = () => original() + 1; f.handlers.turn_start!({}, f.ctx); Date.now = original; f.timeouts[0]!(); expect(f.sent).toHaveLength(0);
	});
	test("ignores synchronous task calls", () => {
		const f = makeFixture(); f.handlers.tool_call!({ toolName: "task", toolCallId: "sync", input: { tasks: [{}] } }, f.ctx); f.handlers.tool_result!({ toolName: "task", toolCallId: "sync", details: {} }); f.timeouts.forEach((fn) => { fn(); }); expect(f.sent).toHaveLength(0);
	});
	test("debounces duplicate terminal frames", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); finish(f, "b", "completed", 1); f.timeouts[0]!(); expect(f.sent.filter((x) => x.message.customType === CUSTOM_TYPE_WAKE)).toHaveLength(1);
	});
	test("notifies once for a stalled child", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "started", 0); finish(f, "b", "completed", 1); const original = Date.now; Date.now = () => original() + STALL_MS + 1; f.intervals[0]!(); f.intervals[0]!(); Date.now = original; expect(f.sent.filter((x) => x.message.customType === CUSTOM_TYPE_STALL)).toHaveLength(1);
	});
	test("matches real progress frames by child index", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "started", 0); finish(f, "b", "completed", 1);
		const original = Date.now; Date.now = () => original() + STALL_MS + 1;
		f.bus["task:subagent:progress"]!({ index: 0, agent: "agent-a", parentToolCallId: "batch-1", progress: { status: "working", recentTools: [{ endMs: Date.now() }] } });
		f.intervals[0]!(); Date.now = original;
		expect(f.sent.filter((x) => x.message.customType === CUSTOM_TYPE_STALL)).toHaveLength(0);
	});
	test("session shutdown only clears its own session", () => {
		const a = makeFixture("shutdown-a"); const b = makeFixture("shutdown-b");
		startAsync(a); startAsync(b); a.handlers.session_shutdown!({}, a.ctx);
		finish(b, "b-a", "completed", 0); finish(b, "b-b", "completed", 1); b.timeouts[0]!();
		expect(b.sent.filter((x) => x.message.customType === CUSTOM_TYPE_WAKE)).toHaveLength(1);
	});
	test("notifies when a terminal child job remains registered", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); f.setSnapshot({ running: [{ id: "job-1", agentId: "a" }], delivery: { pendingJobIds: [] } }); const original = Date.now; Date.now = () => original() + STALE_JOB_MS + 1; f.intervals[0]!(); Date.now = original; expect(f.sent.filter((x) => x.message.customType === CUSTOM_TYPE_STALE_JOB)).toHaveLength(1);
	});
	test("agent_end wakes a settled batch immediately", () => {
		const f = makeFixture(); startAsync(f); finish(f, "a", "completed", 0); finish(f, "b", "completed", 1); f.handlers.agent_end!({ willContinue: false }, f.ctx); expect(f.sent.filter((x) => x.message.customType === CUSTOM_TYPE_WAKE)).toHaveLength(1);
	});
});
