import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { decideActorParsed, environmentForInput } from "./bd-actor-gate.ts";
import { decideBdCloseParsed } from "./bd-close-gate.ts";
import { decideEmbeddedWrite } from "./bd-embedded-write-lock.ts";
import { decideBdInitParsed } from "./bd-init-advisory.ts";
import { decideLeaseClaim } from "./bd-lease-gate.ts";
import { beadsActive, decideCommandParsed, repositoryControlled, repositoryFromCurrentCheckout, repositoryFromGhCreate } from "./pr-bead-link-gate.ts";
import { admitBdMutation, admitBeadsWork, lifecycleBdEnvironment, rewriteBashInput } from "./session-beads-lifecycle.ts";
import { blockReason, commandExecutableIndex, commandFromInput, type ParsedCommand, parse, settingsEnabled, shellCommandOperand, shellHasScriptOperand } from "./shell-command.ts";

type BashInput = { command?: unknown; cmd?: unknown; cwd?: unknown };
type GateDecision = { block: true; reason: string } | undefined;

function inputOf(event: ToolCallEvent, ctx: ExtensionContext): { command: string; cwd: string } {
	const input = event.input as BashInput;
	return {
		command: commandFromInput(input),
		cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd()),
	};
}

/** Match the cwd and environment used by each gated tool's real mutation. */
export function beadsWorkAdmissionTarget(
	toolName: string,
	input: Record<string, unknown>,
	contextCwd: string,
	runtimeCwd: string = process.cwd(),
	runtimeEnv: NodeJS.ProcessEnv = process.env,
): { cwd: string; env: NodeJS.ProcessEnv; requiresWorkspace?: true } {
	if (toolName === "bd_formula_check") {
		if (typeof input.workspace !== "string") return { cwd: runtimeCwd, env: runtimeEnv, requiresWorkspace: true };
		const cwd = resolve(runtimeCwd, input.workspace);
		return { cwd, env: lifecycleBdEnvironment(cwd, runtimeEnv) };
	}
	return { cwd: contextCwd, env: lifecycleBdEnvironment(contextCwd, runtimeEnv) };
}

function suffix(gate: string, reason: string, resolution = "inspect the command and retry"): GateDecision {
	return { block: true, reason: blockReason({ gate, cause: reason, resolution }) };
}

const STDIN_SHELL_COMPOUNDS: Record<string, true> = { if: true, while: true, until: true, case: true, for: true, select: true, coproc: true };

