import { describe, expect, test } from "bun:test";
import { type PoolWaitParams, waitForPool } from "./pool-wait.ts";

function generator(seed = 0x2468ace): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state;
	};
}

function randomText(random: () => number): string {
	const alphabet = "abc[]{}\\\"'\n, :";
	let value = "";
	for (let index = 0; index < random() % 80; index += 1) value += alphabet[random() % alphabet.length] ?? "";
	return value;
}

describe("second-wave pool wait robustness properties", () => {
	test("malformed ready output returns structured errors without hanging", async () => {
		const random = generator();
		const started = performance.now();
		for (let iteration = 0; iteration < 2000; iteration += 1) {
			const output = randomText(random);
			const result = await waitForPool(
				{ pool: "pool:test", epic_id: "epic-1", timeout_s: 0.001, interval_s: 0.001 },
				"/tmp",
				{
					now: () => 0,
					runReady: async () => ({ exitCode: 0, stdout: output, stderr: "" }),
					sleep: async () => undefined,
				},
			);
			expect(result.details.status).toBe("error");
			expect(result.content[0]?.type).toBe("text");
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("fake sleep advances the injected clock and reaches timeout", async () => {
		let now = 0;
		let polls = 0;
		const result = await waitForPool(
			{ pool: "pool:test", epic_id: "epic-1", timeout_s: 0.05, interval_s: 0.01 },
			"/tmp",
			{
				now: () => now,
				runReady: async () => {
					polls += 1;
					return { exitCode: 0, stdout: "[]", stderr: "" };
				},
				sleep: async (milliseconds) => { now += milliseconds; },
			},
		);
		expect(result.details.status).toBe("timeout");
		expect(result.details.polls).toBe(polls);
		expect(polls).toBeGreaterThan(0);
		expect(polls).toBeLessThan(10);
	});

	test("invalid pool parameters refuse synchronously through the async API", async () => {
		const values: unknown[] = [null, undefined, 0, {}, [], { pool: "", epic_id: "x" }, { pool: "p", epic_id: "x", timeout_s: Infinity }];
		for (const value of values) {
			const result = await waitForPool(value as PoolWaitParams, "/tmp", { runReady: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }) });
			expect(result.details.status).toBe("error");
		}
	});
});
