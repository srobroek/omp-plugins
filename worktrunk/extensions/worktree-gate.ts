/**
 * Refuse a mutation whose target is not physically inside a linked worktree of
 * this project.
 *
 * OMP native isolation is retired: every agent — root, lead, or child, whether
 * orchestrated or not — works in its own Worktrunk-created git linked worktree,
 * and the canonical checkout's working tree is never mutated by anyone. A
 * relative path or a defaulted `cwd` is all it takes to land a write in the
 * canonical checkout, because `task` cannot hand a child another cwd and OMP
 * resolves an omitted `bash` cwd to the session cwd.
 *
 * Enforcement is MEMBERSHIP-based, which is what makes "work in a worktree" a
 * contract rather than advice: a mutation is allowed only when its target is
 * inside a worktree that `git worktree list --porcelain` reports for THIS
 * repository and that is not the canonical root. `git worktree list --porcelain`
 * is the fast path used on every tool call; `wt list --format json` is
 * authoritative and richer but takes tens of seconds on a repository with many
 * worktrees, so it belongs at lifecycle time, never here.
 *
 * This is an accident guardrail, NOT a sandbox. Agents are cooperative. A
 * process whose cwd is a worktree can still write any absolute path through
 * `git -C <canonical>`, a shell redirection, or `eval`, and this module never
 * claims otherwise. It is worth having anyway because canonical is never a merge
 * target — landing merges a pull request and refreshes canonical with `git fetch`
 * alone — so no agent has a sanctioned reason to write there.
 *
 * Uncertainty refuses. Path inputs are derived with OMP's own normalization and
 * cwds with OMP's own `resolveToCwd`, never a second parser: a parser that
 * disagreed with the tool performing the write would guard a different file than
 * the one that changes.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import {
	hasGlobPathChars,
	isInternalUrlPath,
	isReadableUrlPath,
	normalizePathLikeInput,
	pathTargetsSsh,
	resolveToCwd,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { editInspect } from "@oh-my-pi/pi-natives";

/** Refusal shape the `tool_call` gate API understands. */
export interface GateRefusal {
	block: true;
	reason: string;
}

/**
 * Tools that only ever READ the filesystem. A read-only agent may read the
 * canonical checkout (the gate blocks mutation, not inspection), and these tools
 * routinely carry canonical paths in arguments and prose — a `task` brief, a
 * `hub` message, a `grep` root. Every other tool name, including an unenumerated
 * `xd://` device and any MCP tool, is treated as mutating: `toolName` is an
 * unrestricted string, so allow-by-omission is how a guardrail silently stops
 * guarding.
 */
const READ_ONLY_TOOLS: Record<string, true> = {
	ask: true,
	ast_grep: true,
	context_notes: true,
	debug: true,
	github: true,
	glob: true,
	goal: true,
	grep: true,
	hub: true,
	lsp: true,
	new_context: true,
	read: true,
	recall: true,
	reflect: true,
	security_scan: true,
	task: true,
	think: true,
	todo: true,
	web_search: true,
	yield: true,
};

/**
 * Argument keys that name a filesystem target on an unenumerated tool. A value
 * under one of these keys is checked even when it is relative, because a
 * relative path resolves against the session cwd — which for an agent that has
 * not yet moved into its worktree IS the canonical checkout.
 */
const PATH_KEYS: Record<string, true> = {
	cwd: true,
	dest: true,
	destination: true,
	dir: true,
	directory: true,
	file: true,
	file_path: true,
	filepath: true,
	files: true,
	out: true,
	outfile: true,
	output: true,
	output_path: true,
	output_root: true,
	path: true,
	paths: true,
	root: true,
	roots: true,
	source: true,
	sources: true,
	src: true,
	target: true,
	targets: true,
};

/** Depth bound on the recursive argument walk; deeper nesting is not a path argument. */
const MAX_SCAN_DEPTH = 6;

