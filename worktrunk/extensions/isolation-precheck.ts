/**
 * Refuse to let work start under OMP native isolation.
 *
 * Native isolation copies the whole checkout with a filesystem clone (`apfs`,
 * `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy`) —
 * there is no git-worktree backend, so it cannot be reconfigured into the
 * worktree model, only turned off. A cloned checkout carries its own copy of
 * `.beads`, and an embedded Dolt database that has been copied is a second
 * ledger: claims, comments and closures written in the clone are invisible to
 * every sibling and are discarded with the clone.
 *
 * This is the whole package. It is a gate rather than a rule because the failure
 * is silent and unrecoverable: nothing surfaces a forked ledger, and the work
 * written into it cannot be recovered after the clone is removed. It is also the
 * narrowest possible gate — one structural test on one argument of one tool, with
 * no filesystem access, no subprocess, no git, and no settings read — so it
 * cannot time out, cannot refuse an unrelated call, and cannot take a session
 * down. Native isolation has no legitimate use against an embedded ledger, so a
 * refusal here never blocks correct work.
 *
 * Canonical-checkout containment is deliberately NOT here. It is steering, in
 * `worktrunk-worktree-required`: a stray write lands in the lead's own checkout,
 * where `git status`, review and the diff all surface it, and it is recoverable.
 */
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

export const ISOLATION_REFUSAL =
	"worktrunk refused this `task` call: it requests `isolated: true`. OMP native isolation clones the " +
	"checkout, and a cloned `.beads` forks the ledger into a second database whose claims and closures no " +
	"sibling can see, discarded with the clone. Set `task.isolation.enabled: false` in " +
	"`~/.omp/agent/config.yml`, verify with `omp config get task.isolation.enabled --json`, and give each " +
	"agent a git linked worktree instead: " +
	"`wt switch -y --create --no-cd --base <base-commit> --format json <branch>`.";

/** True when this `task` payload asks for an isolated child, in either wire shape. */
export function requestsIsolation(input: unknown): boolean {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const record = input as Record<string, unknown>;
	if (record.isolated === true) return true;
	const tasks = record.tasks;
	if (!Array.isArray(tasks)) return false;
	return tasks.some(
		entry => entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).isolated === true,
	);
}

export default function isolationPrecheck(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "task") return undefined;
		return requestsIsolation(event.input) ? { block: true, reason: ISOLATION_REFUSAL } : undefined;
	});
}
