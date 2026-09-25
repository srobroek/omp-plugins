import { describe, expect, test } from "bun:test";
import { type BdReadyResult, refuseUnguardedUnclaim, waitForPool } from "./pool-wait";

function result(stdout: string, exitCode = 0): BdReadyResult {
	return { exitCode, stdout, stderr: exitCode === 0 ? "" : "bd unavailable" };
}

describe("pool_wait", () => {
	test("returns the first record for the requested epic", async () => {
		const calls: string[] = [];
		let poll = 0;
		const waited = await waitForPool(
			{ pool: "pool:implementer", epic_id: "epic-1", timeout_s: 1, interval_s: 0.01 },
			"/tmp/project",
			{
				runReady: async (pool, cwd) => {
					calls.push(`${pool}@${cwd}`);
					poll += 1;
					return poll === 1
						? result(JSON.stringify([{ id: "other", metadata: { epic_id: "epic-2" } }]))
						: result(JSON.stringify([{ id: "match", metadata: { epic_id: "epic-1" } }]));
				},
				sleep: async () => {},
				now: () => poll,
			},
		);

		expect(waited.details.status).toBe("ready");
		expect(waited.details.record).toEqual({ id: "match", metadata: { epic_id: "epic-1" } });
		expect(waited.details.polls).toBe(2);
		expect(calls).toEqual(["pool:implementer@/tmp/project", "pool:implementer@/tmp/project"]);
	});

	test("times out while no matching record is ready", async () => {
		let clock = 0;
		const waited = await waitForPool(
			{ pool: "pool:researcher", epic_id: "epic-1", timeout_s: 0.01, interval_s: 0.01 },
			"/tmp/project",
			{
				runReady: async () => result("[]"),
				sleep: async (milliseconds) => {
					clock += milliseconds;
				},
				now: () => clock,
			},
		);

		expect(waited.details.status).toBe("timeout");
		expect(waited.details.polls).toBe(1);
		expect(waited.content[0]?.text).toContain("timed out");
	});

	test("returns a structured error when bd fails", async () => {
		const waited = await waitForPool(
			{ pool: "pool:operator", epic_id: "epic-1", timeout_s: 1, interval_s: 0.01 },
			"/tmp/project",
			{ runReady: async () => result("", 1), sleep: async () => {} },
		);

		expect(waited.details.status).toBe("error");
		expect(waited.details.error).toBe("bd unavailable");
		expect(waited.content[0]?.text).toContain("pool_wait failed");
	});

	test("rejects a timeout above the safety bound", async () => {
		const waited = await waitForPool({ pool: "pool:operator", epic_id: "epic-1", timeout_s: 1801 }, "/tmp/project");

		expect(waited.details.status).toBe("error");
		expect(waited.details.error).toContain("at most 1800");
	});
	test("refuses unguarded bd unclaim commands", () => {
		expect(refuseUnguardedUnclaim("bd unclaim bead-1")).toEqual({ block: true, reason: expect.stringContaining("--if-assignee") });
		expect(refuseUnguardedUnclaim("bd update bead-1 --assignee pool:shepherd --if-assignee actor")).toBeUndefined();
	});
});
