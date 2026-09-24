import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

type BashInput = { command?: unknown; cmd?: unknown; cwd?: unknown };
type Decision = { block: true; reason: string } | undefined;
export type GitRunner = (args: string[], cwd: string) => string | null;

const MERGE_RETRY = "wt merge <target> --no-squash --no-ff";
export const MERGE_POLICY_REFUSAL = `worker-to-epic merges must preserve history; retry with ${MERGE_RETRY}`;

function shellSegments(command: string): string[] {
	const segments: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) { escaped = false; continue; }
		if (quote) { if (ch === quote) quote = null; else if (quote === '"' && ch === "\\") escaped = true; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "\\") { escaped = true; continue; }
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") { segments.push(command.slice(start, i)); i++; start = i + 1; continue; }
		if (ch === ";" || ch === "|" || ch === "\n") { segments.push(command.slice(start, i)); start = i + 1; }
	}
	segments.push(command.slice(start));
	return segments;
}

function words(segment: string): string[] {
	const result: string[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	const push = () => { if (word) { result.push(word); word = ""; } };
	for (const ch of segment) {
		if (escaped) { word += ch; escaped = false; continue; }
		if (quote) { if (ch === quote) quote = null; else if (quote === '"' && ch === "\\") escaped = true; else word += ch; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "\\") { escaped = true; continue; }
		if (/\s/.test(ch)) push(); else word += ch;
	}
	push();
	return result;
}

const GLOBAL_VALUE_OPTIONS: Record<string, true> = { "-C": true, "--config": true, "--config-set": true };

function targetAndFlags(
	segment: string,
): { target: string | null; noSquash: boolean; noFf: boolean; workdir: string | null } | null {
	const argv = words(segment);
	const wtIndex = argv.findIndex(word => word.split("/").pop() === "wt");
	if (wtIndex < 0) return null;
	// Global options may precede the subcommand: `wt -C DIR merge TARGET`.
	let subIndex = wtIndex + 1;
	let workdir: string | null = null;
	while (subIndex < argv.length && argv[subIndex]?.startsWith("-")) {
		const option = argv[subIndex] ?? "";
		if (option === "-C") workdir = argv[subIndex + 1] ?? null;
		subIndex += GLOBAL_VALUE_OPTIONS[option] === true ? 2 : 1;
	}
	if (argv[subIndex] !== "merge") return null;
	let target: string | null = null;
	let noSquash = false;
	let noFf = false;
	const takesValue: Record<string, true> = { "--stage": true, "--format": true, "--config": true, "--config-set": true, "-C": true };
	for (let i = subIndex + 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--no-squash") { noSquash = true; continue; }
		if (arg === "--no-ff") { noFf = true; continue; }
		if (arg === "--") { target = argv[i + 1] ?? null; break; }
		if (!arg) continue;
		if (arg.startsWith("-") || takesValue[argv[i - 1] ?? ""] === true) continue;
		if (target === null) target = arg;
	}
	return { target, noSquash, noFf, workdir };
}

function commandCwd(command: string, cwd: string): string {
	const match = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command);
	if (!match) return cwd;
	const dir = match[1];
	return dir?.startsWith("/") ? dir : `${cwd}/${dir}`;
}

const defaultGitRunner: GitRunner = (args, cwd) => {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
};

export function decideMergePolicy(command: string, cwd: string, gitRunner: GitRunner = defaultGitRunner): Decision {
	for (const segment of shellSegments(command)) {
		const invocation = targetAndFlags(segment);
		if (!invocation) continue;
		const shellCwd = commandCwd(command, cwd);
		const repoCwd = invocation.workdir
			? invocation.workdir.startsWith("/")
				? invocation.workdir
				: `${shellCwd}/${invocation.workdir}`
			: shellCwd;
		const symbolic = gitRunner(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoCwd);
		const defaultBranch = symbolic?.replace(/^origin\//, "");
		if (!defaultBranch) return { block: true, reason: `cannot determine the repository default branch; ${MERGE_RETRY}` };
		if (invocation.target === null || invocation.target === defaultBranch) continue;
		if (!invocation.noSquash || !invocation.noFf) return { block: true, reason: MERGE_POLICY_REFUSAL.replace("<target>", invocation.target) };
	}
	return undefined;
}

export default function mergePolicyGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		if (event.toolName !== "bash") return undefined;
		const input = event.input as BashInput;
		const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
		if (!command) return undefined;
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd());
		return decideMergePolicy(command, cwd);
	});
}
