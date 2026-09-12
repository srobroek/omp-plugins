import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * A PR that names no bead is a PR nobody can trace back to a decision.
 *
 * The pointer has to exist at creation, because that is the only moment the
 * author knows which beads the branch implements; a later audit finds a merged
 * PR and an orphan bead. So `gh pr create` and the `github` device's `pr_create`
 * are refused when the body names neither a bead nor a reason for having none.
 *
 * Refusing, not injecting: rewriting the body would have to guess the bead from
 * a lease the agent may not hold, or from several it does, and a wrong pointer
 * outlives the PR. The gate only fires where beads is active, so a repository
 * without `.beads/` is untouched, and bot-authored release and dependency PRs
 * never reach a tool call in the first place.
 */

const MAX_COMMAND_LENGTH = 64_000;
const BEAD_REF = /(?:^|\s)(?:Bead|Closes-Bead|Bead-Id):\s*[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+/i;
const NO_BEAD = /(?:^|\s)No-Bead:\s*\S/i;
const PR_CREATE = /(^|[\s;&|(])gh\s+pr\s+create\b/;

export const REASON =
	"This PR names no bead. Where beads is active, a PR and its beads point at each other: the body names what it implements, and each bead carries `pr` metadata, so a later session finds the decision without scanning GitHub history. Add a `Bead: <id>` line (several are fine) and stamp `bd update <id> --set-metadata pr=<n>` after creation. A PR that genuinely needs no bead carries `No-Bead: <reason>` instead.";

export function beadsActive(dir: string): boolean {
	let current = resolve(dir);
	for (;;) {
		if (existsSync(join(current, ".beads"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export function decidePrCreate(
	body: string | null,
	active: boolean,
): { block: true; reason: string } | null {
	if (!active) return null;
	// No body at all is `gh pr create --fill` or an editor session: the body is
	// not visible here, so blocking would refuse a call whose content is unknown.
	if (body === null) return null;
	if (BEAD_REF.test(body) || NO_BEAD.test(body)) return null;
	return { block: true, reason: REASON };
}

/** The `--body`/`-b` value of a `gh pr create`, or null when it carries none. */
export function bodyOfGhCreate(command: string): string | null {
	if (!PR_CREATE.test(command)) return null;
	const flag = /(?:--body|(?<![\w-])-b)(?:[= ]|\s+)('([^']*)'|"([^"]*)"|(\S+))/;
	const match = flag.exec(command);
	if (!match) return null;
	return match[2] ?? match[3] ?? match[4] ?? "";
}

export default function prBeadLinkGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			const input = event.input as {
				command?: unknown;
				content?: unknown;
				path?: unknown;
			};
			if (event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				if (!command || command.length > MAX_COMMAND_LENGTH) return;
				if (!PR_CREATE.test(command)) return;
				const decision = decidePrCreate(
					bodyOfGhCreate(command),
					beadsActive(process.cwd()),
				);
				return decision ?? undefined;
			}
			if (event.toolName === "write") {
				const path = typeof input.path === "string" ? input.path : "";
				if (!path.startsWith("xd://github")) return;
				const content = typeof input.content === "string" ? input.content : "";
				if (!content) return;
				const args = JSON.parse(content) as { op?: string; body?: string };
				if (args.op !== "pr_create") return;
				const decision = decidePrCreate(
					typeof args.body === "string" ? args.body : null,
					beadsActive(process.cwd()),
				);
				return decision ?? undefined;
			}
		} catch {
			return;
		}
	});
}
