import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { commandSegments, invocation, type Token } from "./shell-command.ts";

/**
 * A PR that names neither a bead nor a reason is a PR nobody can trace back to a decision.
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
const NO_BEAD_REF = /(?:^|\s)No-Bead:\s*\S+/i;

/** Flags whose following token is a value, so a `--body` inside one is not the body. */
const VALUE_FLAGS: Record<string, true> = {
	"--title": true,
	"-t": true,
	"--base": true,
	"-B": true,
	"--head": true,
	"-H": true,
	"--repo": true,
	"-R": true,
	"--reviewer": true,
	"-r": true,
	"--assignee": true,
	"-a": true,
	"--label": true,
	"-l": true,
	"--project": true,
	"-p": true,
	"--milestone": true,
	"-m": true,
	"--body-file": true,
	"-F": true,
	"--template": true,
	"-T": true,
};

export const REASON =
	"This PR names no bead or reason for having none. Where beads is active, a PR and its beads point at each other: the body names what it implements, and each bead carries `pr` metadata, so a later session finds the decision without scanning GitHub history. Add a `Bead: <id>` line (several are fine) and stamp `bd update <id> --set-metadata pr=<n>` after creation, or state a truthful `No-Bead: <reason>` when no governing bead exists.";

export function beadsActive(dir: string): boolean {
	let current = resolve(dir);
	for (;;) {
		if (existsSync(join(current, ".beads"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * The `--body` value of one `gh pr create` segment: null when the segment
 * creates no PR, and null when it creates one whose body is not visible here
 * (`--fill`, `--body-file`, an editor session).
 */
export function bodyOfGhCreate(segment: string): string | null {
	const tokens = invocation(segment, ["gh", "pr", "create"]);
	if (!tokens) return null;
	let body: string | null = null;
	for (let i = 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		if (!token.quoted && token.value === "--") break;
		if (token.quoted) continue;
		if (VALUE_FLAGS[token.value]) {
			i++;
			continue;
		}
		if (token.value === "--body" || token.value === "-b") {
			body = tokens[i + 1]?.value ?? "";
			i++;
			continue;
		}
		if (token.value.startsWith("--body=")) {
			body = token.value.slice("--body=".length);
			continue;
		}
		// Short flags cluster, and `gh` accepts a value attached to the last one:
		// `-db'no bead'` is a draft whose body is `no bead`, not a bodyless call.
		const cluster = /^-([A-Za-z]*)b(=?)(.*)$/.exec(token.value);
		if (cluster && !token.value.startsWith("--")) {
			const attached = cluster[3] ?? "";
			body = attached.length > 0 || cluster[2] === "=" ? attached : (tokens[++i]?.value ?? "");
		}
	}
	return body;
}

export function decidePrCreate(
	body: string | null,
	active: boolean,
): { block: true; reason: string } | null {
	if (!active) return null;
	if (body === null) return null;
	if (BEAD_REF.test(body) || NO_BEAD_REF.test(body)) return null;
	return { block: true, reason: REASON };
}

/** Blocks when any `gh pr create` in the command carries neither a bead nor a truthful no-bead reason. */
export function decideCommand(
	command: string,
	active: boolean | ((segment: string) => boolean),
): { block: true; reason: string } | null {
	if (command.length > MAX_COMMAND_LENGTH) return null;
	for (const segment of commandSegments(command)) {
		const segmentActive = typeof active === "function" ? active(segment) : active;
		const decision = decidePrCreate(bodyOfGhCreate(segment), segmentActive);
		if (decision) return decision;
	}
	return null;
}

export function controlledByViewerPermission(permission: unknown): boolean {
	return permission === "WRITE" || permission === "MAINTAIN" || permission === "ADMIN";
}

export function repositoryFromGhCreate(command: string): string | null {
	const tokens = invocation(command, ["gh", "pr", "create"]);
	if (!tokens) return null;
	let selected: string | null = null;
	for (let i = 3; i < tokens.length; i += 1) {
		const token = tokens[i] as Token;
		const value = token.value;
		if (value === "--repo" || value === "-R") {
			const next = tokens[++i];
			selected = next?.value ?? null;
		} else if (value.startsWith("--repo=")) {
			selected = value.slice(7);
		} else if (value.startsWith("-R") && value.length > 2) {
			selected = value.slice(2);
		} else if (/^-[A-Za-z]*R.+$/.test(value) && value.length > 3) {
			selected = value.slice(value.indexOf("R") + 1);
		} else if (value.startsWith("-") && VALUE_FLAGS[value] === true) {
			i += 1;
		}
	}
	return selected && /^(?:[^/\s]+\/)?[^/\s]+\/[^/\s]+$/.test(selected) ? selected : null;
}

export type RepositoryView = { nameWithOwner?: unknown; isFork?: unknown; parent?: { nameWithOwner?: unknown } | null };

export function repositoryFromView(view: RepositoryView): string | null {
	if (typeof view.nameWithOwner !== "string") return null;
	if (view.isFork === true) return typeof view.parent?.nameWithOwner === "string" ? view.parent.nameWithOwner : null;
	if (view.isFork === false) return view.nameWithOwner;
	return null;
}

export function repositoryFromCurrentCheckout(cwd: string): string | null {
	try {
		const raw = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner,isFork,parent"], { cwd, encoding: "utf8" });
		return repositoryFromView(JSON.parse(raw) as RepositoryView);
	} catch { return null; }
}

export function repositoryControlled(repo: string | null): boolean {
	if (!repo) return false;
	try {
		const permission = execFileSync("gh", ["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"], { encoding: "utf8" }).trim();
		return controlledByViewerPermission(permission);
	} catch { return false; }
}

export default function prBeadLinkGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			const input = event.input as {
				command?: unknown;
				content?: unknown;
				path?: unknown;
				cwd?: unknown;
			};
			// The bash tool's own cwd, not this process's: a gate that reads
			// process.cwd() both blocks in the wrong repository and misses in the
			// right one.
			const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
			if (event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : null;
				if (!command?.includes("gh")) return;
				return decideCommand(command, (segment) => beadsActive(cwd) && repositoryControlled(repositoryFromGhCreate(segment) ?? repositoryFromCurrentCheckout(cwd))) ?? undefined;
			}
			if (event.toolName === "write") {
				const path = typeof input.path === "string" ? input.path : "";
				if (!path.startsWith("xd://github")) return;
				const content = typeof input.content === "string" ? input.content : "";
				if (!content) return;
				const args = JSON.parse(content) as { op?: string; body?: string; fill?: boolean; repo?: string };
				if (args.op !== "pr_create") return;
				// `fill: true` builds the body from commits, so it is not visible here;
				// anything else without a body is a bead-less body, not an unknown one.
				if (args.fill === true) return;
				const body = typeof args.body === "string" ? args.body : "";
				return decidePrCreate(body, beadsActive(cwd) && repositoryControlled(typeof args.repo === "string" ? args.repo : repositoryFromCurrentCheckout(cwd))) ?? undefined;
			}
		} catch {
			return;
		}
	});
}
