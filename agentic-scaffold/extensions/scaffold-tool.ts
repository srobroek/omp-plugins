import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const execFileAsync = promisify(execFile);
const COMMANDS = [
	"inspect",
	"preflight",
	"interview",
	"answers",
	"plan",
	"apply",
	"doctor",
	"finish",
	"abort",
	"layers",
	"profiles",
	"member",
	"policy",
] as const;
const ROOT_FLAGS = ["--root", "--cwd", "--state", "--answers", "--output", "-C"] as const;
const TIMEOUT_MS = 10 * 60 * 1000;

export type ScaffoldCommand = (typeof COMMANDS)[number];

export function isScaffoldCommand(value: unknown): value is ScaffoldCommand {
	return typeof value === "string" && (COMMANDS as readonly string[]).includes(value);
}

/** Validate user-supplied arguments before the root is injected by this tool. */
export function validateScaffoldArgs(command: unknown, args: unknown): string | null {
	if (!isScaffoldCommand(command)) return `unknown scaffold command: ${String(command)}`;
	if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
		return "args must be an array of strings";
	}
	for (const arg of args as string[]) {
		if (arg.includes("\0") || /[\r\n]/.test(arg)) return "arguments may not contain NUL or newline";
		if (ROOT_FLAGS.some((flag) => arg === flag || arg.startsWith(flag))) {
			return `argument is reserved by scaffold: ${arg}`;
		}
		const segments = arg.split(/[\\/]/);
		if (segments.includes("..")) return `argument contains a parent path segment: ${arg}`;
		if (arg.startsWith("/") || arg.startsWith("~/") || arg === "~" || arg.startsWith("../") || arg === "..") {
			return `argument escapes the project root: ${arg}`;
		}
	}
	return null;
}

const SCRIPT_REL = ["skills", "agentic-scaffold", "scripts", "scaffold.py"] as const;

/**
 * The CLI that ships beside this extension. Resolved on every call: a plugin
 * upgrade during a session removes the versioned cache directory this module was
 * loaded from, so the load-time path goes stale while the stable `node_modules`
 * link already points at the new version.
 */
export function scaffoldScriptPath(home: string = homedir(), loadedFrom: string = import.meta.dir): string {
	const beside = join(loadedFrom, "..", ...SCRIPT_REL);
	if (existsSync(beside)) return beside;
	const linked = join(home, ".omp", "plugins", "node_modules", "@srobroek", "agentic-scaffold", ...SCRIPT_REL);
	if (existsSync(linked)) return linked;
	return beside;
}

export type ScaffoldExecution = {
	text: string;
	exitCode: number;
	details?: Record<string, unknown>;
};

type Exec = (
	file: string,
	args: string[],
	options: { cwd: string; shell: false; timeout: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const exec: Exec = async (file, args, options) => {
	const result = await execFileAsync(file, args, options);
	return { stdout: result.stdout, stderr: result.stderr };
};

function rejected(reason: string): ScaffoldExecution {
	return {
		text: JSON.stringify({ ok: false, error: reason, exitCode: 6 }),
		exitCode: 6,
		details: { error: reason },
	};
}

/** Execute the CLI with a root that cannot be supplied or overridden by the caller. */
export async function runScaffold(
	cwd: string,
	command: unknown,
	args: unknown,
	signal?: AbortSignal,
	runner: Exec = exec,
): Promise<ScaffoldExecution> {
	const invalid = validateScaffoldArgs(command, args);
	if (invalid) return rejected(invalid);
	// `validateScaffoldArgs` already proved both shapes, but a `string | null` return
	// cannot narrow them, so re-apply the predicate the validator itself uses.
	if (!isScaffoldCommand(command) || !Array.isArray(args)) return rejected("args must be an array of strings");
	const scaffoldArgs = args.filter((value): value is string => typeof value === "string");
	let root: string;
	try {
		root = realpathSync(cwd);
	} catch {
		return rejected(`cannot resolve session cwd: ${cwd}`);
	}
	const argv = [scaffoldScriptPath(), command, "--root", cwd, ...scaffoldArgs];
	try {
		const result = await runner("python3", argv, {
			cwd,
			shell: false,
			timeout: TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
			signal,
		});
		const output = result.stdout.trim();
		if (output) {
			try {
				const parsed: unknown = JSON.parse(output);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { root?: unknown }).root !== "string") {
					return rejected("scaffold CLI output is missing root");
				}
				if ((parsed as { root: string }).root !== root) return rejected("root mismatch");
			} catch (error) {
				if (error instanceof SyntaxError) return rejected("scaffold CLI returned invalid JSON");
				return rejected("root mismatch");
			}
		}
		const code = 0;
		return { text: output || result.stderr.trim(), exitCode: code };
	} catch (error) {
		const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
		const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
		if (stdout) {
			try {
				const parsed: unknown = JSON.parse(stdout);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { root?: unknown }).root !== "string") {
					return rejected("scaffold CLI output is missing root");
				}
				if ((parsed as { root: string }).root !== root) return rejected("root mismatch");
				const code = typeof failure.code === "number" ? failure.code : 1;
				return { text: stdout, exitCode: code, details: { stderr: failure.stderr ?? "" } };
			} catch (jsonError) {
				if (!(jsonError instanceof SyntaxError)) return rejected("root mismatch");
			}
		}
		const code = typeof failure.code === "number" ? failure.code : 1;
		const text = typeof failure.stderr === "string" && failure.stderr.trim() ? failure.stderr.trim() : String(failure.message ?? error);
		return { text, exitCode: code, details: { stderr: failure.stderr ?? "" } };
	}
}

export default function scaffoldTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "scaffold",
		label: "Agentic scaffold",
		description: "Run one deterministic agentic-scaffold CLI command in the session project.",
		parameters: z.object({
			command: z.enum(COMMANDS),
			args: z.array(z.string()),
		}),
		async execute(_id, input, signal, _onUpdate, ctx) {
			const params = input as { command?: unknown; args?: unknown };
			const result = await runScaffold(ctx.cwd, params.command, params.args, signal);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { ...(result.details ?? {}), exitCode: result.exitCode, command: params.command },
			};
		},
	});
}
