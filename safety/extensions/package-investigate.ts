import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { type ShellToken, tokenizeShell } from "./shell-tokenizer.ts";

const MANAGERS = new Set(["pnpm", "npm", "bun", "yarn", "uv", "pip", "pip3", "poetry", "cargo", "go", "composer"]);
// Only verbs that add or change a dependency. Read-only lookups (`npm view`,
// `npm search`, `pip index`, `cargo search`) are the investigation this gate
// asks for, so they are never gated.
const PACKAGE_COMMANDS = new Map<string, Set<string>>([
	["pnpm", new Set(["add", "i", "install"])],
	["npm", new Set(["add", "i", "install"])],
	["bun", new Set(["add", "i", "install"])],
	["yarn", new Set(["add", "i", "install"])],
	["uv", new Set(["add"])],
	["pip", new Set(["install"])],
	["pip3", new Set(["install"])],
	["poetry", new Set(["add"])],
	["cargo", new Set(["add"])],
	["go", new Set(["get"])],
	["composer", new Set(["require"])],
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PACKAGE = /^(?!-)[A-Za-z@./_~][^;|&<>()`$]*$/;
/** A redirection operator standing alone, whose file operand is the next token. */
const REDIRECTION = /^\d*(?:[<>]+|&>>?|>&|<&)$/;
const SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, ")": true, "$(": true, "\n": true };

export const INVESTIGATE_NOTICE =
	"Before adding or changing a dependency, investigate the package (registry, maintainer, release, and downloads) and confirm it is not a typo-squat or abandoned. If it fails that check, revert the change.";

export function extractCommand(input: ToolCallEvent["input"]): string {
	if ("command" in input && typeof input.command === "string") return input.command;
	if ("cmd" in input && typeof input.cmd === "string") return input.cmd;
	return "";
}

/** Package operands of one simple command: stops at the first separator and skips redirections. */
function packagesFrom(tokens: readonly ShellToken[], start: number, out: string[]): void {
	for (let i = start; i < tokens.length; i++) {
		const value = tokens[i]?.value ?? "";
		if (SEPARATORS[value] === true) return;
		if (REDIRECTION.test(value)) {
			if (SEPARATORS[tokens[i + 1]?.value ?? ""] !== true) i++;
			continue;
		}
		if (PACKAGE.test(value)) out.push(value);
	}
}

/** Literal package operands of add/install commands in real shell command positions. */
export function packagesToInvestigate(command: string): string[] {
	const tokens = tokenizeShell(command);
	const packages: string[] = [];
	let position = true;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		if (SEPARATORS[token.value] === true) {
			position = true;
			continue;
		}
		if (!position) continue;
		position = false;
		let commandIndex = i;
		while (tokens[commandIndex] && !tokens[commandIndex]?.startsQuoted && ENV_ASSIGNMENT.test(tokens[commandIndex]?.value ?? "")) {
			commandIndex++;
		}
		// The shell strips quotes from a command word, so `"bun" add x` still runs `bun add x`.
		const word = tokens[commandIndex];
		if (!word || !MANAGERS.has(word.value)) continue;
		const verb = tokens[commandIndex + 1];
		if (!verb || !PACKAGE_COMMANDS.get(word.value)?.has(verb.value)) continue;
		packagesFrom(tokens, commandIndex + 2, packages);
	}
	return packages;
}

export function shouldInvestigate(command: string): boolean {
	return packagesToInvestigate(command).length > 0;
}

export type PackageAdvisor = {
	/** Returns the notice for packages not yet named this session, or undefined. */
	notice(command: string): string | undefined;
	reset(): void;
};

/**
 * Fire-once steering: the first command naming a package gets the
 * investigation notice; a later command gets it only for packages not yet
 * named in this session.
 */
export function createPackageAdvisor(): PackageAdvisor {
	const noticed = new Set<string>();
	return {
		notice(command) {
			const fresh = [...new Set(packagesToInvestigate(command))].filter((name) => !noticed.has(name));
			if (fresh.length === 0) return undefined;
			for (const name of fresh) noticed.add(name);
			return `${INVESTIGATE_NOTICE} Packages: ${fresh.join(", ")}.`;
		},
		reset() {
			noticed.clear();
		},
	};
}

/**
 * Advisory, never a gate: the command always runs. The notice is decided at
 * tool_call (never returning `block`) and prepended to that call's
 * tool_result, the same surface quality-edit-advisory uses. A TTSR rule
 * cannot carry it, because the separator, redirection, and quoting logic
 * needs the shell tokenizer, which rule regexes cannot call.
 */
export default function packageInvestigate(pi: ExtensionAPI): void {
	const advisor = createPackageAdvisor();
	const pending = new Map<string, string>();
	pi.on("session_start", () => {
		advisor.reset();
		pending.clear();
	});
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const text = advisor.notice(extractCommand(event.input));
			if (text !== undefined) pending.set(event.toolCallId, text);
		} catch {
			return;
		}
	});
	pi.on("tool_result", (event: ToolResultEvent) => {
		try {
			const text = pending.get(event.toolCallId);
			if (text === undefined) return;
			pending.delete(event.toolCallId);
			const banner = `<system-reminder>\n${text}\n</system-reminder>\n\n`;
			const [first, ...rest] = event.content;
			if (first?.type === "text") return { content: [{ ...first, text: banner + first.text }, ...rest] };
			return { content: [{ type: "text" as const, text: banner }, ...event.content] };
		} catch {
			return;
		}
	});
}
