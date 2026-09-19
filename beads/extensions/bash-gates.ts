import type { ExtensionAPI, ToolCallEvent, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parse, blockReason, settingsEnabled, type ParsedCommand } from "./shell-command.ts";
import { decideActorGate, environmentForInput } from "./bd-actor-gate.ts";
import { decideBdClose } from "./bd-close-gate.ts";
import { decideBdInit } from "./bd-init-advisory.ts";
import { decideCommand, beadsActive, repositoryControlled, repositoryFromGhCreate, repositoryFromCurrentCheckout } from "./pr-bead-link-gate.ts";

type BashInput = { command?: unknown; cwd?: unknown };
type GateDecision = { block: true; reason: string } | undefined;

function inputOf(event: ToolCallEvent, ctx: ExtensionContext): { command: string; cwd: string } {
	const input = event.input as BashInput;
	return {
		command: typeof input.command === "string" ? input.command : "",
		cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd()),
	};
}

function suffix(gate: string, reason: string): GateDecision {
	return { block: true, reason: blockReason({ gate, cause: reason, resolution: "inspect the command and retry" }) };
}

function decide(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext): GateDecision {
	const { command, cwd } = inputOf(event, ctx);
	if (parsed.unknown) return suffix("bash-gates", "command could not be parsed");
	const env = environmentForInput(event.input);
	if (settingsEnabled("beads", "bd-actor-gate", cwd)) {
		const actor = decideActorGate(command, env);
		if (actor.kind === "block") return suffix("bd-actor-gate", actor.reason);
	}
	if (settingsEnabled("beads", "bd-close-gate", cwd)) {
		const close = decideBdClose(command, cwd);
		if (close) return suffix("bd-close-gate", close.reason);
	}
	if (settingsEnabled("beads", "bd-init-advisory", cwd)) {
		const advisory = decideBdInit(command);
		if (advisory) {
			// Advisories remain non-blocking; the legacy extension owns delivery.
		}
	}
	if (settingsEnabled("beads", "pr-bead-link-gate", cwd) && /\bgh\b/.test(command)) {
		const pr = decideCommand(command, segment => beadsActive(cwd) && repositoryControlled(repositoryFromGhCreate(segment) ?? repositoryFromCurrentCheckout(cwd)));
		if (pr) return suffix("pr-bead-link-gate", pr.reason);
	}
	return undefined;
}

/** The beads plugin's sole Bash tool-call registration. Parsing happens exactly once. */
export default function bashGates(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const { command } = inputOf(event, ctx);
			if (!command) return;
			return decide(parse(command), event, ctx);
		} catch (error) {
			return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`);
		}
	});
}
