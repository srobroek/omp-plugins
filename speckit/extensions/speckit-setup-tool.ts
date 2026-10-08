import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Each setup phase gets its own budget, so one slow networked phase neither starves
 * the phases after it nor hangs setup. A rerun skips the phases already complete.
 */
export const PHASE_TIMEOUT_MS = 60_000;

export type RunResult = { exitCode: number; stdout: string; stderr: string };

export async function run(argv: string[], cwd: string | undefined, deadline: number): Promise<RunResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { exitCode: 124, stdout: "", stderr: "phase budget exhausted; earlier phases may have landed" };
    if (testSpawn) return testSpawn(argv, { cwd, timeout: remaining });
    try {
        const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: remaining });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (proc.signalCode !== null && Date.now() >= deadline) return { exitCode: 124, stdout, stderr: `${stderr}\nphase budget exhausted; earlier phases may have landed` };
        return { exitCode, stdout, stderr };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { exitCode: 1, stdout: "", stderr: message };
    }
}
export async function which(bin: string, deadline: number): Promise<boolean> {
    return (await run(["which", bin], undefined, deadline)).exitCode === 0;
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
	"security-review",
	"status-report",
	"tinyspec",
] as const;

export const CATALOG_URL =
	"https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.community.json";
export const GITIGNORE_ENTRY = "specs/**/spec-status.md";

export type SpawnFn = (
	argv: string[],
	opts: { cwd?: string; timeout: number },
) => RunResult | Promise<RunResult>;

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

/** Extension ids `specify` records as installed in `.specify/extensions/.registry`. */
export function installedExtensions(repo: string): Set<string> {
	const registry = join(repo, ".specify", "extensions", ".registry");
	safePath(registry);
	if (!existsSync(registry)) return new Set();
	try {
		const data: unknown = JSON.parse(readFileSync(registry, "utf8"));
		const extensions = data !== null && typeof data === "object" && "extensions" in data ? data.extensions : undefined;
		if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) return new Set();
		return new Set(Object.keys(extensions));
	} catch {
		// specify reads a corrupt registry as empty too, so every add is attempted.
		return new Set();
	}
}

/**
 * The community catalog's state in `.specify/extension-catalogs.yml`: registered as an
 * install source, absent, or present with other settings that only the user may change.
 */
export function communityCatalogState(repo: string): "trusted" | "absent" | "conflict" {
	const config = join(repo, ".specify", "extension-catalogs.yml");
	safePath(config);
	if (!existsSync(config)) return "absent";
	const parsed: unknown = Bun.YAML.parse(readFileSync(config, "utf8"));
	const catalogs = parsed !== null && typeof parsed === "object" && "catalogs" in parsed && Array.isArray(parsed.catalogs) ? parsed.catalogs : [];
	let conflict = false;
	for (const entry of catalogs as unknown[]) {
		if (entry === null || typeof entry !== "object") continue;
		const { name, url, install_allowed: installAllowed } = entry as Record<string, unknown>;
		if (url === CATALOG_URL && installAllowed === true) return "trusted";
		if (name === "community" || url === CATALOG_URL) conflict = true;
	}
	return conflict ? "conflict" : "absent";
}

export type SetupParams = {
	integration?: string;
	script?: string;
	force?: boolean;
	workspace?: string;
	installAllowed?: boolean;
	skipSpecify?: boolean;
	skipBeads?: boolean;
};

export type PhaseResult = { phase: string; status: "done" | "skipped" | "failed"; detail: string };
export type SetupResult = { ok: boolean; text: string; phases: PhaseResult[] };

