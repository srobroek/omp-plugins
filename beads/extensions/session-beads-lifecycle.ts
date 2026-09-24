/**
 * Beads advisories at the session boundaries.
 *
 * Four prose obligations that only bite at a boundary, where nothing in the
 * conversation reminds the agent of them:
 *
 * - `bd gate check` at a dispatch/recovery boundary, so automatic gates resolve
 *   before work is picked (beads-lifecycle).
 * - the verdict a detached Dolt push left in `.beads/last-push.log`. A detached
 *   process cannot report to the session that spawned it, so an unreported
 *   failure looks published while sitting on one machine (beads-core).
 * - the stale-skip warning from `bd import`: the committed export is behind this
 *   database, so the next export would overwrite a peer's rows (beads-core).
 * - claims still held at session close (beads-core SESSION CLOSE).
 *
 * Gate verification is the only database read initiated at a boundary. It starts
 * asynchronously and the first dispatch or mutation waits for its verdict; session close
 * derives held claims from successful command results without another ledger read.
 */

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import {
	actorValues,
	agentActor,
	type BdInvocation,
	bdInvocations,
	environmentForInput,
	extractCommand,
	flagEnabled,
	globalValue,
	invocationActor,
	isMutatingBdCommand,
	invocationFromArgv,
} from "./bd-actor-gate.ts";
import { embeddedWriteTargets, withEmbeddedWriteLock, writesStore } from "./bd-embedded-write-lock.ts";
import { claimedIds, claimedTextIds, claimResultOutput } from "./bd-lease-gate.ts";
import { repoIdentity, sessionPinFor } from "./beads-store.ts";
import { closeInvocations } from "./shell-command.ts";
import { tokenizeShell } from "./shell-tokenizer.ts";

/**
 * Variables the plugin wins on, in every environment it shapes for bd.
 *
 * `BEADS_DOLT_SHARED_SERVER` overrides the committed `dolt_mode` pin in
 * `.beads/metadata.json` -- bd says so itself, and then fails against a server
 * this repository never provisioned -- so an inherited value is cleared rather
 * than obeyed. Shared-server mode contradicts a committed pin and cannot be a
 * per-call opt-in, which is why this differs from `BEADS_DIR`: that one selects
 * which store to use, so a caller's value is honoured.
 *
 * Cleared to the empty string, not deleted: `pinBashInput` writes an overlay
 * onto a bash call, where a deleted key still inherits the shell's value. bd
 * reads the empty string as unset.
 */
const EMBEDDED_PIN_ENV: Readonly<Record<string, string>> = { BEADS_DOLT_SHARED_SERVER: "" };

function boundedBdEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...base,
		...EMBEDDED_PIN_ENV,
		BD_NO_PAGER: "1",
		BD_NON_INTERACTIVE: "1",
		BD_DOLT_AUTO_START: "false",
		NO_COLOR: "1",
	};
}
export function lifecycleBdEnvironment(cwd: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	delete env.BEADS_DIR;
	const resolved = sessionPinFor(cwd);
	if (resolved !== undefined) env.BEADS_DIR = resolved;
	return boundedBdEnvironment(env);
}


function bdStoreDir(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	const selected = env.BEADS_DIR;
	const dir = selected ? (isAbsolute(selected) ? selected : resolve(cwd, selected)) : join(cwd, ".beads");
	try {
		return statSync(dir).isDirectory() ? resolve(dir) : undefined;
	} catch {
		return undefined;
	}
}


function bdReadFailure(scope: "start" | "close", reason: string): string {
	const bounded = boundedFailure(reason);
	return scope === "start"
		? `Beads gates could not be verified at session start: ${bounded}.`
		: `Beads claims could not be read at session close: ${bounded}. A mutating command was attempted; inspect assigned and touched work before stopping.`;
}

/** Default deadline for an ordinary `bd` read. Boundary hooks start reads detached, so a cold embedded store may use the full two-minute ceiling. */
const TIMEOUT_MS = 120_000;



/**
 * The fixed ceiling on one `bd` command, and the only bound that outlives an event.
 *
 * Every call site gets a fixed ceiling. Gate verification deliberately runs off the
 * session-start boundary with this wider deadline: an event budget cannot distinguish a
 * slow store from a hung one, and measured cold embedded-store reads run 30-50 seconds.
 */
const BD_COMMAND_CEILING_MS = 120_000;

/**
 * How long a mutating bd command waits for this session's gate verification.
 *
 * A `tool_call` has a 30,000 ms budget and the other beads gates plus dispatch need the
 * rest of it. A command that outlasts this is refused rather than admitted unverified,
 * and the refusal says the verification is still running, because it is: the next
 * attempt waits on the same read and converges.
 */
const GATE_ADMISSION_MS = 20_000;

/** Longest advisory list before it stops being read. */
const MAX_LISTED = 8;

/**
 * Gate types bd resolves on its own. A human gate never resolves from a check,
 * so its presence alone is not a reason to spend a `bd gate check`.
 */
export const AUTO_GATE_TYPES: Record<string, true> = {
	timer: true,
	"gh:run": true,
	"gh:pr": true,
	bead: true,
};


interface SessionState {
	actors: Set<string>;
	bdWrote: boolean;
	/** Claims made successfully by this session, keyed by resolved store and bead id. */
	claims: Map<string, TrackedClaim>;
	/** The database this session's bash calls are pinned to, when its checkout has one. */
	pin?: string;
	/** Git common-dir identity for the checkout that started this session. */
	repo?: string;
	/** Repository identity by resolved Bash cwd; avoids a Git subprocess on repeat calls. */
	repos: Map<string, string>;
	staleAdvised: boolean;
	stopFired: boolean;
	touched: Set<string>;
	/** Gate verification by resolved target store; foreign workspaces cannot borrow the session checkout's verdict. */
	gates: Map<string, GateVerification>;
}

export { repoIdentity, sessionPinFor };

/**
 * The value Bash calls in this session's repository family receive, decided once at session start.
 *
 * - a process pin someone else set (a human export, or an earlier session of the same
 *   repository) is mirrored as-is: the shell may predate it, and a human pin is never
 *   replaced by the checkout's own database;
 * - a conflict (the process pin belongs to an unrelated repository) gives this session
 *   its own checkout database per call, which is exactly what the notice asks for;
 * - otherwise the checkout's `.beads`, when it exists.
 */
export function sessionPinAfter(result: AutoPinResult, cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (result.conflict !== undefined) return sessionPinFor(cwd);
	const current = env.BEADS_DIR;
	if (current !== undefined && current !== "") return current;
	return sessionPinFor(cwd);
}

/**
 * Add the session pin to a bash call that carries no `BEADS_DIR` of its own.
 *
 * The persistent shell of an interactive session is spawned before `session_start`
 * runs, so a value placed on `process.env` never reaches it; the call's own `env`
 * does. A caller-supplied `BEADS_DIR` is left alone. The same call carries
 * `EMBEDDED_PIN_ENV`, so a shell that exported shared-server mode still reaches
 * the pinned embedded store; a call that pins its own `BEADS_DIR` shapes its own
 * environment and is left untouched, escape included.
 */
export function pinBashInput(input: unknown, pin: string | undefined): Record<string, unknown> | undefined {
	if (pin === undefined || input === null || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const env = record.env;
	if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) return undefined;
	const current = (env as Record<string, unknown> | undefined)?.BEADS_DIR;
	if (typeof current === "string" && current !== "") return undefined;
	return { ...record, env: { ...((env as Record<string, unknown> | undefined) ?? {}), ...EMBEDDED_PIN_ENV, BEADS_DIR: pin } };
}

