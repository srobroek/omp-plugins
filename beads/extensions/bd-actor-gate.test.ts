import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import bashGates from "./bash-gates.ts";
import bdActorGate, {
	ACTOR_NOTICE_ARBITER,
	actorPresent,
	actorValues,
	agentActor,
	bdInvocations,
	decideActorGate,
	environmentForInput,
	extractCommand,
	firstBdVerb,
	invocationActor,
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

	test("parses canonical and legacy command-local assignments as one actor", () => {
		expect(actorValues("BEADS_ACTOR=omp/Main/release BD_ACTOR=omp/Main/release bd update bead-1 --if-assignee holder", {
			BEADS_ACTOR: "ambient/canonical",
			BD_ACTOR: "ambient/legacy",
		})).toEqual(["omp/Main/release"]);
	});

	test("returns each literal actor used by mutating invocations only", () => {
		expect(
			actorValues(
				"BEADS_ACTOR=omp/Main/a bd close a; export BD_ACTOR=omp/Main/b; bd update b --claim; bd show c",
				emptyEnv,
			),
		).toEqual(["omp/Main/a", "omp/Main/b"]);
	});

test("explicit --actor wins, then BEADS_ACTOR, then BD_ACTOR", () => {
	const ambient = { BD_ACTOR: "omp/Main/legacy", BEADS_ACTOR: "omp/Main/canonical" } as NodeJS.ProcessEnv;
	expect(actorValues("bd --actor omp/Flag/explicit close x", ambient)).toEqual(["omp/Flag/explicit"]);
	expect(actorValues("BEADS_ACTOR=omp/Inline/canonical bd close x", { BD_ACTOR: "omp/Main/legacy" })).toEqual([
		"omp/Inline/canonical",
	]);
	// bd 1.3 gives BEADS_ACTOR precedence even over a command-local BD_ACTOR.
	expect(actorValues("BD_ACTOR=omp/Inline/legacy bd close x", { BEADS_ACTOR: "omp/Main/canonical" })).toEqual([
		"omp/Main/canonical",
	]);
	expect(actorValues("bd close x", ambient)).toEqual(["omp/Main/canonical"]);
	expect(actorValues("bd close x", { BD_ACTOR: "omp/Main/legacy" })).toEqual(["omp/Main/legacy"]);
});

test("the invocation helper applies the same 1.3 precedence", () => {
	const invocation = bdInvocations("bd --actor omp/Flag/explicit close x")[0];
	expect(invocation).toBeDefined();
	if (invocation === undefined) return;
	expect(invocationActor(invocation, { BEADS_ACTOR: "omp/Env/canonical", BD_ACTOR: "omp/Env/legacy" })).toBe("omp/Flag/explicit");
	expect(invocationActor(bdInvocations("BEADS_ACTOR=omp/Inline/canonical bd close x")[0]!, { BD_ACTOR: "omp/Env/legacy" })).toBe("omp/Inline/canonical");
});

	test("distinct invocations still report distinct actors", () => {
		// The plural name stays earned: one command line can carry several writes
		// under different identities. What is gone is two actors for ONE write.
		expect(
			actorValues(
				"BD_ACTOR=omp/Main/a bd close a; BD_ACTOR=omp/Main/b bd update b --claim",
				emptyEnv,
			),
		).toEqual(["omp/Main/a", "omp/Main/b"]);
	});
});

