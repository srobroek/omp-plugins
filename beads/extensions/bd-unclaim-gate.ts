/** Refuse unguarded `bd unclaim` operations. */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type ParsedCommand, type ParseFailure, parse, parsedInvocations } from "./shell-command.ts";

const UNCLAIM = "unclaim";
const HELP_FLAGS: Record<string, true> = { "--help": true, "-h": true };
const IF_ASSIGNEE = "--if-assignee";
const GLOBAL_VALUE_FLAGS: Record<string, true> = { "--actor": true, "--database": true, "--db": true, "-C": true, "--directory": true };

export type BdUnclaimDecision = { block: true; reason: string };

function hasNonEmptyAssignee(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (token === undefined) continue;
		if (token === IF_ASSIGNEE) {
			const value = args[index + 1];
			if (value !== undefined && value.length > 0 && !value.startsWith("-")) return true;
			index++;
			continue;
		}
		if (token.startsWith(`${IF_ASSIGNEE}=`) && token.slice(IF_ASSIGNEE.length + 1).length > 0) return true;
	}
	return false;
}

function wrapperInvocations(parsed: ParsedCommand | ParseFailure): Array<{ args: string[]; verb?: string }> {
	if (parsed.unknown) return [];
	const found: Array<{ args: string[]; verb?: string }> = [];
	for (const position of parsed.commands) {
		const locate = (start: number): string[] | undefined => {
			const token = position.argv[start];
			if (token === undefined) return;
			const basename = token.split("/").pop() ?? token;
			if (basename === "bd" && position.words[start]?.quoted !== true) return position.argv.slice(start + 1);
			if (basename === "env") {
				let index = start + 1;
				while (index < position.argv.length) {
					const option = position.argv[index] as string;
					if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) { index++; continue; }
					if (option === "--") return locate(index + 1);
					if (!option.startsWith("-")) break;
					index++;
					if (["-u", "--unset", "-C", "--chdir", "--argv0"].includes(option)) index++;
				}
				return locate(index);
			}
			if (basename === "command") {
				let index = start + 1;
				while (position.argv[index]?.startsWith("-") === true) index++;
				return locate(index);
			}
			return;
		};
		const args = locate(0);
		if (args === undefined) continue;
		let verb: string | undefined;
		for (let cursor = 0; cursor < args.length; cursor++) {
			const token = args[cursor];
			if (token === undefined || token === "--") { verb = args[cursor + 1]; break; }
			if (!token.startsWith("-")) { verb = token; break; }
			if (!token.includes("=") && GLOBAL_VALUE_FLAGS[token] === true) cursor++;
		}
		found.push({ args: [verb ?? "", ...args], verb });
	}
	// `$(...)`, backticks and `bash -c '...'` bodies parse into `nested`; wrappers inside them count too.
	for (const child of parsed.nested) found.push(...wrapperInvocations(child));
	return found;
}

/** Evaluate parsed bd invocations recursively, before any command rewrite occurs. */
export function decideBdUnclaimParsed(parsed: ParsedCommand | ParseFailure): BdUnclaimDecision | undefined {
	if (parsed === null || typeof parsed !== "object" || !("unknown" in parsed) || typeof parsed.unknown !== "boolean") {
		return { block: true, reason: "unable to verify bd unclaim command syntax" };
	}
	if (parsed.unknown) return;
	if (!Array.isArray(parsed.commands) || !Array.isArray(parsed.nested)) {
		return { block: true, reason: "unable to verify bd unclaim command syntax" };
	}
	const invocations = [...parsedInvocations(parsed), ...wrapperInvocations(parsed)];
	for (const invocation of invocations) {
		if (invocation.verb?.toLowerCase() !== UNCLAIM) continue;
		let help = false;
		for (const argument of invocation.args) {
			if (argument === "--") break;
			if (HELP_FLAGS[argument] === true) {
				help = true;
				break;
			}
		}
		if (help) continue;
		if (!hasNonEmptyAssignee(invocation.args)) {
			return {
				block: true,
				reason: "bd unclaim requires a non-empty --if-assignee compare-and-swap guard",
			};
		}
	}
	return undefined;
}

export function decideBdUnclaim(command: string): BdUnclaimDecision | undefined {
	return decideBdUnclaimParsed(parse(command));
}

export default function bdUnclaimGate(_pi: ExtensionAPI): void {
	// Bash calls are dispatched by bash-gates.ts.
}
