import { afterEach, describe, expect, test } from "bun:test";

import bdLeaseHeartbeat, {
    HEARTBEAT_INTERVAL_MS,
    type HeartbeatClock,
    setHeartbeatClockForTests,
    setHeartbeatRunForTests,
} from "./bd-lease-heartbeat.ts";

const BEAD = "hb-1";
type TestContext = { cwd: string; sessionManager: { getSessionId: () => string } };
type TestInput = { command?: string; cwd?: string; env?: Record<string, string> };
type TestPart = { type: string; text?: string };
type TestEvent = { toolName?: string; toolCallId: string; input: TestInput; content?: TestPart[]; isError?: boolean; details?: unknown };
type Handler = (event: TestEvent, ctx?: TestContext) => unknown;

class FakeClock implements HeartbeatClock {
    private next = 0;
    readonly callbacks = new Map<number, () => void | Promise<void>>();
    readonly timeoutCallbacks = new Map<number, () => void>();

    setInterval(callback: () => void | Promise<void>, milliseconds: number): unknown {
        expect(milliseconds).toBe(HEARTBEAT_INTERVAL_MS);
        const id = ++this.next;
        this.callbacks.set(id, callback);
        return id;
    }

    setTimeout(callback: () => void, _milliseconds: number): unknown {
        const id = ++this.next;
        this.timeoutCallbacks.set(id, callback);
        return id;
    }

    clearTimer(timer: unknown): void {
        this.callbacks.delete(timer as number);
        this.timeoutCallbacks.delete(timer as number);
    }

    async tick(): Promise<void> {
        await Promise.all([...this.callbacks.values()].map(callback => callback()));
    }

    async tickTimeouts(): Promise<void> {
        await Promise.all([...this.timeoutCallbacks.values()].map(callback => callback()));
    }

}

function context(id: string, cwd = "/session/repo"): TestContext {
    return { cwd, sessionManager: { getSessionId: () => id } };
}

function wire(): { handlers: Record<string, Handler[]>; notices: string[] } {
    const handlers: Record<string, Handler[]> = {};
    const notices: string[] = [];
    const pi = {
        on(event: string, handler: Handler) {
            const list = handlers[event] ?? [];
            list.push(handler);
            handlers[event] = list;
        },
        sendMessage(message: { content?: string }) {
            if (typeof message.content === "string") notices.push(message.content);
        },
    };
    bdLeaseHeartbeat(pi as never);
    return { handlers, notices };
}

function claimCall(toolCallId: string, command = `bd update ${BEAD} --claim`, env?: Record<string, string>): TestEvent {
    return { toolName: "bash", toolCallId, input: { command, cwd: "/claiming/repo", ...(env ? { env } : {}) } };
}

function claimResult(toolCallId: string, text = `{"id":"${BEAD}"}`, command = `bd update ${BEAD} --claim`): TestEvent {
    return {
        toolName: "bash",
        toolCallId,
        input: { command, cwd: "/claiming/repo" },
        content: [{ type: "text", text }],
        isError: false,
        details: { exitCode: 0 },
    };
}

async function startClaim(id = "main", bead = BEAD, env?: Record<string, string>): Promise<{ handlers: Record<string, Handler[]>; notices: string[]; ctx: TestContext }> {
    const wired = wire();
    const ctx = context(id);
    const call = claimCall(`claim-${id}-${bead}`, `bd update ${bead} --claim`, env);
    await wired.handlers.tool_call?.[0]?.(call, ctx);
    await wired.handlers.tool_result?.[0]?.(claimResult(call.toolCallId, `{"id":"${bead}"}`), ctx);
    return { ...wired, ctx };
}

afterEach(() => {
    setHeartbeatRunForTests(null);
    setHeartbeatClockForTests(null);
});