function bashCallCwd(input: unknown, fallback: string): string {
	if (input === null || typeof input !== "object") return fallback;
	const cwd = (input as Record<string, unknown>).cwd;
	return typeof cwd === "string" && cwd !== "" ? resolve(fallback, cwd) : fallback;
}

function sessionKey(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): string {
	return ctx?.sessionManager?.getSessionId?.() ?? "default";
}

/**
 * Pin the process to the first session's checkout database when nothing pinned it.
 *
 * `BEADS_DIR` is inherited by every child the process spawns, so setting it once is
 * the same pin a human exports before starting omp. Rules, in order:
 *
 * - a pin this extension did not set is never touched;
 * - the pin belongs to the session that earned it and holds while that session is
 *   live. A concurrent session in another checkout of the SAME repository (an
 *   Worktrunk-linked checkout is the common case) inherits it, which is what the
 *   embedded-store ownership guidance asks for. A concurrent session in an UNRELATED repository
 *   gets a `conflict` back: the process pin cannot serve two databases, and the
 *   caller warns that session to pass its own `BEADS_DIR` per `bd` call;
 * - when the owning session ends, the pin is withdrawn and the next session start
 *   earns its own.
 */
export type AutoPinState = { pinned?: string; owner?: string; ownerRepo?: string; dependents?: Set<string> };
export type AutoPinResult = { pinned?: string; conflict?: string };

export function autoPinBeadsDir(
	cwd: string,
	sessionId: string,
	liveSessions: (id: string) => boolean,
	env: NodeJS.ProcessEnv = process.env,
	state: AutoPinState = autoPinState,
	identity: (cwd: string) => string = repoIdentity,
): AutoPinResult {
	const current = env.BEADS_DIR;
	const ours = current !== undefined && current === state.pinned;
	if (current !== undefined && current !== "" && !ours) return {};
	if (ours && state.owner !== undefined && state.owner !== sessionId && liveSessions(state.owner)) {
		if (state.ownerRepo !== identity(cwd)) return { conflict: current };
		// Same repository: shares the pin and keeps it alive.
		const dependents = state.dependents ?? new Set<string>();
		dependents.add(sessionId);
		state.dependents = dependents;
		return {};
	}
	const dir = sessionPinFor(cwd);
	if (dir === undefined) {
		if (ours) releaseAutoPin(env, state);
		return {};
	}
	if (state.owner !== sessionId || state.pinned !== dir) state.dependents = new Set(); // a restarted owner keeps its dependents
	env.BEADS_DIR = dir;
	state.pinned = dir;
	state.owner = sessionId;
	state.ownerRepo = identity(cwd);
	return { pinned: dir };
}

/**
 * A session ended. The pin outlives its owner while a same-repository dependent is
 * live: ownership passes to that dependent. Otherwise the pin is withdrawn.
 */
export function endAutoPinSession(sessionId: string, liveSessions: (id: string) => boolean, env: NodeJS.ProcessEnv = process.env, state: AutoPinState = autoPinState): void {
	state.dependents?.delete(sessionId);
	if (state.owner !== sessionId) return;
	const heir = [...(state.dependents ?? [])].find((id) => liveSessions(id));
	if (heir !== undefined) {
		state.owner = heir;
		state.dependents?.delete(heir);
		return;
	}
	releaseAutoPin(env, state);
}

/** Withdraw the pin this extension set; a human pin is left alone. */
export function releaseAutoPin(env: NodeJS.ProcessEnv = process.env, state: AutoPinState = autoPinState): void {
	if (state.pinned !== undefined && env.BEADS_DIR === state.pinned) delete env.BEADS_DIR;
	state.pinned = undefined;
	state.owner = undefined;
	state.ownerRepo = undefined;
	state.dependents = undefined;
}

const autoPinState: AutoPinState = {};

/** The repository's `.beads` directory, or nothing when this is not a beads repo. */
export function beadsDir(cwd: string): string | undefined {
	const pin = process.env.BEADS_DIR;
	const dir = pin ? (isAbsolute(pin) ? pin : resolve(cwd, pin)) : join(cwd, ".beads");
	try {
		return statSync(dir).isDirectory() ? dir : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The JSON bd printed, ignoring the human summary it prints first.
 *
 * `bd gate check --json` writes its progress lines and then the envelope, so the
 * payload is the last block that parses to the end of the output.
 */
export function parseTrailingJson(stdout: string): unknown {
	const text = stdout.trim();
	if (!text) return undefined;
	if (text === "null") return null;
	const starts: number[] = [];
	if (text[0] === "{" || text[0] === "[") starts.push(0);
	for (let i = 0; i < text.length - 1; i++) {
		if (text[i] === "\n" && (text[i + 1] === "{" || text[i + 1] === "[")) starts.push(i + 1);
	}
	for (let i = starts.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(text.slice(starts[i]!));
		} catch {
			// An earlier candidate may still parse: bd's own summary can contain braces.
		}
	}
	return undefined;
}

/** Unwrap `BD_JSON_ENVELOPE=1` output; bare `--json` passes through. */
export function envelopeData(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const record = value as Record<string, unknown>;
	if ("schema_version" in record && "data" in record) return record.data;
	return value;
}

export interface Gate {
	id: string;
	awaitType: string;
	blocks?: string;
	reason?: string;
}

export function readGates(stdout: string): Gate[] {
	const data = envelopeData(parseTrailingJson(stdout));
	if (!Array.isArray(data)) return [];
	const gates: Gate[] = [];
	for (const row of data) {
		if (row === null || typeof row !== "object") continue;
		const record = row as Record<string, unknown>;
		if (typeof record.id !== "string") continue;
		if (typeof record.status === "string" && record.status !== "open") continue;
		const description = typeof record.description === "string" ? record.description : "";
		gates.push({
			id: record.id,
			awaitType: typeof record.await_type === "string" ? record.await_type : "unknown",
			blocks: description.match(/blocking\s+(\S+)/)?.[1],
			reason: description.match(/^Reason:\s*(.+)$/m)?.[1],
		});
	}
	return gates;
}

/** Parse a gate list while distinguishing bd's valid empty `null` from bad output. */
export function readGateList(stdout: string): Gate[] | undefined {
	const parsed = parseTrailingJson(stdout);
	if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
		const error = (parsed as Record<string, unknown>).error;
		if (error !== undefined && error !== null && error !== "") return undefined;
	}
	const data = envelopeData(parsed);
	if (data === null) return [];
	if (!Array.isArray(data) || data.some(row => !row || typeof row !== "object" ||
		typeof row.id !== "string" || typeof row.await_type !== "string")) {
		return undefined;
	}
	return readGates(stdout);
}


/** Whether spending a `bd gate check` can change anything. */
export function gatesCanResolve(gates: Gate[]): boolean {
	return gates.some(gate => AUTO_GATE_TYPES[gate.awaitType] === true);
}

export interface CheckOutcome {
	resolved: number;
	escalated: number;
	errors: number;
}

export function readCheckOutcome(stdout: string): CheckOutcome | undefined {
	const data = envelopeData(parseTrailingJson(stdout));
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.resolved !== "number" || typeof record.escalated !== "number" || typeof record.errors !== "number") return undefined;
	return { resolved: record.resolved, escalated: record.escalated, errors: record.errors };
}

