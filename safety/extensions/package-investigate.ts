import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

import { type ShellToken, tokenizeShell } from "./shell-tokenizer.ts";

const MANAGERS = new Set(["pnpm", "npm", "bun", "yarn", "uv", "pip", "pip3", "poetry", "cargo", "go", "composer"]);
const PACKAGE_COMMANDS = new Map<string, Set<string>>([
	["pnpm", new Set(["add", "i", "install", "search", "view"])],
	["npm", new Set(["add", "i", "install", "search", "view"])],
	["bun", new Set(["add", "i", "install", "search", "view"])],
	["yarn", new Set(["add", "i", "install", "search", "view"])],
	["uv", new Set(["add"])],
	["pip", new Set(["install", "index"])],
	["pip3", new Set(["install", "index"])],
	["poetry", new Set(["add"])],
	["cargo", new Set(["add", "search"])],
	["go", new Set(["get"])],
	["composer", new Set(["require"])],
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PACKAGE = /^(?!-)[A-Za-z@./_~][^;|&<>()`$]*$/;
const SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, ")": true, "$(": true, "\n": true };

export function extractCommand(input: ToolCallEvent["input"]): string {
	if ("command" in input && typeof input.command === "string") return input.command;
	if ("cmd" in input && typeof input.cmd === "string") return input.cmd;
	return "";
}

function hasPackage(tokens: readonly ShellToken[], start: number): boolean {
	return tokens.slice(start).some((token) => !token.startsQuoted && PACKAGE.test(token.value));
}

/** Returns true only for literal package operations in real shell command positions. */
export function shouldInvestigate(command: string): boolean {
	const tokens = tokenizeShell(command);
	let position = true;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		if (SEPARATORS[token.value] === true) {
			position = true;
			continue;
		}
		if (!position) continue;
		if (token.startsQuoted) {
			position = false;
			continue;
		}
		let commandIndex = i;
		while (tokens[commandIndex] && !tokens[commandIndex]?.startsQuoted && ENV_ASSIGNMENT.test(tokens[commandIndex]?.value ?? "")) {
			commandIndex++;
		}
		const word = tokens[commandIndex];
		if (!word || word.startsQuoted || !MANAGERS.has(word.value)) {
			position = false;
			continue;
		}
		let verbIndex = commandIndex + 1;
		while (tokens[verbIndex] && !tokens[verbIndex]?.startsQuoted && tokens[verbIndex]?.value.startsWith("-")) {
			verbIndex++;
		}
		const verb = tokens[verbIndex];
		const verbs = PACKAGE_COMMANDS.get(word.value);
        if (!verb || verb.startsQuoted || !verbs?.has(verb.value)) {
            position = false;
            continue;
        }
		const packageStart = verbIndex + 1;
		if (hasPackage(tokens, packageStart)) return true;
		position = false;
	}
	return false;
}

export default function packageInvestigate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			if (!shouldInvestigate(extractCommand(event.input))) return;
			return {
				block: true as const,
				reason:
					"Before adding or changing a dependency, investigate the package (registry, maintainer, release, and downloads) and confirm it is not a typo-squat or abandoned.",
			};
		} catch {
			return;
		}
	});
}
