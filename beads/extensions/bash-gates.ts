import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { decideActorParsed, environmentForInput } from "./bd-actor-gate.ts";
import { decideEmbeddedWrite } from "./bd-embedded-write-lock.ts";
import { rewriteBashInput } from "./session-beads-lifecycle.ts";
import { blockReason, commandFromInput, type ParsedCommand, parse, settingsEnabled } from "./shell-command.ts";

type BashInput = { command?: unknown; cmd?: unknown; cwd?: unknown };
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
 * The write-lock wrapper and the session's `BEADS_DIR` pin compose into one revised input,
 * so the later rewrite never drops the earlier one.
 */
async function decide(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext, pi: ExtensionAPI, deadline: number): Promise<GateDecision | { input: Record<string, unknown> } | undefined> {
	let input = event.input as Record<string, unknown>;
	const { cwd } = inputOf(event, ctx);
	if (parsed.unknown) return suffix("bash-gates", "command could not be parsed", "split the command or run the mutation as a plain single command");
	const env = environmentForInput(event.input);
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
	const rewritten = rewriteBashInput(input, ctx) ?? input;
	if (JSON.stringify(rewritten) !== JSON.stringify(event.input)) return { input: rewritten };
	return undefined;
}

/** The beads plugin's sole Bash tool-call registration. Parsing happens exactly once. */
export default function bashGates(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const { command } = inputOf(event, ctx);
			if (!command) return;
			return await decide(parse(command), event, ctx, pi, Date.now() + TOOL_CALL_BUDGET_MS);
		} catch (error) {
			return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`, "split the command or run the mutation as a plain single command");
		}
	});
}
