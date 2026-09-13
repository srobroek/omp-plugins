import { hostname } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

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
 */

const TIMEOUT_MS = 10_000;
/** Cheap prefilter: never spawn on a command that cannot be a claim. */
const PREFILTER = /\bbd\b[\s\S]{0,400}?--claim\b/;
const BD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

export type BdRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string; stderr?: string };

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

export default function bdLeaseGate(pi: ExtensionAPI): void {
	const pending = new Map<string, string>();

	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input as { command?: unknown; cwd?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			if (!command || !PREFILTER.test(command)) return;
			const sessionCwd = ctx?.cwd ?? process.cwd();
			const inputCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : sessionCwd;
			pending.set(event.toolCallId, leadingCdCwd(command, inputCwd));
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		const cwd = pending.get(event.toolCallId);
		if (cwd === undefined) return;
		pending.delete(event.toolCallId);
		try {
			const text = (event.content ?? [])
				.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
				.join("\n");
			const ids = claimedIds(text);
			if (ids.length === 0) {
				if (!event.isError && bashExitCode(event) === 0) {
					return advisoryResult(event, "Beads lease gate saw a successful claim but could not parse a bead id; inspect the claim and re-stamp it with `bd update <id> --set-metadata lease_host=... lease_pid=...`.");
				}
				return;
			}
			const run = injectedRun ?? defaultRun;
			const host = hostname().split(".")[0] ?? "localhost";
			const advisories: string[] = [];
			for (const id of ids) {
				try {
					const result = run(anchorArgs(id, host, process.pid), cwd);
					if (result.exitCode !== 0) advisories.push(stampFailure(id, `bd exited ${result.exitCode}`, result.stderr));
				} catch (error) {
					advisories.push(stampFailure(id, "bd threw", error instanceof Error ? error.message : String(error)));
				}
			}
			if (advisories.length === 0) return;
			return advisoryResult(event, advisories.join("\n"));
		} catch {
			return;
		}
	});
}

/** Resolve only a literal leading `cd <path> &&`; shell expansions and wrappers stay unresolved. */
function leadingCdCwd(command: string, cwd: string): string {
	const match = /^\s*cd\s+([^\s;&]+)\s*&&/.exec(command);
	if (!match) return cwd;
	const dir = match[1];
	if (dir === undefined || /^[-~$]/.test(dir) || /[\\`"'*?\[\]{}]/.test(dir)) return cwd;
	return dir.startsWith("/") ? dir : resolve(cwd, dir);
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

function defaultRun(argv: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: TIMEOUT_MS,
		env: { ...process.env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
	});
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}