describe("agentActor", () => {
	const sessionDir = "/sessions/-repo";
	const runOne = "2026-09-22T16-36-13-128Z_01a0d3cb-01cc-752f-99ca-d5214749221d";
	const runTwo = "2026-09-22T16-36-13-128Z_01a0d3cb-01cc-752f-99ca-d5214749222d";
	const childFile = `${sessionDir}/${runOne}/AlphaImplementer.jsonl`;
	const nestedFile = `${sessionDir}/${runTwo}/EpicE3Scheduler/EpicE3Scheduler.LeaseTests.jsonl`;

	function context(file: string, header: unknown, withHeader = true, managerDir = sessionDir): never {
		const manager: Record<string, unknown> = {
			getSessionFile: () => file,
			getSessionDir: () => managerDir,
		};
		if (withHeader) manager.getHeader = () => header;
		return { sessionManager: manager } as never;
	}

	test("handles a subagent manager whose session dir is the run directory", () => {
		const managerDir = `${sessionDir}/${runOne}`;
		const file = `${managerDir}/ActorProbe.jsonl`;
		expect(agentActor(context(file, null, true, managerDir))).toBe("omp/01a0d3cb-01cc-752f-99ca-d5214749221d/ActorProbe");
	});

	test("uses a parentSession header and scopes a depth-one agent by run", () => {
		expect(agentActor(context(childFile, { parentSession: `${sessionDir}/${runOne}.jsonl` }))).toBe("omp/01a0d3cb-01cc-752f-99ca-d5214749221d/AlphaImplementer");
	});

	test("scopes a nested agent by the first run and full dotted basename", () => {
		expect(agentActor(context(nestedFile, { parentSession: `${sessionDir}/${runTwo}/EpicE3Scheduler.jsonl` }))).toBe("omp/01a0d3cb-01cc-752f-99ca-d5214749222d/EpicE3Scheduler.LeaseTests");
	});

	test("leaves the main session unchanged", () => {
		expect(agentActor(context(`${sessionDir}/${runOne}.jsonl`, {}))).toBeUndefined();
	});

	test("falls back to the nested run path when no header is available", () => {
		expect(agentActor(context(nestedFile, null))).toBe("omp/01a0d3cb-01cc-752f-99ca-d5214749222d/EpicE3Scheduler.LeaseTests");
		expect(agentActor(context(childFile, undefined, false))).toBe("omp/01a0d3cb-01cc-752f-99ca-d5214749221d/AlphaImplementer");
	});

	test("keeps same agent names distinct across runs", () => {
		const otherRun = `${sessionDir}/2026-09-22T16-36-13-128Z_01a0d3cb-01cc-752f-99ca-d5214749222d/AlphaImplementer.jsonl`;
		expect(agentActor(context(childFile, null))).not.toBe(agentActor(context(otherRun, null)));
	});
});