/**
 * A shell metacharacter makes a command more than the single simple command the
 * bootstrap allowlist reasons about. `$(` is listed explicitly; a bare `$` is
 * not, because the allowlisted shapes are matched token by token and a variable
 * cannot spell `--create` or an `omp/` branch name.
 */
const SHELL_METACHARACTERS = /[;&|`<>\n]|\$\(/;

/** Branch names an agent may create from the canonical checkout. */
const AGENT_BRANCH = /^omp\/[A-Za-z0-9._/-]+$/;

/** `wt switch pr:<N>` shorthand: a review worktree at a pull-request head. */
const PR_BRANCH = /^pr:\d+$/;

/** Edit payload wire modes whose target paths live in a single `input` string. */
const INPUT_EDIT_MODES = ["hashline", "sloppy", "apply_patch"] as const;

export const CREATE_HINT =
	"Claim your bead, then create your worktree with " +
	"`wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>`, " +
	"then work by absolute path under it (or pass `-C <worktree>` / `cwd: <worktree>`).";

export const SANDBOX_LIMIT =
	"This is an accident guardrail, not a sandbox: from a worktree cwd you can still " +
	"write any absolute path via `git -C <canonical>`, a redirection, or `eval`. " +
	"Canonical is never a merge target, so nothing legitimate writes there.";

/** The refusal a mutation outside every project worktree earns. */
export function containmentRefusal(target: string, canonical: string, worktrees: readonly string[]): string {
	const known =
		worktrees.length === 0
			? "This project currently has no linked worktree."
			: `Linked worktrees of this project: ${worktrees.join(", ")}.`;
	return (
		`worktrunk refused this call: it would mutate \`${target}\`, which is not inside a linked ` +
		`worktree of this project (canonical checkout: ${canonical}). ${known} ${CREATE_HINT} ${SANDBOX_LIMIT}`
	);
}

/** The refusal an unclassifiable payload earns. Uncertainty refuses. */
export function uncertaintyRefusal(what: string, canonical: string): string {
	return (
		`worktrunk refused this call: ${what}, so it cannot tell whether the mutation lands in the ` +
		`canonical checkout (${canonical}) or in a worktree. ${CREATE_HINT} ${SANDBOX_LIMIT}`
	);
}

/** The refusal a non-allowlisted command with a canonical effective cwd earns. */
export function bootstrapRefusal(command: string, canonical: string): string {
	return (
		`worktrunk refused this call: its effective working directory is the canonical checkout ` +
		`(${canonical}) and \`${command.split("\n")[0]}\` is not one of the bootstrap commands allowed there ` +
		`(\`wt switch\`/\`wt list\`/\`wt config show\`/\`wt step prune --dry-run\`, read-only \`git\`, and \`bd\`). ` +
		`${CREATE_HINT} ${SANDBOX_LIMIT}`
	);
}

/**
 * Realpath of the deepest EXISTING ancestor, with the missing tail reattached.
 *
 * Never a lexical prefix comparison: `write` writes the supplied path and an
 * archive write replaces the realpath'd physical file, so a symlink inside a
 * worktree pointing at the canonical checkout defeats every lexical check. Both
 * sides of a containment test go through here, so the comparison is between
 * physical identities.
 */
export function realDeepest(target: string): string | null {
	let current = path.resolve(target);
	const missing: string[] = [];
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return missing.length === 0 ? real : path.join(real, ...missing.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return null;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

/** True when `target` is physically inside (or equal to) one of `roots`. */
export function insideAny(target: string, roots: readonly string[]): boolean {
	const real = realDeepest(target);
	if (real === null) return false;
	for (const root of roots) {
		const realRoot = realDeepest(root);
		if (realRoot === null) continue;
		if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) return true;
	}
	return false;
}

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
	} catch {
		return null;
	}
}

/**
 * Absolute canonical root of the repository `cwd` belongs to: the directory
 * holding the common git directory. A linked worktree reports the canonical
 * checkout's `.git`, which is exactly the identity the gate needs. `null` when
 * `cwd` is in no repository at all.
 */
