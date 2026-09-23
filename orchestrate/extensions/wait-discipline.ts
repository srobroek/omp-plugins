/**
 * Refuse an untargeted `hub wait`.
 *
 * Ending a turn is free waiting. A dispatched agent's result auto-delivers, and a peer's
 * `hub send` arrives as steering that wakes the lead. A `wait` therefore buys a lead
 * nothing it would not receive anyway, and each one costs a full turn that re-reads the
 * lead's entire context.
 *
 * Measured across two graded arms of the same project (lead turn ~$0.067, mean lead
 * context 202,258 tokens):
 *   - 89 lead waits, of which 55 (61.8%) returned nothing usable: 29 waited on agents
 *     that had ALREADY finished, 19 ran with no running jobs at all, 7 returned
 *     "Still Running".
 *   - The 34 remaining were 24 peer messages and 10 job completions, both of which
 *     wake the lead or auto-deliver without a wait.
 *   - 77 of the 89 were untargeted, and 64 of those sat inside a run of two or more
 *     consecutive waits with no intervening action.
 * Total ~$5.96 of lead turns bought no information.
 *
 * This is a gate rather than steering because the failure is invisible: every wait
 * returns successfully, so nothing signals that the turn was wasted, and the cost only
 * appears in aggregate afterwards.
 *
 * It is deliberately the narrowest possible gate. One structural test on the arguments
 * of one tool: no filesystem access, no subprocess, no settings read, no cross-call
 * state. So it cannot time out, cannot refuse an unrelated call, and cannot take a
 * session down.
 *
 * A TARGETED wait is allowed through. `ids` names the job and `from` names the peer, so
 * such a wait expresses a specific dependency rather than a poll. The steering rule
 * `orchestrate-process` governs whether even those are warranted.
 */
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

export const WAIT_REFUSAL =
	"orchestrate refused this `hub wait`: it names neither `ids` nor `from`, so it is a poll. " +
	"Subagent results auto-deliver and a peer's `hub send` wakes you, so ending your turn is free " +
	"waiting and a wait is a paid turn that re-reads your whole context. Measured in a graded arm: " +
	"55 of 89 lead waits returned nothing usable, 29 of them waiting on agents that had already " +
	"finished. Do the next useful thing instead — review a returned result, update the ledger, " +
	"integrate a delivered branch, dispatch the next independent bead, or answer a peer — and if " +
	"nothing remains, END YOUR TURN. When you genuinely depend on one specific thing, wait for that " +
	"thing: `ids` for a job, or `from` for a peer.";

/** True when this `hub` payload is a wait that names neither a job nor a peer. */
export function isUntargetedWait(input: unknown): boolean {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const record = input as Record<string, unknown>;
	if (record.op !== "wait") return false;
	const ids = record.ids;
	if (Array.isArray(ids) && ids.length > 0) return false;
	const from = record.from;
	if (typeof from === "string" && from.trim() !== "") return false;
	return true;
}

export default function waitDiscipline(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "hub") return undefined;
		return isUntargetedWait(event.input) ? { block: true, reason: WAIT_REFUSAL } : undefined;
	});
}
