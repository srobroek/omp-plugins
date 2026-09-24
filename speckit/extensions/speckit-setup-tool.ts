import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** A tool_call has a 30,000 ms budget; leave 5,000 ms for dispatch and reporting. */
export const TIMEOUT_MS = 25_000;
export function run(
    argv: string[],
    cwd?: string,
    deadline = Date.now() + TIMEOUT_MS,
): { exitCode: number; stdout: string; stderr: string } {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { exitCode: 124, stdout: "", stderr: "setup event budget exhausted; earlier changes may have landed" };
    if (testSpawn) return testSpawn(argv, { cwd, timeout: Math.min(TIMEOUT_MS, remaining) });
    try {
        const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: Math.min(TIMEOUT_MS, remaining) });
        if (proc.exitedDueToTimeout === true) return { exitCode: 124, stdout: proc.stdout.toString(), stderr: `${proc.stderr.toString()}\nsetup event budget exhausted; earlier changes may have landed` };
        return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { exitCode: 1, stdout: "", stderr: message };
    }
}
export function which(bin: string, deadline = Date.now() + TIMEOUT_MS): boolean {
    return run(["which", bin], undefined, deadline).exitCode === 0;
}

export const FORMULAS = [
	"speckit-feature",
	"speckit-lean",
	"speckit-basic",
	"mol-speckit-iterate",
	"mol-speckit-fix-findings",
	"mol-speckit-bugfix",
	"mol-speckit-refine",
] as const;

export const EXTENSIONS = [
	"agent-context",
	"bugfix",
	"cleanup",
	"critique",
	"fix-findings",
	"iterate",
	"qa",
	"refine",
	"retro",
	"review",
	"roadmap",
	"security-review",
	"tinyspec",
] as const;

export const STATUS_REPORT_FROM = "latest-release:Open-Agent-Tools/spec-kit-status";
export const CATALOG_URL =
	"https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.community.json";
export const GITIGNORE_ENTRY = "specs/**/spec-status.md";

export type SpawnFn = (
	argv: string[],
	opts?: { cwd?: string; timeout?: number },
) => { exitCode: number; stdout: string; stderr: string };

let testSpawn: SpawnFn | null = null;
let testPluginRoot: string | null = null;

export function setSpawnForTests(fn: SpawnFn | null): void {
	testSpawn = fn;
}

export function setPluginRootForTests(root: string | null): void {
	testPluginRoot = root;
}

export function pluginRoot(): string {
	if (testPluginRoot) return testPluginRoot;
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}



export function parseSpecifyMajorMinor(
	versionOut: string,
): { major: number; minor: number } | null {
	const m = versionOut.match(/(\d+)\.(\d+)/);
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]) };
}

export function specifyVersionOk(versionOut: string): boolean {
	const v = parseSpecifyMajorMinor(versionOut);
	if (!v) return false;
	return v.major > 0 || (v.major === 0 && v.minor >= 12);
}

export function ensureGitignore(repo: string): string {
	safePath(join(repo, ".gitignore"));
	const gi = join(repo, ".gitignore");
	const existing = existsSync(gi) ? readFileSync(gi, "utf8") : "";
	if (existing.split("\n").some((l) => l.trim() === GITIGNORE_ENTRY)) {
		return "gitignore already has spec-status.md";
	}
	const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	if (existsSync(gi)) appendFileSync(gi, `${prefix}${GITIGNORE_ENTRY}\n`);
	else writeFileSync(gi, `${GITIGNORE_ENTRY}\n`);
	return "appended specs/**/spec-status.md to .gitignore";
}

function safePath(path: string): void {
	const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
	let current = parse(absolute).root;
	for (const part of absolute.slice(current.length).split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean)) {
		current = join(current, part);
		const st = lstatSync(current, { throwIfNoEntry: false });
		if (st?.isSymbolicLink()) throw new Error(`unsafe symlink: ${current}`);
	}
}

export function installFormulas(repo: string, srcDir: string): string[] {
	const destDir = join(repo, ".beads", "formulas");
	safePath(destDir);
	const copies: { src: string; dest: string; name: string }[] = [];
	for (const name of FORMULAS) {
		const src = join(srcDir, `${name}.formula.toml`);
		const dest = join(destDir, `${name}.formula.toml`);
		safePath(src);
		safePath(dest);
		if (!lstatSync(src, { throwIfNoEntry: false })?.isFile()) {
			throw new Error(`required formula missing or unsafe: ${src}`);
		}
		const st = lstatSync(dest, { throwIfNoEntry: false });
		if (st && (!st.isFile() || !readFileSync(src).equals(readFileSync(dest)))) {
			throw new Error(`refusing divergent formula destination: ${dest}`);
		}
		if (!st) copies.push({ src, dest, name });
	}
	mkdirSync(destDir, { recursive: true });
	for (const { src, dest } of copies) copyFileSync(src, dest);
	return copies.map(({ name }) => `copied ${name}`);
}

