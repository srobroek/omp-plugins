import {
	existsSync,
	mkdirSync,
	copyFileSync,
	appendFileSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 180_000;

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
	"agent-assign",
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

export function run(
	argv: string[],
	cwd?: string,
): { exitCode: number; stdout: string; stderr: string } {
	if (testSpawn) return testSpawn(argv, { cwd, timeout: TIMEOUT_MS });
	try {
		const proc = Bun.spawnSync(argv, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		return {
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, stdout: "", stderr: message };
	}
}

export function which(bin: string): boolean {
	if (testSpawn) return testSpawn(["which", bin]).exitCode === 0;
	try {
		const proc = Bun.spawnSync(["which", bin], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5_000,
		});
		return proc.exitCode === 0;
	} catch {
		return false;
	}
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

export function installFormulas(repo: string, srcDir: string): string[] {
	const lines: string[] = [];
	const destDir = join(repo, ".beads", "formulas");
	mkdirSync(destDir, { recursive: true });
	for (const name of FORMULAS) {
		const src = join(srcDir, `${name}.formula.toml`);
		if (!existsSync(src)) {
			lines.push(`WARNING: ${name} formula not found at ${src}`);
			continue;
		}
		copyFileSync(src, join(destDir, `${name}.formula.toml`));
		lines.push(`copied ${name}`);
	}
	return lines;
}

export type SetupParams = {
	integration?: string;
	script?: string;
	force?: boolean;
	workspace?: string;
	skipSpecify?: boolean;
};

export function runSetup(params: SetupParams): { ok: boolean; text: string } {
	const repo = params.workspace ?? process.cwd();
	const log: string[] = [];
	const integration = params.integration ?? "codex";
	const script = params.script ?? "sh";

	if (!params.skipSpecify) {
		if (!which("specify")) {
			return { ok: false, text: "ERROR: specify not on PATH. uv tool install specify-cli" };
		}
		const ver = run(["specify", "--version"], repo);
		if (!specifyVersionOk(`${ver.stdout}\n${ver.stderr}`)) {
			return {
				ok: false,
				text: `ERROR: specify-cli >= 0.12.0 required. Got: ${ver.stdout || ver.stderr}`,
			};
		}
		const specifyDir = join(repo, ".specify");
		if (!existsSync(specifyDir) || params.force) {
			const init = run(
				["specify", "init", "--here", "--force", "--integration", integration, "--script", script],
				repo,
			);
			log.push(`specify init exit=${init.exitCode}`);
			if (init.stdout) log.push(init.stdout.trim());
			if (init.exitCode !== 0) log.push(init.stderr.trim());
		} else {
			log.push(".specify already present (pass force=true to re-scaffold)");
		}

		run(
			[
				"specify",
				"extension",
				"catalog",
				"add",
				"--name",
				"community",
				"--install-allowed",
				CATALOG_URL,
			],
			repo,
		);
		log.push("catalog add attempted");

		for (const ext of EXTENSIONS) {
			const add = run(["specify", "extension", "add", ext], repo);
			if (add.exitCode !== 0) log.push(`WARNING: extension ${ext} skipped: ${add.stderr.trim()}`);
			else log.push(`extension ${ext} ok`);
		}
		const status = run(
			["specify", "extension", "add", "status-report", "--from", STATUS_REPORT_FROM],
			repo,
		);
		if (status.exitCode !== 0) log.push(`WARNING: status-report skipped: ${status.stderr.trim()}`);
		else log.push("extension status-report ok");
	} else {
		log.push("skipSpecify: specify CLI steps omitted");
	}

	if (which("bd")) {
		const where = run(["bd", "where"], repo);
		if (where.exitCode !== 0) {
			const init = run(["bd", "init", "--skip-hooks"], repo);
			log.push(`bd init exit=${init.exitCode}`);
		} else {
			log.push("beads workspace already present");
		}
		log.push(...installFormulas(repo, join(pluginRoot(), "formulas")));
	} else {
		log.push("SKIP: bd not on PATH — formulas not installed");
	}

	log.push(ensureGitignore(repo));
	return { ok: true, text: log.join("\n") };
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
			skipSpecify: z
				.boolean()
				.optional()
				.describe("Skip specify CLI (formulas + gitignore only)"),
		}),
		execute: async (_id, params: SetupParams) => {
			try {
				const result = runSetup(params);
				return {
					content: [{ type: "text", text: result.text }],
					details: { ok: result.ok },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `setup failed open: ${message}` }],
					details: { ok: false },
				};
			}
		},
	});
}
