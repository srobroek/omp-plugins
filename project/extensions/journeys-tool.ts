import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;
const JOURNEYS_SCRIPT = ["skills", "journey-init", "scripts", "journeys.py"] as const;


/** Resolve the bundled helper relative to this extension's installed location. */
export function journeysScriptPath(loadedFrom: string = import.meta.dir): string {
	return join(loadedFrom, "..", ...JOURNEYS_SCRIPT);
}

type Exec = (
	file: string,
	args: string[],
	options: { cwd: string; shell: false; timeout: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const exec: Exec = async (file, args, options) => {
	const result = await execFileAsync(file, args, options);
	return { stdout: result.stdout, stderr: result.stderr };
};

export type JourneysIndexParams = {
	command: "index" | "lint" | "prune";
	journeysDir: string;
	keep?: number;
	yes?: boolean;
	journey?: string;
};

export type JourneysExecution = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type JourneysRunner = Exec;

function journeysArgs(params: JourneysIndexParams): string[] {
	const args = [journeysScriptPath(), params.command, params.journeysDir];
	if (params.command !== "prune") return args;
	if (params.keep !== undefined) args.push("--keep", String(params.keep));
	if (params.journey !== undefined) args.push("--journey", params.journey);
	if (params.yes) args.push("--yes");
	return args;
}

const JOURNEYS_ERROR = {} as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };

/** Run the single-source Python helper with the session project as cwd. */
export async function runJourneys(
	cwd: string,
	params: JourneysIndexParams,
	signal?: AbortSignal,
	runner: JourneysRunner = exec,
): Promise<JourneysExecution> {
	try {
		const result = await runner("python3", journeysArgs(params), {
			cwd,
			shell: false,
			timeout: TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
			signal,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = typeof error === "object" && error !== null ? (error as typeof JOURNEYS_ERROR) : JOURNEYS_ERROR;
		const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
		const stderr = typeof failure.stderr === "string" ? failure.stderr : typeof failure.message === "string" ? failure.message : "";
		const code = typeof failure.code === "number" ? failure.code : 1;
		return { stdout, stderr, exitCode: code };
	}
}

/** Resolve the physical directory a command or formula install will operate in. */
function managedRoot(dir: string): string | null {
	const absolute = resolve(isAbsolute(dir) ? dir : join(process.cwd(), dir));
	if (dir.split(sep === "\\" ? /[\\/]/ : "/").includes("..")) return null;
	try {
		return realpathSync(absolute);
	} catch {
		return null;
	}
}

function safePath(path: string, base: string): void {
	const absolute = resolve(isAbsolute(path) ? path : join(process.cwd(), path));
	const inside = relative(base, absolute);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
		throw new Error(`outside the managed root: ${absolute}`);
	}
	let current = base;
	if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`unsafe symlink: ${current}`);
	}
	for (const part of inside.split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean)) {
		current = join(current, part);
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`unsafe symlink: ${current}`);
		}
	}
}

const FORMULAS_DIR = new URL("../skills/journey-verify/formulas/", import.meta.url).pathname;

export function formulaSources(dir = FORMULAS_DIR): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => n.endsWith(".formula.toml"))
		.sort()
		.map((n) => join(dir, n));
}

