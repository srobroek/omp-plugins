import type {
	ExtensionAPI,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { tokenize } from "./bd-close-gate.ts";

/**
 * Process-wide seam shared with omp-orchestrate. Orchestrate records tool calls whose
 * richer run-scoped actor notice it delivered; this adapter drains the id at tool_result
 * and suppresses only its generic duplicate. The versioned symbol is the whole cross-plugin
 * interface, so the packages remain independently loadable.
 */
export const ACTOR_NOTICE_ARBITER = Symbol.for(
	"com.srobroek.beads.actor-notice-arbiter.v1",
);

interface ActorNoticeArbiter {
	handledToolCalls: Set<string>;
}

/** Install the arbiter during extension load, before either plugin can receive a tool call. */
function installActorNoticeArbiter(): ActorNoticeArbiter {
	const existing: unknown = Reflect.get(globalThis, ACTOR_NOTICE_ARBITER);
	if (
		existing !== null &&
		typeof existing === "object" &&
		"handledToolCalls" in existing
	) {
		const handledToolCalls = existing.handledToolCalls;
		if (handledToolCalls instanceof Set) return { handledToolCalls };
	}
	const created: ActorNoticeArbiter = { handledToolCalls: new Set<string>() };
	Reflect.set(globalThis, ACTOR_NOTICE_ARBITER, created);
	return created;
}

const ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"] as const;
type ActorVar = (typeof ACTOR_VARS)[number];

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
	/** Actor values an earlier `export` in the same command line set. */
	exported: Partial<Record<ActorVar, string>>;
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
	let exported: Partial<Record<ActorVar, string>> = {};
	for (const tokens of commandSegments(command)) {
		if (tokens[0] === "export") {
			for (const variable of ACTOR_VARS) {
				const assignment = tokens.findLast(token => token.startsWith(`${variable}=`));
				if (assignment !== undefined) {
					exported = { ...exported, [variable]: assignment.slice(variable.length + 1) };
				}
			}
			continue;
		}
		let i = 0;
		while (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "")) i++;
		if (tokens[i] !== "bd") continue;
		const prefix = tokens.slice(0, i);
		i++;
		while (tokens[i]?.startsWith("-")) {
			const flag = tokens[i];
			if (flag === undefined) break;
			i++;
			if (VALUE_FLAGS.has(flag)) i++;
		}
		const verb = tokens[i];
		if (verb !== undefined) {
			out.push({ verb: verb.toLowerCase(), args: tokens.slice(i + 1), prefix, exported: { ...exported } });
		}
	}
	return out;
}

/** Hunt trigger verbs for `bd_mutate_actor_claim`. */
export const MUTATING_VERBS: Record<string, true> = {
	assign: true,
	batch: true,
	claim: true,
	close: true,
	comment: true,
	cook: true,
	create: true,
	"create-form": true,
	defer: true,
	delete: true,
	duplicate: true,
	edit: true,
	forget: true,
	import: true,
	link: true,
	note: true,
	priority: true,
	promote: true,
	q: true,
	remember: true,
	rename: true,
	reopen: true,
	"set-state": true,
	ship: true,
	supersede: true,
	tag: true,
	unclaim: true,
	undefer: true,
	update: true,
};

const GROUP_WRITES: Record<string, Record<string, true>> = {
	audit: { label: true, record: true },
	comments: { add: true },
	dep: { add: true, relate: true, remove: true, unrelate: true },
	epic: { "close-eligible": true },
	gate: { "add-waiter": true, check: true, create: true, resolve: true },
	label: { add: true, propagate: true, remove: true },
	"merge-slot": { acquire: true, create: true, release: true },
	swarm: { create: true },
	todo: { add: true, done: true },
};

const MOL_WRITES: Record<string, true> = {
	bond: true,
	burn: true,
	distill: true,
	pour: true,
	squash: true,
};
const pendingAdvisory = new Map<string, string>();

export function extractCommand(input: Record<string, unknown>): string {
	if (typeof input.command === "string") return input.command;
	if (typeof input.cmd === "string") return input.cmd;
	return "";
}