describe("claim detection", () => {
    test("arms only for a successful real claim", async () => {
        const clock = new FakeClock();
        setHeartbeatClockForTests(clock);
        const { handlers } = wire();
        const ctx = context("positive");
        const call = claimCall("positive", "cd /work && bd update hb-1 --claim");
        await handlers.tool_call?.[0]?.(call, ctx);
        await handlers.tool_result?.[0]?.(claimResult("positive", '{"id":"hb-1"}', "cd /work && bd update hb-1 --claim"), ctx);
        expect(clock.callbacks.size).toBe(1);
    });

    test("arms for the default non-JSON claim output the bash tool returns", async () => {
        const clock = new FakeClock();
        const calls: string[][] = [];
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(argv => {
            calls.push(argv);
            return { exitCode: 0, stdout: "{}" };
        });
        const { handlers } = wire();
        const ctx = context("plain");
        const call = claimCall("plain", "bd update hb-1 --claim");
        await handlers.tool_call?.[0]?.(call, ctx);
        await handlers.tool_result?.[0]?.(
            {
                ...claimResult("plain", "\u2713 Updated issue: hb-1 \u2014 title\n\nWall time: 0.89 seconds", "bd update hb-1 --claim"),
                details: { timeoutSeconds: 300, wallTimeMs: 890 },
            },
            ctx,
        );
        expect(clock.callbacks.size).toBe(1);
        await clock.tick();
        expect(calls).toEqual([["bd", "heartbeat", "hb-1", "--json"]]);
    });

    test("does not arm for quoted or echoed claim text", async () => {
        const clock = new FakeClock();
        setHeartbeatClockForTests(clock);
        for (const [index, command] of ["echo 'bd update hb-1 --claim'", "printf '%s' --claim"].entries()) {
            const { handlers } = wire();
            const id = `negative-${index}`;
            const ctx = context(id);
            const call = claimCall(id, command);
            await handlers.tool_call?.[0]?.(call, ctx);
            await handlers.tool_result?.[0]?.(claimResult(id, '{"id":"hb-1"}', command), ctx);
        }
        expect(clock.callbacks.size).toBe(0);
    });

    test("does not arm after a failed claim even when output names a bead", async () => {
        const clock = new FakeClock();
        setHeartbeatClockForTests(clock);
        const { handlers } = wire();
        const ctx = context("failed");
        const call = claimCall("failed");
        await handlers.tool_call?.[0]?.(call, ctx);
        await handlers.tool_result?.[0]?.({ ...claimResult("failed"), isError: true, details: { exitCode: 1 } }, ctx);
        expect(clock.callbacks.size).toBe(0);
    });
});

