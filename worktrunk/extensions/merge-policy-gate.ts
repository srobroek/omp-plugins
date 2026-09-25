import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

type BashInput = { command?: unknown; cmd?: unknown; cwd?: unknown };
type EvalInput = { language?: unknown; code?: unknown };
type Decision = { block: true; reason: string } | undefined;

const MERGE_RETRY = "wt merge <target> --no-squash --no-ff";
const SOURCE_WORKTREE_RETRY = `${MERGE_RETRY} from the source worktree`;
export const MERGE_POLICY_REFUSAL = `worker-to-epic merges must preserve history; retry with ${MERGE_RETRY}`;

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let escapedDollarParen = false;
	let literalParenDepth = 0;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			escaped = false;
			if (quote === null && ch === "$" && command[i + 1] === "(") escapedDollarParen = true;
			continue;
		}
		if (escapedDollarParen) {
			escapedDollarParen = false;
			if (ch === "(") { literalParenDepth = 1; continue; }
		}
		if (literalParenDepth > 0) {
			if (ch === "(") literalParenDepth++;
			else if (ch === ")") literalParenDepth--;
			continue;
		}
		if (quote) { if (ch === quote) quote = null; else if (quote === '"' && ch === "\\") escaped = true; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "\\") { escaped = true; continue; }
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") { segments.push(command.slice(start, i)); i++; start = i + 1; continue; }
		if (ch === ";" || ch === "|" || ch === "\n" || ch === "(" || ch === ")") { segments.push(command.slice(start, i)); start = i + 1; }
	}
	segments.push(command.slice(start));
	return segments;
}

function matchingCommandSubstitutionEnd(command: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let i = start + 2; i < command.length; i++) {
		const ch = command[i];
		if (escaped) { escaped = false; continue; }
		if (quote) {
			if (ch === quote) quote = null;
			else if (quote === '"' && ch === "\\") escaped = true;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "\\") { escaped = true; continue; }
		const opensSubstitution = command.startsWith("$(", i) || ((command[i] === "<" || command[i] === ">") && command[i + 1] === "(");
		if (opensSubstitution) { depth++; i++; continue; }
		if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function nestedShellCommands(command: string): string[] {
	const nested: string[] = [];
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\") { i++; continue; }
		if (ch === "'") {
			while (++i < command.length && command[i] !== "'") { /* skip literal single-quoted data */ }
			continue;
		}
		const opensSubstitution = command.startsWith("$(", i) || ((ch === "<" || ch === ">") && command[i + 1] === "(");
		if (opensSubstitution) {
			const end = matchingCommandSubstitutionEnd(command, i);
			if (end >= 0) { nested.push(command.slice(i + 2, end)); i = end; }
			continue;
		}
		if (ch !== "`") continue;
		let escaped = false;
		for (let end = i + 1; end < command.length; end++) {
			const nestedChar = command[end];
			if (escaped) { escaped = false; continue; }
			if (nestedChar === "\\") { escaped = true; continue; }
			if (nestedChar === "`") { nested.push(command.slice(i + 1, end)); i = end; break; }
		}
	}
	for (const segment of splitShellSegments(command)) {
		const argv = words(segment);
		const executable = argv[0]?.split("/").pop();
		if ((executable === "bash" || executable === "sh" || executable === "zsh" || executable === "dash" || executable === "ksh") && argv[1] === "-c" && argv[2]) {
			nested.push(argv[2]);
		}
		if (executable === "eval" && argv.length > 1) nested.push(argv.slice(1).join(" "));
	}
	return nested;
}

function shellSegments(command: string): string[] {
	const segments: string[] = [];
	const pending = [command];
	while (pending.length > 0) {
		const source = pending.pop();
		if (!source) continue;
		segments.push(...splitShellSegments(source));
		const nested = nestedShellCommands(source);
		for (let i = nested.length; i > 0; i--) {
			const nestedCommand = nested[i - 1];
			if (nestedCommand !== undefined) pending.push(nestedCommand);
		}
	}
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

function evalMergeInvocations(code: string): { invocations: Array<{ invocation: MergeInvocation; start: number; end: number }>; unparseable: boolean } {
	const invocations: Array<{ invocation: MergeInvocation; start: number; end: number }> = [];
	const literalPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
	const sequencePattern = /(\[|\()((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)(?:\s*,\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`))*\s*,?\s*)(\]|\))/g;
	for (const match of code.matchAll(sequencePattern)) {
		const body = match[2] ?? "";
		const argv = [...body.matchAll(literalPattern)].map(literal => (literal[1] ?? "").slice(1, -1).replace(/\\(.)/g, "$1"));
		const invocation = parseTargetAndFlags(argv);
		if (invocation) {
			const start = match.index ?? 0;
			invocations.push({ invocation, start, end: start + match[0].length });
		}
	}
	const literals: Array<{ value: string; start: number; end: number }> = [];
	for (const match of code.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
		const start = match.index ?? 0;
		const value = (match[2] ?? "").replace(/\\(.)/g, "$1");
		literals.push({ value, start, end: start + match[0].length });
		for (const segment of shellSegments(match[2] ?? "")) {
			const invocation = parseTargetAndFlags(words(segment));
			if (invocation) invocations.push({ invocation, start, end: start + match[0].length });
		}
	}
	const suspicious = literals.filter(({ value }) => value === "merge" || value === "wt" || value.endsWith("/wt"));
	const hasWt = suspicious.some(({ value }) => value === "wt" || value.endsWith("/wt"));
	const hasMerge = suspicious.some(({ value }) => value === "merge");
	const dynamicMergeSequence = /(?:\[|\()[^)\]]*(?:\+[^,)\]]*|[A-Za-z_$][\w$]*)\s*,\s*(['"`])merge\1/.test(code);
	const uncoveredLiteral = ({ start, end }: { start: number; end: number }) => !invocations.some(({ invocation, start: invocationStart, end: invocationEnd }) =>
		invocation.noSquash && invocation.noFf && start >= invocationStart && end <= invocationEnd);
	return {
		invocations,
		unparseable: dynamicMergeSequence || (hasWt && hasMerge && suspicious.some(uncoveredLiteral)),
	};
}

export function decideEvalMergePolicy(code: string): Decision {
	const detected = evalMergeInvocations(code);
	if (detected.unparseable) return { block: true, reason: EVAL_MERGE_REFUSAL };
	for (const invocation of detected.invocations) {
		if (!invocation.invocation.noSquash || !invocation.invocation.noFf) return { block: true, reason: EVAL_MERGE_REFUSAL };
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

