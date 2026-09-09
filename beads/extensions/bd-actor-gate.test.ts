import { afterEach, describe, expect, test } from "bun:test";

import bdActorGate, {
	ACTOR_NOTICE_ARBITER,
	actorPresent,
	actorValues,
	decideActorGate,
	environmentForInput,
	extractCommand,
	firstBdVerb,
	isClaimCommand,
	isMutatingBdCommand,
} from "./bd-actor-gate.ts";

const emptyEnv = {} as NodeJS.ProcessEnv;
const actorEnv = { BEADS_ACTOR: "omp/GateBuilder/backlog" } as NodeJS.ProcessEnv;

afterEach(() => {
	Reflect.deleteProperty(globalThis, ACTOR_NOTICE_ARBITER);
});

describe("extractCommand", () => {
	test("reads command then cmd", () => {
		expect(extractCommand({ command: "bd show x" })).toBe("bd show x");
		expect(extractCommand({ cmd: "bd list" })).toBe("bd list");
		expect(extractCommand({})).toBe("");
	});
});

describe("actorValues / environmentForInput", () => {
	test("returns the tool-level BD_ACTOR used by a claim without an id", () => {
		const env = environmentForInput({ env: { BD_ACTOR: "omp/Main/alias" } }, emptyEnv);
		expect(actorValues("bd ready --claim", env)).toEqual(["omp/Main/alias"]);
	});

	test("returns each literal actor used by mutating invocations only", () => {
		expect(
			actorValues(
				"BEADS_ACTOR=omp/Main/a bd close a; export BD_ACTOR=omp/Main/b; bd update b --claim; bd show c",
				emptyEnv,
			),
		).toEqual(["omp/Main/a", "omp/Main/b"]);
	});
});

