import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { decideActorParsed, environmentForInput } from "./bd-actor-gate.ts";
import { decideBdCloseParsed } from "./bd-close-gate.ts";
import { beginEmbeddedWrite, decideEmbeddedWrite } from "./bd-embedded-write-lock.ts";
import { decideBdInitParsed } from "./bd-init-advisory.ts";
import { decideLeaseClaim } from "./bd-lease-gate.ts";
import { beadsActive, decideCommandParsed, repositoryControlled, repositoryFromCurrentCheckout, repositoryFromGhCreate } from "./pr-bead-link-gate.ts";
import { rewriteBashInput } from "./session-beads-lifecycle.ts";
import { blockReason, commandFromInput, type ParsedCommand, parse, settingsEnabled } from "./shell-command.ts";

type BashInput = { command?: unknown; cmd?: unknown; cwd?: unknown };
type GateDecision = { block: true; reason: string } | undefined;

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

/** Every beads gate sees the same validated parse; rewrites happen only after all decisions allow. */
async function decide(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext, pi: ExtensionAPI): Promise<GateDecision | { input: Record<string, unknown> } | undefined> {
	const { cwd } = inputOf(event, ctx);
	if (parsed.unknown) return suffix("bash-gates", "command could not be parsed", "split the command or run the mutation as a plain single command");
	const env = environmentForInput(event.input);
	if (settingsEnabled("beads", "bd-actor-gate", cwd)) {
		const actor = decideActorParsed(parsed, env);
		if (actor.kind === "block") return suffix("bd-actor-gate", actor.reason);
        if (actor.kind === "advisory" && typeof pi.sendMessage === "function") pi.sendMessage({ customType: "beads-bd-actor-advisory", content: actor.text, display: true, attribution: "user" }, { triggerTurn: false });
	}
	if (settingsEnabled("beads", "bd-close-gate", cwd)) {
		const close = await decideBdCloseParsed(parsed, cwd);
		if (close) return suffix("bd-close-gate", close.reason);
	}
    if (settingsEnabled("beads", "bd-init-advisory", cwd)) {
        const advisory = decideBdInitParsed(parsed);
        if (advisory && typeof pi.sendMessage === "function") pi.sendMessage({ customType: "beads-bd-init-advisory", content: advisory, display: true, attribution: "user" }, { triggerTurn: false });
    }
	if (settingsEnabled("beads", "bd-lease-gate", cwd)) await decideLeaseClaim(parsed, event, ctx);
	if (settingsEnabled("beads", "bd-embedded-write-lock", cwd)) {
		const embedded = await decideEmbeddedWrite(parsed, event, ctx);
		if (embedded) return suffix("bd-embedded-write-lock", embedded.reason);
	}
	if (settingsEnabled("beads", "pr-bead-link-gate", cwd)) {
		const pr = decideCommandParsed(parsed, segment => beadsActive(cwd) && repositoryControlled(repositoryFromGhCreate(segment) ?? repositoryFromCurrentCheckout(cwd)));
		if (pr) return suffix("pr-bead-link-gate", pr.reason);
	}
	const rewritten = rewriteBashInput(event.input, ctx);
	if (rewritten && JSON.stringify(rewritten) !== JSON.stringify(event.input)) return { input: rewritten };
	return undefined;
}

/** The beads plugin's sole Bash tool-call registration. Parsing happens exactly once. */
export default function bashGates(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const { command } = inputOf(event, ctx);
			if (!command) return;
			beginEmbeddedWrite(event.toolCallId);
			return await decide(parse(command), event, ctx, pi);
		} catch (error) {
			return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`, "split the command or run the mutation as a plain single command");
		}
	});
}
