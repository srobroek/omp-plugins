import type {
	ExtensionAPI,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

/** Hunt trigger verbs for `bd_mutate_actor_claim`. */
export const MUTATING_VERBS: Record<string, true> = {
	update: true,
	create: true,
	close: true,
	comment: true,
	comments: true,
	claim: true,
	unclaim: true,
	dep: true,
	label: true,
	remember: true,
	forget: true,
	mol: true,
	audit: true,
	"set-state": true,
};
const pendingAdvisory = new Map<string, string>();

export function extractCommand(input: Record<string, unknown>): string {
	if (typeof input.command === "string") return input.command;
	if (typeof input.cmd === "string") return input.cmd;
	return "";
}

export function commandHasBeadsActor(command: string): boolean {
	return /(?:^|[\s;&|])BEADS_ACTOR=/.test(command);
}

export function actorPresent(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (commandHasBeadsActor(command)) return true;
	const v = env.BEADS_ACTOR;
	return typeof v === "string" && v.trim().length > 0;
}

/**
 * First `bd` invocation in the string. Returns the verb token after `bd`.
 */
export function firstBdVerb(command: string): string | null {
	const m = command.match(/(?:^|[\s;&|(`])bd\s+([a-z][\w-]*)/i);
	return m ? m[1].toLowerCase() : null;
}

export function isMutatingBdCommand(command: string): boolean {
	if (!/\bbd\s+/.test(command)) return false;
	const verb = firstBdVerb(command);
	if (!verb) return false;
	if (!MUTATING_VERBS[verb]) return false;
	if (verb === "comments") {
		return /\bbd\s+comments\s+add\b/i.test(command);
	}
	return true;
}

/** `bd update <id> --claim` or `bd claim <id>`. */
export function isClaimCommand(command: string): boolean {
	if (/\bbd\s+claim\b/i.test(command)) return true;
	return /\bbd\s+update\s+\S+[^\n]*--claim\b/i.test(command);
}

export type ActorGateDecision =
	| { kind: "allow" }
	| { kind: "block"; reason: string }
	| { kind: "advisory"; text: string };

const CLAIM_REASON =
	"bd claim / `bd update <id> --claim` without BEADS_ACTOR creates undistinguishable dead claims. Set BEADS_ACTOR=<harness>/<agent-name>/<session-id> and retry.";

const ADVISORY_TEXT =
	"BEADS_ACTOR is unset on this mutating `bd` command. Subagents must set BEADS_ACTOR so claims are attributable. Export it before mutating work.";

export function decideActorGate(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
): ActorGateDecision {
	if (!isMutatingBdCommand(command)) return { kind: "allow" };
	if (actorPresent(command, env)) return { kind: "allow" };
	if (isClaimCommand(command)) return { kind: "block", reason: CLAIM_REASON };
	return { kind: "advisory", text: ADVISORY_TEXT };
}

function prepend(
	event: ExtensionToolResultEvent,
	text: string,
): { content: ExtensionToolResultEvent["content"] } {
	const prefix = { type: "text" as const, text: `${text}\n\n` };
	const existing = event.content ?? [];
	return { content: [prefix, ...existing] };
}

export default function bdActorGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command || !/\bbd\s+/.test(command)) return;
			const decision = decideActorGate(command);
			if (decision.kind === "block") {
				return { block: true, reason: decision.reason };
			}
			if (decision.kind === "advisory") {
				pendingAdvisory.set(event.toolCallId, decision.text);
			}
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event: ExtensionToolResultEvent) => {
		try {
			const text = pendingAdvisory.get(event.toolCallId);
			pendingAdvisory.delete(event.toolCallId);
			if (!text) return;
			return prepend(event, text);
		} catch {
			return;
		}
	});
}
