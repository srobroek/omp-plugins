import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { commandSegments, invocation, type Token } from "./shell-command.ts";

/**
 * A PR that names no bead is a PR nobody can trace back to a decision.
 *
 * A live ledger requires a Bead, Closes-Bead, or Bead-Id trailer.
 * A regular-file .beads/RETIRED marker opts out the nearest ledger.
 * No-Bead: is not accepted; this marker belongs to the gate, not bd.
 */

const MAX_COMMAND_LENGTH = 64_000;
const BEAD_REF = /(?:^|\s)(?:Bead|Closes-Bead|Bead-Id):\s*[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+/i;


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
	"This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer. To opt out, retire the nearest ledger with this gate's regular-file .beads/RETIRED marker; No-Bead: is not accepted.";

export function beadsActive(dir: string): boolean {
	let current = resolve(dir);
	for (;;) {
		const beads = join(current, ".beads");
		if (existsSync(beads)) {
			try { return !statSync(join(beads, "RETIRED")).isFile(); } catch { return true; }
		}
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

export type RepositoryControl =
	| { kind: "controlled" }
	| { kind: "uncontrolled" }
	| { kind: "unknown"; reason: string };

export function decidePrCreate(
	body: string | null,
	active: boolean | RepositoryControl,
): { block: true; reason: string } | null {
	if (active === false || (typeof active !== "boolean" && active.kind === "uncontrolled")) return null;
	if (body === null) return null;
	if (BEAD_REF.test(body)) return null;
	if (typeof active !== "boolean" && active.kind === "unknown") {
		return {
			block: true,
			reason: `${active.reason}. This PR must name a bead while repository control is unknown.`,
		};
	}
	return { block: true, reason: REASON };
}

/** Blocks when any `gh pr create` in the command carries neither a bead nor a truthful no-bead reason. */
export function decideCommand(
	command: string,
	active: boolean | RepositoryControl | ((segment: string) => boolean | RepositoryControl),
): { block: true; reason: string } | null {
	if (command.length > MAX_COMMAND_LENGTH) return null;
	for (const segment of commandSegments(command)) {
		const segmentActive = typeof active === "function" ? active(segment) : active;
		const decision = decidePrCreate(bodyOfGhCreate(segment), segmentActive);
		if (decision) return decision;
	}
	return null;
}

/**
 * The permission lookup deliberately fails closed: today's catch silently passed, but
 * a bead-linkage gate is safer when an unreadable repository requires operator action.
 */
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


export function repositoryControlled(repo: string | null): RepositoryControl {
	if (!repo) return { kind: "unknown", reason: "Repository permission could not be determined because the repository could not be identified" };
	try {
		const permission = execFileSync("gh", ["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"], { encoding: "utf8" }).trim();
		return controlledByViewerPermission(permission) ? { kind: "controlled" } : { kind: "uncontrolled" };
	} catch (error) {
		const failure = error instanceof Error ? error.message : String(error);
		return { kind: "unknown", reason: `Repository permission could not be determined: ${failure}` };
	}
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
