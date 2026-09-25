import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

type BashInput = { command?: unknown; cmd?: unknown; cwd?: unknown };
type EvalInput = { language?: unknown; code?: unknown };
type Decision = { block: true; reason: string } | undefined;

const MERGE_RETRY = "wt merge <target> --no-squash --no-ff";
const SOURCE_WORKTREE_RETRY = `${MERGE_RETRY} from the source worktree`;
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

type MergeInvocation = { target: string | null; noSquash: boolean; noFf: boolean; workdir: string | null };

function parseTargetAndFlags(argv: string[]): MergeInvocation | null {
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
	if (argv.includes("--help") || argv.includes("-h")) return null;
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

const EVAL_MERGE_REFUSAL = "run the merge through the bash tool from the source worktree; retry with `wt merge <target> --no-squash --no-ff` for worker-to-epic merges, or `wt merge` for the default branch";

function evalMergeInvocations(code: string): { invocations: MergeInvocation[]; unparseable: boolean } {
	const invocations: MergeInvocation[] = [];
	const listPattern = /\[((?:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*,?)+)\]/g;
	for (const match of code.matchAll(listPattern)) {
		const body = match[1] ?? "";
		const pieces = body.split(",").map(piece => piece.trim()).filter(Boolean);
		const argv: string[] = [];
		let valid = pieces.length > 0;
		for (const piece of pieces) {
			const quote = piece[0];
			if ((quote !== "'" && quote !== '"' && quote !== "`") || piece.at(-1) !== quote) {
				valid = false;
				break;
			}
			argv.push(piece.slice(1, -1).replace(/\\(.)/g, "$1"));
		}
		if (valid) {
			const invocation = parseTargetAndFlags(argv);
			if (invocation) invocations.push(invocation);
		}
	}
	const stringPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
	for (const match of code.matchAll(stringPattern)) {
		const invocation = parseTargetAndFlags(words(match[2] ?? ""));
		if (invocation) invocations.push(invocation);
	}
	const executable = /(?:subprocess|os\.system|shlex|Bun\.\$|(?:spawn|exec|run|call|Popen)\s*\()/i.test(code);
	const directVariable = /\[\s*(['"`])wt\1\s*,\s*([A-Za-z_$][\w$]*)/.exec(code)?.[2];
	const mergeAssignment = /\b([A-Za-z_$][\w$]*)\s*=\s*(['"`])merge\2/.exec(code)?.[1];
	const variablePair = directVariable !== undefined && directVariable === mergeAssignment;
	const wtVariable = /\b([A-Za-z_$][\w$]*)\s*=\s*(['"`])wt\2/.exec(code)?.[1];
	const variableList = wtVariable !== undefined && mergeAssignment !== undefined && new RegExp(`\\[[^\\]]*\\b${wtVariable}\\b[^\\]]*\\b${mergeAssignment}\\b`).test(code);
	const splitDynamic = /(?:(['"`])w\1\s*\+\s*(['"`])t\2\s*(?:\+\s*)?(?:merge|(['"`])merge\3)|(['"`])w\4\s*\+\s*(['"`])t\s+merge\5)/.test(code);
	const splitArgvDynamic = /(['"`])w\1\s*\+\s*(['"`])t\2\s*,\s*(['"`])merge\3/.test(code);
	const dynamic = executable && (variablePair || variableList || splitDynamic || splitArgvDynamic);
	return { invocations, unparseable: dynamic };
}

export function decideEvalMergePolicy(code: string): Decision {
	const detected = evalMergeInvocations(code);
	if (detected.unparseable) return { block: true, reason: EVAL_MERGE_REFUSAL };
	for (const invocation of detected.invocations) {
		if (!invocation.noSquash || !invocation.noFf) return { block: true, reason: EVAL_MERGE_REFUSAL };
	}
	return undefined;
}

function commandCwd(command: string, cwd: string): string {
	const match = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command);
	if (!match) return cwd;
	const dir = match[1];
	return dir?.startsWith("/") ? dir : `${cwd}/${dir}`;
}

export type GitRunner = (args: string[], cwd: string) => string | null;
export type WtRunner = (args: string[], cwd: string) => string | null;

const defaultGitRunner: GitRunner = (args, cwd) => {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
};

const defaultWtRunner: WtRunner = (args, cwd) => {
	const result = Bun.spawnSync(["wt", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
};

export function decideMergePolicy(
	command: string,
	cwd: string,
	gitRunner: GitRunner = defaultGitRunner,
	wtRunner: WtRunner = defaultWtRunner,
): Decision {
	for (const segment of shellSegments(command)) {
		const invocation = parseTargetAndFlags(words(segment));
		if (!invocation || invocation.target === null) continue;
		const shellCwd = commandCwd(command, cwd);
		const repoCwd = invocation.workdir
			? invocation.workdir.startsWith("/")
				? invocation.workdir
				: `${shellCwd}/${invocation.workdir}`
			: shellCwd;
		const configured = wtRunner(["config", "state", "default-branch"], repoCwd);
		const symbolic = configured || gitRunner(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoCwd);
		const defaultBranch = symbolic?.replace(/^origin\//, "");
		if (!defaultBranch) return { block: true, reason: `cannot determine the repository default branch; ${MERGE_RETRY}` };
		if (invocation.target === defaultBranch) continue;
		if (!invocation.noSquash || !invocation.noFf) return { block: true, reason: MERGE_POLICY_REFUSAL.replace("<target>", invocation.target) };
		const currentBranch = gitRunner(["branch", "--show-current"], repoCwd);
		if (!currentBranch || currentBranch === invocation.target) {
			return { block: true, reason: `worker-to-epic merges must run from the source worktree; retry with ${SOURCE_WORKTREE_RETRY.replace("<target>", invocation.target)}` };
		}
	}
	return undefined;
}

export default function mergePolicyGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		if (event.toolName === "eval") {
			const input = event.input as EvalInput;
			return typeof input.code === "string" ? decideEvalMergePolicy(input.code) : undefined;
		}
		if (event.toolName !== "bash") return undefined;
		const input = event.input as BashInput;
		const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
		if (!command) return undefined;
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd());
		return decideMergePolicy(command, cwd);
	});
}