describe("subagent Bash actor rewrite", () => {
	const actorPrefix = "export BEADS_ACTOR='omp/01a0d3cb-01cc-752f-99ca-d5214749221d/AlphaImplementer'; ";
	const envKeys = ["BEADS_DIR", "BEADS_ACTOR", "BD_ACTOR"] as const;
	const savedEnv: Partial<Record<(typeof envKeys)[number], string>> = {};
	beforeEach(() => {
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const key of envKeys) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	function handler() {
		const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
		bashGates({ on: (_event: string, callback: (event: unknown, ctx: unknown) => unknown) => handlers.push(callback) } as never);
		return handlers[0];
	}
	function replacementInput(result: unknown): Record<string, unknown> | undefined {
		if (result === null || typeof result !== "object") return undefined;
		const input = (result as { input?: unknown }).input;
		return input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
	}
	function replacementCommand(result: unknown): string | undefined {
		const input = replacementInput(result);
		const command = input?.command ?? input?.cmd;
		return typeof command === "string" ? command : undefined;
	}
	const subagent = contextForBash("/sessions/-repo/2026-09-22T16-36-13-128Z_01a0d3cb-01cc-752f-99ca-d5214749221d/AlphaImplementer.jsonl", { parentSession: "/sessions/-repo/main.jsonl" });

	test("prefixes BEADS_ACTOR while preserving supplied env", async () => {
		const result = await handler()?.({ toolName: "bash", input: { command: "bd update A --claim", env: { FOO: "bar" } } }, subagent);
		const input = replacementInput(result);
		expect(replacementCommand(result)).toContain(actorPrefix);
		expect(input?.env).toEqual({ FOO: "bar" });
	});

	test("prefixes even when ambient actor variables are set", async () => {
		process.env.BEADS_DIR = "/tmp/actor-test-no-store";
		process.env.BEADS_ACTOR = "ambient/x";
		process.env.BD_ACTOR = "ambient/y";
		const result = await handler()?.({ toolName: "bash", input: { command: "bd update A --claim" } }, subagent);
		expect(replacementCommand(result)).toContain(actorPrefix);
	});

	test("does not rewrite main, non-bd, explicit flag, or command-local actor", async () => {
		const main = contextForBash("/sessions/-repo/2026-09-22T16-36-13-128Z_01a0d3cb-01cc-752f-99ca-d5214749221d.jsonl", {});
		const mainResult = await handler()?.({ toolName: "bash", input: { command: "bd update A --claim", env: { BEADS_ACTOR: "MainActor" } } }, main);
		expect(replacementCommand(mainResult) ?? "").not.toContain(actorPrefix);
		for (const [ctx, command] of [
			[subagent, "echo bd update A --claim"],
			[subagent, "bd --actor Explicit update A --claim"],
			[subagent, "BEADS_ACTOR=Explicit bd update A --claim"],
		] as const) {
			const result = await handler()?.({ toolName: "bash", input: { command } }, ctx);
			expect(replacementCommand(result) ?? "").not.toContain(actorPrefix);
		}
	});
});

function contextForBash(file: string, header: unknown): never {
	return {
		cwd: "/repo",
		sessionManager: {
			getHeader: () => header,
			getSessionFile: () => file,
			getSessionDir: () => "/sessions/-repo",
		},
	} as never;
}

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

	test("transparent wrappers retain real bd invocations", () => {
		expect(firstBdVerb("command bd close x")).toBe("close");
		expect(firstBdVerb("env FOO=1 bd close x")).toBe("close");
		expect(firstBdVerb("sudo -u build bd close x")).toBe("close");
		expect(isMutatingBdCommand("echo command bd close x")).toBe(false);
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
	test("blocks boolean claim flags without actor", () => {
		for (const command of ["bd update chezmoi-2ji --claim=true", "bd ready --claim=1"]) {
			expect(decideActorGate(command, emptyEnv).kind).toBe("block");
		}
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
	test("blocks create without actor", () => {
		const d = decideActorGate("bd create --title 'new bead'", emptyEnv);
		expect(d.kind).toBe("block");
		if (d.kind === "block") {
			expect(d.reason).toContain("Owner");
			expect(d.reason).toContain("--owner");
			expect(d.reason).toContain("--assignee");
		}
	});
	test("allows create with actor", () => {
		expect(decideActorGate("bd create --title 'new bead'", actorEnv).kind).toBe("allow");
	});
	test("blocks every verb that constructs an issue, not just `create`", () => {
		// `bd create --help` reports "Aliases: create, new", and `create-form` is
		// the interactive form over the same path. Each stamps an unrepairable
		// Owner, so blocking the literal verb alone leaves a silent permit.
		for (const command of [
			"bd new --title 'new bead'",
			"bd create-form",
		]) {
			const d = decideActorGate(command, emptyEnv);
			expect(d.kind).toBe("block");
			if (d.kind === "block") expect(d.reason).toContain("Owner");
		}
	});
	test("allows `bd new` when an actor is present", () => {
		expect(decideActorGate("bd new --title 'new bead'", actorEnv).kind).toBe(
			"allow",
		);
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
	test("decides claim-shaped bash and advisories without a migrated tool_call registration", () => {
		expect(decideActorGate("bd update chezmoi-2ji --claim", emptyEnv)).toEqual(
			expect.objectContaining({ kind: "block", reason: expect.stringContaining("BEADS_ACTOR") }),
		);
		expect(decideActorGate("bd show x", emptyEnv).kind).toBe("allow");
		expect(decideActorGate("bd close x", { BD_ACTOR: "omp/x/y" } as NodeJS.ProcessEnv).kind).toBe("allow");
		expect(decideActorGate("bd close x", emptyEnv).kind).toBe("advisory");
	});

	test("the retained tool_result handler ignores non-bash tools", () => {
		const handlers: Record<string, Array<(event: unknown) => unknown>> = {};
		bdActorGate({ on: (event: string, handler: (value: unknown) => unknown) => {
			const list = handlers[event] ?? [];
			list.push(handler);
			handlers[event] = list;
		} } as never);
		const toolResult = handlers.tool_result?.[0];
		expect(toolResult?.({ toolName: "edit", toolCallId: "c3", content: [] })).toBeUndefined();
	});
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
