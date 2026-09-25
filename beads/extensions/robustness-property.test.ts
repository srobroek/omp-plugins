import { describe, expect, test } from "bun:test";
import { embeddedWriteTargets } from "./bd-embedded-write-lock.ts";
import { decideActorParsed } from "./bd-actor-gate.ts";
import bashGates from "./bash-gates.ts";
import { parse, classify, parsedInvocations } from "./shell-command.ts";
import { shellQuoteBalanced, tokenizeShell } from "./shell-tokenizer.ts";
import { pinBashInput, rewriteBashInput } from "./session-beads-lifecycle.ts";

type Jsonish = null | boolean | number | string | Jsonish[] | { [key: string]: Jsonish };
type ToolHandler = (event: unknown, context: unknown) => unknown;

function generator(seed = 0x5eed): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state;
	};
}

function jsonish(random: () => number, depth = 0): Jsonish {
	if (depth > 2) return [null, false, random() % 17, ""][random() % 4] as Jsonish;
	switch (random() % 6) {
		case 0: return null;
		case 1: return (random() & 1) === 1;
		case 2: return (random() % 2001) - 1000;
		case 3: return ["", "bd show x", "$(bd close x)", "\u0000", "'quoted'"][random() % 5] ?? "";
		case 4: return Array.from({ length: random() % 4 }, () => jsonish(random, depth + 1));
		default: return { value: jsonish(random, depth + 1), command: random() % 2 === 0 ? "bd show x" : null };
	}
}

function shellSource(random: () => number): string {
	const alphabet = "abc ;|&()$\\\\\\\"'\\n\\t<>=";
	let source = "";
	for (let index = 0; index < random() % 80; index += 1) source += alphabet[random() % alphabet.length] ?? "";
	return source;
}

function handler(): ToolHandler {
	let callback: ToolHandler | undefined;
	bashGates({
		on: (event: string, registered: ToolHandler) => {
			if (event === "tool_call") callback = registered;
		},
	} as never);
	if (callback === undefined) throw new Error("bash gate did not register a tool_call handler");
	return callback;
}

describe("second-wave beads robustness properties", () => {
	test("parser, tokenizer, actor decision, and lifecycle helpers never throw on JSON-ish values", () => {
		const random = generator();
		const started = performance.now();
		for (let iteration = 0; iteration < 2000; iteration += 1) {
			const value = jsonish(random);
			expect(() => {
				const parsed = parse(value);
				classify(parsed);
				parsedInvocations(parsed);
				decideActorParsed(value, {});
				tokenizeShell(value);
				shellQuoteBalanced(value);
				pinBashInput(value, "/tmp/robustness-pin");
				rewriteBashInput(value, { cwd: "/tmp" } as never);
			}).not.toThrow();
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("bash tool_call handler remains asynchronous and fail-closed for random commands", async () => {
		const random = generator(0xabc123);
		const call = handler();
		const started = performance.now();
		for (let iteration = 0; iteration < 2000; iteration += 1) {
			const result = await call(
				{ toolName: "bash", input: { command: shellSource(random), cwd: "/tmp" } },
				{ cwd: "/tmp" },
			);
			expect(result === undefined || (result !== null && typeof result === "object")).toBe(true);
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("embedded target classification stays bounded for random shell strings", () => {
		const random = generator(0x44aa);
		const started = performance.now();
		for (let iteration = 0; iteration < 2000; iteration += 1) {
			const targets = embeddedWriteTargets(shellSource(random), "/tmp", {});
			expect(targets.kind === "stores" || targets.kind === "unknown").toBe(true);
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("actor gate blocks malformed parsed structures rather than throwing", () => {
		for (const value of [null, undefined, 0, "bd close x", {}, { segments: [null], nested: [] }, { segments: [], nested: [null] }]) {
			expect(decideActorParsed(value, {}).kind).toBe("block");
		}
	});
});