describe("heartbeat cadence and ownership", () => {
    test("runs every interval with the claim cwd and environment", async () => {
        const clock = new FakeClock();
        const calls: Array<{ argv: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests((argv, cwd, env) => {
            calls.push({ argv, cwd, env });
            return { exitCode: 0, stdout: "", stderr: "" };
        });
        await startClaim("cadence", BEAD, { BEADS_DIR: "/scratch/beads", BEADS_ACTOR: "agent/cadence" });
        await clock.tick();
        await clock.tick();
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({ argv: ["bd", "heartbeat", BEAD, "--json"], cwd: "/claiming/repo" });
        expect(calls[0]?.env.BEADS_DIR).toBe("/scratch/beads");
        expect(calls[0]?.env.BEADS_ACTOR).toBe("agent/cadence");
    });

    test("never overlaps a heartbeat for one bead", async () => {
        const clock = new FakeClock();
        const pending = Promise.withResolvers<{ exitCode: number; stdout: string }>();
        let calls = 0;
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(() => {
            calls++;
            return pending.promise;
        });
        await startClaim("overlap");
        const first = clock.tick();
        await Promise.resolve();
        await clock.tick();
        expect(calls).toBe(1);
        pending.resolve({ exitCode: 0, stdout: "" });
        await first;
        await clock.tick();
        expect(calls).toBe(2);
    });

    test("does not start a second timer for a duplicate claim in one session", async () => {
        const clock = new FakeClock();
        setHeartbeatClockForTests(clock);
        const wired = wire();
        const ctx = context("duplicate");
        for (const callId of ["duplicate-1", "duplicate-2"]) {
            const call = claimCall(callId);
            await wired.handlers.tool_call?.[0]?.(call, ctx);
            await wired.handlers.tool_result?.[0]?.(claimResult(callId), ctx);
        }
        expect(clock.callbacks.size).toBe(1);
    });

    test("a child agent ending does not stop the parent heartbeat", async () => {
        const clock = new FakeClock();
        const calls: string[] = [];
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(argv => {
            calls.push(argv[2] ?? "");
            return { exitCode: 0, stdout: "" };
        });
        const parent = await startClaim("parent", "parent-1");
        await startClaim("child", "child-1");
        await parent.handlers.agent_end?.[0]?.({ toolCallId: "agent-end", input: {} }, context("child"));
        await clock.tick();
        expect(calls).toEqual(["parent-1"]);
    });

    test("does not arm a claim result delivered to a foreign session", async () => {
        const clock = new FakeClock();
        setHeartbeatClockForTests(clock);
        const wired = wire();
        const call = claimCall("same-tool-call");
        await wired.handlers.tool_call?.[0]?.(call, context("owner"));
        await wired.handlers.tool_result?.[0]?.(claimResult(call.toolCallId), context("foreign"));
        expect(clock.callbacks.size).toBe(0);
        await wired.handlers.tool_result?.[0]?.(claimResult(call.toolCallId), context("owner"));
        expect(clock.callbacks.size).toBe(1);
    });

    test("a stop command in one session cannot stop another session", async () => {
        const clock = new FakeClock();
        const calls: string[] = [];
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(argv => {
            calls.push(argv[2] ?? "");
            return { exitCode: 0, stdout: "" };
        });
        const owner = await startClaim("owner", "shared-bead");
        const foreign = await startClaim("foreign", "foreign-bead");
        const stop = claimCall("foreign-stop", "bd close shared-bead");
        await foreign.handlers.tool_call?.[0]?.(stop, foreign.ctx);
        await foreign.handlers.tool_result?.[0]?.(claimResult(stop.toolCallId, "", "bd close shared-bead"), foreign.ctx);
        await clock.tick();
        expect(calls.sort()).toEqual(["foreign-bead", "shared-bead"]);
        expect(owner.notices).toHaveLength(0);
    });
});

describe("stop conditions and failure notices", () => {
    for (const [label, command] of [["close", `bd close ${BEAD}`], ["unclaim", `bd unclaim ${BEAD}`], ["status", `bd update ${BEAD} --status closed`]] as const) {
        test(`stops on successful ${label}`, async () => {
            const clock = new FakeClock();
            let calls = 0;
            setHeartbeatClockForTests(clock);
            setHeartbeatRunForTests(() => {
                calls++;
                return { exitCode: 0, stdout: "" };
            });
            const { handlers, ctx } = await startClaim(`stop-${label}`);
            const stopCall = { toolName: "bash", toolCallId: `stop-call-${label}`, input: { command, cwd: "/claiming/repo" } };
            await handlers.tool_call?.[0]?.(stopCall, ctx);
            await handlers.tool_result?.[0]?.(claimResult(stopCall.toolCallId, "", command), ctx);
            await clock.tick();
            expect(calls).toBe(0);
        });
    }

    test("does not stop for an explicit in_progress status", async () => {
        const clock = new FakeClock();
        let calls = 0;
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(() => {
            calls++;
            return { exitCode: 0, stdout: "" };
        });
        const { handlers, ctx } = await startClaim("still-active");
        const status = claimCall("still-active-status", `bd update ${BEAD} --status in_progress`);
        await handlers.tool_call?.[0]?.(status, ctx);
        await handlers.tool_result?.[0]?.(claimResult(status.toolCallId, "", status.input.command), ctx);
        await clock.tick();
        expect(calls).toBe(1);
    });

    test("stops on agent_end and session_shutdown", async () => {
        const clock = new FakeClock();
        let calls = 0;
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(() => {
            calls++;
            return { exitCode: 0, stdout: "" };
        });
        const agent = await startClaim("agent-end");
        await agent.handlers.agent_end?.[0]?.({ toolCallId: "agent-end", input: {} }, agent.ctx);
        await clock.tick();
        expect(calls).toBe(0);
        const shutdown = await startClaim("shutdown");
        await startClaim("shutdown-other");
        await shutdown.handlers.session_shutdown?.[0]?.({ toolCallId: "shutdown", input: {} }, shutdown.ctx);
        await clock.tick();
        expect(calls).toBe(0);
    });

    test("stops after one failure and emits one concise notice", async () => {
        const clock = new FakeClock();
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(() => ({ exitCode: 1, stdout: "", stderr: "not holder" }));
        const wired = await startClaim("failure");
        await clock.tick();
        await clock.tick();
        expect(wired.notices).toHaveLength(1);
        expect(wired.notices[0]).toContain(BEAD);
        expect(wired.notices[0]).toContain("not holder");
    });

    for (const [label, result, reason] of [
        ["json error", { exitCode: 0, stdout: '{"error":"lease lost"}' }, "lease lost"],
        ["timeout", { exitCode: 124, stdout: "", stderr: "deadline" }, "timed out"],
    ] as const) {
        test(`stops after one ${label} and emits one advisory`, async () => {
            const clock = new FakeClock();
            setHeartbeatClockForTests(clock);
            setHeartbeatRunForTests(() => result);
            const wired = await startClaim(`failure-${label}`);
            await clock.tick();
            await clock.tick();
            expect(wired.notices).toHaveLength(1);
            expect(wired.notices[0]).toContain(BEAD);
            expect(wired.notices[0]).toContain(reason);
            expect(clock.callbacks.size).toBe(0);
        });
    }

    test("stops a heartbeat runner that never resolves", async () => {
        const clock = new FakeClock();
        let calls = 0;
        setHeartbeatClockForTests(clock);
        setHeartbeatRunForTests(() => {
            calls++;
            const { promise } = Promise.withResolvers<{ exitCode: number; stdout: string }>();
            return promise;
        });
        const wired = await startClaim("hung");
        const firstTick = clock.tick();
        await Promise.resolve();
        await clock.tickTimeouts();
        await firstTick;
        await clock.tick();
        expect(calls).toBe(1);
        expect(wired.notices).toHaveLength(1);
        expect(wired.notices[0]).toContain("timed out");
        expect(clock.callbacks.size).toBe(0);
    });
});
