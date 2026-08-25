import { describe, expect, test } from "bun:test";

import bdActorGate, {
	actorPresent,
	decideActorGate,
	extractCommand,
	firstBdVerb,
	isClaimCommand,
	isMutatingBdCommand,
} from "./bd-actor-gate.ts";

const emptyEnv = {} as NodeJS.ProcessEnv;
const actorEnv = { BEADS_ACTOR: "omp/GateBuilder/backlog" } as NodeJS.ProcessEnv;

describe("extractCommand", () => {
	test("reads command then cmd", () => {
		expect(extractCommand({ command: "bd show x" })).toBe("bd show x");
		expect(extractCommand({ cmd: "bd list" })).toBe("bd list");
		expect(extractCommand({})).toBe("");
	});
});

describe("firstBdVerb / isMutatingBdCommand", () => {
	test("mutating verbs from hunt", () => {
		for (const v of [
			"update x --status open",
			"create --title t",
			"close x",
			"comment x -m hi",
			"comments add x --body hi",
			"claim x",
			"unclaim x",
			"dep add a b",
			"label add x foo",
			"remember foo",
			"forget foo",
			"mol pour x",
			"audit x",
			"set-state x open",
		]) {
			expect(isMutatingBdCommand(`bd ${v}`)).toBe(true);
		}
	});

	test("read-only verbs never trigger", () => {
		for (const cmd of [
			"bd show chezmoi-2ji",
			"bd ready --unassigned --json",
			"bd list",
			"bd where",
			"bd comments chezmoi-7eg",
			"bd swarm validate",
			"echo hello",
			"git status",
		]) {
			expect(isMutatingBdCommand(cmd)).toBe(false);
		}
	});

	test("comments without add is read-only", () => {
		expect(firstBdVerb("bd comments chezmoi-7eg")).toBe("comments");
		expect(isMutatingBdCommand("bd comments chezmoi-7eg")).toBe(false);
	});
});

describe("actorPresent", () => {
	test("prefix in command string", () => {
		expect(actorPresent("BEADS_ACTOR=omp/x/y bd update z --claim", emptyEnv)).toBe(true);
	});
	test("process env", () => {
		expect(actorPresent("bd close z", actorEnv)).toBe(true);
	});
	test("absent", () => {
		expect(actorPresent("bd close z", emptyEnv)).toBe(false);
	});
});

describe("isClaimCommand", () => {
	test("update --claim", () => {
		expect(isClaimCommand("bd update chezmoi-2ji --claim")).toBe(true);
	});
	test("bd claim", () => {
		expect(isClaimCommand("bd claim chezmoi-2ji")).toBe(true);
	});
	test("update without claim flag", () => {
		expect(isClaimCommand("bd update chezmoi-2ji --status open")).toBe(false);
	});
});

describe("decideActorGate", () => {
	test("blocks claim without actor", () => {
		const d = decideActorGate("bd update chezmoi-2ji --claim", emptyEnv);
		expect(d.kind).toBe("block");
	});
	test("allows claim with actor env", () => {
		expect(decideActorGate("bd update chezmoi-2ji --claim", actorEnv).kind).toBe("allow");
	});
	test("allows claim with command prefix", () => {
		expect(
			decideActorGate("BEADS_ACTOR=omp/x/y bd update chezmoi-2ji --claim", emptyEnv).kind,
		).toBe("allow");
	});
	test("advisory for other mutating without actor", () => {
		const d = decideActorGate("bd close chezmoi-2ji", emptyEnv);
		expect(d.kind).toBe("advisory");
	});
	test("allow read-only even without actor", () => {
		expect(decideActorGate("bd show chezmoi-2ji", emptyEnv).kind).toBe("allow");
		expect(decideActorGate("bd comments chezmoi-7eg", emptyEnv).kind).toBe("allow");
	});
	test("allow mutating when actor present", () => {
		expect(decideActorGate("bd close x", actorEnv).kind).toBe("allow");
	});
});

describe("integration", () => {
	test("blocks claim-shaped bash; advisories via tool_result", () => {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (e: string, h: (ev: unknown) => unknown) => {
				(handlers[e] ??= []).push(h);
			},
		};
		bdActorGate(fakePi as never);

		const blocked = handlers.tool_call![0]!({
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "bd update chezmoi-2ji --claim" },
		});
		expect(blocked).toEqual(
			expect.objectContaining({ block: true, reason: expect.stringContaining("BEADS_ACTOR") }),
		);

		const allowedShow = handlers.tool_call![0]!({
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "bd show x" },
		});
		expect(allowedShow).toBeUndefined();

		const adv = handlers.tool_call![0]!({
			toolName: "bash",
			toolCallId: "c3",
			input: { command: "bd close x" },
		});
		expect(adv).toBeUndefined();
		const patched = handlers.tool_result![0]!({
			toolName: "bash",
			toolCallId: "c3",
			content: [{ type: "text", text: "closed" }],
		});
		expect(JSON.stringify(patched)).toContain("BEADS_ACTOR");
	});
});
