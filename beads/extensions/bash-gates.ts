import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { agentActor, bdInvocations, decideActorParsed, environmentForInput } from "./bd-actor-gate.ts";
import { decideBdCloseParsed } from "./bd-close-gate.ts";
import { decideEmbeddedWrite } from "./bd-embedded-write-lock.ts";
import { admitBdMutation, admitBeadsWork, lifecycleBdEnvironment, rewriteBashInput } from "./session-beads-lifecycle.ts";
import { blockReason, commandFromInput, type ParsedCommand, parse, settingsEnabled } from "./shell-command.ts";


type BashInput = { command?: unknown; cmd?: unknown; cwd?: unknown; env?: unknown };
type GateDecision = { block: true; reason: string } | undefined;


/** Stay below the host's 30 second tool_call deadline, including every gate. */
const TOOL_CALL_BUDGET_MS = 25_000;

function inputOf(event: ToolCallEvent, ctx: ExtensionContext): { command: string; cwd: string } {
	const input = event.input as BashInput;
	return {
		command: commandFromInput(input),
		cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd()),
	};
}

function suffix(gate: string, reason: string, resolution = "inspect the command and retry"): GateDecision {
	return { block: true, reason: blockReason({ gate, cause: reason, resolution }) };
}

/**
 * Every store-safety gate sees the same validated parse; rewrites happen only after all decisions allow.
 *
 * The write-lock wrapper, session's `BEADS_DIR` pin, and subagent actor prefix
 * compose into one revised command, so a later rewrite never drops an earlier one.
 */
function actorForCommand(command: string, ctx: ExtensionContext): string | undefined {
	const actor = agentActor(ctx);
	if (actor === undefined) return undefined;
	const invocations = bdInvocations(command);
	if (invocations.length === 0) return undefined;
	if (invocations.some(invocation =>
		invocation.globals.some(token => token === "--actor" || token.startsWith("--actor=")) ||
		invocation.prefix.some(token => token.startsWith("BEADS_ACTOR=")) ||
		invocation.exported.BEADS_ACTOR !== undefined,
	)) return undefined;
	return actor;
}

function inputForAgentActor(input: Record<string, unknown>, command: string, ctx: ExtensionContext): Record<string, unknown> {
	const actor = actorForCommand(command, ctx);
	if (actor === undefined) return input;
	const key = typeof input.command === "string" ? "command" : "cmd";
	if (typeof input[key] !== "string") return input;
	const escaped = actor.replaceAll("'", "'\\''");
	return { ...input, [key]: `export BEADS_ACTOR='${escaped}'; ${input[key]}` };
}

function environmentForActorDecision(input: Record<string, unknown>, command: string, ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env = environmentForInput(input as ToolCallEvent["input"]);
	const actor = actorForCommand(command, ctx);
	return actor === undefined ? env : { ...env, BEADS_ACTOR: actor };
}

async function decide(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext, pi: ExtensionAPI, deadline: number): Promise<GateDecision | { input: Record<string, unknown> } | undefined> {
	let input = event.input as Record<string, unknown>;
	const { cwd } = inputOf(event, ctx);
	if (parsed.unknown) return suffix("bash-gates", "command could not be parsed", "split the command or run the mutation as a plain single command");
	const env = environmentForActorDecision(input, parsed.command, ctx);
	if (settingsEnabled("beads", "bd-close-gate", cwd)) {
		try {
			const close = await decideBdCloseParsed(parsed, cwd, deadline);
			if (close !== undefined) return suffix("bd-close-gate", close.reason, "resolve the gate with `bd gate check` or `bd gate resolve <gate-id>`, then retry");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return suffix("bd-close-gate", reason, "retry after the Beads lookup is available; the close was refused without gate proof");
		}
	}
	if (settingsEnabled("beads", "bd-actor-gate", cwd)) {
		const actor = decideActorParsed(parsed, env);
		if (actor.kind === "block") return suffix("bd-actor-gate", actor.reason);
		if (actor.kind === "advisory" && typeof pi.sendMessage === "function") pi.sendMessage({ customType: "beads-bd-actor-advisory", content: actor.text, display: true, attribution: "user" }, { triggerTurn: false });
	}

	if (settingsEnabled("beads", "bd-embedded-write-lock", cwd)) {
		const embedded = await decideEmbeddedWrite(parsed, event, ctx, deadline);
		if (embedded?.kind === "block") return suffix("bd-embedded-write-lock", embedded.reason);
		if (embedded?.kind === "rewrite") input = embedded.input;
	}
	// Apply the actor prefix after every runner rewrite so the executed command keeps it.
	input = inputForAgentActor(input, parsed.command, ctx);
	const rewritten = rewriteBashInput(input, ctx) ?? input;
	if (JSON.stringify(rewritten) !== JSON.stringify(event.input)) return { input: rewritten };
	return undefined;
}

/** The beads plugin's sole Bash tool-call registration. Parsing happens exactly once. */
export default function bashGates(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			const input = event.input as Record<string, unknown>;
			const gatedTool = event.toolName === "task" ||
				(event.toolName === "bd_reconcile" && input.apply === true) ||
				(event.toolName === "bd_formula_check" && input.deep === true);
			if (gatedTool) {
				const workspace = typeof input.workspace === "string" ? input.workspace : undefined;
				if (event.toolName === "bd_formula_check" && workspace === undefined) return suffix("beads-gate-admission", "deep formula checks require an explicit workspace so admission and execution cannot select different stores", "set workspace to the target checkout and retry");
				const cwd = workspace === undefined ? (ctx?.cwd ?? process.cwd()) : resolve(ctx?.cwd ?? process.cwd(), workspace);
				const admission = await admitBeadsWork(ctx, cwd, lifecycleBdEnvironment(cwd));
				if (admission) return suffix("beads-gate-admission", admission.reason, "retry the operation; verification continues and the next attempt waits on the same read");
				return undefined;
			}
			if (event.toolName !== "bash") return;
			const { command } = inputOf(event, ctx);
			if (!command) return;
			const admission = await admitBdMutation(event.input, ctx, targetCwd => settingsEnabled("beads", "beads-gate-admission", targetCwd));
			if (admission) return suffix("beads-gate-admission", admission.reason, "retry the command; verification continues and the next attempt waits on the same read");
			return await decide(parse(command), event, ctx, pi, Date.now() + TOOL_CALL_BUDGET_MS);
		} catch (error) {
			return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`, "split the command or run the mutation as a plain single command");
		}
	});
}