export function installFormulas(
	rawRepoRoot: string,
	force = false,
	rawSourcesDir = FORMULAS_DIR,
): { ok: boolean; text: string; copied?: number; unchanged?: number } {
	const repoRoot = managedRoot(rawRepoRoot);
	const sourcesDir = managedRoot(rawSourcesDir);
	if (repoRoot === null) return { ok: false, text: `ERROR not a Beads workspace: ${rawRepoRoot}` };
	if (sourcesDir === null) return { ok: false, text: `ERROR no formula sources: ${rawSourcesDir}` };
	try {
		safePath(repoRoot, repoRoot);
		safePath(sourcesDir, sourcesDir);
		safePath(join(repoRoot, ".beads", "formulas"), repoRoot);
	} catch (err) {
		return { ok: false, text: `ERROR ${err instanceof Error ? err.message : String(err)}` };
	}
	const beadsDir = join(repoRoot, ".beads");
	try {
		if (!existsSync(beadsDir) || !lstatSync(beadsDir).isDirectory()) {
			return { ok: false, text: `ERROR not a Beads workspace: ${repoRoot}` };
		}
	} catch {
		return { ok: false, text: `ERROR not a Beads workspace: ${repoRoot}` };
	}
	const destinationDir = join(beadsDir, "formulas");
	if (existsSync(destinationDir)) {
		const st = lstatSync(destinationDir);
		if (st.isSymbolicLink() || !st.isDirectory()) {
			return { ok: false, text: `ERROR unsafe formula destination: ${destinationDir}` };
		}
	}
	const required = ["journey-step-agentic-verification", "journey-step-human-verification"];
	for (const name of required) {
		const source = join(sourcesDir, `${name}.formula.toml`);
		const st = lstatSync(source, { throwIfNoEntry: false });
		if (!st?.isFile() || st.isSymbolicLink()) {
			return { ok: false, text: `ERROR required formula missing or unsafe: ${source}` };
		}
	}
	const sources = formulaSources(sourcesDir);
	if (!sources.length) {
		return { ok: false, text: `ERROR no formula files found in ${sourcesDir}` };
	}
	const unchanged = new Set<string>();
	const unsafe: string[] = [];
	const conflicts: string[] = [];
	for (const source of sources) {
		const sourceStat = lstatSync(source);
		if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
			return { ok: false, text: `ERROR unsafe formula source: ${source}` };
		}
		const destination = join(destinationDir, basename(source));
		const st = lstatSync(destination, { throwIfNoEntry: false });
		if (st) {
			if (st.isSymbolicLink() || !st.isFile()) {
				unsafe.push(destination);
			} else if (readFileSync(destination).equals(readFileSync(source))) {
				unchanged.add(source);
			} else {
				conflicts.push(destination);
			}
		}
	}
	if (unsafe.length) {
		return { ok: false, text: `ERROR unsafe formula destinations: ${unsafe.join(", ")}` };
	}
	if (conflicts.length && !force) {
		return {
			ok: false,
			text: `ERROR refusing to overwrite divergent formula files: ${conflicts.join(", ")}`,
		};
	}
	mkdirSync(destinationDir, { recursive: true });
	let copied = 0;
	for (const source of sources) {
		if (unchanged.has(source)) continue;
		copyFileSync(source, join(destinationDir, basename(source)));
		copied += 1;
	}
	return {
		ok: true,
		text: `formulas: ${copied} copied, ${unchanged.size} unchanged`,
		copied,
		unchanged: unchanged.size,
	};
}

export default function journeysTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "journeys_index",
		label: "Journey index/lint/prune",
		description: "Index, structurally lint (not semantic readiness), or prune a user-journeys directory by running its bundled journeys.py helper.",
		parameters: z.object({
			command: z.enum(["index", "lint", "prune"]),
			journeysDir: z.string().describe("Path to the journeys directory"),
			keep: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe("prune: keep newest N runs (default 20)"),
			yes: z.boolean().optional().describe("prune: actually delete (default dry-run)"),
			journey: z.string().min(1).optional().describe("prune: selected journey directory name; omit only for an explicitly authorized directory-wide prune"),
		}) as unknown as TSchema,
		approval: (toolCall) => {
			const input = typeof toolCall === "object" && toolCall !== null && "input" in toolCall ? toolCall.input : undefined;
			const record = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
			const cmd = typeof record.command === "string" ? record.command : undefined;
			const yes = "yes" in record && Boolean(record.yes);
			if (cmd === "lint") return "read";
			if (cmd === "prune" && !yes) return "read";
			return "exec";
		},
		execute: async (_id, params: JourneysIndexParams, signal, _onUpdate, ctx) => {
			const result = await runJourneys(ctx.cwd, params, signal);
			const text = result.stdout && result.stderr ? `${result.stdout}\n${result.stderr}` : result.stdout || result.stderr;
			return {
				content: [{ type: "text" as const, text }],
				details: { ok: result.exitCode === 0, command: params.command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
			};
		},
	});

	pi.registerTool({
		name: "journey_install_formulas",
		label: "Install journey formulas",
		description: "Copy package-owned journey formula TOMLs into a Beads workspace .beads/formulas/.",
		parameters: z.object({
			repoRoot: z.string().describe("Repository root containing .beads/"),
			force: z.boolean().optional().describe("Overwrite divergent destination files"),
		}) as unknown as TSchema,
		execute: async (_id, params: { repoRoot: string; force?: boolean }) => {
			const result = installFormulas(params.repoRoot, Boolean(params.force));
			return { content: [{ type: "text", text: result.text }], details: { ok: result.ok, copied: result.copied, unchanged: result.unchanged } };
		},
	});
}
