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
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { extractCommand, MUTATING_VERBS } from "./bd-actor-gate.ts";

/** No session boundary may hang on the database or on `gh`. */
const TIMEOUT_MS = 8000;

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

/**
 * Verbs that write the database beyond bd-actor-gate's claim taxonomy. `ready`
 * is a read unless it carries `--claim`, which is the swarm claim path.
 */
export const EXTRA_WRITE_VERBS: Record<string, true> = {
	import: true,
	gate: true,
	defer: true,
	supersede: true,
};

let advisedGates = false;
let bdWrote = false;
let staleAdvised = false;
let stopFired = false;
let touched = new Set<string>();

export function resetSessionBeadsLifecycleForTests(): void {
	advisedGates = false;
	bdWrote = false;
	staleAdvised = false;
	stopFired = false;
	touched = new Set();
}

/** The repository's `.beads` directory, or nothing when this is not a beads repo. */
export function beadsDir(cwd: string): string | undefined {
	const dir = join(cwd, ".beads");
	return existsSync(dir) ? dir : undefined;
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

/** Whether spending a `bd gate check` can change anything. */
export function gatesCanResolve(gates: Gate[]): boolean {
	return gates.some(gate => AUTO_GATE_TYPES[gate.awaitType] === true);
}

export interface CheckOutcome {
	resolved: number;
	escalated: number;
	errors: number;
}

export function readCheckOutcome(stdout: string): CheckOutcome {
	const data = envelopeData(parseTrailingJson(stdout));
	const record = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
	const count = (key: string): number => (typeof record[key] === "number" ? (record[key] as number) : 0);
	return { resolved: count("resolved"), escalated: count("escalated"), errors: count("errors") };
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

/** Every `bd` verb in a command line, skipping the global flags that precede one. */
export function bdVerbs(command: string): string[] {
	const pattern = /(?:^|[\s;&|(`])bd\s+(?:(?:-C|--directory|--db|--actor)\s+\S+\s+)*([a-z][\w-]*)/gi;
	const verbs: string[] = [];
	for (const match of command.matchAll(pattern)) verbs.push(match[1]!.toLowerCase());
	return verbs;
}

/** Whether this command line wrote the beads database. */
export function isBdWrite(command: string): boolean {
	for (const verb of bdVerbs(command)) {
		if (verb === "comments") {
			if (/\bbd\s+comments\s+add\b/i.test(command)) return true;
			continue;
		}
		if (verb === "ready") {
			if (/--claim\b/.test(command)) return true;
			continue;
		}
		if (MUTATING_VERBS[verb] || EXTRA_WRITE_VERBS[verb]) return true;
	}
	return false;
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
		if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.\d+)?$/i.test(token)) ids.push(token);
	}
	return ids;
}

export interface Bead {
	id: string;
	title: string;
	status: string;
	assignee?: string;
}

export function readBeads(stdout: string): Bead[] {
	const data = envelopeData(parseTrailingJson(stdout));
	if (!Array.isArray(data)) return [];
	const beads: Bead[] = [];
	for (const row of data) {
		if (row === null || typeof row !== "object") continue;
		const record = row as Record<string, unknown>;
		if (typeof record.id !== "string") continue;
		beads.push({
			id: record.id,
			title: typeof record.title === "string" ? record.title : "",
			status: typeof record.status === "string" ? record.status : "",
			assignee: typeof record.assignee === "string" ? record.assignee : undefined,
		});
	}
	return beads;
}

/**
 * Claims this session is answerable for.
 *
 * `in_progress` only: an open bead is either backlog this session never touched
 * or work it just filed, and neither is a close-out omission. A held claim is.
 */
export function heldClaims(beads: Bead[], seen: Set<string>, actor: string | undefined): Bead[] {
	return beads.filter(bead => {
		if (bead.status !== "in_progress") return false;
		if (seen.has(bead.id)) return true;
		return actor !== undefined && actor.length > 0 && bead.assignee === actor;
	});
}

export function formatSessionCloseAdvisory(beads: Bead[]): string {
	const lines = ["Beads left in progress at session close, and this session wrote to the database:"];
	for (const bead of beads.slice(0, MAX_LISTED)) {
		const who = bead.assignee ? ` [${bead.assignee}]` : "";
		lines.push(`- ${bead.id}${who} ${bead.title}`);
	}
	if (beads.length > MAX_LISTED) lines.push(`- ...and ${beads.length - MAX_LISTED} more`);
	lines.push(
		"Close what is finished with a factual `--reason`, release what is not (`bd unclaim <id>`), and write residual context onto any bead whose work continues elsewhere (`bd comments add <id> -m ...`) -- the bead is the handover, not a PR body. File remaining or discovered work as its own bead before stopping.",
	);
	return lines.join("\n");
}

type SessionStopEvent = {
	stop_hook_active?: boolean;
	stopHookActive?: boolean;
};

export function handleSessionStop(
	event: SessionStopEvent,
	listOutput: string | undefined,
	seen: Set<string> = touched,
	actor: string | undefined = process.env.BEADS_ACTOR,
): { continue: true; additionalContext: string } | undefined {
	if (event.stop_hook_active === true || event.stopHookActive === true) return;
	if (stopFired) return;
	if (!listOutput) return;
	const held = heldClaims(readBeads(listOutput), seen, actor);
	if (held.length === 0) return;
	stopFired = true;
	return { continue: true, additionalContext: formatSessionCloseAdvisory(held) };
}

/** Run bd for its stdout. Warnings on stderr are noise here and are dropped. */
async function runBd(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["bd", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_JSON_ENVELOPE: "1" },
			timeout: TIMEOUT_MS,
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return out;
	} catch {
		return undefined;
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

/**
 * Open gates, after letting the automatic ones resolve.
 *
 * The cheap read comes first: a repository with no gates, which is most of them,
 * costs one read-only call and never a network-bound `gh` check.
 */
async function gateAdvisory(cwd: string): Promise<string | undefined> {
	const listed = await runBd(cwd, ["gate", "list", "--json"]);
	if (listed === undefined) return undefined;
	let gates = readGates(listed);
	if (gates.length === 0) return undefined;
	let outcome: CheckOutcome | undefined;
	if (gatesCanResolve(gates)) {
		const checked = await runBd(cwd, ["gate", "check", "--json"]);
		if (checked !== undefined) {
			outcome = readCheckOutcome(checked);
			if (outcome.resolved > 0) {
				const relisted = await runBd(cwd, ["gate", "list", "--json"]);
				if (relisted !== undefined) gates = readGates(relisted);
			}
		}
	}
	return formatGateAdvisory(gates, outcome);
}

/** Text blocks of a tool result, joined. */
function resultText(event: ExtensionToolResultEvent): string {
	let text = "";
	for (const block of event.content ?? []) {
		if (block !== null && typeof block === "object" && (block as { type?: string }).type === "text") {
			text += (block as { text?: string }).text ?? "";
		}
	}
	return text;
}

export default function sessionBeadsLifecycle(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (advisedGates) return;
		advisedGates = true;
		bdWrote = false;
		staleAdvised = false;
		stopFired = false;
		touched = new Set();
		try {
			const dir = beadsDir(ctx?.cwd ?? process.cwd());
			if (dir === undefined) return;
			const notices = [consumeLastPush(dir), await gateAdvisory(ctx.cwd)].filter(
				(notice): notice is string => notice !== undefined,
			);
			if (notices.length === 0) return;
			// A message rather than `ctx.ui.notify`: the agent runs the commands this
			// is about, and a UI notification reaches neither it nor a --print session.
			pi.sendMessage({
				customType: "com.srobroek.beads.session-lifecycle",
				content: notices.join("\n\n"),
				display: true,
				attribution: "user",
				triggerTurn: false,
			});
		} catch (error) {
			pi.logger.error("beads session-start check failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// Only the fired-once latch resets per turn; what the session touched must
	// accumulate across the whole session.
	pi.on("turn_start", () => {
		stopFired = false;
	});

	pi.on("tool_result", (event: ExtensionToolResultEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input ?? {});
			if (!command || !/\bbd\s+/.test(command)) return;
			if (!event.isError && isBdWrite(command)) {
				bdWrote = true;
				for (const id of beadIdCandidates(command)) touched.add(id);
			}
			if (staleAdvised) return;
			const notice = staleSkipNotice(resultText(event));
			if (notice === undefined) return;
			staleAdvised = true;
			return { content: [{ type: "text" as const, text: `${notice}\n\n` }, ...(event.content ?? [])] };
		} catch {
			// Attribution and advisories must never disturb a tool result.
			return;
		}
	});

	pi.on("session_stop", async (event: SessionStopEvent, ctx: { cwd?: string }) => {
		try {
			const cwd = ctx?.cwd ?? process.cwd();
			if (!bdWrote || beadsDir(cwd) === undefined) return;
			const listed = await runBd(cwd, ["list", "--status", "open,in_progress", "--json"]);
			return handleSessionStop(event, listed);
		} catch (error) {
			pi.logger.error("beads session-close check failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
	});
}
