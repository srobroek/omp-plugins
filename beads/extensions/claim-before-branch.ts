import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

import { extractCommand, tokenize } from "./bd-close-gate.ts";

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HELP_OR_VERSION = new Set(["--help", "-h", "--version", "-V"]);

/** Find a real branch/worktree creation at command position, ignoring shell data. */
export function hasUnclaimedBranchCreation(command: string): boolean {
	const tokens = tokenize(command);
	let i = 0;
	while (i < tokens.length) {
		while (i < tokens.length && SEPARATORS.has(tokens[i] as string)) i++;
		if (i >= tokens.length) break;
		const end = (() => {
			let j = i;
			while (j < tokens.length && !SEPARATORS.has(tokens[j] as string)) j++;
			return j;
		})();
		const segment = tokens.slice(i, end);
		i = end;
		let k = 0;
		while (k < segment.length && ENV_ASSIGNMENT.test(segment[k] as string)) k++;
		const commandName = (segment[k] as string | undefined)?.split("/").pop();
		if (commandName !== "wt" && commandName !== "git") continue;
		const args = segment.slice(k + 1);
		if (args.some(token => HELP_OR_VERSION.has(token))) continue;
		if (commandName === "wt") {
			if (args[0] === "switch" && args.includes("--create")) return true;
			continue;
		}
		let arg = 0;
		if (args[arg] === "-C") arg += 2;
		if (args[arg] === "checkout" && args[arg + 1] === "-b") return true;
		if (args[arg] === "switch" && args[arg + 1] === "-c") return true;
		if (args[arg] === "worktree" && args[arg + 1] === "add") return true;
	}
	return false;
}

const ADVISORY =
	"MUST claim the bead before creating a branch or worktree: `bd update <id> --claim` is atomic and first-wins. " +
	"On refusal, treat the bead as taken; do not release another actor's claim to proceed.";

export default function claimBeforeBranch(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command || !hasUnclaimedBranchCreation(command)) return;
			pi.sendMessage(
				{ customType: "beads-claim-before-branch", content: ADVISORY, display: true, attribution: "user" },
				{ triggerTurn: false },
			);
		} catch {
			// Advisory only: never disturb the bash call.
		}
	});
}