function output(result: RunResult): string {
    return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

/**
 * Bootstrap `params.workspace`, resolved against the caller's `cwd`. Every phase
 * detects work already done and skips it, so a rerun resumes after a failure.
 */
export async function runSetup(params: SetupParams, cwd: string): Promise<SetupResult> {
    const repo = resolve(cwd, params.workspace ?? ".");
    const phases: PhaseResult[] = [];
    const record = (phase: string, status: PhaseResult["status"], detail: string) => phases.push({ phase, status, detail });
    const finish = (): SetupResult => ({
        ok: phases.every((row) => row.status !== "failed"),
        text: phases.map((row) => `${row.phase}: ${row.status} -- ${row.detail}`).join("\n"),
        phases,
    });
    const budget = () => Date.now() + PHASE_TIMEOUT_MS;
    const integration = params.integration ?? "codex";
    const script = params.script ?? "sh";
    let current = "preflight";
    const fail = (detail: string): SetupResult => {
        record(current, "failed", detail);
        return finish();
    };
    try {
        safePath(repo);
        safePath(join(repo, ".specify"));
        safePath(join(repo, ".beads"));
        safePath(join(repo, ".gitignore"));
        if (params.skipSpecify) record("specify", "skipped", "skipSpecify: specify CLI steps omitted");
        else {
            current = "specify";
            const deadline = budget();
            if (!(await which("specify", deadline))) return fail("specify not on PATH");
            const ver = await run(["specify", "--version"], repo, deadline);
            if (ver.exitCode !== 0 || !specifyVersionOk(`${ver.stdout}\n${ver.stderr}`)) return fail(`specify-cli >= 0.12.0 required. Got: ${ver.stdout || ver.stderr}`);
            record(current, "done", ver.stdout.trim());
            current = "specify init";
            if (existsSync(join(repo, ".specify")) && !params.force) record(current, "skipped", ".specify already present (pass force=true to re-scaffold)");
            else {
                const init = await run(["specify", "init", "--here", "--force", "--integration", integration, "--script", script], repo, budget());
                if (init.exitCode !== 0) return fail(output(init));
                record(current, "done", "scaffolded .specify/");
            }
            current = "catalog community";
            // specify reads SPECKIT_CATALOG_URL first, as one install-allowed catalog that replaces every other.
            const envCatalog = process.env.SPECKIT_CATALOG_URL;
            if (envCatalog) record(current, "skipped", `SPECKIT_CATALOG_URL=${envCatalog} replaces every catalog for specify; no project catalog is registered or read`);
            else if (!params.installAllowed) record(current, "skipped", "not registered: the public community catalog becomes an install source only with installAllowed=true, after vetting");
            else {
                const state = communityCatalogState(repo);
                if (state === "trusted") record(current, "skipped", "already registered as an install source");
                else if (state === "conflict") return fail("a community catalog entry with other settings exists in .specify/extension-catalogs.yml; resolve it explicitly, then retry");
                else {
                    const catalog = await run(["specify", "extension", "catalog", "add", "--name", "community", "--install-allowed", CATALOG_URL], repo, budget());
                    if (catalog.exitCode !== 0) return fail(output(catalog));
                    record(current, "done", "registered as an install source (installAllowed=true)");
                }
            }
            const installed = installedExtensions(repo);
            const hint = params.installAllowed || envCatalog ? "" : " (an extension found only in the community catalog needs installAllowed=true)";
            for (const ext of EXTENSIONS) {
                current = `extension ${ext}`;
                if (installed.has(ext)) {
                    record(current, "skipped", "already installed");
                    continue;
                }
                const add = await run(["specify", "extension", "add", ext], repo, budget());
                if (add.exitCode !== 0) return fail(`${output(add)}${hint}`);
                record(current, "done", "installed");
            }
        }
        current = "beads";
        if (params.skipBeads) record(current, "skipped", "beads explicitly omitted; molecule workflows are unavailable");
        else {
            const deadline = budget();
            if (!(await which("bd", deadline))) return fail("bd not on PATH; install beads or explicitly set skipBeads=true for SpecKit-only setup");
            const where = await run(["bd", "where"], repo, deadline);
            if (where.exitCode === 0) record(current, "skipped", "beads workspace already present");
            else {
                const init = await run(["bd", "init", "--skip-hooks"], repo, deadline);
                if (init.exitCode !== 0) return fail(`bd init: ${output(init)}`);
                record(current, "done", "bd init --skip-hooks");
            }
            current = "formulas";
            const copied = installFormulas(repo, join(pluginRoot(), "formulas"));
            record(current, copied.length ? "done" : "skipped", copied.length ? copied.join(", ") : "every formula already present");
        }
        current = "gitignore";
        const gitignore = ensureGitignore(repo);
        record(current, gitignore.startsWith("appended") ? "done" : "skipped", gitignore);
        return finish();
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
			"Resumable SpecKit bootstrap in the caller's workspace: specify init, opt-in community catalog, required extensions, copy bd formulas, gitignore spec-status.md. Each phase has its own timeout and skips work already done.",
		parameters: z.object({
			integration: z.string().optional().describe("specify integration (codex|claude). Default codex"),
			script: z.string().optional().describe("specify script flavor (sh|ps). Default sh"),
			force: z.boolean().optional().describe("Re-run specify init even if .specify exists"),
			workspace: z.string().optional().describe("Repo root, resolved against the caller's working directory; defaults to it"),
			installAllowed: z
				.boolean()
				.optional()
				.describe("Register the public community catalog as a trusted install source (--install-allowed). Opt in only after vetting the required extensions"),
			skipBeads: z.boolean().optional().describe("Explicitly omit beads and formulas; molecule workflows unavailable"),
			skipSpecify: z
				.boolean()
				.optional()
				.describe("Skip specify CLI (formulas + gitignore only)"),
		}) as unknown as TSchema,
		execute: async (_id, params: SetupParams, _signal, _onUpdate, ctx) => {
			try {
				const result = await runSetup(params, ctx.cwd);
				return {
					content: [{ type: "text", text: result.text }],
					details: { ok: result.ok, phases: result.phases },
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
