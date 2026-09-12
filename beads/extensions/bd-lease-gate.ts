import { hostname } from "node:os";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";


/**
 * A claim is a lease, and a lease has a holder you can check.
 *
 * `bd` records ownership as an assignee string and nothing else, so a session
 * that crashes leaves a claim no one can distinguish from live work. Staleness
 * is the usual guess, and it is wrong in both directions: an agent deep in an
 * implementation touches no bead for an hour, while a crashed session looks busy
 * for a day.
 *
 * So `--claim` gets stamped with the holder's host and pid, taken from this
 * process rather than the shell's `$$` (which is the bash child, dead the moment
 * the command returns). A later session reads those anchors and proves the
 * holder gone with `kill -0`. Nothing here blocks: stamping is all this gate
 * does, and the refusal it enables lives in rule://beads-core, because deciding
 * a lease is dead needs the bead's metadata that only the agent has read.
 */

const MAX_COMMAND_LENGTH = 64_000;
const CLAIM = /(^|[\s;&|(])bd\s+(?:update|ready)\s+[^;&|]*--claim\b/;
const ALREADY_STAMPED = /--set-metadata[= ]\s*lease_(?:host|pid)=/;

export function stampLease(
	command: string,
	host: string,
	pid: number,
): string | null {
	if (command.length > MAX_COMMAND_LENGTH) return null;
	if (ALREADY_STAMPED.test(command)) return null;
	// Append to the claiming invocation, not the end of a chain: `bd update x
	// --claim && bd comment ...` must not stamp the comment.
	const match = CLAIM.exec(command);
	if (!match) return null;
	const anchors = ` --set-metadata lease_host=${host} --set-metadata lease_pid=${pid}`;
	const start = match.index + (match[1]?.length ?? 0);
	const rest = command.slice(start);
	const end = rest.search(/[;&|]|$/);
	const invocation = rest.slice(0, end).trimEnd();
	const trailing = rest.slice(invocation.length);
	return command.slice(0, start) + invocation + anchors + trailing;
}

export default function bdLeaseGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input as { command?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			if (!command) return;
			const host = hostname().split(".")[0] ?? "localhost";
			const stamped = stampLease(command, host, process.pid);
			if (!stamped) return;
			return { input: { ...event.input, command: stamped } };
		} catch {
			return;
		}
	});
}