function unknownMayReachGatedCommand(parsed: ParsedCommand): boolean {
	if ("kind" in parsed) return true;
	for (const position of parsed.commands) {
		const normalized = position.words.map(word => word.normalized);
		const words = normalized.map(word => word.split("/").pop() ?? word);
		if (position.stdinFed && STDIN_SHELL_COMPOUNDS[position.executable?.split("/").pop() ?? ""] === true) return true;
		if (words.some(word => word === "bd" || word.startsWith("bd "))) return true;
		if (words.some(word => /(^|\s)gh\s+pr\s+create(?:\s|$)/.test(word))) return true;
		const gh = words.indexOf("gh");
		if (gh >= 0 && words.slice(gh + 1).includes("pr") && words.slice(gh + 1).includes("create")) return true;
		if (position.words.some(word => /`|\$\(/.test(word.value))) return true;
		if (position.opaqueWrapperOptions && position.words.some(word => /(^|[^\\])[$`*?[\]{}~]/.test(word.value))) return true;
		if (position.opaqueWrapperOptions && words.some(word => ["bash", "sh", "zsh", "dash", "ksh"].includes(word))) return true;
		const env = words.indexOf("env");
		if (env >= 0 && normalized.slice(env + 1).some(word => word.startsWith("-S") || word === "--split-string" || word.startsWith("--split-string="))) return true;
		let candidateIndex = position.executableIndex;
		while (candidateIndex !== undefined && candidateIndex < position.words.length) {
			const word = words[candidateIndex];
			if (word !== undefined && ["if", "then", "else", "elif", "while", "until", "do", "time", "coproc", "!"].includes(word)) {
				candidateIndex++;
				continue;
			}
			const resolved = commandExecutableIndex(position.words, candidateIndex);
			if (resolved.index === candidateIndex) break;
			if (resolved.opaqueWrapperOptions && position.words.slice(candidateIndex).some(token => /(^|[^\\])[$`*?[\]{}~]/.test(token.value) || ["bash", "sh", "zsh", "dash", "ksh"].includes(token.normalized.split("/").pop() ?? token.normalized))) return true;
			candidateIndex = resolved.index;
		}
		const candidate = candidateIndex === undefined ? undefined : words[candidateIndex];
		if (candidate === "eval" || candidate === "source" || candidate === ".") return true;
		if (candidate === "trap") return true;
		if (candidate === "alias") return true;
		const candidateSource = candidateIndex === undefined ? undefined : position.words[candidateIndex]?.value;
		if (candidateSource !== undefined && /(^|[^\\])[$`*?[\]{}~]/.test(candidateSource)) return true;
		if (candidate === "find" && normalized.some(word => word === "-exec" || word === "-execdir")) return true;
		if (candidate !== undefined && ["bash", "sh", "zsh", "dash", "ksh"].includes(candidate)) {
			if (position.stdinFed) return true;
			if (candidateIndex !== undefined && shellHasScriptOperand(position.words, candidateIndex)) return true;
			const command = shellCommandOperand(position.words, candidateIndex ?? 0);
			if (command !== undefined && /(^|[^\\])[$`*?[\]{}~]/.test(command.value)) return true;
			const xargs = words.indexOf("xargs");
			if (command === undefined && candidateIndex !== undefined && xargs >= 0 && xargs < candidateIndex && position.words.slice(candidateIndex + 1).some(word => /^[-+][^-]*c/.test(word.normalized))) return true;
		}
	}
	return parsed.nested.some(unknownMayReachGatedCommand);
}

function wrapperCwdChangeMayReachGatedCommand(parsed: ParsedCommand): boolean {
	if ("kind" in parsed) return false;
	for (const position of parsed.commands) {
		const executableIndex = position.executableIndex;
		if (executableIndex === undefined) continue;
		const executable = position.words[executableIndex]?.normalized.split("/").pop();
		if (executable !== "bd" && executable !== "gh" && !["bash", "sh", "zsh", "dash", "ksh"].includes(executable ?? "")) continue;
		const env = position.words.findIndex(word => (word.normalized.split("/").pop() ?? word.normalized) === "env");
		if (env < 0 || env >= executableIndex) continue;
		if (position.words.slice(env + 1, executableIndex).some(word => word.normalized === "-C" || word.normalized.startsWith("-C") || word.normalized === "--chdir" || word.normalized.startsWith("--chdir="))) return true;
	}
	return parsed.nested.some(wrapperCwdChangeMayReachGatedCommand);
}

/**
 * Every beads gate sees the same validated parse; rewrites happen only after all decisions allow.
 *
 * A gate that rewrites hands its result to the next one, so the embedded-write runner
 * wrapper and the session's `BEADS_DIR` pin compose into one revised input instead of
 * the later rewrite dropping the earlier one.
 */
async function decide(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext, pi: ExtensionAPI): Promise<GateDecision | { input: Record<string, unknown> } | undefined> {
	let input = event.input as Record<string, unknown>;
	const { cwd } = inputOf(event, ctx);
	const env = environmentForInput(event.input);
	if ((env.BASH_ENV ?? "") !== "" || (env.ENV ?? "") !== "") return suffix("bash-gates", "the shell startup environment can execute an uninspected file", "unset BASH_ENV and ENV, then retry the command");
	if (parsed.unknown && unknownMayReachGatedCommand(parsed)) return suffix("bash-gates", "command could not be parsed", "split the command or run the mutation as a plain single command");
	if (wrapperCwdChangeMayReachGatedCommand(parsed)) return suffix("bash-gates", "a command wrapper changes the gated command's working directory", "pass the working directory through the Bash tool's cwd field or use a separate cd command");
	if (settingsEnabled("beads", "bd-actor-gate", cwd)) {
		const actor = decideActorParsed(parsed, env);
		if (actor.kind === "block") return suffix("bd-actor-gate", actor.reason);
        if (actor.kind === "advisory" && typeof pi.sendMessage === "function") pi.sendMessage({ customType: "beads-bd-actor-advisory", content: actor.text, display: true, attribution: "user" }, { triggerTurn: false });
	}
	if (settingsEnabled("beads", "bd-close-gate", cwd)) {
		const close = await decideBdCloseParsed(parsed, cwd);
		if (close) return suffix("bd-close-gate", close.reason);
	}
    if (settingsEnabled("beads", "bd-init-advisory", cwd)) {
        const advisory = decideBdInitParsed(parsed);
        if (advisory && typeof pi.sendMessage === "function") pi.sendMessage({ customType: "beads-bd-init-advisory", content: advisory, display: true, attribution: "user" }, { triggerTurn: false });
    }
	if (settingsEnabled("beads", "bd-lease-gate", cwd)) await decideLeaseClaim(parsed, event, ctx);
	if (settingsEnabled("beads", "bd-embedded-write-lock", cwd)) {
		const embedded = await decideEmbeddedWrite(parsed, event, ctx);
		if (embedded?.kind === "block") return suffix("bd-embedded-write-lock", embedded.reason);
		if (embedded?.kind === "rewrite") input = embedded.input;
	}
	if (settingsEnabled("beads", "pr-bead-link-gate", cwd)) {
		const pr = decideCommandParsed(parsed, segment => beadsActive(cwd) && repositoryControlled(repositoryFromGhCreate(segment) ?? repositoryFromCurrentCheckout(cwd)));
		if (pr) return suffix("pr-bead-link-gate", pr.reason);
	}
	// Last of the blocking gates: the session's automatic gates must be verified before a
	// command picks or changes work. `session_start` starts that read and does not wait for
	// it, so this is where the wait is spent -- on the call that actually needs the verdict,
	// and only once it has passed every cheaper refusal above.
	const admission = await admitBdMutation(event.input, ctx, targetCwd => settingsEnabled("beads", "beads-gate-admission", targetCwd));
	if (admission) return suffix("beads-gate-admission", admission.reason, "retry the command; the verification continues and the next attempt waits on the same read");
	const rewritten = rewriteBashInput(input, ctx) ?? input;
	if (JSON.stringify(rewritten) !== JSON.stringify(event.input)) return { input: rewritten };
	return undefined;
}

/** The beads plugin's sole Bash tool-call registration. Parsing happens exactly once. */
export default function bashGates(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			const toolInput = event.input as Record<string, unknown>;
			const gatedTool = event.toolName === "task" ||
				(event.toolName === "bd_reconcile" && toolInput.apply === true) ||
				(event.toolName === "bd_formula_check" && toolInput.deep === true);
			if (gatedTool) {
				const contextCwd = ctx?.cwd ?? process.cwd();
				const target = beadsWorkAdmissionTarget(event.toolName, toolInput, contextCwd);
				if (target.requiresWorkspace) return suffix("beads-gate-admission", "deep formula checks require an explicit workspace so admission and execution cannot select different stores", "set workspace to the target checkout and retry");
				if (!settingsEnabled("beads", "beads-gate-admission", target.cwd)) return;
				const admission = await admitBeadsWork(ctx, target.cwd, target.env);
				return admission ? suffix("beads-gate-admission", admission.reason, "retry the operation; verification continues and the next attempt waits on the same read") : undefined;
			}
			if (event.toolName !== "bash") return;
			const { command } = inputOf(event, ctx);
			if (!command) return;
			return await decide(parse(command), event, ctx, pi);
		} catch (error) {
			return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`, "split the command or run the mutation as a plain single command");
		}
	});
}
