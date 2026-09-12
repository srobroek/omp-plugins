import { hostname } from "node:os";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

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

export type BdRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string };

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
	const pending = new Set<string>();

	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input as { command?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			if (command && PREFILTER.test(command)) pending.add(event.toolCallId);
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		try {
			if (!pending.delete(event.toolCallId)) return;
			const text = (event.content ?? [])
				.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
				.join("\n");
			const ids = claimedIds(text);
			if (ids.length === 0) return;
			const run = injectedRun ?? defaultRun;
			const host = hostname().split(".")[0] ?? "localhost";
			for (const id of ids) run(anchorArgs(id, host, process.pid), process.cwd());
		} catch {
			return;
		}
	});
}

function defaultRun(argv: string[], cwd: string): { exitCode: number; stdout: string } {
	const proc = Bun.spawnSync(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: TIMEOUT_MS,
		env: { ...process.env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
	});
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}