export function canonicalRoot(cwd: string): string | null {
	const out = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (out === null) return null;
	const commonDir = out.trim();
	if (commonDir.length === 0) return null;
	return realDeepest(path.dirname(commonDir));
}

/**
 * Linked, non-canonical worktrees of this repository, as physical paths.
 *
 * A bare or missing entry is skipped; the canonical root itself is excluded,
 * because it is the one place no agent may mutate.
 */
export function projectWorktrees(canonical: string): string[] {
	const out = git(canonical, ["worktree", "list", "--porcelain"]);
	if (out === null) return [];
	const realCanonical = realDeepest(canonical);
	const found: string[] = [];
	for (const line of out.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const real = realDeepest(line.slice("worktree ".length).trim());
		if (real === null || real === realCanonical) continue;
		found.push(real);
	}
	return found;
}

/** Project topology the decision runs against. Injectable so tests need no repository. */
export interface GateTopology {
	/** Canonical root, or `null` when the session is in no repository. */
	canonical: string | null;
	/** Cached non-canonical worktrees. */
	worktrees: readonly string[];
	/** Re-read the worktree list and return it. */
	refresh(): readonly string[];
}

const canonicalCache = new Map<string, string | null>();
const worktreeCache = new Map<string, string[]>();

/**
 * Forget the cached worktree list. Called when a worktree-creating command is
 * observed, so the very next check sees the new worktree rather than refusing
 * work in it.
 */
export function invalidateWorktreeCache(): void {
	worktreeCache.clear();
}

/** Forget every cached lookup. Tests and a repository change use this. */
export function resetTopologyCache(): void {
	canonicalCache.clear();
	worktreeCache.clear();
}

export function defaultTopology(sessionCwd: string): GateTopology {
	let canonical = canonicalCache.get(sessionCwd);
	if (canonical === undefined) {
		canonical = canonicalRoot(sessionCwd);
		canonicalCache.set(sessionCwd, canonical);
	}
	const root = canonical;
	if (root === null) return { canonical: null, worktrees: [], refresh: () => [] };
	const read = (): string[] => {
		const fresh = projectWorktrees(root);
		worktreeCache.set(root, fresh);
		return fresh;
	};
	return {
		canonical: root,
		get worktrees(): readonly string[] {
			return worktreeCache.get(root) ?? read();
		},
		refresh: read,
	};
}

/**
 * True when `target` is inside a project worktree, re-reading the worktree list
 * once before concluding it is not. A worktree created by a command this gate
 * never saw is otherwise a false refusal, and the re-read costs one `git` call
 * only on the path that was about to refuse.
 */
function contained(target: string, topology: GateTopology): boolean {
	if (insideAny(target, topology.worktrees)) return true;
	return insideAny(target, topology.refresh());
}

/**
 * The absolute filesystem path this argument names, or `null` when it names no
 * filesystem path at all (an internal URL, a web URL, an `ssh://` target, or an
 * unresolvable string). Resolution goes through OMP's own `resolveToCwd`, which
 * expands `~` — a hand-rolled `path.resolve` does not, and would guard the wrong
 * file for every `~`-spelled target.
 */
export function resolveTarget(raw: string, sessionCwd: string): string | null {
	const normalized = normalizePathLikeInput(unwrapHashlineHeaderPath(raw));
	if (normalized.length === 0) return null;
	if (isInternalUrlPath(normalized) || isReadableUrlPath(normalized) || pathTargetsSsh(normalized)) return null;
	try {
		return resolveToCwd(normalized, sessionCwd);
	} catch {
		return null;
	}
}

