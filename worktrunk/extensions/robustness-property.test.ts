import { describe, expect, test } from "bun:test";
import { requestsIsolation } from "./isolation-precheck.ts";
import { decideEvalMergePolicy, decideMergePolicy } from "./merge-policy-gate.ts";

function generator(seed = 0x13579bdf): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state;
	};
}

function source(random: () => number): string {
	const alphabet = "wt merge develop --no-squash --no-ff ;|&()$\\\\\\\"'\\n";
	let value = "";
	for (let index = 0; index < random() % 100; index += 1) value += alphabet[random() % alphabet.length] ?? "";
	return value;
}

const gitRunner = (_args: string[], _cwd: string): string => "origin/main";
const worktrunkRunner = (_args: string[], _cwd: string): string | null => null;

function blocked(command: string): boolean {
	return decideMergePolicy(command, "/tmp", gitRunner, worktrunkRunner)?.block === true;
}

describe("second-wave worktrunk robustness properties", () => {
	test("merge policy and isolation precheck never throw for malformed JSON-ish input", () => {
		const random = generator();
		const started = performance.now();
		for (let iteration = 0; iteration < 2000; iteration += 1) {
			const value = source(random);
			expect(() => {
				decideEvalMergePolicy(value);
				decideMergePolicy(value, "/tmp", gitRunner, worktrunkRunner);
				requestsIsolation(value);
				requestsIsolation({ isolated: value });
			}).not.toThrow();
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("merge guard preserves a block through shell whitespace and transparent wrappers", () => {
		const equivalents = [
			"  wt  merge  develop  ",
			"command wt merge develop",
			"env wt merge develop",
			"(wt merge develop)",
			"echo $(wt merge develop)",
			"wt merge develop --no-squash",
			"wt merge develop --no-ff",
		];
		expect(blocked("wt merge develop")).toBe(true);
		for (const command of equivalents) expect(blocked(command)).toBe(true);
	});
});
