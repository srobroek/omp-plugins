import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type ProjectSetupScanParams = {
	path?: string;
};

export type DetectedModule = {
	id: string;
	root: "project" | "bundled-hint";
	path: string;
};

export type ProjectSetupScanResult = {
	ok: boolean;
	path: string;
	mode: "init" | "reproduce";
	git: {
		present: boolean;
		root: boolean;
		hasRemote: boolean;
		branch: string | null;
	};
	license: { present: boolean; files: string[]; guessed: string | null };
	ci: { present: boolean; workflows: string[] };
	gitignore: { present: boolean };
	packageManagers: string[];
	languages: string[];
	existingModules: DetectedModule[];
	projectSetup: {
		dir: boolean;
		sourcesToml: boolean;
		answersToml: boolean;
		enabled: string[];
	};
	omp: {
		pluginManifest: boolean;
		marketplaceJson: boolean;
		linkedHint: boolean;
	};
	topLevelDirs: string[];
};

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "UNLICENSE"];

const PM_MARKERS: Array<{ file: string; name: string }> = [
	{ file: "pnpm-lock.yaml", name: "pnpm" },
	{ file: "bun.lock", name: "bun" },
	{ file: "bun.lockb", name: "bun" },
	{ file: "yarn.lock", name: "yarn" },
	{ file: "package-lock.json", name: "npm" },
	{ file: "Cargo.toml", name: "cargo" },
	{ file: "go.mod", name: "go" },
	{ file: "pyproject.toml", name: "uv/pip" },
	{ file: "uv.lock", name: "uv" },
	{ file: "poetry.lock", name: "poetry" },
	{ file: "Pipfile.lock", name: "pipenv" },
	{ file: "Gemfile", name: "bundler" },
	{ file: "composer.json", name: "composer" },
];

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function readText(p: string): string | null {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

function guessLicense(text: string): string | null {
	const t = text.slice(0, 400).toLowerCase();
	if (t.includes("apache license") && t.includes("version 2.0")) return "apache-2.0";
	if (t.includes("mit license")) return "mit";
	if (t.includes("gnu general public license") && t.includes("version 3")) return "gpl-3.0";
	if (t.includes("gnu general public license") && t.includes("version 2")) return "gpl-2.0";
	if (t.includes("mozilla public license")) return "mpl-2.0";
	if (t.includes("bsd 3-clause") || t.includes("redistribution and use in source and binary"))
		return "bsd-3-clause";
	if (t.includes("unlicense")) return "unlicense";
	return null;
}

function detectGit(cwd: string): ProjectSetupScanResult["git"] {
	const root = isDir(join(cwd, ".git")) || isFile(join(cwd, ".git"));
	if (!root) {
		return { present: false, root: false, hasRemote: false, branch: null };
	}
	const branchRun = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
		encoding: "utf8",
		timeout: 5000,
	});
	const remoteRun = spawnSync("git", ["-C", cwd, "remote"], {
		encoding: "utf8",
		timeout: 5000,
	});
	const branch =
		branchRun.status === 0 ? (branchRun.stdout ?? "").trim() || null : null;
	const hasRemote = remoteRun.status === 0 && (remoteRun.stdout ?? "").trim().length > 0;
	return { present: true, root: true, hasRemote, branch };
}

function detectLicense(cwd: string): ProjectSetupScanResult["license"] {
	const files: string[] = [];
	for (const name of LICENSE_FILES) {
		if (isFile(join(cwd, name))) files.push(name);
	}
	let guessed: string | null = null;
	if (files[0]) {
		const body = readText(join(cwd, files[0]));
		if (body) guessed = guessLicense(body);
	}
	return { present: files.length > 0, files, guessed };
}

