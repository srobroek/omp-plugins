import type { ExtensionAPI, InputEvent, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { commandWords } from "./command-words.ts";
import { tokenizeShell } from "./shell-tokenizer.ts";
import { EDIT_TOOLS, targetPaths } from "./tool-targets.ts";

/** Dependency manifests. Lowercased basenames; macOS filesystems fold case. */
const MANIFESTS: Record<string, true> = {
	"package.json": true, "cargo.toml": true, "pyproject.toml": true,
	"go.mod": true, "go.sum": true, "requirements.txt": true,
	"composer.json": true, "gemfile": true, "pipfile": true,
	"package-lock.json": true, "npm-shrinkwrap.json": true, "pnpm-lock.yaml": true,
};

/** Any `*.lock` (uv, Cargo, poetry, yarn) plus bun's `bun.lock`/`bun.lockb`. */
const LOCKFILE = /\.lock$|^bun\.lock/;

/** Separator tokens from `tokenizeShell`; `&&`/`||` arrive as two tokens each. */
const SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "$(": true };
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true };
/** Package runners that run the package binary named after their own options (`npx ncu -u`). */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx"]);
/** Package-runner options that take the next word (`npx -p npm-check-updates ncu -u`). */
const PACKAGE_RUNNER_VALUE_FLAGS: ReadonlySet<string> = new Set(["-p", "--package"]);
/** Package-manager options that take a value before the subcommand (`npm --prefix /repo install`). */
const PM_VALUE_FLAGS: Record<string, true> = {
	"--prefix": true, "-C": true, "--dir": true, "--cwd": true, "--filter": true, "-F": true, "-w": true,
	"--workspace": true, "--registry": true, "--cache": true, "--userconfig": true, "--directory": true,
	"--project": true, "--config-file": true, "--cache-dir": true,
};
// Maps and Sets, not object literals: a word such as `constructor` or `toString` must
// not resolve to an inherited member and read as a package manager or a subcommand.
const NPM_INSTALL: ReadonlySet<string> = new Set([
	"i", "in", "ins", "inst", "insta", "instal", "install", "isnt", "isnta",
	"isntal", "isntall", "add", "ci", "clean-install", "ic", "install-clean",
	"it", "install-test", "cit", "install-ci-test", "update", "up", "upgrade", "udpate",
]);
/** Subcommands that install, add, or move a version, per package manager. */
const MUTATING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["npm", NPM_INSTALL],
	["pnpm", new Set(["i", "install", "add", "update", "up", "upgrade", "it", "install-test"])],
	["bun", new Set(["i", "install", "add", "update", "up", "upgrade"])],
	["yarn", new Set(["install", "add", "up", "upgrade", "upgrade-interactive", "update"])],
	["pip", new Set(["install"])],
	["uv", new Set(["add", "sync"])],
	["poetry", new Set(["add", "update", "install"])],
	["cargo", new Set(["add", "install", "update"])],
	["go", new Set(["get"])],
	["bundle", new Set(["install", "update", "add"])],
	["bundler", new Set(["install", "update", "add"])],
	["gem", new Set(["install", "update"])],
	["composer", new Set(["require", "update", "upgrade", "install"])],
]);
/** Subcommands that run another command (`pnpm dlx ncu -u`). */
const RUNNERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["npm", new Set(["exec", "x"])],
	["pnpm", new Set(["dlx", "exec"])],
	["yarn", new Set(["dlx", "exec"])],
	["bun", new Set(["x"])],
]);
/** Nested `bash -c` / substitution depth past which the gate stops reading and blocks. */
const MAX_DEPTH = 8;

function subcommand(args: string[]): [string | undefined, number] {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (!arg.startsWith("-")) return [arg, i];
		if (Object.hasOwn(PM_VALUE_FLAGS, arg)) i++;
	}
	return [undefined, args.length];
}

/** The command a package runner runs: the words after its own options. */
function packageRunnerCommand(args: string[]): string[] {
	let i = 0;
	while (args[i]?.startsWith("-")) i += PACKAGE_RUNNER_VALUE_FLAGS.has(args[i] as string) ? 2 : 1;
	return args.slice(i);
}

/** Whether one simple command (its words, separators removed) installs or moves a dependency. */
function simpleCommandMutates(words: string[], depth: number): boolean {
	if (depth > MAX_DEPTH) return true;
	const [first, ...rest] = commandWords(words).argv;
	if (first === undefined) return false;
	const name = first.slice(first.lastIndexOf("/") + 1).toLowerCase();
	if (PACKAGE_RUNNERS.has(name)) return simpleCommandMutates(packageRunnerCommand(rest), depth + 1);
	if (Object.hasOwn(SHELLS, name)) {
		const flag = rest.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
		const script = flag === -1 ? undefined : rest[flag + 1];
		return script !== undefined && commandMutates(script, depth + 1);
	}
	// `--help` prints usage and changes nothing (`uv add --help`).
	if (rest.some((arg) => arg === "--help" || arg === "-h")) return false;
	if (name === "ncu" || name === "npm-check-updates") return rest.some((arg) => arg === "-u" || arg === "--upgrade");
	if (/^python\d*(?:\.\d+)*$/.test(name)) {
		const module = rest.indexOf("-m");
		return module !== -1 && rest[module + 1] === "pip" && subcommand(rest.slice(module + 2))[0] === "install";
	}
	const pm = /^pip\d*(?:\.\d+)*$/.test(name) ? "pip" : name;
	const table = MUTATING.get(pm);
	if (table === undefined) return false;
	const [sub, at] = subcommand(rest);
	const after = rest.slice(at + 1);
	// Bare `yarn` installs.
	if (sub === undefined) return pm === "yarn" && !rest.some((arg) => arg === "--version" || arg === "-v");
	if (RUNNERS.get(pm)?.has(sub)) return simpleCommandMutates(after, depth + 1);
	if (pm === "uv" && sub === "pip") {
		const [inner] = subcommand(after);
		return inner === "install" || inner === "sync";
	}
	if (pm === "uv" && sub === "lock") {
		return after.some((arg) => arg === "-U" || arg === "--upgrade" || arg === "-P" || arg.startsWith("--upgrade-package"));
	}
	return table.has(sub);
}