/** `xd://<tool>` device target, or `null`. */
function xdDeviceTool(raw: string): string | null {
	const normalized = normalizePathLikeInput(unwrapHashlineHeaderPath(raw));
	const match = /^xd:\/\/([^?#]+)/i.exec(normalized);
	const name = match?.[1]?.trim();
	return name === undefined || name.length === 0 ? null : name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The longest leading path segment run that contains no glob magic. */
export function globBase(pattern: string): string {
	if (!hasGlobPathChars(pattern)) return pattern;
	const segments = pattern.split("/");
	const plain: string[] = [];
	for (const segment of segments) {
		if (hasGlobPathChars(segment)) break;
		plain.push(segment);
	}
	const base = plain.join("/");
	return base.length === 0 ? "." : base;
}

/**
 * Target paths of an `edit` call, or `null` when the payload will not parse.
 *
 * The `input`-string modes are parsed with OMP's own `editInspect`, in mode
 * order, taking the first mode that yields any path: unioning every mode's
 * output would fold one parser's misreading of another mode's payload into the
 * result and refuse legitimate work.
 */
export function editTargets(input: unknown): string[] | null {
	const record = asRecord(input);
	if (record === null) return null;
	if (typeof record.path === "string") {
		const targets = [record.path];
		const edits = Array.isArray(record.edits) ? record.edits : [];
		for (const entry of edits) {
			const rename = asRecord(entry)?.rename;
			if (typeof rename === "string") targets.push(rename);
		}
		return targets;
	}
	if (typeof record.input !== "string") return null;
	const payload = JSON.stringify({ input: record.input });
	for (const mode of INPUT_EDIT_MODES) {
		let inspection: { paths: string[]; fileOps: { to?: string | null }[] };
		try {
			inspection = editInspect(mode, payload);
		} catch {
			continue;
		}
		if (inspection.paths.length === 0) continue;
		const targets = [...inspection.paths];
		for (const op of inspection.fileOps) {
			if (typeof op.to === "string" && op.to.length > 0) targets.push(op.to);
		}
		return targets;
	}
	return null;
}

/** Whitespace-split honouring quotes. `null` on an unbalanced quote. */
export function tokenize(command: string): string[] | null {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;
	for (const char of command) {
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}
	if (quote !== undefined) return null;
	if (started) tokens.push(current);
	return tokens;
}

/** Consume `wt`'s global options, returning the subcommand tokens. */
function afterWtGlobals(tokens: readonly string[]): string[] | null {
	const rest = [...tokens];
	for (;;) {
		const head = rest[0];
		if (head === undefined) return null;
		if (head === "-y" || head === "--yes" || head === "-v" || head === "--verbose") {
			rest.shift();
			continue;
		}
		if (head === "-C" || head === "--config" || head === "--config-set") {
			if (rest[1] === undefined) return null;
			rest.splice(0, 2);
			continue;
		}
		return rest;
	}
}

/** Consume `git`'s global options, returning the subcommand tokens. */
function afterGitGlobals(tokens: readonly string[]): string[] | null {
	const rest = [...tokens];
	for (;;) {
		const head = rest[0];
		if (head === undefined) return null;
		if (head === "--no-pager" || head === "--no-replace-objects") {
			rest.shift();
			continue;
		}
		if (head === "-C" || head === "-c") {
			if (rest[1] === undefined) return null;
			rest.splice(0, 2);
			continue;
		}
		return rest;
	}
}

function wtSwitchAllowed(args: readonly string[]): boolean {
	let yes = false;
	let create = false;
	let noCd = false;
	let formatJson = false;
	let base: string | undefined;
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (token === undefined) return false;
		switch (token) {
			case "-y":
			case "--yes":
				yes = true;
				continue;
			case "-c":
			case "--create":
				create = true;
				continue;
			case "--no-cd":
				noCd = true;
				continue;
			case "--base":
			case "-b": {
				base = args[++index];
				if (base === undefined) return false;
				continue;
			}
			case "--format": {
				if (args[++index] !== "json") return false;
				formatJson = true;
				continue;
			}
			default:
				if (token.startsWith("-")) return false;
				positionals.push(token);
		}
	}
	if (!yes || !noCd || !formatJson || positionals.length !== 1) return false;
	const branch = positionals[0] as string;
	if (create) return AGENT_BRANCH.test(branch) && base !== undefined;
	return PR_BRANCH.test(branch);
}

/**
 * True when this command is one an agent must be able to run from the canonical
 * checkout, because its first action necessarily starts there: `task` cannot
 * hand a child another cwd, so bootstrapping a worktree, reading git state, and
 * reaching the embedded Beads store in canonical `.beads` all happen from there.
 *
 * The list is closed. Any token outside a matched shape refuses.
 */
export function bootstrapAllowed(command: string): boolean {
	if (SHELL_METACHARACTERS.test(command)) return false;
	const tokens = tokenize(command);
	if (tokens === null) return false;
	const program = tokens[0];
	if (program === undefined) return false;
	const rest = tokens.slice(1);
	if (program === "bd") return true;
	if (program === "wt") {
		const args = afterWtGlobals(rest);
		if (args === null) return false;
		const sub = args[0];
		const tail = args.slice(1);
		if (sub === "switch") return wtSwitchAllowed(tail);
		if (sub === "list") return tail.length === 0 || (tail.length === 2 && tail[0] === "--format" && tail[1] === "json");
		if (sub === "config") return tail.length === 1 && tail[0] === "show";
		if (sub === "step") return tail.length === 2 && tail[0] === "prune" && tail[1] === "--dry-run";
		return false;
	}
	if (program === "git") {
		const args = afterGitGlobals(rest);
		if (args === null) return false;
		const sub = args[0];
		if (sub === "rev-parse" || sub === "status" || sub === "fetch" || sub === "log") return true;
		if (sub === "worktree") return args[1] === "list";
		if (sub === "branch") return args[1] === "--list";
		return false;
	}
	return false;
}

/** True when the command creates a worktree, so the cached list is stale. */
export function createsWorktree(command: string): boolean {
	return /\bwt\s+(?:[^\n]*\s)?(?:switch|new)\b[^\n]*(?:--create|\s-c\b)|\bgit\s+(?:[^\n]*\s)?worktree\s+add\b/.test(
		command,
	);
}

/** The bash call's command string, whatever spelling the input uses. */
export function extractCommand(input: unknown): string {
	const record = asRecord(input);
	const command = record?.command;
	return typeof command === "string" ? command : "";
}

/** Every string in `input` that names a filesystem path on an unenumerated tool. */
export function scanPathArguments(input: unknown, depth = 0): string[] {
	if (depth > MAX_SCAN_DEPTH) return [];
	if (Array.isArray(input)) {
		return input.flatMap(entry => scanPathArguments(entry, depth + 1));
	}
	const record = asRecord(input);
	if (record === null) return [];
	const found: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === "string") {
			const normalized = normalizePathLikeInput(value);
			if (normalized.length === 0) continue;
			if (PATH_KEYS[key] === true || path.isAbsolute(normalized) || normalized.startsWith("~/")) {
				found.push(normalized);
			}
			continue;
		}
		if (PATH_KEYS[key] === true && Array.isArray(value)) {
			for (const entry of value) if (typeof entry === "string") found.push(entry);
			continue;
		}
		found.push(...scanPathArguments(value, depth + 1));
	}
	return found;
}

