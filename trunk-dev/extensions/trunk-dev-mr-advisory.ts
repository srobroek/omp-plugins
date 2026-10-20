import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { commandInvocations, type Invocation, isReleaseRepository, parseGitInvocation } from "./lib.ts";

const GIT_TIMEOUT_MS = 2_000;
const CONVENTIONAL_TITLE = /^[a-z]+(?:\([^)\r\n]+\))?!?: .+$/;
const FLAG_LINE = /^Flag:\s*\S/m;
const NO_FLAG_LINE = /^Flag:\s*none\b/im;
const DAY_MS = 24 * 60 * 60 * 1000;

type GitRunner = (args: readonly string[], cwd: string) => string | null;
type ReadText = (path: string) => string | null;

function runGit(args: readonly string[], cwd: string): string | null {
	try {
		const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
		return result.exitCode === 0 ? result.stdout.toString() : null;
	} catch {
		return null;
	}
}

function readText(path: string): string | null {
	try { return readFileSync(path, "utf8"); } catch { return null; }
}

function exists(path: string): boolean {
	try { return existsSync(path); } catch { return false; }
}

function titleParts(title: string): { type: string; breaking: boolean } | undefined {
	const match = /^([a-z]+)(?:\([^)\r\n]+\))?(!)?: /.exec(title);
	return match ? { type: match[1] as string, breaking: Boolean(match[2]) } : undefined;
}

function titleNeedsFlag(title: string): boolean {
	const parts = titleParts(title);
	return parts !== undefined && (parts.type === "feat" || parts.breaking);
}

type OptionValue = { value?: string; fromFile: boolean; missing: boolean };

function optionValue(args: readonly string[], names: ReadonlySet<string>): OptionValue {
	let value: string | undefined;
	let fromFile = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (names.has(arg)) {
			const next = args[++i];
			if (next === undefined) return { value, fromFile, missing: true };
			value = next;
			fromFile = next.startsWith("@") || next === "-";
			continue;
		}
		for (const name of names) {
			if (!arg.startsWith(`${name}=`)) continue;
			value = arg.slice(name.length + 1);
			fromFile = value.startsWith("@") || value === "-";
			break;
		}
	}
	return { value, fromFile, missing: false };
}

function forgeCommand(invocation: Invocation): { kind: "create" | "merge"; args: readonly string[]; cwd: string } | undefined {
	const { argv } = invocation;
	if (argv[0] === "glab" && argv[1] === "mr" && (argv[2] === "create" || argv[2] === "merge")) {
		return { kind: argv[2], args: argv.slice(3), cwd: invocation.cwd };
	}
	if (argv[0] === "gh" && argv[1] === "pr" && (argv[2] === "create" || argv[2] === "merge")) {
		return { kind: argv[2], args: argv.slice(3), cwd: invocation.cwd };
	}
	return undefined;
}

function defaultBranch(cwd: string, git: GitRunner): string | undefined {
	const originHead = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd)?.trim();
	if (originHead?.startsWith("origin/")) return originHead;
	for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
		if (git(["rev-parse", "--verify", candidate], cwd) !== null) return candidate;
	}
	return undefined;
}

function branchPushAge(cwd: string, git: GitRunner, now: number): string | undefined {
	const head = git(["rev-parse", "--verify", "HEAD"], cwd)?.trim();
	const base = defaultBranch(cwd, git);
	if (!head || !base) return undefined;
	const mergeBase = git(["merge-base", head, base], cwd)?.trim();
	if (!mergeBase) return undefined;
	const commitTime = git(["show", "-s", "--format=%ct", mergeBase], cwd)?.trim();
	if (!commitTime || !/^\d+$/.test(commitTime)) return undefined;
	const age = now - Number(commitTime) * 1000;
	if (age <= 2 * DAY_MS) return undefined;
	return `This topic branch is based on a commit ${Math.floor(age / DAY_MS)} days old; keep branches short-lived (about 2 days) and open an MR with required CI.`;
}

