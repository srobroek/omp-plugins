import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { environmentForInput } from "./bd-actor-gate.ts";
import { withEmbeddedWriteLock } from "./bd-embedded-write-lock.ts";
import { leadingCdCwd, type ParsedCommand } from "./shell-command.ts";

/**
 * A claim is a lease, and a lease has a holder you can check.
 *
 * `bd` records ownership as an assignee string and nothing else, so a session
 * that crashes leaves a claim no one can distinguish from live work. Staleness
 * is the usual guess, and it is wrong in both directions: an agent deep in an
 * implementation touches no bead for an hour, while a crashed session looks busy
 * for a day. rule://beads-core therefore requires proving the holder gone, and
 * that needs a holder recorded at claim time.
 *
 * The anchors are written AFTER the claim, never by rewriting the command.
 * Rewriting means parsing shell text, and a hand-rolled parser corrupts what it
 * misreads: a heredoc carrying a claim, an escaped separator, a claim inside
 * `$(...)`. A separate `bd update` cannot corrupt anything -- when detection
 * misses, a bead simply lacks anchors, and rule://beads-core treats a lease
 * without them as unprovable rather than dead.
 *
 * The pid is this process, not the shell's `$$`: the bash child is dead by the
 * time anyone reads it.
 *
 * The stamp is a real `bd` write, so on an embedded store it goes through the same
 * per-store lock the bash boundary uses. It runs in the `tool_result` of the claim
 * whose hold may still be open, which is why that lock counts holds per tool call:
 * passing this call's id joins the hold instead of waiting on it.
 *
 * It also runs under the claim call's OWN environment rather than this process's.
 * A bash call carrying `BEADS_DIR` writes the database that variable names, so a
 * stamp spawned with the process environment could address a different store than
 * the claim it is anchoring -- and would then queue on that other store's lock.
 */

const TIMEOUT_MS = 10_000;
/** Cheap prefilter: never spawn on a command that cannot be a claim. */
const PREFILTER = /\bbd\b[\s\S]{0,400}?--claim\b/;
const BD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
export type BdRun = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ exitCode: number; stdout: string; stderr?: string }> | { exitCode: number; stdout: string; stderr?: string };

let injectedRun: BdRun | null = null;

/** Replace the `bd` seam. Pass `null` to restore the real one. */
export function setBdRunForTests(fn: BdRun | null): void {
	injectedRun = fn;
}

/**
 * Bead ids that a completed claim reports as claimed by this actor. Read from
 * `bd`'s own output rather than from the command text, so quoting, wrappers and
 * heredocs are irrelevant.
 */
export function claimedIds(output: string): string[] {
	const ids = new Set<string>();
	for (const match of output.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
		const id = match[1];
		if (id && BD_ID.test(id)) ids.add(id);
	}
	for (const match of output.matchAll(/\b(?:Claimed|claimed)\s+([A-Za-z][A-Za-z0-9-]+)\b/g)) {
		const id = match[1];
		if (id && BD_ID.test(id)) ids.add(id);
	}
	return [...ids];
}

/**
 * Text emitted by the claim result, including stdout retained in structured
 * tool details when the rendered content was capped or spilled.
 */
function claimResultOutput(event: ToolResultEvent): string {
	const content = (event.content ?? [])
		.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
		.join("\n");
	const details = event.details;
	const stdout = details !== null && typeof details === "object" && "stdout" in details && typeof details.stdout === "string" ? details.stdout : "";
	return [content, stdout].filter(Boolean).join("\n");
}

export function anchorArgs(id: string, host: string, pid: number): string[] {
	return [
		"bd",
		"update",
		id,
		"--set-metadata",
		`lease_host=${host}`,
		"--set-metadata",
		`lease_pid=${pid}`,
	];
}

const pendingClaims = new Map<string, { cwd: string; env: NodeJS.ProcessEnv }>();

/** Record claim context from the shared parsed Bash dispatch. */
export function decideLeaseClaim(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext): void {
	try {
		if (event.toolName !== "bash") return;
		const command = parsed.command;
		if (!command || !PREFILTER.test(command)) return;
		const input = event.input as { cwd?: unknown };
		const sessionCwd = ctx?.cwd ?? process.cwd();
		const inputCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : sessionCwd;
		pendingClaims.set(event.toolCallId, { cwd: leadingCdCwd(command, inputCwd), env: environmentForInput(event.input) });
	} catch { /* fail closed at parser layer */ }
}

export default function bdLeaseGate(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event: ToolResultEvent) => {
		const claim = pendingClaims.get(event.toolCallId);
		if (claim === undefined) return;
		const { cwd, env } = claim;
		pendingClaims.delete(event.toolCallId);
		try {
			const text = claimResultOutput(event);
			if (event.isError || bashExitCode(event) !== 0) return;
			const ids = claimedIds(text);
			if (ids.length === 0) return;
			const run = injectedRun ?? defaultRun;
			const host = hostname().split(".")[0] ?? "localhost";
			const advisories: string[] = [];
			for (const id of ids) {
				const stamped = await withEmbeddedWriteLock(cwd, event.toolCallId, async () => {
					try {
						const result = await run(anchorArgs(id, host, process.pid), cwd, env);
						return result.exitCode === 0 ? undefined : stampFailure(id, `bd exited ${result.exitCode}`, result.stderr);
					} catch (error) { return stampFailure(id, "bd threw", error instanceof Error ? error.message : String(error)); }
				}, env);
				if (stamped.kind === "failed") advisories.push(stampFailure(id, "the embedded write lock refused the stamp", stamped.reason));
				else if (stamped.value !== undefined) advisories.push(stamped.value);
			}
			if (advisories.length === 0) return;
			return advisoryResult(event, advisories.join("\n"));
		} catch { return; }
	});
}

function bashExitCode(event: ToolResultEvent): number {
	const details = event.details;
	if (details !== null && typeof details === "object" && "exitCode" in details && typeof details.exitCode === "number") return details.exitCode;
	return event.isError ? 1 : 0;
}

function stampFailure(id: string, reason: string, detail?: string): string {
	const suffix = detail?.replace(/\s+/g, " ").trim();
	return `Beads lease stamp failed for ${id}: ${reason}${suffix ? ` (${suffix})` : ""}. Re-stamp with \`bd update ${id} --set-metadata lease_host=... lease_pid=...\`.`;
}

function advisoryResult(event: ToolResultEvent, text: string): { content: ToolResultEvent["content"] } {
	return { content: [{ type: "text", text: `${text}\n\n` }, ...(event.content ?? [])] };
}

/**
 * Spawn bd without blocking the event loop.
 *
 * The write lock this stamp runs inside renews its lease on an event-loop timer, and
 * `Bun.spawnSync` would block that timer for the whole command. Ten seconds is well
 * inside the lease, but the invariant worth keeping is simple rather than arithmetic:
 * no writer this plugin owns blocks the loop while holding the lock.
 */
async function defaultRun(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: TIMEOUT_MS,
		killSignal: "SIGKILL",
		env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { exitCode: (await proc.exited) ?? 1, stdout, stderr };
}
