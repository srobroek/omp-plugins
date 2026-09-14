import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { commandSegments, invocation } from "./shell-command.ts";

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
 *
 * It also only fires for PRs against the repository that owns the bead store.
 * A bead id means nothing to an upstream project, so a PR opened from here at
 * another repository (`-R owner/repo`, or a fork head `owner:branch` against a
 * different owner) carries no bead line and is not refused for lacking one.
 */

const MAX_COMMAND_LENGTH = 64_000;
const BEAD_REF = /(?:^|\s)(?:Bead|Closes-Bead|Bead-Id):\s*[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+/i;
const NO_BEAD = /(?:^|\s)No-Bead:\s*\S/i;

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
	"This PR names no bead. Where beads is active, a PR and its beads point at each other: the body names what it implements, and each bead carries `pr` metadata, so a later session finds the decision without scanning GitHub history. Add a `Bead: <id>` line (several are fine) and stamp `bd update <id> --set-metadata pr=<n>` after creation. A PR that genuinely needs no bead carries `No-Bead: <reason>` instead.";

export function beadsActive(dir: string): boolean {
	return beadsRoot(dir) !== null;
}

/** The directory holding the active `.beads`, walking up from `dir`; null when none. */
export function beadsRoot(dir: string): string | null {
	let current = resolve(dir);
	for (;;) {
		if (existsSync(join(current, ".beads"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * `owner/repo`, lowercased, from any way GitHub spells a repository: a bare
 * slug, `host/owner/repo`, an https URL, or an ssh URL. Null when the text is
 * not a repository reference.
 */
export function repoSlug(ref: string): string | null {
	const text = ref.trim().replace(/\.git$/, "").replace(/\/+$/, "");
	const url = /^(?:https?:\/\/|ssh:\/\/|git@)[^/:]+[/:](.+)$/.exec(text);
	const path = url ? (url[1] ?? "") : text;
	const parts = path.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	const [owner, repo] = parts.slice(-2);
	if (!owner || !repo || /\s/.test(owner) || /\s/.test(repo)) return null;
	return `${owner}/${repo}`.toLowerCase();
}

const originCache = new Map<string, string | null>();

/** The `origin` remote of the checkout that owns the bead store, as a slug; null when unknown. */
export function beadsRepo(dir: string): string | null {
	const root = beadsRoot(dir);
	if (!root) return null;
	const cached = originCache.get(root);
	if (cached !== undefined) return cached;
	let slug: string | null = null;
	try {
		const result = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode === 0) slug = repoSlug(result.stdout.toString());
	} catch {
		slug = null;
	}
	originCache.set(root, slug);
	return slug;
}

/** What a PR creation targets: an explicit repository, or the owner of a fork head. */
export type PrTarget = { repo: string | null; headOwner: string | null };

/**
 * Whether a PR aimed at `target` lands in the repository that owns the bead
 * store. Unknown on either side keeps the gate on: a bead line costs nothing
 * in the home repository, while a wrong skip loses the pointer for good.
 */
export function targetsBeadsRepo(target: PrTarget, beadsSlug: string | null): boolean {
	if (!beadsSlug) return true;
	if (target.repo) {
		const slug = repoSlug(target.repo);
		return slug === null || slug === beadsSlug;
	}
	if (target.headOwner) return target.headOwner.toLowerCase() === beadsSlug.split("/")[0];
	return true;
}

/** The owner in a `--head owner:branch` value; null for a plain branch name. */
function headOwnerOf(head: string | undefined): string | null {
	if (!head) return null;
	const colon = head.indexOf(":");
	return colon > 0 ? head.slice(0, colon) : null;
}

export type GhCreate = { body: string | null; target: PrTarget };

/**
 * The `--body`, `--repo` and `--head` of one `gh pr create` segment: null when
 * the segment creates no PR. `body` is null when the PR's body is not visible
 * here (`--fill`, `--body-file`, an editor session).
 */
export function parseGhCreate(segment: string): GhCreate | null {
	const tokens = invocation(segment, ["gh", "pr", "create"]);
	if (!tokens) return null;
	let body: string | null = null;
	let repo: string | null = null;
	let head: string | undefined;
	for (let i = 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		if (!token.quoted && token.value === "--") break;
		if (token.quoted) continue;
		if (token.value === "--repo" || token.value === "-R") {
			repo = tokens[++i]?.value ?? null;
			continue;
		}
		if (token.value.startsWith("--repo=")) {
			repo = token.value.slice("--repo=".length);
			continue;
		}
		if (token.value === "--head" || token.value === "-H") {
			head = tokens[++i]?.value;
			continue;
		}
		if (token.value.startsWith("--head=")) {
			head = token.value.slice("--head=".length);
			continue;
		}
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
	return { body, target: { repo, headOwner: headOwnerOf(head) } };
}

/** The `--body` value of one `gh pr create` segment; see `parseGhCreate`. */
export function bodyOfGhCreate(segment: string): string | null {
	return parseGhCreate(segment)?.body ?? null;
}

export function decidePrCreate(
	body: string | null,
	active: boolean,
): { block: true; reason: string } | null {
	if (!active) return null;
	if (body === null) return null;
	if (BEAD_REF.test(body) || NO_BEAD.test(body)) return null;
	return { block: true, reason: REASON };
}

/**
 * Blocks when any `gh pr create` in the command carries a bead-less body and
 * targets the bead store's own repository (`beadsSlug`; null means unknown).
 */
export function decideCommand(
	command: string,
	active: boolean,
	beadsSlug: string | null = null,
): { block: true; reason: string } | null {
	if (command.length > MAX_COMMAND_LENGTH) return null;
	for (const segment of commandSegments(command)) {
		const create = parseGhCreate(segment);
		if (!create || !targetsBeadsRepo(create.target, beadsSlug)) continue;
		const decision = decidePrCreate(create.body, active);
		if (decision) return decision;
	}
	return null;
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
				const active = beadsActive(cwd);
				return decideCommand(command, active, active ? beadsRepo(cwd) : null) ?? undefined;
			}
			if (event.toolName === "write") {
				const path = typeof input.path === "string" ? input.path : "";
				if (!path.startsWith("xd://github")) return;
				const content = typeof input.content === "string" ? input.content : "";
				if (!content) return;
				const args = JSON.parse(content) as {
					op?: string;
					body?: string;
					fill?: boolean;
					repo?: string;
					head?: string;
				};
				if (args.op !== "pr_create") return;
				const active = beadsActive(cwd);
				const target: PrTarget = {
					repo: typeof args.repo === "string" ? args.repo : null,
					headOwner: headOwnerOf(typeof args.head === "string" ? args.head : undefined),
				};
				if (active && !targetsBeadsRepo(target, beadsRepo(cwd))) return;
				// `fill: true` builds the body from commits, so it is not visible here;
				// anything else without a body is a bead-less body, not an unknown one.
				if (args.fill === true) return;
				const body = typeof args.body === "string" ? args.body : "";
				return decidePrCreate(body, active) ?? undefined;
			}
		} catch {
			return;
		}
	});
}