function detectCi(cwd: string): ProjectSetupScanResult["ci"] {
	const wfDir = join(cwd, ".github", "workflows");
	if (!isDir(wfDir)) return { present: false, workflows: [] };
	let names: string[] = [];
	try {
		names = readdirSync(wfDir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
	} catch {
		names = [];
	}
	return { present: names.length > 0, workflows: names.sort() };
}

function detectPackageManagers(cwd: string): string[] {
	const found: string[] = [];
	for (const m of PM_MARKERS) {
		if (isFile(join(cwd, m.file)) && !found.includes(m.name)) found.push(m.name);
	}
	if (isFile(join(cwd, "package.json")) && !found.some((n) => ["pnpm", "bun", "yarn", "npm"].includes(n))) {
		found.push("npm");
	}
	return found;
}

function detectLanguages(cwd: string, pms: string[]): string[] {
	const langs = new Set<string>();
	if (pms.includes("cargo")) langs.add("rust");
	if (pms.includes("go")) langs.add("go");
	if (pms.includes("uv") || pms.includes("uv/pip") || pms.includes("poetry") || pms.includes("pipenv"))
		langs.add("python");
	if (pms.includes("pnpm") || pms.includes("bun") || pms.includes("yarn") || pms.includes("npm"))
		langs.add("typescript");
	if (isFile(join(cwd, "go.mod"))) langs.add("go");
	if (isFile(join(cwd, "Cargo.toml"))) langs.add("rust");
	if (isFile(join(cwd, "pyproject.toml")) || isFile(join(cwd, "requirements.txt"))) langs.add("python");
	return [...langs].sort();
}

function parseEnabled(answers: string): string[] {
	const m = answers.match(/enabled\s*=\s*\[([^\]]*)\]/s);
	if (!m) return [];
	const inner = m[1] ?? "";
	return [...inner.matchAll(/["']([^"']+)["']/g)].map((x) => x[1] ?? "").filter(Boolean);
}

function discoverModules(dir: string, root: DetectedModule["root"]): DetectedModule[] {
	if (!isDir(dir)) return [];
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: DetectedModule[] = [];
	for (const name of entries) {
		const child = join(dir, name);
		if (!isDir(child)) continue;
		if (isFile(join(child, "module.toml"))) {
			out.push({ id: name, root, path: child });
		}
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

function detectOmp(cwd: string): ProjectSetupScanResult["omp"] {
	return {
		pluginManifest: isFile(join(cwd, ".omp-plugin", "plugin.json")) || isDir(join(cwd, ".omp-plugin")),
		marketplaceJson: isFile(join(cwd, ".omp-plugin", "marketplace.json")),
		linkedHint: isFile(join(cwd, "package.json")) && (readText(join(cwd, "package.json")) ?? "").includes('"omp"'),
	};
}

function topLevelDirs(cwd: string): string[] {
	if (!isDir(cwd)) return [];
	try {
		return readdirSync(cwd)
			.filter((n) => isDir(join(cwd, n)))
			.sort();
	} catch {
		return [];
	}
}

export function scanProject(cwd: string): ProjectSetupScanResult {
	const sourcesToml = isFile(join(cwd, ".project-setup", "sources.toml"));
	const answersToml = isFile(join(cwd, ".project-setup", "answers.toml"));
	const answersBody = answersToml ? readText(join(cwd, ".project-setup", "answers.toml")) : null;
	const enabled = answersBody ? parseEnabled(answersBody) : [];
	const projectModules = discoverModules(join(cwd, ".project-setup", "modules"), "project");
	const pms = detectPackageManagers(cwd);
	return {
		ok: true,
		path: cwd,
		mode: sourcesToml ? "reproduce" : "init",
		git: detectGit(cwd),
		license: detectLicense(cwd),
		ci: detectCi(cwd),
		gitignore: { present: isFile(join(cwd, ".gitignore")) },
		packageManagers: pms,
		languages: detectLanguages(cwd, pms),
		existingModules: projectModules,
		projectSetup: {
			dir: isDir(join(cwd, ".project-setup")),
			sourcesToml,
			answersToml,
			enabled,
		},
		omp: detectOmp(cwd),
		topLevelDirs: topLevelDirs(cwd),
	};
}

export default function projectSetupScan(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "project_setup_scan",
		label: "Scan project setup state",
		description:
			"Read-only detect of existing repo state for project-setup: git, license, CI, gitignore, package managers, languages, .project-setup modules, and init vs reproduce mode.",
		parameters: z.object({
			path: z.string().optional().describe("Project directory; defaults to session cwd"),
		}),
		approval: "read",
		execute: async (_id, params: ProjectSetupScanParams, _signal, _onUpdate, ctx) => {
			const cwd = params.path ?? ctx?.cwd ?? process.cwd();
			try {
				if (!existsSync(cwd) || !isDir(cwd)) {
					return {
						content: [{ type: "text", text: `project_setup_scan: not a directory: ${cwd}` }],
						details: { ok: false, error: "not_a_directory", path: cwd },
					};
				}
				const result = scanProject(cwd);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `project_setup_scan failed: ${message}` }],
					details: { ok: false, error: message, path: cwd },
				};
			}
		},
	});
}

if (import.meta.main) {
	const cwd = process.argv[2] ?? process.cwd();
	console.log(JSON.stringify(scanProject(cwd), null, 2));
}
