import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { commandInvocations, type GitInvocation, isAssignmentOverride, isReleaseRepository, parseGitInvocation } from "./lib.ts";

const GIT_TIMEOUT_MS = 2_000;
const COMMIT_HEADER = /^(?:feat|fix|perf|revert|refactor|chore|docs|test|ci|build|style)(?:\([^)\r\n]+\))?!?: \S.*$/;
/** `git push` options that consume the next argv word when not written as `--opt=value`. */
const PUSH_VALUE_OPTIONS = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
/** `git push` options that take no separate value; `--opt=value` forms are accepted by name. */
const PUSH_FLAG_OPTIONS = new Set([
	"-u", "--set-upstream", "--no-set-upstream", "--force", "-f", "--force-with-lease", "--no-force-with-lease",
	"--force-if-includes", "--no-force-if-includes", "--porcelain", "--quiet", "-q", "--verbose", "-v",
	"--atomic", "--no-atomic", "--thin", "--no-thin", "--follow-tags", "--no-follow-tags", "--prune",
	"--no-verify", "--verify", "--recurse-submodules", "--no-recurse-submodules", "--signed", "--no-signed",
	"--progress", "--no-progress", "-4", "-6", "--ipv4", "--ipv6",
]);

type Decision = { block: true; reason: string } | undefined;
type GitRunner = (args: readonly string[], cwd: string) => string | null;
type ReadMessage = (path: string) => string | null;

function runGit(args: readonly string[], cwd: string): string | null {
	try {
		const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
		return result.exitCode === 0 ? result.stdout.toString() : null;
	} catch { return null; }
}

function readMessage(path: string): string | null {
	try { return readFileSync(path, "utf8"); } catch { return null; }
}

function conventional(subject: string): boolean {
	return COMMIT_HEADER.test(subject.trim());
}

function commitText(args: readonly string[], cwd: string, read: ReadMessage): { text?: string; uncertain: boolean } {
	let inline: string | undefined;
	let file: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "-m" || arg === "--message") {
			const value = args[++i];
			if (value === undefined) return { uncertain: true };
			if (inline === undefined) inline = value;
			continue;
		}
		if (arg.startsWith("--message=")) { if (inline === undefined) inline = arg.slice("--message=".length); continue; }
		if (arg === "-F" || arg === "--file") {
			const value = args[++i];
			if (value === undefined) return { uncertain: true };
			file = value;
			continue;
		}
		if (arg.startsWith("--file=")) file = arg.slice("--file=".length);
	}
	if (inline !== undefined) return { text: inline, uncertain: false };
	if (file !== undefined) {
		const contents = read(resolve(cwd, file));
		return contents === null ? { uncertain: true } : { text: contents, uncertain: false };
	}
	// Editor-supplied messages have no observable subject here, so they are allowed.
	return { uncertain: false };
}

function subjectOf(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*#/.test(line)) continue;
		if (line.trim()) return line.trim();
	}
	return undefined;
}

function decideCommit(parsed: GitInvocation, read: ReadMessage, override: boolean): Decision {
	if (parsed.subcommand !== "commit" || override) return;
	const message = commitText(parsed.args, parsed.cwd, read);
	if (message.uncertain || message.text === undefined) return;
	const subject = subjectOf(message.text);
	if (!subject || /^(?:fixup|squash)!\s/.test(subject) || /^Merge\s/.test(subject) || /^Revert\s/.test(subject)) return;
	if (conventional(subject)) return;
	return { block: true, reason: "Use a Conventional Commit subject such as `feat(scope): summary`, or set TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT=1 to override." };
}

type ParsedPush = { dryRun: boolean; deleting: boolean; tagOnly: boolean; allBranches: boolean; refspecs: string[]; certain: boolean };

function parsePush(args: readonly string[]): ParsedPush {
	const result: ParsedPush = { dryRun: false, deleting: false, tagOnly: false, allBranches: false, refspecs: [], certain: true };
	let remoteSeen = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") continue;
		if (arg === "--dry-run" || arg === "-n") { result.dryRun = true; continue; }
		if (arg === "--delete" || arg === "-d") { result.deleting = true; continue; }
		if (arg === "--tags") { result.tagOnly = true; continue; }
		// --all and --mirror push every local branch, main/master included.
		if (arg === "--all" || arg === "--branches" || arg === "--mirror") { result.allBranches = true; continue; }
		if (arg.startsWith("-")) {
			const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
			if (PUSH_VALUE_OPTIONS.has(name)) {
				if (!arg.includes("=")) {
					if (args[i + 1] === undefined) return { ...result, certain: false };
					i++;
				}
				continue;
			}
			if (PUSH_FLAG_OPTIONS.has(name)) continue;
			return { ...result, certain: false };
		}
		const looksLikeRefspec = arg.includes(":") || arg.startsWith("refs/heads/") || arg.startsWith("refs/tags/");
		if (!remoteSeen && result.refspecs.length === 0 && !looksLikeRefspec) { remoteSeen = true; continue; }
		result.refspecs.push(arg);
	}
	if (!(result.tagOnly && result.refspecs.length === 0)) result.tagOnly = false;
	return result;
}