export type SetupParams = {
	integration?: string;
	script?: string;
	force?: boolean;
	workspace?: string;
	skipSpecify?: boolean;
	skipBeads?: boolean;
};

export function runSetup(params: SetupParams): { ok: boolean; text: string } {
    const repo = params.workspace ?? process.cwd();
    const deadline = Date.now() + TIMEOUT_MS;
    const log: string[] = [];
    const integration = params.integration ?? "codex";
    const script = params.script ?? "sh";
    const fail = (text: string) => ({ ok: false, text: [...log, `ERROR: ${text}`].join("\n") });
    try {
        safePath(repo);
        safePath(join(repo, ".specify"));
        safePath(join(repo, ".beads"));
        safePath(join(repo, ".gitignore"));
        if (!params.skipSpecify) {
            if (!which("specify", deadline)) return fail("specify not on PATH or setup event budget exhausted");
            const ver = run(["specify", "--version"], repo, deadline);
            if (ver.exitCode !== 0 || !specifyVersionOk(`${ver.stdout}\n${ver.stderr}`)) return fail(`specify-cli >= 0.12.0 required. Got: ${ver.stdout || ver.stderr}`);
            const specifyDir = join(repo, ".specify");
            if (!existsSync(specifyDir) || params.force) {
                const init = run(["specify", "init", "--here", "--force", "--integration", integration, "--script", script], repo, deadline);
                log.push(`specify init exit=${init.exitCode}`);
                if (init.stdout) log.push(init.stdout.trim());
                if (init.exitCode !== 0) return fail(`specify init: ${init.stderr.trim()}`);
            } else log.push(".specify already present (pass force=true to re-scaffold)");
            const catalog = run(["specify", "extension", "catalog", "add", "--name", "community", "--install-allowed", CATALOG_URL], repo, deadline);
            if (catalog.exitCode !== 0) return fail(`catalog add: ${catalog.stderr.trim()}`);
            log.push("catalog community ok");
            for (const ext of EXTENSIONS) {
                const add = run(["specify", "extension", "add", ext], repo, deadline);
                if (add.exitCode !== 0) return fail(`extension ${ext}: ${add.stderr.trim()}`);
                log.push(`extension ${ext} ok`);
            }
            const status = run(["specify", "extension", "add", "status-report", "--from", STATUS_REPORT_FROM], repo, deadline);
            if (status.exitCode !== 0) return fail(`status-report: ${status.stderr.trim()}`);
            log.push("extension status-report ok");
        } else log.push("skipSpecify: specify CLI steps omitted");
        if (params.skipBeads) log.push("SKIP: beads explicitly omitted; molecule workflows are unavailable");
        else if (which("bd", deadline)) {
            const where = run(["bd", "where"], repo, deadline);
            if (where.exitCode !== 0) {
                const init = run(["bd", "init", "--skip-hooks"], repo, deadline);
                log.push(`bd init exit=${init.exitCode}`);
                if (init.exitCode !== 0) return fail(`bd init: ${init.stderr.trim()}`);
            } else log.push("beads workspace already present");
            if (Date.now() >= deadline) return fail("setup event budget exhausted; earlier changes may have landed");
            log.push(...installFormulas(repo, join(pluginRoot(), "formulas")));
        } else return fail("bd not on PATH; install beads or explicitly set skipBeads=true for SpecKit-only setup");
        if (Date.now() >= deadline) return fail("setup event budget exhausted; earlier changes may have landed");
        log.push(ensureGitignore(repo));
        return { ok: true, text: log.join("\n") };
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}

export default function speckitSetupTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "speckit_setup",
		label: "Bootstrap SpecKit",
		description:
			"Idempotent SpecKit bootstrap: specify init, community catalog, required extensions, copy bd formulas, gitignore spec-status.md.",
		parameters: z.object({
			integration: z.string().optional().describe("specify integration (codex|claude). Default codex"),
			script: z.string().optional().describe("specify script flavor (sh|ps). Default sh"),
			force: z.boolean().optional().describe("Re-run specify init even if .specify exists"),
			workspace: z.string().optional().describe("Repo cwd; defaults to process cwd"),
			skipBeads: z.boolean().optional().describe("Explicitly omit beads and formulas; molecule workflows unavailable"),
			skipSpecify: z
				.boolean()
				.optional()
				.describe("Skip specify CLI (formulas + gitignore only)"),
		}) as unknown as TSchema,
		execute: async (_id, params: SetupParams) => {
			try {
				const result = runSetup(params);
				return {
					content: [{ type: "text", text: result.text }],
					details: { ok: result.ok },
					isError: !result.ok,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `setup failed: ${message}` }],
					details: { ok: false },
					isError: true,
				};
			}
		},
	});
}
