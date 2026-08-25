/**
 * Refuse bash that invokes speckit-taskstoissues at command position.
 *
 * The companion TTSR (`speckit-no-taskstoissues`) can only see the slash form
 * unambiguously. Quoting is invisible to a regex, so a title like
 * `bd create --title 'port speckit-taskstoissues deny'` used to fire. This gate
 * tokenizes argv so quoted mentions pass and real invocations do not.
 *
 * Fails open: a throwing tool_call handler is a bash outage.
 */
import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

export const DENY_REASON =
	"blocked by speckit (taskstoissues converts tasks.md into a second tracker): do not run speckit-taskstoissues / speckit.taskstoissues / specify … /speckit.taskstoissues. Task state lives in beads. Link an existing GitHub issue with `bd update <id> --external-ref gh-<number>` instead.";

const SEPARATOR: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, ")": true };

const TRANSPARENT_PREFIX: Record<string, true> = { command: true, env: true, sudo: true };

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const BANNED_COMMAND: Record<string, true> = {
	"speckit-taskstoissues": true,
	"speckit.taskstoissues": true,
};

const SPECIFY_BANNED: Record<string, true> = {
	"/speckit.taskstoissues": true,
	"speckit.taskstoissues": true,
	"speckit-taskstoissues": true,
	"/speckit-taskstoissues": true,
};

const PREFILTER = /speckit[-.]taskstoissues/;

export function extractCommand(input: Record<string, unknown>): string {
	if (typeof input.command === "string") return input.command;
	if (typeof input.cmd === "string") return input.cmd;
	return "";
}

/**
 * Shell-ish tokenizer: enough to tell a command-position invocation from the
 * same words inside a quoted --title/--reason/-m. Duplicated from the delivery
 * plugin because plugins install independently.
 */
export function tokenize(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let started = false;
	let quote: '"' | "'" | null = null;
	const flush = (): void => {
		if (started) {
			out.push(cur);
			cur = "";
			started = false;
		}
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			else {
				cur += ch;
				started = true;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			cur += command[i + 1] as string;
			started = true;
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (SEPARATOR[ch] === true) {
			flush();
			out.push(ch);
			continue;
		}
		cur += ch;
		started = true;
	}
	flush();
	return out;
}

function isBannedInvocation(tokens: string[]): boolean {
	let atCommand = true;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (SEPARATOR[token] === true) {
			atCommand = true;
			continue;
		}
		if (!atCommand) continue;
		if (TRANSPARENT_PREFIX[token] === true || ENV_ASSIGNMENT.test(token)) continue;
		atCommand = false;

		const base = token.split("/").pop() ?? token;
		if (BANNED_COMMAND[token] === true || BANNED_COMMAND[base] === true) return true;

		if (token === "specify" || base === "specify") {
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j] as string;
				if (SEPARATOR[arg] === true) break;
				if (SPECIFY_BANNED[arg] === true) return true;
			}
		}
	}
	return false;
}

export function isTaskstoissuesInvocation(command: string): boolean {
	if (!PREFILTER.test(command)) return false;
	for (const line of command.split(/\r?\n/)) {
		if (isBannedInvocation(tokenize(line))) return true;
	}
	return false;
}

export function decideToolCall(
	toolName: string,
	input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
	if (toolName !== "bash") return;
	const command = extractCommand(input);
	if (!command) return;
	if (isTaskstoissuesInvocation(command)) return { block: true, reason: DENY_REASON };
	return;
}

export default function taskstoissuesGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			return decideToolCall(event.toolName, event.input);
		} catch {
			return;
		}
	});
}
