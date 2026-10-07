import type { ExtensionAPI, InputEvent, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { tokenizeShell } from "./shell-tokenizer";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

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
/** Words that run the following words as the command. */
const PASSTHROUGH: Record<string, true> = {
	sudo: true, env: true, time: true, nohup: true, nice: true, command: true, exec: true, "--": true, npx: true, bunx: true,
};
/** Wrapper flags that consume the next word (`sudo -u user`, `nice -n 5`). */
const PASSTHROUGH_VALUE_FLAGS: Record<string, true> = { "-u": true, "-g": true, "-n": true, "-C": true };
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Package-manager options that take a value before the subcommand (`npm --prefix /repo install`). */
const PM_VALUE_FLAGS: Record<string, true> = {
	"--prefix": true, "-C": true, "--dir": true, "--cwd": true, "--filter": true, "-F": true, "-w": true,
	"--workspace": true, "--registry": true, "--cache": true, "--userconfig": true, "--directory": true,
	"--project": true, "--config-file": true, "--cache-dir": true,
};
const NPM_INSTALL: Record<string, true> = {
	i: true, in: true, ins: true, inst: true, insta: true, instal: true, install: true, isnt: true, isnta: true,
	isntal: true, isntall: true, add: true, ci: true, "clean-install": true, ic: true, "install-clean": true,
	it: true, "install-test": true, cit: true, "install-ci-test": true, update: true, up: true, upgrade: true, udpate: true,
};
/** Subcommands that install, add, or move a version, per package manager. */
const MUTATING: Record<string, Record<string, true>> = {
	npm: NPM_INSTALL,
	pnpm: { i: true, install: true, add: true, update: true, up: true, upgrade: true, it: true, "install-test": true },
	bun: { i: true, install: true, add: true, update: true, up: true, upgrade: true },
	yarn: { install: true, add: true, up: true, upgrade: true, "upgrade-interactive": true, update: true },
	pip: { install: true },
	uv: { add: true, sync: true },
	poetry: { add: true, update: true, install: true },
	cargo: { add: true, install: true, update: true },
	go: { get: true },
	bundle: { install: true, update: true, add: true },
	bundler: { install: true, update: true, add: true },
	gem: { install: true, update: true },
	composer: { require: true, update: true, upgrade: true, install: true },
};
/** Subcommands that run another command (`pnpm dlx ncu -u`). */
const RUNNERS: Record<string, Record<string, true>> = {
	npm: { exec: true, x: true }, pnpm: { dlx: true, exec: true }, yarn: { dlx: true, exec: true }, bun: { x: true },
};
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

/** Whether one simple command (its words, separators removed) installs or moves a dependency. */
function simpleCommandMutates(words: string[], depth: number): boolean {
	if (depth > MAX_DEPTH) return true;
	let i = 0;
	while (i < words.length) {
		const word = words[i] as string;
		if (ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (!Object.hasOwn(PASSTHROUGH, word.slice(word.lastIndexOf("/") + 1))) break;
		// `command -v yarn` looks a name up; it does not run it.
		if (word === "command" && (words[i + 1] === "-v" || words[i + 1] === "-V")) return false;
		i++;
		while (words[i]?.startsWith("-") && words[i] !== "--") {
			if (Object.hasOwn(PASSTHROUGH_VALUE_FLAGS, words[i] as string)) i++;
			i++;
		}
	}
	const first = words[i];
	if (first === undefined) return false;
	const name = first.slice(first.lastIndexOf("/") + 1).toLowerCase();
	const rest = words.slice(i + 1);
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
	const table = MUTATING[pm];
	if (!table) return false;
	const [sub, at] = subcommand(rest);
	const after = rest.slice(at + 1);
	// Bare `yarn` installs.
	if (sub === undefined) return pm === "yarn" && !rest.some((arg) => arg === "--version" || arg === "-v");
	if (RUNNERS[pm]?.[sub]) return simpleCommandMutates(after, depth + 1);
	if (pm === "uv" && sub === "pip") {
		const [inner] = subcommand(after);
		return inner === "install" || inner === "sync";
	}
	if (pm === "uv" && sub === "lock") {
		return after.some((arg) => arg === "-U" || arg === "--upgrade" || arg === "-P" || arg.startsWith("--upgrade-package"));
	}
	return Object.hasOwn(table, sub);
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

/**
 * Every path this call would write. Hashline `edit` carries no `path` when a
 * patch spans several files, so the derived `paths` array is the only complete
 * target list and both shapes must be read.
 */
export function targetPaths(input: ToolCallEvent["input"]): string[] {
	const out: string[] = [];
	// `in` narrows one literal key at a time, so the two spellings stay unrolled.
	if ("path" in input && typeof input.path === "string" && input.path.length > 0) {
		out.push(input.path);
	}
	if ("file_path" in input && typeof input.file_path === "string" && input.file_path.length > 0) {
		out.push(input.file_path);
	}
	if ("paths" in input && Array.isArray(input.paths)) {
		for (const p of input.paths) if (typeof p === "string" && p.length > 0) out.push(p);
	}
	return out;
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
	if (Object.hasOwn(EDIT_TOOLS, toolName)) {
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