/** The environment a bash tool call supplies to its child process. */
export function environmentForInput(
	input: Record<string, unknown>,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	const supplied = input.env;
	if (supplied !== null && typeof supplied === "object") {
		for (const [name, value] of Object.entries(supplied)) {
			if (typeof value === "string") env[name] = value;
		}
	}
	return env;
}

function invocationActors(invocation: BdInvocation, env: NodeJS.ProcessEnv): string[] {
	const actors: string[] = [];
	for (const variable of ACTOR_VARS) {
		const assignment = invocation.prefix.findLast(token => token.startsWith(`${variable}=`));
		const value = assignment !== undefined
			? assignment.slice(variable.length + 1)
			: (invocation.exported[variable] ?? env[variable]);
		if (value?.trim() && !/[$`]/.test(value)) actors.push(value.trim());
	}
	return actors;
}

export function actorValues(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const actors = bdInvocations(command)
		.filter(isMutatingInvocation)
		.flatMap(invocation => invocationActors(invocation, env));
	return [...new Set(actors)];
}

export function actorPresent(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const first = bdInvocations(command)[0];
	return first !== undefined && invocationActors(first, env).length > 0;
}

/** First literal `bd` invocation, after global flags. */
export function firstBdVerb(command: string): string | null {
	return bdInvocations(command)[0]?.verb ?? null;
}

function isMutatingInvocation({ verb, args }: BdInvocation): boolean {
	if (args.includes("--help") || args.includes("-h")) return false;
	if (verb === "duplicates") return args.includes("--auto-merge") && !args.includes("--dry-run");
	if (MUTATING_VERBS[verb] === true) return true;
	if (verb === "ready") return args.includes("--claim");
	if (verb === "dep" && args.includes("--blocks")) return true;
	if (verb === "mol") {
		if (args.includes("--dry-run")) return false;
		const action = args[0] ?? "";
		if (MOL_WRITES[action] === true) return true;
		if (action !== "wisp") return false;
		const wispAction = args[1];
		return (
			wispAction === "create" ||
			wispAction === "gc" ||
			(wispAction !== undefined && wispAction !== "list")
		);
	}
	const action = args[0] ?? "";
	return GROUP_WRITES[verb]?.[action] === true;
}

export function isMutatingBdCommand(command: string): boolean {
	return bdInvocations(command).some(isMutatingInvocation);
}

/** `bd update <id> --claim` or `bd claim <id>`, at shell command position. */
export function isClaimCommand(command: string): boolean {
	return bdInvocations(command).some(
		({ verb, args }) =>
			verb === "claim" ||
			((verb === "update" || verb === "ready") && args.includes("--claim")),
	);
}

export type ActorGateDecision =
	| { kind: "allow" }
	| { kind: "block"; reason: string }
	| { kind: "advisory"; text: string };

const CLAIM_REASON =
	"bd claim / `bd update <id> --claim` without BEADS_ACTOR or BD_ACTOR creates undistinguishable dead claims. Set either variable to <harness>/<agent-name>/<session-id> and retry.";

const ADVISORY_TEXT =
	"BEADS_ACTOR and BD_ACTOR are unset on this mutating `bd` command. Subagents must set either variable so writes and claims are attributable. Export one before mutating work.";

export function decideActorGate(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
): ActorGateDecision {
	let advisory = false;
	for (const invocation of bdInvocations(command)) {
		if (
			!isMutatingInvocation(invocation) ||
			invocationActors(invocation, env).length > 0
		) {
			continue;
		}
		const { verb, args } = invocation;
		const claim =
			verb === "claim" ||
			((verb === "update" || verb === "ready") && args.includes("--claim"));
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
	const arbiter = installActorNoticeArbiter();
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command || !/\bbd\s+/.test(command)) return;
			// The bash tool's own `env` argument reaches the child like an export does.
			const env = environmentForInput(event.input);
			const decision = decideActorGate(command, env);
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
			const claimedByOrchestrate = arbiter.handledToolCalls.delete(event.toolCallId);
			const text = pendingAdvisory.get(event.toolCallId);
			pendingAdvisory.delete(event.toolCallId);
			if (claimedByOrchestrate || !text) return;
			return prepend(event, text);
		} catch {
			return;
		}
	});
}