export function formatGateAdvisory(gates: Gate[], outcome: CheckOutcome | undefined): string | undefined {
	if (gates.length === 0) return undefined;
	const lines = [`${gates.length} open beads gate(s) block work in this repository:`];
	for (const gate of gates.slice(0, MAX_LISTED)) {
		const blocks = gate.blocks ? ` blocks ${gate.blocks}` : "";
		const reason = gate.reason ? ` -- ${gate.reason}` : "";
		lines.push(`- ${gate.id} (${gate.awaitType})${blocks}${reason}`);
	}
	if (gates.length > MAX_LISTED) lines.push(`- ...and ${gates.length - MAX_LISTED} more`);
	if (outcome) {
		lines.push(
			`\`bd gate check\` ran at session start: ${outcome.resolved} resolved, ${outcome.escalated} escalated, ${outcome.errors} errors.`,
		);
	}
	lines.push(
		"A human gate resolves only through a recorded human decision (`bd gate resolve <id>`); never force-close a gated issue around one.",
	);
	return lines.join("\n");
}

/**
 * What the previous session's detached push left behind.
 *
 * The writer records `started:` before detaching and overwrites it with a
 * verdict, so a surviving `started:` line means the push was cut off.
 */
export function lastPushNotice(contents: string): string | undefined {
	const lines = contents.split("\n").filter(line => line.trim().length > 0);
	const last = lines[lines.length - 1] ?? "";
	if (last.startsWith("failed:")) {
		return `The last session's beads push FAILED -- bead state is committed locally but not published: ${last}. Rerun the push once the cause is fixed.`;
	}
	if (last.startsWith("started:")) {
		return "The last session's beads push did not finish (no verdict recorded), so it may need rerunning.";
	}
	return undefined;
}

/**
 * The stale-skip warning, from either shape bd reports it in.
 *
 * Only a real import produces this: `--dry-run` reports every row as `created`
 * and never compares (verified against bd 1.1.2), and file mtime cannot stand in
 * for it because a checkout sets mtime to clone time regardless of content age.
 */
