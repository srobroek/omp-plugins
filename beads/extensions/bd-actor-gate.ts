import type {
	ExtensionAPI,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import { tokenize } from "./bd-close-gate.ts";

const VALUE_FLAGS = new Set(["--actor", "--db", "-C", "--directory", "--dolt-auto-commit"]);

/** Literal simple commands only; this is not a shell interpreter. */
export function commandSegments(command: string): string[][] {
	const segments: string[][] = [];
	let segment: string[] = [];
	for (const token of tokenize(command)) {
		if ([";", "&", "|", "(", ")", "\n"].includes(token)) {
			if (segment.length) segments.push(segment);
			segment = [];
		} else segment.push(token);
	}
	if (segment.length) segments.push(segment);
	return segments;
}

export interface BdInvocation {
	verb: string;
	args: string[];
	/** `NAME=value` assignments prefixed to this very `bd` word. */
	prefix: string[];
	/** The `BEADS_ACTOR` value an earlier `export` in the same command line set, if any. */
	exported?: string;
}

/**
 * Every `bd` invocation in the command line, with the environment it runs under.
 *
 * `export BEADS_ACTOR=x && bd close y` is one shell line and two segments; the
 * export is what `bd` inherits, so it counts. A bare `BEADS_ACTOR=x; bd close y`
 * does not: without `export` the variable never reaches the child process.
 */
export function bdInvocations(command: string): BdInvocation[] {
	const out: BdInvocation[] = [];
	let exported: string | undefined;
	for (const tokens of commandSegments(command)) {
		if (tokens[0] === "export") {
			const assignment = tokens.findLast(token => token.startsWith("BEADS_ACTOR="));
			if (assignment !== undefined) exported = assignment.slice("BEADS_ACTOR=".length);
			continue;
		}
		let i = 0;
		while (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "")) i++;
		if (tokens[i] !== "bd") continue;
		const prefix = tokens.slice(0, i);
		i++;
		while (tokens[i]?.startsWith("-")) {
			const flag = tokens[i++]!;
			if (VALUE_FLAGS.has(flag)) i++;
		}
		if (tokens[i]) out.push({ verb: tokens[i]!.toLowerCase(), args: tokens.slice(i + 1), prefix, exported });
	}
	return out;
}

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


export function actorPresent(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const invocations = bdInvocations(command);
	const first = invocations[0];
	const prefixed = first?.prefix.findLast(token => token.startsWith("BEADS_ACTOR="));
	const v =
		prefixed !== undefined ? prefixed.slice("BEADS_ACTOR=".length) : (first?.exported ?? env.BEADS_ACTOR);
	return typeof v === "string" && v.trim().length > 0 && !/[$`]/.test(v);
}

/**
 * First literal `bd` invocation, after global flags.
 */
export function firstBdVerb(command: string): string | null {
	return bdInvocations(command)[0]?.verb ?? null;
}

export function isMutatingBdCommand(command: string): boolean {
	return bdInvocations(command).some(({ verb, args }) =>
		verb === "ready" ? args.includes("--claim") :
		verb === "comments" ? args[0] === "add" : Object.hasOwn(MUTATING_VERBS, verb));
}

/** `bd update <id> --claim` or `bd claim <id>`. */
export function isClaimCommand(command: string): boolean {
	return bdInvocations(command).some(({ verb, args }) =>
		verb === "claim" || ((verb === "update" || verb === "ready") && args.includes("--claim")));
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
	let advisory = false;
	for (const invocation of bdInvocations(command)) {
		const { verb, args, prefix, exported } = invocation;
		const claim = verb === "claim" || ((verb === "update" || verb === "ready") && args.includes("--claim"));
		const mutates = claim || (verb === "comments" ? args[0] === "add" : Object.hasOwn(MUTATING_VERBS, verb));
		if (!mutates) continue;
		const assignment = prefix.findLast(token => token.startsWith("BEADS_ACTOR="));
		const actor =
			assignment !== undefined ? assignment.slice("BEADS_ACTOR=".length) : (exported ?? env.BEADS_ACTOR);
		if (actor?.trim() && !/[$`]/.test(actor)) continue;
		if (claim) return { kind: "block", reason: CLAIM_REASON };
		advisory = true;
	}
	return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" };
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
			// The bash tool's own `env` argument reaches the child like an export does.
			const toolEnv = (event.input as { env?: Record<string, string> }).env;
			const decision = decideActorGate(command, toolEnv ? { ...process.env, ...toolEnv } : process.env);
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
