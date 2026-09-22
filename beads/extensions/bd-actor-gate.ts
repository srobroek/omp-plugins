import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolResultEvent,
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

/**
 * Global flags of `bd` itself that consume the next word, read from `bd --help`
 * on 1.3.0. A missing entry is not cosmetic: the parser would take the flag's
 * VALUE for the verb, so `bd --database x close y` would look like verb `x`.
 */
const VALUE_FLAGS = new Set([
	"--actor",
	"--database",
	"--db",
	"-C",
	"--directory",
	"--dolt-auto-commit",
	"--mem-profile",
]);

/**
 * Launchers that run the real command after their own arguments, so `bd` behind one
 * is still `bd` at command position. This serves actor attribution; the write lock
 * deliberately models no wrappers at all and refuses anything but a direct call.
 */
const TRANSPARENT_WRAPPERS: Record<string, true> = { command: true, env: true, sudo: true };

const WRAPPER_VALUE_FLAGS: Record<string, true> = {
	"-C": true,
	"--chdir": true,
	"--chroot": true,
	"--command-timeout": true,
	"-g": true,
	"--group": true,
	"-h": true,
	"--host": true,
	"-p": true,
	"--prompt": true,
	"-R": true,
	"-T": true,
	"-u": true,
	"--unset": true,
	"--user": true,
};

/** Literal simple commands only; this is not a shell interpreter. */
export function commandSegments(command: string): string[][] {
	const segments: string[][] = [];
	let segment: string[] = [];
	for (const token of tokenize(command)) {
		if ([";", "&", "|", "(", ")", "$(", "\n"].includes(token)) {
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
	/** Global flags and their values, sitting between the `bd` word and the verb. */
	globals: string[];
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
		const prefix: string[] = [];
		while (true) {
			while (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "")) {
				prefix.push(tokens[i] as string);
				i++;
			}
			const wrapper = (tokens[i] ?? "").split("/").pop() ?? "";
			if (TRANSPARENT_WRAPPERS[wrapper] !== true) break;
			i++;
			if (wrapper === "command") continue;
			while (tokens[i]?.startsWith("-")) {
				const flag = tokens[i] as string;
				i++;
				if (WRAPPER_VALUE_FLAGS[flag] === true) i++;
			}
		}
		// Match by basename: `/usr/local/bin/bd close x` and `bd close x` are one
		// command, and treating the path form as something else splits every
		// classification this parser feeds.
		const word = tokens[i];
		if (word === undefined || (word.split("/").pop() ?? word) !== "bd") continue;
		i++;
		const scanned = scanGlobals(tokens, i);
		const verb = tokens[scanned.next];
		if (verb !== undefined) {
			out.push({ verb: verb.toLowerCase(), args: tokens.slice(scanned.next + 1), globals: scanned.globals, prefix, exported: { ...exported } });
		}
	}
	return out;
}

/**
 * The global flags between `bd` and its verb, and where the verb starts.
 *
 * `--flag=value` is one word and consumes nothing after it. Reading it as a bare
 * flag would take the NEXT word for the value and leave the verb one place off,
 * which is how `--directory=/path` came to resolve the wrong store.
 */
function scanGlobals(tokens: string[], from: number): { globals: string[]; next: number } {
	const globals: string[] = [];
	let i = from;
	while (true) {
		const flag = tokens[i];
		if (flag === undefined || !flag.startsWith("-")) break;
		globals.push(flag);
		i++;
		if (flag.includes("=")) continue;
		if (!VALUE_FLAGS.has(flag)) continue;
		const value = tokens[i];
		if (value !== undefined) globals.push(value);
		i++;
	}
	return { globals, next: i };
}

/** The value a global flag carries, in either the `--flag value` or `--flag=value` spelling. */
export function globalValue(globals: string[], names: string[]): string | undefined {
	for (const [index, token] of globals.entries()) {
		for (const name of names) {
			if (token === name) return globals[index + 1];
			if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
		}
	}
	return undefined;
}

/**
 * Whether a boolean flag is switched ON, in any spelling the CLI accepts.
 *
 * `--flag` and `--flag=true` are on; `--flag=false` is OFF and treating it as
 * present inverted the meaning of `--readonly=false` and `--help=false`. A value
 * bd itself would reject counts as off, because such a command fails and writes
 * nothing.
 */