/**
 * The refusal this tool call earns, or `undefined` when it may run.
 *
 * The gate is inert when the session is in no git repository: there is no
 * project to protect and no worktree anyone could be asked to occupy. Inside a
 * project, every mutation must land in a non-canonical worktree of it, and
 * anything the gate cannot classify refuses.
 */
export function decideWorktreeCall(
	toolName: string,
	input: unknown,
	sessionCwd: string,
	topology: GateTopology = defaultTopology(sessionCwd),
): GateRefusal | undefined {
	const canonical = topology.canonical;
	if (canonical === null) return undefined;
	if (READ_ONLY_TOOLS[toolName] === true) return undefined;

	const refuseTarget = (target: string): GateRefusal | undefined =>
		contained(target, topology)
			? undefined
			: {
					block: true,
					// The physical target, so it is comparable with the realpath'd roots
					// beside it: `/tmp` vs `/private/tmp` otherwise reads as a bug.
					reason: containmentRefusal(realDeepest(target) ?? target, canonical, topology.worktrees),
				};

	const refuseAll = (raws: readonly string[]): GateRefusal | undefined => {
		for (const raw of raws) {
			const target = resolveTarget(raw, sessionCwd);
			if (target === null) continue;
			const refusal = refuseTarget(target);
			if (refusal) return refusal;
		}
		return undefined;
	};

	switch (toolName) {
		case "write": {
			const record = asRecord(input);
			if (record === null || typeof record.path !== "string") {
				return { block: true, reason: uncertaintyRefusal("this `write` call has no `path` string", canonical) };
			}
			const device = xdDeviceTool(record.path);
			if (device !== null) {
				// A device call carries the real arguments in `content`; classify it by
				// the device's own rule. A payload that is not JSON names no path and
				// the device rejects it before anything is written.
				if (typeof record.content !== "string") return undefined;
				let nested: unknown;
				try {
					nested = JSON.parse(record.content);
				} catch {
					return undefined;
				}
				return decideWorktreeCall(device, nested, sessionCwd, topology);
			}
			return refuseAll([record.path]);
		}
		case "edit": {
			const targets = editTargets(input);
			if (targets === null) {
				return {
					block: true,
					reason: uncertaintyRefusal("this `edit` payload names no parseable `[PATH#TAG]` target", canonical),
				};
			}
			return refuseAll(targets);
		}
		case "ast_edit": {
			const record = asRecord(input);
			const paths = record?.paths;
			if (!Array.isArray(paths) || paths.length === 0) {
				return { block: true, reason: uncertaintyRefusal("this `ast_edit` call names no `paths`", canonical) };
			}
			const bases: string[] = [];
			for (const entry of paths) {
				if (typeof entry !== "string") {
					return { block: true, reason: uncertaintyRefusal("an `ast_edit` path is not a string", canonical) };
				}
				bases.push(globBase(normalizePathLikeInput(entry)));
			}
			return refuseAll(bases);
		}
		case "bash": {
			const record = asRecord(input);
			const rawCwd = record?.cwd;
			const effective =
				typeof rawCwd === "string" && rawCwd.length > 0 ? resolveTarget(rawCwd, sessionCwd) : sessionCwd;
			if (effective === null) {
				return { block: true, reason: uncertaintyRefusal("this `bash` call's `cwd` does not resolve", canonical) };
			}
			if (contained(effective, topology)) return undefined;
			const command = extractCommand(input);
			if (command.length === 0) {
				return { block: true, reason: uncertaintyRefusal("this `bash` call has no `command` string", canonical) };
			}
			if (bootstrapAllowed(command)) return undefined;
			return { block: true, reason: bootstrapRefusal(command, canonical) };
		}
		case "eval": {
			const record = asRecord(input);
			const rawCwd = record?.cwd;
			const effective =
				typeof rawCwd === "string" && rawCwd.length > 0 ? resolveTarget(rawCwd, sessionCwd) : sessionCwd;
			if (effective === null) {
				return { block: true, reason: uncertaintyRefusal("this `eval` call's `cwd` does not resolve", canonical) };
			}
			return refuseTarget(effective);
		}
		default:
			return refuseAll(scanPathArguments(input));
	}
}

export default function worktreeGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		const sessionCwd = ctx?.cwd ?? process.cwd();
		try {
			if (event.toolName === "bash" && createsWorktree(extractCommand(event.input))) invalidateWorktreeCache();
			return decideWorktreeCall(event.toolName, event.input, sessionCwd);
		} catch (error) {
			const canonical = canonicalCache.get(sessionCwd) ?? null;
			if (canonical === null) return undefined;
			return {
				block: true,
				reason: uncertaintyRefusal(
					`this call could not be classified (${error instanceof Error ? error.message : String(error)})`,
					canonical,
				),
			};
		}
	});
}