function destination(refspec: string): { branch?: string; deleting: boolean; tag: boolean } | undefined {
	const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec;
	if (!spec || spec.startsWith("-") || spec.includes("*") || spec.includes("?") || spec.includes("[")) return undefined;
	if (!spec.includes(":")) {
		if (spec.startsWith("refs/tags/")) return { deleting: false, tag: true };
		return { branch: spec.startsWith("refs/heads/") ? spec.slice("refs/heads/".length) : spec, deleting: false, tag: false };
	}
	const colon = spec.indexOf(":");
	if (colon === 0) return { deleting: true, tag: false };
	const dst = spec.slice(colon + 1);
	if (!dst) return { deleting: true, tag: false };
	if (dst.startsWith("refs/tags/")) return { deleting: false, tag: true };
	return { branch: dst.startsWith("refs/heads/") ? dst.slice("refs/heads/".length) : dst, deleting: false, tag: false };
}

function decidePush(parsed: GitInvocation, git: GitRunner, override: boolean): Decision {
	if (parsed.subcommand !== "push" || override) return;
	const push = parsePush(parsed.args);
	if (!push.certain || push.dryRun || push.deleting || push.tagOnly) return;
	let targetsMain = false;
	const isMain = (branch: string) => branch === "main" || branch === "master";
	const currentBranch = () => git(["branch", "--show-current"], parsed.cwd)?.trim() || undefined;
	if (push.allBranches) {
		targetsMain = true;
	} else if (push.refspecs.length === 0) {
		const branch = currentBranch();
		if (!branch) return;
		targetsMain = isMain(branch);
	} else {
		for (const refspec of push.refspecs) {
			const dest = destination(refspec);
			if (!dest) return;
			if (dest.deleting || dest.tag) continue;
			// A bare `HEAD` or `@` refspec pushes the current branch to its same-named remote branch.
			const branch = dest.branch === "HEAD" || dest.branch === "@" ? currentBranch() : dest.branch;
			if (!branch) return;
			if (isMain(branch)) targetsMain = true;
		}
	}
	if (!targetsMain) return;
	return { block: true, reason: "Do not push directly to main/master; push to a branch and open an MR (or set TRUNK_DEV_ALLOW_MAIN_PUSH=1 to override)." };
}

export type CommitGateOptions = {
	git?: GitRunner;
	readFile?: ReadMessage;
	exists?: (path: string) => boolean;
	processEnv?: Readonly<Record<string, string | undefined>>;
};

/** Pure decision seam for Conventional Commit subjects and direct main/master pushes, applied only in release repositories. */
export function decideCommitGate(command: string, cwd: string, options: CommitGateOptions = {}): Decision {
	try {
		const git = options.git ?? runGit;
		const read = options.readFile ?? readMessage;
		const env = options.processEnv ?? process.env;
		for (const invocation of commandInvocations(command, cwd)) {
			const parsed = parseGitInvocation(invocation);
			if (!parsed) continue;
			if (parsed.subcommand !== "commit" && parsed.subcommand !== "push") continue;
			if (!isReleaseRepository(parsed.cwd, { git, exists: options.exists, readFile: read })) continue;
			const decision = parsed.subcommand === "commit"
				? decideCommit(parsed, read, isAssignmentOverride(invocation, "TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT", env))
				: decidePush(parsed, git, isAssignmentOverride(invocation, "TRUNK_DEV_ALLOW_MAIN_PUSH", env));
			if (decision) return decision;
		}
		return undefined;
	} catch { return undefined; }
}

function toolCwd(input: Record<string, unknown>, sessionCwd: string): string {
	return typeof input.cwd === "string" && input.cwd ? resolve(sessionCwd, input.cwd) : sessionCwd;
}

export default function trunkDevCommitGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input as Record<string, unknown>;
			if (typeof input.command !== "string" || !/\b(?:git|dgit)\b/.test(input.command)) return;
			const env = input.env !== null && typeof input.env === "object" ? input.env as Record<string, string> : undefined;
			const decision = decideCommitGate(input.command, toolCwd(input, ctx.cwd), { processEnv: { ...process.env, ...env } });
			if (decision) return decision;
		} catch { /* Defense in depth: uncertain command parsing allows the tool. */ }
	});
}