export function flagEnabled(tokens: string[], names: string[]): boolean {
	for (const token of tokens) {
		for (const name of names) {
			if (token === name) return true;
			if (token.startsWith(`${name}=`)) return TRUTHY[token.slice(name.length + 1)] === true;
			// `bd orphans -fj` is `-f -j`, so a fused run of short booleans has to be
			// read letter by letter; matching the whole token missed `-f` entirely.
			if (name.length === 2 && name.startsWith("-") && /^-[A-Za-z]{2,}$/.test(token) && token.includes(name.slice(1))) {
				return true;
			}
		}
	}
	return false;
}

/** The values Go's flag parsing reads as true. */
const TRUTHY: Record<string, true> = { "": true, "1": true, t: true, T: true, TRUE: true, true: true, True: true };

/** Hunt trigger verbs for `bd_mutate_actor_claim`. */
export const MUTATING_VERBS: Record<string, true> = {
	assign: true,
	batch: true,
	claim: true,
	close: true,
	done: true,
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
	new: true,
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
	undefer: true,
	update: true,
};

const GROUP_WRITES: Record<string, Record<string, true>> = {
	audit: { label: true, record: true },
	comments: { add: true },
	dep: { add: true, relate: true, remove: true, unrelate: true },
	epic: { "close-eligible": true },
	gate: { "add-waiter": true, check: true, create: true, resolve: true },
	kv: { append: true, delete: true, rm: true, set: true, update: true },
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

export { commandFromInput as extractCommand } from "./shell-command.ts";

/** The environment a bash tool call supplies to its child process. */
export function environmentForInput(
	input: ToolCallEvent["input"],
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	const supplied = "env" in input ? input.env : undefined;
	if (supplied !== null && typeof supplied === "object") {
		for (const [name, value] of Object.entries(supplied)) {
			if (typeof value === "string") env[name] = value;
		}
	}
	return env;
}

/**
 * The ONE actor this invocation will really write under.
 *
 * Both variables are read, but they are not equals: measured against bd 1.2.2,
 * `BD_ACTOR` beats `BEADS_ACTOR` whenever both resolve, and `BEADS_ACTOR` governs
 * only when `BD_ACTOR` is absent. bd's own `--help` documents the default as
 * `$BEADS_ACTOR`, which is why the order is worth stating here rather than
 * inferring from the name.
 *
 * The practical consequence, and the reason this returns one value instead of a
 * list: this harness sets BOTH variables on every call, so an inline
 * `BEADS_ACTOR=x bd update <id> --claim` is a silent no-op -- the claim lands under
 * the ambient `BD_ACTOR`. Collecting both values reported two actors for one write,
 * and the second had written nothing.
 */
export function invocationActor(invocation: BdInvocation, env: NodeJS.ProcessEnv): string | null {
	const resolve = (variable: ActorVar): string | null => {
		const assignment = invocation.prefix.findLast(token => token.startsWith(`${variable}=`));
		const value = assignment !== undefined
			? assignment.slice(variable.length + 1)
			: (invocation.exported[variable] ?? env[variable]);
		// A value carrying `$` or a backtick is unresolved text, not an identity.
		if (!value?.trim() || /[$`]/.test(value)) return null;
		return value.trim();
	};
	return resolve("BD_ACTOR") ?? resolve("BEADS_ACTOR");
}

/**
 * Every actor a command line writes under: one per mutating invocation, deduped.
 *
 * Still plural, because one command line can carry several invocations under
 * different actors. What it no longer does is report two actors for a single write
 * because two variables were set.
 */
export function actorValues(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const actors = bdInvocations(command)
		.filter(isMutatingInvocation)
		.map(invocation => invocationActor(invocation, env))
		.filter((actor): actor is string => actor !== null);
	return [...new Set(actors)];
}

export function actorPresent(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const first = bdInvocations(command)[0];
	return first !== undefined && invocationActor(first, env) !== null;
}

/**
 * One `bd` invocation read from an argv the plugin itself builds, so an internal
 * spawn is classified by the same rules as a command line an agent typed.
 * `undefined` when the argv carries no verb.
 */
export function invocationFromArgv(args: string[]): BdInvocation | undefined {
	const scanned = scanGlobals(args, 0);
	const verb = args[scanned.next];
	if (verb === undefined) return undefined;
	return { verb: verb.toLowerCase(), args: args.slice(scanned.next + 1), globals: scanned.globals, prefix: [], exported: {} };
}

/** First literal `bd` invocation, after global flags. */
export function firstBdVerb(command: string): string | null {
	return bdInvocations(command)[0]?.verb ?? null;
}

export function isMutatingInvocation({ verb, args }: BdInvocation): boolean {
	if (args.includes("--help") || args.includes("-h")) return false;
	if (verb === "duplicates") return args.includes("--auto-merge") && !args.includes("--dry-run");
	if (MUTATING_VERBS[verb] === true) return true;
	if (verb === "ready") return flagEnabled(args, ["--claim"]);
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
			((verb === "update" || verb === "ready") && flagEnabled(args, ["--claim"])),
	);
}

export type ActorGateDecision =
	| { kind: "allow" }
	| { kind: "block"; reason: string }
	| { kind: "advisory"; text: string };

const CLAIM_REASON =
	"bd claim / `bd update <id> --claim` without BEADS_ACTOR or BD_ACTOR creates undistinguishable dead claims. Set either variable to <harness>/<agent-name>/<session-id> and retry.";

/**
 * Verbs that construct a new issue, and so stamp an `Owner` that cannot be
 * repaired afterwards. `new` is `create`'s own alias (`bd create --help`
 * reports "Aliases: create, new"), and `create-form` is the interactive form
 * over the same path, so all three must refuse rather than warn.
 */
const CREATING_VERBS: Record<string, true> = {
	create: true,
	"create-form": true,
	new: true,
};

const CREATE_REASON =
	"bd create / `bd new` / `bd create-form` without BEADS_ACTOR or BD_ACTOR silently sets Owner to the invoking human's git identity. There is no --owner flag, and --assignee sets a different field, so the mis-attribution is permanent. Set either variable to <harness>/<agent-name>/<session-id> and retry.";

const ADVISORY_TEXT =
	"BEADS_ACTOR and BD_ACTOR are unset on this mutating `bd` command. Subagents must set either variable so writes and claims are attributable. Export one before mutating work.";

import type { ParsedCommand } from "./shell-command.ts";

/** Decide across command-position segments and recursively executable children. */
export function decideActorParsed(parsed: ParsedCommand, env: NodeJS.ProcessEnv = process.env): ActorGateDecision {
	let advisory = false;
	for (const segment of parsed.segments) {
		const decision = decideActorGate(segment.join(" "), env);
		if (decision.kind === "block") return decision;
		if (decision.kind === "advisory") advisory = true;
	}
	for (const child of parsed.nested) {
		const decision = decideActorParsed(child, env);
		if (decision.kind === "block") return decision;
		if (decision.kind === "advisory") advisory = true;
	}
	return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" };
}

export function decideActorGate(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
): ActorGateDecision {
	let advisory = false;
	for (const invocation of bdInvocations(command)) {
		if (!isMutatingInvocation(invocation) || invocationActor(invocation, env) !== null) {
			continue;
		}
		const { verb, args } = invocation;
		const claim =
			verb === "claim" ||
			((verb === "update" || verb === "ready") && flagEnabled(args, ["--claim"]));
		if (claim) return { kind: "block", reason: CLAIM_REASON };
		if (CREATING_VERBS[verb] === true)
			return { kind: "block", reason: CREATE_REASON };
		advisory = true;
	}
	return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" };
}

function prepend(
	event: ToolResultEvent,
	text: string,
): { content: ToolResultEvent["content"] } {
	const prefix = { type: "text" as const, text: `${text}\n\n` };
	const existing = event.content ?? [];
	return { content: [prefix, ...existing] };
}

export default function bdActorGate(pi: ExtensionAPI): void {
	const arbiter = installActorNoticeArbiter();

	pi.on("tool_result", (event: ToolResultEvent) => {
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
