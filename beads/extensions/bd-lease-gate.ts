import { hostname } from "node:os";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { commandSegments, invocation } from "./shell-command.ts";

/**
 * A claim is a lease, and a lease has a holder you can check.
 *
 * `bd` records ownership as an assignee string and nothing else, so a session
 * that crashes leaves a claim no one can distinguish from live work. Staleness
 * is the usual guess, and it is wrong in both directions: an agent deep in an
 * implementation touches no bead for an hour, while a crashed session looks busy
 * for a day.
 *
 * So `bd update --claim` gets stamped with the holder's host and pid, taken from
 * this process rather than the shell's `$$` (which is the bash child, dead the
 * moment the command returns). A later session reads those anchors and proves
 * the holder gone with `kill -0`.
 *
 * Only `bd update` is stamped: `bd ready --claim` rejects `--set-metadata`
 * ("unknown flag"), so stamping it would break a supported claiming path.
 * rule://beads-core requires the follow-up `bd update` there. Nothing here
 * blocks; the refusal this enables needs bead metadata only the agent has read.
 */

const MAX_COMMAND_LENGTH = 64_000;
const ALREADY_STAMPED = /--set-metadata[= ]\s*lease_(?:host|pid)=/;

export function stampLease(
	command: string,
	host: string,
	pid: number,
): string | null {
	if (command.length > MAX_COMMAND_LENGTH) return null;
	const anchors = ` --set-metadata lease_host=${host} --set-metadata lease_pid=${pid}`;
	// Every claiming invocation in the chain, not just the first: `bd update a
	// --claim && bd update b --claim` must leave both beads with lease anchors.
	let stamped = false;
	const out = commandSegments(command).map((segment) => {
		const tokens = invocation(segment, ["bd", "update"]);
		if (!tokens) return segment;
		if (!tokens.some((token) => !token.quoted && token.value === "--claim")) return segment;
		if (ALREADY_STAMPED.test(segment)) return segment;
		stamped = true;
		const body = segment.trimEnd();
		return body + anchors + segment.slice(body.length);
	});
	return stamped ? out.join("") : null;
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