export function staleSkipNotice(output: string): string | undefined {
	let stale: string | undefined;
	const data = envelopeData(parseTrailingJson(output));
	if (data !== null && typeof data === "object" && !Array.isArray(data)) {
		const ids = (data as Record<string, unknown>).stale_skipped_ids;
		if (Array.isArray(ids) && ids.length > 0) stale = ids.map(String).join(", ");
	}
	if (stale === undefined) {
		const plain = output.match(/\((\d+) stale skipped/);
		if (plain && Number(plain[1]) > 0) stale = `${plain[1]} row(s)`;
	}
	if (stale === undefined) return undefined;
	return [
		`\`bd import\` skipped stale rows (${stale}): the JSONL export is BEHIND this database and local state was kept.`,
		"Commit a fresh export (`bd export -o .beads/issues.jsonl`, then stage it) BEFORE pulling peer changes -- otherwise the next export overwrites what a peer committed.",
	].join(" ");
}

/** Every real `bd` verb in a command line. */
export function bdVerbs(command: string): string[] {
	return bdInvocations(command).map(invocation => invocation.verb);
}

const HELP_VALUE_PREFIXES: Record<string, true> = { "--acceptance": true, "--add-label": true, "--append-notes": true, "--body-file": true, "--description": true, "--design": true, "--design-file": true, "--mem-profile": true, "--notes": true, "--set-metadata": true, "--title": true };

 /** Whether this command line wrote the beads database. */
 export function isBdWrite(command: string): boolean {
	if (isMutatingBdCommand(command)) return true;
	return bdInvocations(command).some(({ verb, args }) => {
		if (verb !== "update" && verb !== "ready" && verb !== "claim") return false;
		const help = args.indexOf("--help");
		const claim = args.indexOf("--claim");
		return help > 0 && claim > help && args.slice(0, help).some(token => HELP_VALUE_PREFIXES[token] === true);
	});
 }

/**
 * Bead-id-shaped arguments in a command line.
 *
 * Deliberately loose: callers intersect these with ids the database actually
 * returns, which discards anything that merely looks like an id.
 */
export function beadIdCandidates(command: string): string[] {
	const ids: string[] = [];
	for (const token of command.split(/[\s;&|(`'"]+/)) {
		if (token.startsWith("-")) continue;
		if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.\d+)*$/i.test(token)) ids.push(token);
	}
	return ids;
}

function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
	for (const name of names) {
		const index = args.indexOf(name);
		if (index >= 0) return args[index + 1];
		const inline = args.find(arg => arg.startsWith(`${name}=`));
		if (inline !== undefined) return inline.slice(name.length + 1);
	}
	return undefined;
}

function mutationTargetIds(args: readonly string[]): string[] {
	const ids: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const token = args[index] ?? "";
		if (["--assignee", "-a", "--status", "-s"].includes(token)) {
			index++;
			continue;
		}
		if (/^(?:--assignee|--status|-a|-s)=/u.test(token) || /^(?:--claim|--json)(?:=|$)/u.test(token)) continue;
		// An unknown option may consume later bead-shaped tokens, but it cannot
		// change positional IDs already seen. Preserve those and stop parsing.
		if (token.startsWith("-")) break;
		const [id] = beadIdCandidates(token);
		if (id !== undefined) ids.push(id);
	}
	return ids;
}

function commandSucceeded(event: ToolResultEvent): boolean {
	if (event.isError === true) return false;
	const details = event.details;
	if (details !== null && typeof details === "object" && "exitCode" in details) {
		const exitCode = details.exitCode;
		if (typeof exitCode === "number" && exitCode !== 0) return false;
	}
	return !/\bCommand exited with code -?[1-9]\d*\b/u.test(resultText(event));
}

interface TrackedClaim {
	id: string;
	actor: string | undefined;
	store: string | undefined;
}

interface ClaimTarget {
	key: string;
	store: string | undefined;
}

function canonicalStore(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}

function bdStoreForInvocation(invocation: BdInvocation, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	if (flagEnabled(invocation.globals, ["--global", "--database"])) return undefined;
	const directory = globalValue(invocation.globals, ["-C", "--directory"]);
	const db = globalValue(invocation.globals, ["--db"]);
	const base = directory === undefined ? cwd : resolve(cwd, directory);
	if (db !== undefined) {
		const target = resolve(base, db);
		if (!existsSync(target)) return undefined;
		return canonicalStore(statSync(target).isDirectory() ? target : dirname(target));
	}
	if (directory !== undefined) return canonicalStore(sessionPinFor(base) ?? join(base, ".beads"));
	const local = invocation.prefix.findLast(token => token.startsWith("BEADS_DIR="))?.slice("BEADS_DIR=".length);
	const pinned = local ?? env.BEADS_DIR;
	return canonicalStore(pinned === undefined || pinned === "" ? (sessionPinFor(cwd) ?? join(cwd, ".beads")) : isAbsolute(pinned) ? pinned : resolve(cwd, pinned));
}

function bdInvocationUsesExternalStore(invocation: BdInvocation): boolean {
	return flagEnabled(invocation.globals, ["--global", "--database"]);
}

function claimTarget(invocation: BdInvocation, cwd: string, env: NodeJS.ProcessEnv): ClaimTarget {
	const localStore = invocation.prefix.findLast(token => token.startsWith("BEADS_DIR="))?.slice("BEADS_DIR=".length);
	const global = flagEnabled(invocation.globals, ["--global"]);
	const database = globalValue(invocation.globals, ["--database"]);
	const db = globalValue(invocation.globals, ["--db"]);
	const directory = globalValue(invocation.globals, ["-C", "--directory"]);
	const base = directory === undefined ? cwd : resolve(cwd, directory);
	const selector = global ? ["global"] : database !== undefined ? ["database", database] : db !== undefined ? ["db", resolve(base, db)] : directory !== undefined ? ["directory", base] : undefined;
	const store = bdStoreForInvocation(invocation, cwd, env);
	if (selector !== undefined) return { key: `external:${JSON.stringify(selector)}`, store };
	if (store !== undefined) return { key: store, store };
	return { key: `external:${JSON.stringify(["beadsDir", localStore === undefined ? undefined : resolve(cwd, localStore)])}`, store: undefined };
}

function trackedClaimKey(target: ClaimTarget, id: string): string {
	return `${target.key}\0${id}`;
}

function setTrackedClaim(state: SessionState, target: ClaimTarget, id: string, actor: string | undefined): void {
	if (target.store !== undefined) {
		for (const [key, claim] of state.claims) {
			if (claim.id === id && claim.store === target.store) state.claims.delete(key);
		}
	}
	state.claims.set(trackedClaimKey(target, id), { id, actor, store: target.store });
}

function deleteTrackedClaim(state: SessionState, target: ClaimTarget, id: string): void {
	state.claims.delete(trackedClaimKey(target, id));
	if (target.store === undefined) return;
	for (const [key, claim] of state.claims) {
		if (claim.id === id && claim.store === target.store) state.claims.delete(key);
	}
}

const TRANSITION_VALUE_FLAGS: Record<string, true> = {
	"--actor": true, "--database": true, "--db": true, "-C": true, "--directory": true, "--dolt-auto-commit": true, "--mem-profile": true,
	"--acceptance": true, "--add-label": true, "--append-notes": true, "--assignee": true, "-a": true, "--await-id": true, "--body-file": true, "--defer": true,
	"--description": true, "-d": true, "--design": true, "--design-file": true, "--due": true, "--estimate": true, "-e": true, "--external-ref": true, "--if-assignee": true,
	"--if-status": true, "--metadata": true, "--notes": true, "--parent": true, "--priority": true, "-p": true, "--remove-label": true, "--session": true, "--set-labels": true,
	"--set-metadata": true, "--spec-id": true, "--status": true, "-s": true, "--title": true, "--type": true, "-t": true, "--unset-metadata": true, "--reason": true, "-r": true, "--message": true,
};

/** Command-local help and actor overrides, excluding tokens consumed as string option values. */
function commandTransitionFlags(args: string[]): { actorOverride: string | undefined; claim: boolean; help: boolean } {
	let actorOverride: string | undefined;
	let claim = false;
	for (let index = 0; index < args.length; index++) {
		const token = args[index] as string;
		const name = token.split("=", 1)[0] ?? token;
		if (TRANSITION_VALUE_FLAGS[name] === true) {
			if (name === "--actor") actorOverride = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[index + 1];
			if (!token.includes("=")) index++;
			continue;
		}
		if (flagEnabled([token], ["--help", "-h"])) return { actorOverride, claim, help: true };
		if (flagEnabled([token], ["--claim"])) claim = true;
	}
	return { actorOverride, claim, help: false };
}

/** Update the claims this session can prove from a successful Bash result; no database read is needed at shutdown. */
function recordClaimTransitions(state: SessionState, command: string, cwd: string, env: NodeJS.ProcessEnv, event: ToolResultEvent, invocations: BdInvocation[]): void {
	const transitionInvocations = invocations.flatMap(invocation => {
		const flags = commandTransitionFlags(invocation.args);
		return flagEnabled(invocation.globals, ["--help", "-h"]) || flags.help ? [] : [{ flags, invocation }];
	});
	const commandTokens = tokenizeShell(command);
	const terminalToken = commandTokens.findLast(token => token.value !== "\n")?.value;
	const safeCdAndBd = /^\s*cd\s+[^;&|<>]+&&\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*['"]?bd['"]?\b/u.test(command);
	const lexicalMutation = transitionInvocations.length === 1 && terminalToken !== "&" && !/\$\(|[;|<>]/u.test(command) && (!command.includes("&&") || safeCdAndBd);
	const mutationSucceededDirectly = lexicalMutation;
	const output = claimResultOutput(event);
	const allOutputIds = new Set(claimedIds(output));
	const labeledOutputIds = new Set(claimedTextIds(output));
	const claimInvocations: Array<{ actor: string; directIds: string[]; invocation: BdInvocation; target: ClaimTarget }> = transitionInvocations.flatMap(({ flags, invocation }) => {
		const enabled = invocation.verb === "claim" || ((invocation.verb === "update" || invocation.verb === "ready") && flags.claim);
		const actor = enabled ? (flags.actorOverride ?? invocationActor(invocation, env)) : null;
		return actor === null ? [] : [{ actor, directIds: mutationTargetIds(invocation.args), invocation, target: claimTarget(invocation, cwd, env) }];
	});
	const actorsByClaim = new Map<string, Set<string>>();
	for (const { actor, directIds, target } of claimInvocations) {
		for (const id of directIds) {
			const key = trackedClaimKey(target, id);
			const actors = actorsByClaim.get(key) ?? new Set<string>();
			actors.add(actor);
			actorsByClaim.set(key, actors);
		}
	}
	for (const { actor, directIds, target } of claimInvocations) {
		if (mutationSucceededDirectly) {
			state.actors.add(actor);
			for (const id of directIds.length > 0 ? directIds : allOutputIds) setTrackedClaim(state, target, id, actor);
			continue;
		}
		for (const id of directIds) {
			if (!labeledOutputIds.has(id)) continue;
			const actors = actorsByClaim.get(trackedClaimKey(target, id));
			state.actors.add(actor);
			setTrackedClaim(state, target, id, actors?.size === 1 ? actor : undefined);
		}
	}
	if (!mutationSucceededDirectly) return;
	const entry = transitionInvocations[0];
	if (entry === undefined) return;
	const { invocation } = entry;
	const target = claimTarget(invocation, cwd, env);
	for (const close of closeInvocations(command)) {
		for (const id of close.ids) deleteTrackedClaim(state, target, id);
	}
	if (invocation.verb === "assign") {
		const [idToken, assignee] = invocation.args;
		const [id] = idToken === undefined ? [] : beadIdCandidates(idToken);
		if (id !== undefined && assignee !== undefined) {
			if (state.actors.has(assignee)) setTrackedClaim(state, target, id, assignee);
			else deleteTrackedClaim(state, target, id);
		}
		return;
	}
	if (invocation.verb !== "update") return;
	const status = optionValue(invocation.args, ["--status", "-s"]);
	const assignee = optionValue(invocation.args, ["--assignee", "-a"]);
	for (const id of mutationTargetIds(invocation.args)) {
		if (status === "closed" || assignee === "") deleteTrackedClaim(state, target, id);
		else if (assignee !== undefined) {
			if (state.actors.has(assignee)) setTrackedClaim(state, target, id, assignee);
			else deleteTrackedClaim(state, target, id);
		}
	}
}

const SAFE_RELEASE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Build the native command used to release a claim. `bd unclaim --reason`
 * records the handoff and resets the issue to `open`; `--if-assignee` is the
 * only safe release because a late agent-end callback must never clobber a new
 * owner. If CAS is unavailable, return no command and leave an advisory for a
 * human rather than constructing an unguarded mutation.
 */
export function releaseClaimArgs(
	id: string,
	holder: string,
	env: NodeJS.ProcessEnv = process.env,
	releasedAt = new Date().toISOString(),
	casSupported = true,
): string[] | undefined {
	const actor = env.BD_ACTOR?.trim() || env.BEADS_ACTOR?.trim() || "";
	if (!casSupported) return undefined;
	if (!SAFE_RELEASE_IDENTIFIER.test(id) || !SAFE_RELEASE_IDENTIFIER.test(holder) || !SAFE_RELEASE_IDENTIFIER.test(actor)) return undefined;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(releasedAt)) return undefined;
	const reason = `session release by ${actor} at ${releasedAt}; previous holder ${holder}`;
	return ["unclaim", id, "--reason", reason, "--if-assignee", holder];
}

/**
 * Restore a parked status after `bd unclaim` resets the assignee and status to
 * open. The second mutation is guarded by `--if-status open`, so a new worker
 * that claims the bead between the two commands cannot be overwritten. A
 * terminal in-progress claim gets the explicit open transition; open claims
 * need no follow-up. The release reason remains the native unclaim audit.
 */
function restoreReleasedStatusArgs(id: string, status: string): string[] | undefined {
	if (status === "in_progress") return ["update", id, "--status", "open", "--if-status", "open"];
	if (status === "blocked" || status === "deferred") return ["update", id, "--status", status, "--if-status", "open"];
	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function releaseClaimCommand(
	id: string,
	holder: string,
	env: NodeJS.ProcessEnv = process.env,
	releasedAt = new Date().toISOString(),
	casSupported = true,
	targetStore?: string,
): string | undefined {
	const args = releaseClaimArgs(id, holder, env, releasedAt, casSupported);
	if (args === undefined) return undefined;
	const actor = env.BD_ACTOR?.trim() || env.BEADS_ACTOR?.trim() || "";
	const assignments = [`BEADS_ACTOR=${shellQuote(actor)}`, `BD_ACTOR=${shellQuote(actor)}`];
	if (targetStore !== undefined) assignments.unshift(`BEADS_DIR=${shellQuote(targetStore)}`);
	return [...assignments, "bd", ...args.map(shellQuote)].join(" ");
}


export interface Bead {
	id: string;
	title: string;
	status: string;
	assignee?: string;
	/** Exact tracked store; null means the originating target could not be reproduced safely. */
	releaseStore?: string | null;
	labels?: string[];
	metadata?: Record<string, string>;
}

export function readBeads(stdout: string): Bead[] {
	const data = envelopeData(parseTrailingJson(stdout));
	if (!Array.isArray(data)) return [];
	const beads: Bead[] = [];
	for (const row of data) {
		if (row === null || typeof row !== "object") continue;
		const record = row as Record<string, unknown>;
		if (typeof record.id !== "string") continue;
		const rawMetadata = record.metadata;
		const metadata: Record<string, string> | undefined = rawMetadata !== null && typeof rawMetadata === "object"
			? Object.fromEntries(
					Object.entries(rawMetadata as Record<string, unknown>).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: undefined;
		beads.push({
			id: record.id,
			title: typeof record.title === "string" ? record.title : "",
			status: typeof record.status === "string" ? record.status : "",
			labels: Array.isArray(record.labels) && record.labels.every((label) => typeof label === "string")
				? record.labels as string[]
				: undefined,
			assignee: typeof record.assignee === "string" && record.assignee.trim() ? record.assignee : undefined,
			metadata: Object.keys(metadata ?? {}).length > 0 ? metadata : undefined,
		});
	}
	return beads;
}

/** A lease anchor makes a foreign claim checkable without guessing from age. */
export function claimAnchor(bead: Bead): { host: string; pid: number } | undefined {
	const host = bead.metadata?.lease_host?.trim();
	const pid = Number(bead.metadata?.lease_pid);
	return host && Number.isInteger(pid) && pid > 0 ? { host, pid } : undefined;
}

/**
 * Claims this session is answerable for.
 *
 * Touched in-progress work and assigned unfinished work remain accountable,
 * including claims parked as blocked or deferred.
 */
export function heldClaims(
	beads: Bead[],
	seen: Set<string>,
	actor: string | ReadonlySet<string> | undefined,
): Bead[] {
	const actors = typeof actor === "string"
		? new Set(actor.trim() ? [actor.trim()] : [])
		: actor;
	return beads.filter(bead => {
		if (bead.assignee === undefined && bead.labels?.includes("state:reported")) return false;
		if (!["open", "in_progress", "blocked", "deferred"].includes(bead.status)) return false;
		if (bead.assignee !== undefined && actors?.has(bead.assignee)) return true;
		return bead.status === "in_progress" && seen.has(bead.id);
	});
}

export function formatSessionCloseAdvisory(
	beads: Bead[],
	env: NodeJS.ProcessEnv = process.env,
	releasedAt = new Date().toISOString(),
	casSupported = true,
	actors?: ReadonlySet<string>,
): string {
	const effectiveActors = actors ?? new Set([env.BD_ACTOR?.trim() || env.BEADS_ACTOR?.trim() || ""].filter(Boolean));
	const lines = ["Beads claims still held at session close (a mutating command was attempted):"];
	for (const bead of beads.slice(0, MAX_LISTED)) {
		const who = bead.assignee ? ` [${bead.assignee}]` : "";
		lines.push(`- ${bead.id}${who} ${bead.title}`);
		const anchor = claimAnchor(bead);
		if (anchor !== undefined) lines.push(`  Lease anchor: host=${anchor.host} pid=${anchor.pid}; check that process on that host before takeover.`);
		const actor = bead.assignee !== undefined && effectiveActors.has(bead.assignee)
			? bead.assignee
			: undefined;
		const release = bead.assignee === undefined || actor === undefined || bead.releaseStore === null ? undefined
			: releaseClaimCommand(bead.id, bead.assignee, { ...env, BD_ACTOR: actor }, releasedAt, casSupported, bead.releaseStore);
		if (release === undefined) {
			lines.push("  Release unavailable: the effective actor is missing or ambiguous; verify the current assignee and actor before retrying.");
		} else {
			lines.push(`  Release with: ${release}`);
			if (!casSupported) lines.push("  Then verify: bd show <id> --json must show no assignee.");
		}
	}
	if (beads.length > MAX_LISTED) lines.push(`- ...and ${beads.length - MAX_LISTED} more`);
	lines.push(
		"Close what is finished with a factual --reason, release only with the guarded command above, and write residual context onto any bead whose work continues elsewhere (bd comments add <id> \"...\"). The bead is the handover, not a PR body. File remaining or discovered work as its own bead before stopping.",
	);
	return lines.join("\n");
}

function trackedClaimAdvisory(state: SessionState): string | undefined {
	if (state.claims.size === 0) return undefined;
	const claims: Bead[] = [...state.claims.values()].map(claim => ({
		id: claim.id,
		title: "claim recorded by this session",
		status: "in_progress",
		assignee: claim.actor,
		releaseStore: claim.store ?? null,
	}));
	return formatSessionCloseAdvisory(claims, {}, new Date().toISOString(), true, state.actors);
}

type SessionStopEvent = {
	stop_hook_active?: boolean;
	stopHookActive?: boolean;
};

export type BdRunResult = { output: string } | { failure: string };

function boundedFailure(reason: string): string {
	const oneLine = reason.replace(/\s+/g, " ").trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

export function handleSessionStop(
	event: SessionStopEvent,
	listOutput: string | undefined,
	seen: Set<string>,
	actor: string | ReadonlySet<string> | undefined = process.env.BEADS_ACTOR ?? process.env.BD_ACTOR,
	casSupported = true,
	listFailure?: string,
): { continue: true; additionalContext: string } | undefined {
	if (event.stop_hook_active === true || event.stopHookActive === true) return;
	const data = listOutput === undefined ? undefined : envelopeData(parseTrailingJson(listOutput));
	if (!Array.isArray(data) || data.some(row => !row || typeof row !== "object" ||
		typeof row.id !== "string" || typeof row.status !== "string")) {
		const reason = listFailure === undefined ? "the command returned no readable result" : listFailure;
		return { continue: true, additionalContext: bdReadFailure("close", reason) };
	}
	const held = heldClaims(readBeads(listOutput!), seen, actor);
	if (held.length === 0) return;
	const actors = typeof actor === "string" ? new Set(actor.trim() ? [actor.trim()] : []) : actor;
	return { continue: true, additionalContext: formatSessionCloseAdvisory(held, {}, new Date().toISOString(), casSupported, actors) };
}
/** Reads no boundary waits for. Only tests join them. */
const backgroundReads = new Set<Promise<unknown>>();

function track<T>(pending: Promise<T>): Promise<T> {
	backgroundReads.add(pending);
	const forget = (): void => { backgroundReads.delete(pending); };
	void pending.then(forget, forget);
	return pending;
}

export async function settleBackgroundWorkForTests(): Promise<void> {
	while (backgroundReads.size > 0) await Promise.allSettled([...backgroundReads]);
}

async function settleWithin<T>(pending: Promise<T>, budgetMs: number): Promise<T | undefined> {
	if (budgetMs <= 0) return undefined;
	const { promise, resolve } = Promise.withResolvers<undefined>();
	// The raw timer only resolves this local promise; its callback cannot throw or reach extension state.
	const timer = setTimeout(resolve, budgetMs);
	timer.unref();
	try {
		return await Promise.race([pending, promise]);
	} finally {
		clearTimeout(timer);
	}
}

export type AgentEndEvent = {
	willContinue?: boolean;
	outcome?: unknown;
	status?: unknown;
};

/**
 * Release only after a genuinely terminal agent turn. The host sends an
 * `agent_end` event for resumable turns too; those must retain their claims.
 * Outcome/status are deliberately observational: completed, aborted, failed,
 * blocked, and deferred turns all release the same unfinished claim through
 * the ownership-checked native command.
 */
function terminalAgentEnd(event: unknown): event is AgentEndEvent {
	return event === null || typeof event !== "object" || (event as AgentEndEvent).willContinue !== true;
}

async function releaseClaimsAtAgentEnd(
	state: SessionState,
	cwd: string,
	report: (message: string) => void,
): Promise<void> {
	const deadline = Date.now() + BD_COMMAND_CEILING_MS;
	for (const [key, claim] of [...state.claims]) {
		const actor = claim.actor;
		// A claim whose exact store or actor cannot be proven is advisory-only.
		if (actor === undefined || claim.store === undefined) continue;
		try {
			const env = lifecycleBdEnvironment(cwd, { BD_ACTOR: actor, BEADS_ACTOR: actor });
			env.BEADS_DIR = claim.store;
			const shown = await runBdResult(cwd, ["show", claim.id, "--json"], deadline, env);
			if (!("output" in shown)) {
				report(`terminal claim read for ${claim.id} was not verified: ${shown.failure}`);
				continue;
			}
			const rows = envelopeData(parseTrailingJson(shown.output));
			if (!Array.isArray(rows)) {
				report(`terminal claim read for ${claim.id} returned malformed data; release was refused`);
				continue;
			}
			const bead = rows.find(row => row !== null && typeof row === "object" && "id" in row && row.id === claim.id);
			if (bead === undefined || bead === null || typeof bead !== "object") continue;
			const record = bead as Record<string, unknown>;
			if (record.assignee !== actor || !["epic", "task"].includes(String(record.issue_type)) ||
				!["open", "in_progress", "blocked", "deferred"].includes(String(record.status))) continue;
			const release = releaseClaimArgs(claim.id, actor, env, new Date().toISOString(), true);
			if (release === undefined) continue;
			const released = await runBdResult(cwd, release, deadline, env);
			if (!("output" in released)) {
				report(`terminal claim release for ${claim.id} was not verified: ${released.failure}`);
				continue;
			}
			const restore = restoreReleasedStatusArgs(claim.id, String(record.status));
			if (restore !== undefined) {
				const restored = await runBdResult(cwd, restore, deadline, env);
				if (!("output" in restored)) {
					report(`terminal claim status restore for ${claim.id} was not verified: ${restored.failure}`);
					continue;
				}
			}
			state.claims.delete(key);
		} catch (error) {
			// One malformed or slow bead must not prevent independent claims from
			// getting their own ownership check and release attempt.
			report(`terminal claim release for ${claim.id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

interface GateVerdict {
	notice?: string;
	verified: boolean;
}

interface GateVerification {
	pending: Promise<GateVerdict>;
	verdict?: GateVerdict;
	/** True after an operation was admitted using this completed verdict. */
	admitted?: boolean;
}




/**
 * A holder id per internal run. Session boundaries carry no tool call, and such a
 * run is never nested inside one -- `session_start` precedes every tool call -- so a
 * fresh id is both correct and incapable of self-deadlock.
 */
let internalRuns = 0;

export type BdStream = (cwd: string, args: string[], deadline: number, env: NodeJS.ProcessEnv) => Promise<string | BdRunResult | undefined>;

let injectedStream: BdStream | null = null;

/** Replace the `bd` seam. Pass `null` to restore the real one. */
export function setBdStreamForTests(fn: BdStream | null): void {
	injectedStream = fn;
}

/**
 * Run bd while retaining a bounded reason when the command cannot be read.
 * The typed result keeps stdout separate from failure context; the legacy wrapper
 * below preserves the string-or-undefined seam used by other lifecycle checks.
 */
export async function runBdResult(
	cwd: string,
	args: string[],
	deadline = Date.now() + TIMEOUT_MS,
	env: NodeJS.ProcessEnv = process.env,
): Promise<BdRunResult> {
	const stream = injectedStream;
	const execute = async (): Promise<BdRunResult> => {
		if (stream === null) return spawnBd(cwd, args, deadline, env);
		const result = await stream(cwd, args, deadline, env);
		if (result === undefined) return { failure: "bd command could not be run" };
		return typeof result === "string" ? { output: result } : result;
	};
	let result: BdRunResult;
	if (writesStore(invocationFromArgv(args))) {
		const locked = await withEmbeddedWriteLock(
			cwd,
			`beads-session-run-${process.pid}-${internalRuns++}`,
			execute,
			env,
			deadline,
		);
		result = locked.kind === "failed" ? { failure: boundedFailure(locked.reason) } : locked.value;
	} else {
		result = await execute();
	}
	return Date.now() >= deadline ? { failure: "bd command timed out" } : result;
}

export async function runBd(
	cwd: string,
	args: string[],
	deadline = Date.now() + TIMEOUT_MS,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const result = await runBdResult(cwd, args, deadline, env);
	return "output" in result ? result.output : undefined;
}

async function spawnBd(cwd: string, args: string[], deadline: number, env: NodeJS.ProcessEnv): Promise<BdRunResult> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return { failure: "bd command timed out" };
	const started = Date.now();
	try {
		const proc = Bun.spawn(["bd", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_JSON_ENVELOPE: "1" },
			timeout: Math.min(BD_COMMAND_CEILING_MS, remaining),
			killSignal: "SIGKILL",
		});
		// Only a read is unreferenced, so that a slow one cannot hold the harness open after
		// the session is done with it. A mutating command runs inside the embedded write lock
		// this process holds: letting the harness exit while it writes would drop the lock
		// from under a live writer, which is how the Dolt journal gets corrupted.
		if (!writesStore(invocationFromArgv(args))) proc.unref();
		const [out, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		if (code === 0) return { output: out };
		if (Date.now() >= deadline || Date.now() - started >= remaining) return { failure: "bd command timed out" };
		const detail = stderr.replace(/\s+/g, " ").trim();
		return { failure: boundedFailure(`bd exited with code ${code}${detail ? `: ${detail}` : ""}`) };
	} catch (error) {
		if (Date.now() >= deadline || Date.now() - started >= remaining) return { failure: "bd command timed out" };
		return { failure: boundedFailure(`bd could not run: ${error instanceof Error ? error.message : String(error)}`) };
	}
}

/**
 * Read the push verdict and consume it, so a stale verdict is not re-reported.
 * This is the only reader, so consuming the file loses nothing.
 */
function consumeLastPush(dir: string): string | undefined {
	const log = join(dir, "last-push.log");
	if (!existsSync(log)) return undefined;
	let notice: string | undefined;
	try {
		notice = lastPushNotice(readFileSync(log, "utf8"));
	} catch {
		notice = undefined;
	}
	try {
		rmSync(log, { force: true });
	} catch {
		// A verdict that cannot be consumed is still worth reporting once.
	}
	return notice;
}

async function gateAdvisory(cwd: string, env: NodeJS.ProcessEnv): Promise<GateVerdict> {
	const runGate = (args: string[]): Promise<BdRunResult> => runBdResult(cwd, args, Date.now() + BD_COMMAND_CEILING_MS, env);
	const listed = await runGate(["gate", "list", "--json"]);
	if (!("output" in listed)) return { notice: bdReadFailure("start", listed.failure), verified: false };
	let gates = readGateList(listed.output);
	if (gates === undefined) return { notice: "Beads gate list returned malformed data; unresolved gates remain unverified.", verified: false };
	if (gates.length === 0) return { verified: true };
	let outcome: CheckOutcome | undefined;
	if (gatesCanResolve(gates)) {
		const checked = await runGate(["gate", "check", "--json"]);
		if (!("output" in checked)) return { notice: bdReadFailure("start", checked.failure), verified: false };
		outcome = readCheckOutcome(checked.output);
		if (outcome === undefined) return { notice: "Beads gate check returned malformed data; unresolved gates remain unverified.", verified: false };
		if (outcome.errors > 0) {
			return { notice: `Beads gate check reported ${outcome.errors} error(s); unresolved gates remain unverified.`, verified: false };
		}
		if (outcome.resolved > 0) {
			const relisted = await runGate(["gate", "list", "--json"]);
			if (!("output" in relisted)) return { notice: bdReadFailure("start", relisted.failure), verified: false };
			const relistedGates = readGateList(relisted.output);
			if (relistedGates === undefined) return { notice: "Beads gate list returned malformed data; unresolved gates remain unverified.", verified: false };
			gates = relistedGates;
		}
	}
	return { notice: formatGateAdvisory(gates, outcome), verified: true };
}

/** Text blocks of a tool result, joined. */
function resultText(event: ToolResultEvent): string {
	let text = "";
	for (const block of event.content ?? []) {
		if (block !== null && typeof block === "object" && (block as { type?: string }).type === "text") {
			text += (block as { text?: string }).text ?? "";
		}
	}
	return text;
}

/** Resolve the lifecycle's canonical embedded-store pin for a Bash call. */
type SessionPinGetter = (cwd: string, ctx: ExtensionContext) => string | undefined;

type GateAdmitter = (cwd: string, env: NodeJS.ProcessEnv, ctx: ExtensionContext, refresh: boolean) => Promise<GateAdmission>;

interface LifecycleBridge {
	gateAdmitter?: GateAdmitter;
	sessionPinGetter?: SessionPinGetter;
}

const LIFECYCLE_BRIDGE = Symbol.for("com.srobroek.beads.session-lifecycle.bridge.v1");

/** Process-wide bridge because each configured extension is emitted as a separate bundle. */
function lifecycleBridge(): LifecycleBridge {
	const globals = globalThis as typeof globalThis & { [key: symbol]: LifecycleBridge | undefined };
	const existing = globals[LIFECYCLE_BRIDGE];
	if (existing !== undefined) return existing;
	const created: LifecycleBridge = {};
	globals[LIFECYCLE_BRIDGE] = created;
	return created;
}

export function pinnedBeadsDir(cwd: string, ctx?: ExtensionContext): string | undefined {
	const pin = ctx === undefined ? undefined : lifecycleBridge().sessionPinGetter?.(cwd, ctx);
	return pin ?? (ctx === undefined ? sessionPinFor(cwd) : undefined);
}

/** Shared Bash rewrite used by bash-gates.ts; the lifecycle supplies session ownership. */
export function rewriteBashInput(input: unknown, ctx: ExtensionContext): Record<string, unknown> | undefined {
	const cwd = bashCallCwd(input, ctx?.cwd ?? process.cwd());
	const pin = pinnedBeadsDir(cwd, ctx);
	return pinBashInput(input, pin === "" ? undefined : pin);
}

/**
 * Whether a mutating bd command may run yet.
 *
 * `session_start` does not block on the gate check any more, so this is where the
 * beads-lifecycle obligation is actually kept: automatic gates are verified before work is
 * picked. Called by bash-gates.ts, which owns the plugin's sole Bash `tool_call`.
 */
export type GateAdmission = { block: true; reason: string } | undefined;


export async function admitBeadsWork(
	ctx: ExtensionContext,
	cwd: string = ctx?.cwd ?? process.cwd(),
	env: NodeJS.ProcessEnv = lifecycleBdEnvironment(cwd),
	refresh = true,
): Promise<GateAdmission> {
	const gateAdmitter = lifecycleBridge().gateAdmitter;
	if (gateAdmitter === undefined) return undefined;
	return await gateAdmitter(resolve(cwd), boundedBdEnvironment(env), ctx, refresh);
}

export async function admitBdMutation(input: unknown, ctx: ExtensionContext, targetEnabled?: (cwd: string) => boolean): Promise<GateAdmission> {
	const command = extractCommand(input ?? {});
	if (!command) return undefined;
	if (/\bcd\s+(?:"[^"]*\$[^"]*"|'[^']*\$[^']*'|\$[A-Za-z_])/u.test(command)) {
		return { block: true, reason: "cannot resolve the dynamic working directory before this mutation" };
	}
	const writes = bdInvocations(command).filter(invocation => writesStore(invocation));
	if (writes.some(invocation => invocation.prefix.some(token => token.startsWith("BEADS_DIR=") && /[$`]/u.test(token)))) {
		return { block: true, reason: "Beads directory is selected dynamically and cannot be verified before this mutation" };
	}
	if (writes.length === 0) return undefined;
	// Classify the caller's command before any runner rewrite, but verify the environment
	// the mutation will actually receive after the lifecycle applies its per-session pin.
	const effectiveInput = rewriteBashInput(input, ctx) ?? input;
	const cwd = bashCallCwd(effectiveInput, ctx?.cwd ?? process.cwd());
	const env = environmentForInput(effectiveInput as ToolCallEvent["input"]);
	const writeTargets = embeddedWriteTargets(command, cwd, env);
	if (writeTargets.kind === "refused") return { block: true, reason: writeTargets.reason };
	const direct = writes.length === 1 ? writes[0] : undefined;
	if (direct !== undefined && bdInvocationUsesExternalStore(direct)) return undefined;
	const store = direct === undefined ? undefined : bdStoreForInvocation(direct, cwd, env);
	if (targetEnabled?.(store === undefined ? cwd : dirname(store)) === false) return undefined;
	return await admitBeadsWork(ctx, cwd, store === undefined ? env : { ...env, BEADS_DIR: store }, false);
}

export default function sessionBeadsLifecycle(pi: ExtensionAPI): void {
	const sessions = new Map<string, SessionState>();
	function stateFor(ctx: ExtensionContext): SessionState {
		const key = sessionKey(ctx);
		let state = sessions.get(key);
		if (!state) {
			state = { actors: new Set(), bdWrote: false, claims: new Map(), gates: new Map(), repos: new Map(), staleAdvised: false, stopFired: false, touched: new Set() };
			sessions.set(key, state);
		}
		return state;
	}

	function identityFor(state: SessionState, cwd: string): string {
		const key = resolve(cwd);
		const cached = state.repos.get(key);
		if (cached !== undefined) return cached;
		const identity = repoIdentity(key);
		state.repos.set(key, identity);
		return identity;
	}

	/**
	 * A message rather than `ctx.ui.notify`: the agent runs the commands these advisories
	 * are about, and a UI notification reaches neither it nor a --print session.
	 */
	const advise = (content: string): void => {
		pi.sendMessage(
			{ customType: "com.srobroek.beads.session-lifecycle", content, display: true, attribution: "user" },
			{ triggerTurn: false },
		);
	};

	lifecycleBridge().sessionPinGetter = (cwd, ctx) => {
		const localStore = join(resolve(cwd), ".beads");
		const local = (() => {
			try { return statSync(localStore).isDirectory() ? realpathSync(localStore) : undefined; } catch { return undefined; }
		})();
		const state = sessions.get(sessionKey(ctx));
		if (state !== undefined) {
			if (state.repo !== undefined && identityFor(state, cwd) !== state.repo) return undefined;
			const inherited = process.env.BEADS_DIR;
			const nonRepository = state.repo === resolve(cwd);
			if (nonRepository && local !== undefined && state.pin === inherited && local !== inherited) return local;
			return state.pin ?? sessionPinFor(cwd) ?? local;
		}
		return process.env.BEADS_DIR ?? sessionPinFor(cwd) ?? local;
	};

	const verificationFor = (key: string, state: SessionState, cwd: string, env: NodeJS.ProcessEnv, refresh = false): GateVerification | undefined => {
		const dir = bdStoreDir(cwd, env);
		if (dir === undefined) return undefined;
		const existing = state.gates.get(dir);
		if (existing !== undefined && (existing.verdict === undefined || (!refresh && existing.verdict.verified === true) || (existing.verdict.verified === true && existing.admitted !== true))) return existing;
		if (existing !== undefined) state.gates.delete(dir);
		const verification = (async (): Promise<GateVerdict> => {
			try {
				return await gateAdvisory(cwd, env);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				pi.logger.error("beads gate check failed", { error: reason, store: dir });
				return { notice: bdReadFailure("start", reason), verified: false };
			}
		})();
		const gate: GateVerification = { pending: verification };
		state.gates.set(dir, gate);
		track(verification.then(verdict => {
			gate.verdict = verdict;
			if (verdict.notice !== undefined && sessions.get(key) === state) advise(verdict.notice);
		}));
		return gate;
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const key = sessionKey(ctx);
		sessions.delete(key);
		const state = stateFor(ctx);
		try {
			const cwd = ctx?.cwd ?? process.cwd();
			const pin = autoPinBeadsDir(cwd, key, (id) => sessions.has(id));
			state.repo = identityFor(state, cwd);
			state.pin = sessionPinAfter(pin, cwd);
			if (pin.conflict !== undefined) {
				advise(
					`This process is pinned to another repository's beads database (\`BEADS_DIR=${pin.conflict}\`) by a live session. ` +
					"Bash calls in this checkout use its own `.beads`; calls in other repositories remain unpinned unless they provide `BEADS_DIR`.",
				);
			}
			const bdEnv = lifecycleBdEnvironment(cwd);
			const dir = bdStoreDir(cwd, bdEnv);
			if (dir === undefined) return;
			const pushed = consumeLastPush(dir);
			if (pushed !== undefined) advise(pushed);
			// The gate check runs off this boundary. It is up to three `bd` calls, and one
			// ordinary read on a cold embedded store already outlasts the whole handler
			// budget, so waiting here reported a healthy store as unverifiable. Nothing is
			// admitted on that silence: the first operation for each target store waits on
			// that store's own verdict.
			verificationFor(key, state, cwd, bdEnv);
		} catch (error) {
			pi.logger.error("beads session-start check failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	lifecycleBridge().gateAdmitter = async (cwd, env, ctx, refresh) => {
		const key = sessionKey(ctx);
		const state = sessions.get(key);
		if (state === undefined) return undefined;
		const gate = verificationFor(key, state, cwd, env, refresh);
		if (gate === undefined) return undefined;
		if (gate.verdict === undefined) await settleWithin(gate.pending, GATE_ADMISSION_MS);
		if (gate.verdict?.verified === true) {
			gate.admitted = true;
			return undefined;
		}
		const reason = gate.verdict?.notice === undefined
			? `automatic beads gates are still being verified for ${cwd} after ${GATE_ADMISSION_MS} ms, so an automatic gate may still be unresolved and this operation would pick or change work ahead of it. The read is slow, not failed`
			: `automatic beads gates could not be verified for ${cwd}, so this operation could pick or change work while a gate remains unresolved. ${gate.verdict.notice}`;
		return { block: true, reason };
	};

	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		const key = sessionKey(ctx);
		const state = sessions.get(key);
		sessions.delete(key);
		endAutoPinSession(key, (id) => sessions.has(id));
		if (state === undefined) return;
		const advisory = trackedClaimAdvisory(state);
		if (advisory === undefined) return;
		pi.logger.error("beads claims remained at session shutdown", { claims: [...state.claims.keys()] });
		pi.sendMessage({ customType: "com.srobroek.beads.session-lifecycle", content: advisory, display: true, attribution: "user" }, { triggerTurn: false });
	});

	pi.on("turn_start", (_event, ctx: ExtensionContext) => {
		stateFor(ctx).stopFired = false;
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input ?? {};
			const command = extractCommand(input);
			if (!command) return;
			const invocations = bdInvocations(command);
			if (invocations.length === 0) return;
			const state = stateFor(ctx);
			if (isBdWrite(command)) {
				state.bdWrote = true;
				const effectiveInput = rewriteBashInput(input, ctx) ?? input;
				const cwd = bashCallCwd(effectiveInput, ctx?.cwd ?? process.cwd());
				const env = environmentForInput(effectiveInput as ToolCallEvent["input"]);
				for (const actor of actorValues(command, env)) state.actors.add(actor);
				for (const id of beadIdCandidates(command)) state.touched.add(id);
				if (commandSucceeded(event)) recordClaimTransitions(state, command, cwd, env, event, invocations);
			}
			if (state.staleAdvised) return;
			const notice = staleSkipNotice(resultText(event));
			if (notice === undefined) return;
			state.staleAdvised = true;
			return { content: [{ type: "text" as const, text: `${notice}\n\n` }, ...(event.content ?? [])] };
		} catch {
			// Attribution and advisories must never disturb a tool result.
			return;
		}
	});

	pi.on("session_stop", (event: SessionStopEvent, ctx: ExtensionContext) => {
		const state = sessions.get(sessionKey(ctx));
		if (state === undefined || state.stopFired || event.stop_hook_active === true || event.stopHookActive === true) return;
		const additionalContext = trackedClaimAdvisory(state);
		if (additionalContext === undefined) return;
		state.stopFired = true;
		return { continue: true as const, additionalContext };
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		if (!terminalAgentEnd(event)) return;
		const state = sessions.get(sessionKey(ctx));
		if (state === undefined || state.claims.size === 0) return;
		const pending = releaseClaimsAtAgentEnd(state, ctx?.cwd ?? process.cwd(), (message) => {
			pi.logger.error("beads terminal claim release advisory", { message, outcome: event.outcome, status: event.status });
		});
		// Spawned task executors await agent_end handlers; return their finalizer so
		// the task cannot settle while an actor-owned claim is still being checked.
		if (agentActor(ctx) !== undefined) return await pending;
		// Main-agent session_stop steering runs first. Its terminal cleanup remains
		// detached from the boundary so a cold embedded read cannot hold the harness.
		track(pending).catch((error: unknown) => {
			pi.logger.error("beads terminal claim release failed", { error: error instanceof Error ? error.message : String(error) });
		});
	});
}
