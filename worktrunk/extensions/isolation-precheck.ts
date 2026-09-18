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
 * Two halves, because one is not enough. `session_start` reports the setting so
 * the remedy is stated before any work is attempted; the `task` gate is the
 * enforceable half, because the setting can be re-enabled at any point after a
 * session starts and a start-time check would never see it.
 */
import type { ExtensionAPI, SessionStartEvent, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";

export const ISOLATION_REMEDY =
	"OMP native isolation is retired: it clones the checkout, and a cloned `.beads` forks the ledger into " +
	"a second database whose claims and closures no sibling can see. Set `task.isolation.enabled: false` " +
	"under `task.isolation` in `~/.omp/agent/config.yml`, verify with " +
	"`omp config get task.isolation.enabled --json`, and give each agent a git linked worktree instead " +
	"(`wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>`).";

export const ISOLATION_REFUSAL = `worktrunk refused this \`task\` call: it requests \`isolated: true\`. ${ISOLATION_REMEDY}`;

export const ISOLATION_ADVISORY = `\`task.isolation.enabled\` is **true** in this session. ${ISOLATION_REMEDY}`;

/** True when this `task` payload asks for an isolated child, in either wire shape. */
export function requestsIsolation(input: unknown): boolean {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const record = input as Record<string, unknown>;
	if (record.isolated === true) return true;
	const tasks = record.tasks;
	if (!Array.isArray(tasks)) return false;
	return tasks.some(
		entry =>
			entry !== null &&
			typeof entry === "object" &&
			!Array.isArray(entry) &&
			(entry as Record<string, unknown>).isolated === true,
	);
}

/** Whether native isolation is on. Unreadable settings count as off: the `task` gate still refuses. */
export function isolationEnabled(): boolean {
	try {
		return settings.get("task.isolation.enabled") === true;
	} catch {
		return false;
	}
}

export default function isolationPrecheck(pi: ExtensionAPI): void {
	pi.on("session_start", (_event: SessionStartEvent) => {
		if (!isolationEnabled()) return;
		// A message rather than a UI notification: the agent is the one that must
		// stop spawning isolated children, and a notification reaches neither it
		// nor a `--print` session.
		pi.sendMessage(
			{
				customType: "com.srobroek.worktrunk.isolation-precheck",
				content: ISOLATION_ADVISORY,
				display: true,
				attribution: "user",
			},
			{ triggerTurn: false },
		);
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "task") return undefined;
		return requestsIsolation(event.input) ? { block: true, reason: ISOLATION_REFUSAL } : undefined;
	});
}
