/**
 * Advise when bd will authenticate as root because its Dolt user variable is absent.
 * Advisory only: never blocks or mutates the environment, and speaks once per process.
 */
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { commandSegments, environmentForInput, extractCommand } from "./bd-actor-gate.ts";

export const BEADS_DOLT_SERVER_USER = "BEADS_DOLT_SERVER_USER";

export const DOLT_USER_ADVISORY =
	"`BEADS_DOLT_SERVER_USER` is absent from this `bd` call's environment. The global config already declares `dolt.user: beads`, but the beads client ignores that key (upstream gastownhall/beads#6598), so it authenticates as root and the hardened Dolt server rejects the call with access denied. Set `BEADS_DOLT_SERVER_USER=beads` in the environment that runs `bd`; this advisory does not inject it.";

const ADVISED_KEY = Symbol.for("com.srobroek.beads.dolt-user-advisory.sent");

function bdInvocation(command: string): { found: boolean; inlineUser?: string } {
	for (const segment of commandSegments(command)) {
		let index = 0;
		let inlineUser: string | undefined;
		while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] as string)) {
			const assignment = segment[index] as string;
			if (assignment.startsWith(`${BEADS_DOLT_SERVER_USER}=`)) {
				inlineUser = assignment.slice(BEADS_DOLT_SERVER_USER.length + 1);
			}
			index++;
		}
		if (segment[index] === "bd") return { found: true, inlineUser };
	}
	return { found: false };
}


export function decideBdDoltUser(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const invocation = bdInvocation(command);
	if (!invocation.found || env[BEADS_DOLT_SERVER_USER] || invocation.inlineUser) return undefined;
	return DOLT_USER_ADVISORY;
}

export function resetBdDoltUserAdvisoryForTests(): void {
	delete (globalThis as { [ADVISED_KEY]?: boolean })[ADVISED_KEY];
}

export default function bdDoltUserAdvisory(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			const advisory = decideBdDoltUser(command, environmentForInput(event.input));
			if (advisory === undefined) return;
			const holder = globalThis as { [ADVISED_KEY]?: boolean };
			if (holder[ADVISED_KEY] === true) return;
			holder[ADVISED_KEY] = true;
			pi.sendMessage(
				{
					customType: "com.srobroek.beads.dolt-user-advisory",
					content: advisory,
					display: true,
					attribution: "user",
				},
				{ triggerTurn: false },
			);
		} catch {
			// Advisory only: a bug here must never disturb a bash call.
		}
		return;
	});
}