describe("firstBdVerb / isMutatingBdCommand", () => {
	test("mutating verbs from hunt", () => {
		for (const v of [
			"assign x worker",
			"batch operations.json",
			"claim x",
			"close x",
			"comment x -m hi",
			"cook release",
			"create --title t",
			"create-form",
			"defer x",
			"delete x",
			"duplicate a b",
			"edit x",
			"forget foo",
			"import issues.jsonl",
			"link a b",
			"note x hi",
			"priority x 1",
			"promote x",
			"q task",
			"remember foo",
			"rename x y",
			"reopen x",
			"set-state x open",
			"ship capability",
			"supersede a b",
			"tag x blocked",
			"unclaim x",
			"undefer x",
			"update x --status open",
			"comments add x --body hi",
			"dep add a b",
			"label add x foo",
			"mol pour x",
			"audit record --kind tool_call",
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

	test("grouped read actions and previews never trigger", () => {
		for (const cmd of [
			"bd mol list",
			"bd mol show mol-1",
			"bd mol current mol-1",
			"bd mol progress mol-1",
			"bd mol ready",
			"bd mol stale",
			"bd mol last-activity mol-1",
			"bd mol seed formula",
			"bd mol pour formula --dry-run",
			"bd mol wisp list",
			"bd mol --help",
			"bd dep tree x",
			"bd dep list x",
			"bd dep --help",
			"bd label list x",
			"bd label list-all",
			"bd label --help",
			"bd audit list",
			"bd audit --help",
			"bd gate list",
			"bd gate show gate-1",
			"bd todo list",
			"bd kv get key",
			"bd kv list",
			"bd duplicates",
			"bd duplicates --dry-run",
		]) {
			expect(isMutatingBdCommand(cmd)).toBe(false);
		}
	});

	test("grouped write actions trigger", () => {
		for (const cmd of [
			"bd mol pour formula",
			"bd mol bond a b",
			"bd mol wisp formula",
			"bd mol wisp create formula",
			"bd mol wisp gc",
			"bd dep add a b",
			"bd dep relate a b",
			"bd dep remove a b",
			"bd label add x foo",
			"bd label propagate x foo",
			"bd label remove x foo",
			"bd audit record --kind tool_call",
			"bd audit label event-1 useful",
			"bd gate check",
			"bd gate resolve gate-1",
			"bd todo add task",
			"bd kv append key value",
			"bd kv delete key",
			"bd kv rm key",
			"bd kv set key value",
			"bd kv update key value",
			"bd duplicates --auto-merge",
			"bd todo done todo-1",
		]) {
			expect(isMutatingBdCommand(cmd)).toBe(true);
		}
	});

	test("mentions and heredoc bodies are not invocations", () => {
		expect(isMutatingBdCommand("echo 'bd mol pour formula'")).toBe(false);
		expect(isMutatingBdCommand("cat <<'EOF'\nbd close x\nEOF")).toBe(false);
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
	test("exported earlier on the same command line", () => {
		expect(actorPresent("cd /repo && export BEADS_ACTOR=omp-main && bd close z", emptyEnv)).toBe(true);
	});
	test("an unexported assignment in an earlier segment never reaches bd", () => {
		expect(actorPresent("BEADS_ACTOR=omp-main; bd close z", emptyEnv)).toBe(false);
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
	test("quoted claim text does not turn another write into a claim", () => {
		expect(isClaimCommand("bd create --title 'bd update x --claim'")).toBe(false);
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
		// The handler reads the harness's real environment; a developer shell that
		// exports BEADS_ACTOR would otherwise turn every case here green.
		const saved = process.env.BEADS_ACTOR;
		delete process.env.BEADS_ACTOR;
		try {
			runIntegration();
		} finally {
			if (saved !== undefined) process.env.BEADS_ACTOR = saved;
		}
	});

	test.each(["orchestrate-first", "beads-first"] as const)(
		"arbitrates ordinary mutations and claims with %s handler order",
		(order) => {
			const handlers: Record<string, Array<(event: unknown) => unknown>> = {};
			const fakePi = {
				zod: {},
				registerTool: () => {},
				on: (event: string, handler: (value: unknown) => unknown) => {
					const registered = handlers[event] ?? [];
					registered.push(handler);
					handlers[event] = registered;
				},
			};
			bdActorGate(fakePi as never);
			const installed: unknown = Reflect.get(globalThis, ACTOR_NOTICE_ARBITER);
			if (installed === null || typeof installed !== "object" || !("handledToolCalls" in installed)) {
				throw new Error("beads actor arbiter was not installed");
			}
			const toolCall = handlers.tool_call?.[0];
			const toolResult = handlers.tool_result?.[0];
			if (toolCall === undefined || toolResult === undefined) {
				throw new Error("beads actor handlers were not registered");
			}
			const handledToolCalls = installed.handledToolCalls;
			if (!(handledToolCalls instanceof Set)) throw new Error("invalid beads actor arbiter");

			const id = `coinstalled-${order}`;
			if (order === "orchestrate-first") handledToolCalls.add(id);
			toolCall({
				toolName: "bash",
				toolCallId: id,
				input: { command: "bd close x", env: { BEADS_ACTOR: "", BD_ACTOR: "" } },
			});
			if (order === "beads-first") handledToolCalls.add(id);
			const result = toolResult({
				toolName: "bash",
				toolCallId: id,
				content: [{ type: "text", text: "closed" }],
			});
			expect(result).toBeUndefined();
			expect(handledToolCalls.has(id)).toBe(false);

			for (const [claimKind, command] of [
				["update", "bd update x --claim"],
				["top-level", "bd claim x"],
			] as const) {
				const claimId = `claim-${claimKind}-${order}`;
				const claim = toolCall({
					toolName: "bash",
					toolCallId: claimId,
					input: { command, env: { BEADS_ACTOR: "", BD_ACTOR: "" } },
				});
				expect(claim).toMatchObject({ block: true });
				expect(handledToolCalls.has(claimId)).toBe(false);
			}
		},
	);

	function runIntegration() {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: (value: unknown) => unknown) => {
				const registered = handlers[event] ?? [];
				registered.push(handler);
				handlers[event] = registered;
			},
		};
		bdActorGate(fakePi as never);
		const toolCall = handlers.tool_call?.[0];
		const toolResult = handlers.tool_result?.[0];
		if (toolCall === undefined || toolResult === undefined) {
			throw new Error("beads actor handlers were not registered");
		}

		const blocked = toolCall({
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "bd update chezmoi-2ji --claim" },
		});
		expect(blocked).toEqual(
			expect.objectContaining({ block: true, reason: expect.stringContaining("BEADS_ACTOR") }),
		);

		const allowedShow = toolCall({
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "bd show x" },
		});
		expect(allowedShow).toBeUndefined();

		const allowedToolEnv = toolCall({
			toolName: "bash",
			toolCallId: "c-env",
			input: { command: "bd close x", env: { BD_ACTOR: "omp/x/y" } },
		});
		expect(allowedToolEnv).toBeUndefined();
		const toolEnvResult = toolResult({
			toolName: "bash",
			toolCallId: "c-env",
			content: [{ type: "text", text: "closed" }],
		});
		expect(toolEnvResult).toBeUndefined();

		const adv = toolCall({
			toolName: "bash",
			toolCallId: "c3",
			input: { command: "bd close x" },
		});
		expect(adv).toBeUndefined();
		const patched = toolResult({
			toolName: "bash",
			toolCallId: "c3",
			content: [{ type: "text", text: "closed" }],
		});
		expect(JSON.stringify(patched)).toContain("BEADS_ACTOR");
	}
});

describe("export in an earlier segment", () => {
	test("a mutation after an export raises no advisory", () => {
		expect(
			decideActorGate("cd /repo && export BEADS_ACTOR=omp-main && bd close chezmoi-2ji --reason done", emptyEnv).kind,
		).toBe("allow");
	});
	test("the legacy actor export also attributes later mutations", () => {
		expect(decideActorGate("export BD_ACTOR=omp/x/y && bd close chezmoi-2ji", emptyEnv).kind).toBe("allow");
	});
	test("a claim after an export is allowed", () => {
		expect(decideActorGate("export BEADS_ACTOR=omp/x/y && bd update chezmoi-2ji --claim", emptyEnv).kind).toBe(
			"allow",
		);
	});
	test("a claim after an export of something else is still blocked", () => {
		expect(decideActorGate("export OTHER=1 && bd update chezmoi-2ji --claim", emptyEnv).kind).toBe("block");
	});
	test("an export after the bd command does not count", () => {
		expect(decideActorGate("bd close chezmoi-2ji && export BEADS_ACTOR=omp-main", emptyEnv).kind).toBe(
			"advisory",
		);
	});
});

describe("here-documents", () => {
	test("a commit message that mentions bd close is not a bd command", () => {
		const command = "git commit -q -F - <<'EOF'\nfix: x\n\nafter that, bd close y and bd update z --claim.\nEOF";
		expect(decideActorGate(command, emptyEnv).kind).toBe("allow");
	});
});
