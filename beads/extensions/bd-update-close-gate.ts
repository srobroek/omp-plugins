import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parsedInvocations, parse, type ParsedCommand } from "./shell-command.ts";

const UPDATE = "update";
const CLOSING_STATUSES: Record<string, true> = { closed: true, done: true };
const STATUS_FLAGS = ["--status", "-s"];

/** The command form that preserves close reasons and close-time gates. */
export const UPDATE_CLOSE_REASON = 'Use `bd close ID --reason "<factual reason>"` instead.';

function statusValue(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (token === undefined) continue;
		const flag = STATUS_FLAGS.find(candidate => token === candidate || token.startsWith(`${candidate}=`));
		if (flag === undefined) continue;
		if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1).toLowerCase();
		return args[index + 1]?.toLowerCase();
	}
	return undefined;
}

/** Return true when a parsed `bd update` transitions any issue to a close status. */
export function hasClosingBdUpdate(parsed: ParsedCommand): boolean {
	return parsedInvocations(parsed).some(invocation =>
		invocation.verb?.toLowerCase() === UPDATE && CLOSING_STATUSES[statusValue(invocation.args) ?? ""] === true,
	);
}

export function decideBdUpdateCloseParsed(parsed: ParsedCommand): { block: true; reason: string } | undefined {
	return hasClosingBdUpdate(parsed) ? { block: true, reason: UPDATE_CLOSE_REASON } : undefined;
}

export function decideBdUpdateClose(command: string): { block: true; reason: string } | undefined {
	return decideBdUpdateCloseParsed(parse(command));
}

export default function bdUpdateCloseGate(_pi: ExtensionAPI): void {
	// Bash calls are dispatched by bash-gates.ts.
}