/**
 * Whether a bash command installs, adds, or moves a dependency. Words are read
 * quote-aware at command position only, so `echo "npm install"` is data while
 * `cd repo && npm i` is a command. Here-document bodies count only for their
 * substitutions. Backtick and `$( … )` substitutions are read wherever they appear,
 * including inside quotes (a single-quoted one is over-matched: the gate blocks).
 */
export function commandMutates(command: string, depth = 0): boolean {
	if (depth > MAX_DEPTH) return true;
	let words: string[] = [];
	for (const token of tokenizeShell(command, { hereDocumentSubstitutionsOnly: true })) {
		if (token.sawQuote || !Object.hasOwn(SEPARATORS, token.value)) {
			words.push(token.value);
			continue;
		}
		if (simpleCommandMutates(words, depth)) return true;
		words = [];
	}
	if (simpleCommandMutates(words, depth)) return true;
	for (const match of command.matchAll(/`([^`]*)`|\$\(([^()]*)\)/g)) {
		if (commandMutates(match[1] ?? match[2] ?? "", depth + 1)) return true;
	}
	return false;
}

const SKILL_READ = /^skill:\/\/whats-new(?:\/|$)|whats-new\/SKILL\.md/i;
const HANDOVER_READ = /^skill:\/\/dep-update(?:\/|$)|dep-update\/SKILL\.md/i;

export const DENY_REASON =
	"blocked by whats-new (research-only): this session loaded the whats-new skill, which reports what changed " +
	"between two versions and changes nothing itself. Do not edit dependency manifests or lockfiles and do not " +
	"run installers or upgrade commands while researching -- the finding belongs in the report. If the user " +
	"actually wants the upgrade applied, that is dep-update's job: read `skill://dep-update` and run its " +
	"dep_scan/dep_apply confirm loop (reading it releases this gate, not the per-bump approval).";

/** Armed for the rest of the session once the skill is loaded. */
export interface GateState {
	armed: boolean;
}

export function createState(): GateState {
	return { armed: false };
}

/** Reading the skill body -- or any of its references -- starts a research pass. */
export function armsGate(raw: string): boolean {
	return SKILL_READ.test(raw.replaceAll("\\", "/").trim());
}

/**
 * `/skill:<name>` input embeds the skill body directly, with no `read` call, so the
 * submitted text is the only signal for that path.
 */
export function decideInput(state: GateState, text: string): void {
	const command = text.trimStart().split(/\s/, 1)[0];
	if (command === "/skill:dep-update") state.armed = false;
	else if (command === "/skill:whats-new") state.armed = true;
}

/** dep-update owns real upgrades, so loading it hands the session over. */
export function disarmsGate(raw: string): boolean {
	return HANDOVER_READ.test(raw.replaceAll("\\", "/").trim());
}

export function isDependencyFile(raw: string): boolean {
	const path = raw.replaceAll("\\", "/").trim();
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	return Object.hasOwn(MANIFESTS, name) || LOCKFILE.test(name);
}

export function decideToolCall(
	state: GateState,
	toolName: string,
	input: ToolCallEvent["input"],
): { block: true; reason: string } | undefined {
	if (toolName === "read") {
		for (const path of targetPaths(input)) {
			if (disarmsGate(path)) state.armed = false;
			else if (armsGate(path)) state.armed = true;
		}
		return;
	}
	if (!state.armed) return;
	if (toolName === "dep_apply") return { block: true, reason: DENY_REASON };
	if (EDIT_TOOLS.has(toolName)) {
		if (targetPaths(input).some(isDependencyFile)) return { block: true, reason: DENY_REASON };
		return;
	}
	if (toolName === "bash") {
		const command = "command" in input ? input.command : undefined;
		if (typeof command === "string" && commandMutates(command)) {
			return { block: true, reason: DENY_REASON };
		}
	}
	return;
}

export default function reportOnlyGate(pi: ExtensionAPI): void {
	// Closure state, not module state: one arming must not leak from the session
	// that researched into a sibling session sharing this process.
	const state = createState();

	pi.on("session_start", () => {
		state.armed = false;
	});

	pi.on("input", (event: InputEvent) => {
		decideInput(state, event.text);
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			return decideToolCall(state, event.toolName, event.input);
		} catch {
			return;
		}
	});
}