function pushHasBranchRef(args: readonly string[]): boolean | undefined {
	const refs: string[] = [];
	let remoteSeen = false;
	for (const arg of args) {
		if (arg.startsWith("-")) continue;
		if (!remoteSeen && !arg.includes(":") && !arg.startsWith("refs/heads/") && !arg.startsWith("refs/tags/")) {
			remoteSeen = true;
			continue;
		}
		refs.push(arg);
	}
	if (refs.length === 0) return true;
	for (const refspec of refs) {
		const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec;
		if (!spec || /[*?[]/.test(spec)) return undefined;
		if (spec.startsWith("refs/tags/")) continue;
		const colon = spec.indexOf(":");
		const src = colon < 0 ? spec : spec.slice(0, colon);
		const dst = colon < 0 ? src : spec.slice(colon + 1);
		if (src.startsWith("refs/tags/") || dst.startsWith("refs/tags/")) continue;
		if (dst) return true;
	}
	return false;
}

export type AdvisoryOptions = {
	git?: GitRunner;
	readFile?: ReadText;
	exists?: (path: string) => boolean;
	now?: number;
};

/** Return concise advisories for the command; parsing and probe failures are always silent. */
export function decideMrAdvisory(command: string, cwd: string, options: AdvisoryOptions = {}): string[] {
	try {
		const git = options.git ?? runGit;
		const read = options.readFile ?? readText;
		const fileExists = options.exists ?? exists;
		const now = options.now ?? Date.now();
		const advisories: string[] = [];
		for (const invocation of commandInvocations(command, cwd)) {
			const forge = forgeCommand(invocation);
			if (forge?.kind === "create") {
				const title = optionValue(forge.args, new Set(["--title", "-t"]));
				if (title.value !== undefined && !title.fromFile && !CONVENTIONAL_TITLE.test(title.value)) {
					advisories.push("trunk-dev: MR/PR titles should use Conventional Commits, e.g. `feat(scope): summary`.");
				}
				const body = optionValue(forge.args, new Set(["--description", "--body", "-d", "-b"]));
				if (title.value !== undefined && titleNeedsFlag(title.value)) {
					const isFeature = titleParts(title.value)?.type === "feat";
					if (body.fromFile || body.value === undefined || body.missing) {
						advisories.push(isFeature
							? "trunk-dev: every `feat` MR/PR ships behind a feature flag; add a `Flag: <name> (default off; owner <alias>; remove by YYYY-MM-DD)` line, and review file/editor-provided text manually."
							: "trunk-dev: add a `Flag:` decision line to the MR/PR description (or `Flag: none — reason`); review file/editor-provided text manually.");
					} else if (!FLAG_LINE.test(body.value)) {
						advisories.push(isFeature
							? "trunk-dev: every `feat` MR/PR ships behind a feature flag; add a `Flag: <name> (default off; owner <alias>; remove by YYYY-MM-DD)` line."
							: "trunk-dev: this breaking MR/PR needs a `Flag:` decision line in its description (for example `Flag: none — reason`).");
					} else if (isFeature && NO_FLAG_LINE.test(body.value)) {
						advisories.push("trunk-dev: `Flag: none` is only for non-feature changes; gate this `feat` behind a default-off flag, or retype the change truthfully (`fix`, `refactor`, `chore`).");
					}
				}
			}
			if (forge?.kind === "merge" && !forge.args.some((arg) => arg === "--squash" || arg === "-s")) {
				if (isReleaseRepository(forge.cwd, { git, exists: fileExists, readFile: read })) {
					advisories.push("trunk-dev: squash-merge this MR/PR so its Conventional Commit title is the release unit (`--squash`).");
				}
			}
			const gitCommand = parseGitInvocation(invocation);
			if (gitCommand?.subcommand === "push") {
				const args = gitCommand.args;
				if (args.some((arg) => ["--dry-run", "-n", "--delete", "-d", "--tags", "--all", "--mirror"].includes(arg))) continue;
				const hasBranch = pushHasBranchRef(args);
				if (hasBranch) {
					const age = branchPushAge(gitCommand.cwd, git, now);
					if (age) advisories.push(`trunk-dev: ${age}`);
				}
			}
		}
		return [...new Set(advisories)];
	} catch {
		return [];
	}
}

function toolCwd(input: Record<string, unknown>, sessionCwd: string): string {
	return typeof input.cwd === "string" && input.cwd ? resolve(sessionCwd, input.cwd) : sessionCwd;
}

export default function trunkDevMrAdvisory(pi: ExtensionAPI): void {
	const pending = new Map<string, string[]>();
	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		try {
			if (event.toolName !== "bash") return;
			const input = event.input as Record<string, unknown>;
			if (typeof input.command !== "string") return;
			const hints = decideMrAdvisory(input.command, toolCwd(input, ctx.cwd));
			if (hints.length > 0) pending.set(event.toolCallId, hints);
		} catch {
			// Advisories must never interrupt tool execution.
		}
	});
	pi.on("tool_result", (event: ToolResultEvent) => {
		try {
			const hints = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			if (!hints || event.isError === true) return;
			return { additionalContext: hints.join(" ") };
		} catch {
			return;
		}
	});
}
