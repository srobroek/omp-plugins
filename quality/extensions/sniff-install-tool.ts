import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const BUNDLES = [
	"core",
	"dup",
	"security",
	"rust",
	"go",
	"python",
	"js-ts",
	"shell",
	"sql",
	"css",
	"data",
	"api",
	"infra",
	"docs",
] as const;

type BundleName = (typeof BUNDLES)[number];

type ToolRec = {
	name: string;
	bin: string;
	key: string;
	hint: string;
	pkg?: string;
	miseSpec?: string;
};

const TOOLS: Record<BundleName, ToolRec[]> = {
	core: [
		{ name: "semgrep", bin: "semgrep", key: "pipx", hint: "pipx install semgrep  (or: brew install semgrep)" },
		{ name: "lizard", bin: "lizard", key: "pipx", hint: "pipx install lizard" },
		{
			name: "scc",
			bin: "scc",
			key: "brew",
			hint: "brew install scc  (or: go install github.com/boyter/scc/v3@latest)",
			miseSpec: "go:github.com/boyter/scc/v3",
		},
	],
	dup: [{ name: "jscpd", bin: "jscpd", key: "npm", hint: "npm i -g jscpd" }],
	security: [
		{ name: "trivy", bin: "trivy", key: "brew", hint: "brew install trivy  (or: https://aquasecurity.github.io/trivy)" },
		{ name: "checkov", bin: "checkov", key: "pipx", hint: "pipx install checkov" },
		{
			name: "gitleaks",
			bin: "gitleaks",
			key: "brew",
			hint: "brew install gitleaks  (used by the secrets-scan package too)",
		},
	],
	rust: [
		{ name: "clippy", bin: "cargo-clippy", key: "rustup", hint: "rustup component add clippy" },
		{ name: "cargo-machete", bin: "cargo-machete", key: "cargo", hint: "cargo install cargo-machete" },
	],
	go: [
		{
			name: "golangci-lint",
			bin: "golangci-lint",
			key: "brew",
			hint: "brew install golangci-lint  (or: https://golangci-lint.run)",
		},
		{
			name: "deadcode",
			bin: "deadcode",
			key: "go",
			hint: "go install golang.org/x/tools/cmd/deadcode@latest",
			miseSpec: "go:golang.org/x/tools/cmd/deadcode",
		},
	],
	python: [
		{ name: "ruff", bin: "ruff", key: "pipx", hint: "pipx install ruff  (or: uv tool install ruff)" },
		{ name: "vulture", bin: "vulture", key: "pipx", hint: "pipx install vulture" },
		{ name: "pylint", bin: "pylint", key: "pipx", hint: "pipx install pylint" },
		{ name: "mypy", bin: "mypy", key: "pipx", hint: "pipx install mypy" },
		{ name: "pyright", bin: "pyright", key: "pipx", hint: "pipx install pyright  (or: npm i -g pyright)" },
	],
	"js-ts": [
		{
			name: "eslint",
			bin: "eslint",
			key: "npm-local",
			hint: "npm i -D eslint typescript-eslint eslint-plugin-sonarjs eslint-plugin-unicorn  (project-local; sonarjs = cognitive-complexity + dup)",
		},
		{ name: "knip", bin: "knip", key: "npm-local", hint: "npm i -D knip  (project-local; dead files/exports/deps)" },
		{ name: "madge", bin: "madge", key: "npm-local", hint: "npm i -D madge  (project-local; circular deps)" },
		{
			name: "type-coverage",
			bin: "type-coverage",
			key: "npm-local",
			hint: "npm i -D type-coverage  (project-local; any-leakage %)",
		},
		{
			name: "dependency-cruiser",
			bin: "depcruise",
			key: "npm-local",
			hint: "npm i -D dependency-cruiser  (project-local; cycles + architecture boundaries)",
		},
		{
			name: "biome",
			bin: "biome",
			key: "npm-local",
			hint: "npm i -D --save-exact @biomejs/biome  (project-local; fast lint+fmt, JSON too)",
		},
		{
			name: "svelte-check",
			bin: "svelte-check",
			key: "npm-local",
			hint: "npm i -D svelte-check  (project-local; Svelte compiler/type/a11y diagnostics)",
		},
		{
			name: "vue-tsc",
			bin: "vue-tsc",
			key: "npm-local",
			hint: "npm i -D vue-tsc  (project-local; Vue SFC-aware type checking)",
		},
	],
	shell: [
		{ name: "shellcheck", bin: "shellcheck", key: "brew", hint: "brew install shellcheck" },
		{ name: "shfmt", bin: "shfmt", key: "brew", hint: "brew install shfmt" },
	],
	sql: [
		{ name: "sqlfluff", bin: "sqlfluff", key: "pipx", hint: "pipx install sqlfluff" },
		{ name: "squawk", bin: "squawk", key: "cargo", hint: "cargo install squawk  (Postgres migration safety)" },
	],
	css: [
		{
			name: "stylelint",
			bin: "stylelint",
			key: "npm-local",
			hint: "npm i -D stylelint stylelint-config-standard stylelint-config-recommended-scss  (project-local; add -recommended-vue for Vue SFC styles)",
		},
		{
			name: "stylelint-declaration-strict-value",
			bin: "stylelint",
			key: "npm-local",
			hint: "npm i -D stylelint-declaration-strict-value  (project-local; OPT-IN: enforce tokens over magic colors/sizes)",
		},
	],
	data: [
		{ name: "yamllint", bin: "yamllint", key: "pipx", hint: "pipx install yamllint" },
		{
			name: "taplo",
			bin: "taplo",
			key: "cargo",
			hint: "cargo install taplo-cli --locked  (or: brew install taplo)",
			pkg: "taplo-cli",
		},
		{ name: "check-jsonschema", bin: "check-jsonschema", key: "pipx", hint: "pipx install check-jsonschema" },
	],
	api: [
		{
			name: "vacuum",
			bin: "vacuum",
			key: "brew",
			hint: "brew install daveshanley/vacuum/vacuum  (OpenAPI lint; Go, fast, spectral-ruleset compatible)",
			pkg: "daveshanley/vacuum/vacuum",
		},
		{
			name: "spectral",
			bin: "spectral",
			key: "npm",
			hint: "npm i -g @stoplight/spectral-cli  (OpenAPI lint; Node alternative to vacuum)",
			pkg: "@stoplight/spectral-cli",
		},
		{
			name: "oasdiff",
			bin: "oasdiff",
			key: "brew",
			hint: "brew install oasdiff/homebrew-oasdiff/oasdiff  (OPT-IN: OpenAPI breaking-change vs base; needs CI baseline)",
			pkg: "oasdiff/homebrew-oasdiff/oasdiff",
		},
		{
			name: "graphql-inspector",
			bin: "graphql-inspector",
			key: "npm",
			hint: "npm i -g @graphql-inspector/cli  (OPT-IN: GraphQL breaking-change diff; needs baseline)",
		},
		{
			name: "buf",
			bin: "buf",
			key: "brew",
			hint: "brew install bufbuild/buf/buf  (or: https://buf.build)",
			pkg: "bufbuild/buf/buf",
		},
		{
			name: "openapi-spec-validator",
			bin: "openapi-spec-validator",
			key: "pipx",
			hint: "pipx install openapi-spec-validator  (OpenAPI structural validity gate)",
		},
		{
			name: "protolint",
			bin: "protolint",
			key: "go",
			hint: "go install github.com/yoheimuta/protolint/cmd/protolint@latest",
			miseSpec: "go:github.com/yoheimuta/protolint/cmd/protolint",
		},
	],
	infra: [
		{ name: "hadolint", bin: "hadolint", key: "brew", hint: "brew install hadolint" },
		{ name: "tflint", bin: "tflint", key: "brew", hint: "brew install tflint" },
		{ name: "actionlint", bin: "actionlint", key: "brew", hint: "brew install actionlint" },
		{
			name: "zizmor",
			bin: "zizmor",
			key: "pipx",
			hint: "pipx install zizmor  (OPT-IN: GitHub Actions security dataflow)",
		},
		{
			name: "pinact",
			bin: "pinact",
			key: "go",
			hint: "go install github.com/suzuki-shunsuke/pinact/cmd/pinact@latest  (OPT-IN: pin actions to commit SHAs)",
			miseSpec: "go:github.com/suzuki-shunsuke/pinact/cmd/pinact",
		},
		{ name: "kube-linter", bin: "kube-linter", key: "brew", hint: "brew install kube-linter" },
		{
			name: "kubeconform",
			bin: "kubeconform",
			key: "brew",
			hint: "brew install kubeconform  (k8s manifest schema validation)",
		},
	],
	docs: [
		{ name: "markdownlint-cli2", bin: "markdownlint-cli2", key: "npm", hint: "npm i -g markdownlint-cli2" },
		{
			name: "lychee",
			bin: "lychee",
			key: "cargo",
			hint: "cargo install lychee  (or: brew install lychee)  (OPT-IN: dead-link check; network)",
		},
		{
			name: "cspell",
			bin: "cspell",
			key: "npm",
			hint: "npm i -g cspell  (OPT-IN: offline spell-check across code + docs)",
		},
	],
};
const PROBE_TIMEOUT_MS = 1_500;
const INSTALL_TIMEOUT_MS = 300_000;

function have(bin: string): boolean {
	const proc = Bun.spawnSync(["sh", "-c", `command -v ${JSON.stringify(bin)}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return proc.exitCode === 0;
}

function runnable(bin: string): boolean {
	if (!have(bin)) return false;
	for (const flag of ["--version", "--help"]) {
		try {
			const proc = Bun.spawnSync([bin, flag], {
				stdout: "pipe",
				stderr: "pipe",
				stdin: new Uint8Array(),
				timeout: PROBE_TIMEOUT_MS,
			});
			if (proc.exitCode === 0) return true;
		} catch {
			// timeout or spawn failure — try next flag
		}
	}
	return false;
}

function managerCmd(key: string, preferMise: boolean): string {
	if (preferMise) {
		if (key === "cargo") return "mise-cargo";
		if (key === "npm") return "mise-npm";
		if (key === "pipx") return "mise-pipx";
		if (key === "go" || key === "brew") return "mise-reg";
	}
	switch (key) {
		case "brew":
			return have("brew") ? "brew" : "";
		case "pipx":
			if (have("pipx")) return "pipx";
			if (have("uv")) return "uv-tool";
			return "";
		case "npm":
			return have("npm") ? "npm" : "";
		case "npm-local":
			return have("npm") ? "npm-local" : "";
		case "cargo":
			return have("cargo") ? "cargo" : "";
		case "go":
			return have("go") ? "go" : "";
		case "rustup":
			return have("rustup") ? "rustup" : "";
		default:
			return "";
	}
}

function runArgv(
	argv: string[],
	cwd: string,
	dryRun: boolean,
	lines: string[],
): void {
	lines.push(`  + ${argv.join(" ")}`);
	if (dryRun) return;
	try {
		const proc = Bun.spawnSync(argv, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: INSTALL_TIMEOUT_MS,
		});
		const out = proc.stdout.toString();
		const err = proc.stderr.toString();
		if (out) lines.push(out.replace(/\n$/, ""));
		if (err) lines.push(err.replace(/\n$/, ""));
		if (proc.exitCode !== 0) {
			lines.push(`      (failed — exit ${proc.exitCode})`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		lines.push(`      (failed — ${message})`);
	}
}

function installOne(rec: ToolRec, cwd: string, preferMise: boolean, dryRun: boolean, lines: string[]): void {
	const pkg = rec.pkg ?? rec.name;
	const miseSpec = rec.miseSpec ?? rec.bin;
	if (runnable(rec.bin)) {
		lines.push(`  = ${rec.name} already installed`);
		return;
	}
	if (have(rec.bin)) {
		lines.push(`  ~ ${rec.name} present but not runnable (shim?) — (re)installing to make it work`);
	}
	const mgr = managerCmd(rec.key, preferMise);
	if (!mgr) {
		lines.push(`  ! ${rec.name}: no supported manager on PATH — install manually:`);
		lines.push(`      ${rec.hint}`);
		return;
	}
	lines.push(`  installing ${rec.name} via ${mgr} ...`);
	switch (mgr) {
		case "brew":
			runArgv(["brew", "install", pkg], cwd, dryRun, lines);
			break;
		case "pipx":
			runArgv(["pipx", "install", pkg], cwd, dryRun, lines);
			break;
		case "uv-tool":
			runArgv(["uv", "tool", "install", pkg], cwd, dryRun, lines);
			break;
		case "npm":
			runArgv(["npm", "install", "-g", pkg], cwd, dryRun, lines);
			break;
		case "cargo":
			runArgv(["cargo", "install", pkg], cwd, dryRun, lines);
			break;
		case "go": {
			let goPath = miseSpec.startsWith("go:") ? miseSpec.slice(3) : miseSpec;
			if (!goPath.includes("@")) goPath = `${goPath}@latest`;
			runArgv(["go", "install", goPath], cwd, dryRun, lines);
			break;
		}
		case "rustup":
			runArgv(["rustup", "component", "add", "clippy"], cwd, dryRun, lines);
			break;
		case "mise-cargo":
			runArgv(["mise", "use", `cargo:${pkg}`], cwd, dryRun, lines);
			break;
		case "mise-npm":
			runArgv(["mise", "use", `npm:${pkg}`], cwd, dryRun, lines);
			break;
		case "mise-pipx":
			runArgv(["mise", "use", `pipx:${pkg}`], cwd, dryRun, lines);
			break;
		case "mise-reg":
			runArgv(["mise", "use", miseSpec], cwd, dryRun, lines);
			break;
		case "npm-local":
			lines.push(`  ! ${rec.name} is project-local — install inside the repo, not globally:`);
			lines.push(`      ${rec.hint}`);
			break;
		default:
			lines.push(`  ! ${rec.name}: unknown manager ${mgr}`);
	}
}

function probeBundle(name: BundleName, lines: string[]): void {
	const tools = TOOLS[name];
	let installed = 0;
	let missing = 0;
	let shim = 0;
	lines.push("");
	lines.push(`[${name}]`);
	for (const rec of tools) {
		if (runnable(rec.bin)) {
			lines.push(`  ok   ${rec.name}`);
			installed += 1;
		} else if (have(rec.bin)) {
			lines.push(`  SHIM ${rec.name}   — on PATH but not runnable; install to activate: ${rec.hint}`);
			shim += 1;
		} else {
			lines.push(`  MISS ${rec.name}   — ${rec.hint}`);
			missing += 1;
		}
	}
	if (shim > 0) {
		lines.push(`  (${installed} usable, ${shim} unrunnable/shim, ${missing} missing)`);
	} else {
		lines.push(`  (${installed} installed, ${missing} missing)`);
	}
}

function listBundle(name: BundleName, lines: string[]): void {
	lines.push("");
	lines.push(`[${name}]`);
	for (const rec of TOOLS[name]) {
		lines.push(`  ${rec.name.padEnd(18)} ${rec.hint}`);
	}
}

export type SniffInstallMode = "probe" | "list" | "install";

export type SniffInstallOptions = {
	mode?: SniffInstallMode;
	bundles?: string[];
	all?: boolean;
	dryRun?: boolean;
	noMise?: boolean;
	cwd?: string;
};

export function runSniffInstall(opts: SniffInstallOptions): { ok: boolean; report: string } {
	const mode: SniffInstallMode = opts.mode ?? "probe";
	const cwd = opts.cwd ?? process.cwd();
	const preferMise = !opts.noMise && have("mise");
	const lines: string[] = [];

	if (mode === "probe") {
		lines.push("sniff tool probe (all tools optional; missing ones are skipped, not fatal)");
		for (const b of BUNDLES) probeBundle(b, lines);
		lines.push("");
		lines.push("Install a bundle with: sniff_install_tools mode=install bundles=[<bundle>]");
		return { ok: true, report: lines.join("\n") };
	}

	if (mode === "list") {
		for (const b of BUNDLES) listBundle(b, lines);
		return { ok: true, report: lines.join("\n") };
	}

	const targets: string[] = opts.all ? [...BUNDLES] : (opts.bundles ?? []);
	if (targets.length === 0) {
		return {
			ok: false,
			report: `sniff_install_tools: install needs at least one bundle name (known: ${BUNDLES.join(" ")})`,
		};
	}
	for (const t of targets) {
		if (!(t in TOOLS)) {
			return {
				ok: false,
				report: `sniff: unknown bundle "${t}" (known: ${BUNDLES.join(" ")})`,
			};
		}
	}
	if (opts.dryRun) lines.push("(dry run — no changes will be made)");
	for (const t of targets) {
		const b = t as BundleName;
		lines.push("");
		lines.push(`[${b}]`);
		for (const rec of TOOLS[b]) {
			installOne(rec, cwd, preferMise, Boolean(opts.dryRun), lines);
		}
	}
	lines.push("");
	lines.push("Done. Re-run probe to confirm.");
	return { ok: true, report: lines.join("\n") };
}

type ToolParams = {
	mode?: SniffInstallMode;
	bundles?: string[];
	all?: boolean;
	dryRun?: boolean;
	noMise?: boolean;
	path?: string;
};

export default function sniffInstallTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "sniff_install_tools",
		label: "Sniff install tools",
		description:
			"Probe, list, or install sniff smell-scanner bundles (mise-first, skip-if-present). Never sudo. Default mode is probe.",
		parameters: z.object({
			mode: z
				.enum(["probe", "list", "install"])
				.optional()
				.describe("probe (default), list, or install"),
			bundles: z
				.array(z.string())
				.optional()
				.describe("Bundle names for install: core dup security rust go python js-ts shell sql css data api infra docs"),
			all: z.boolean().optional().describe("Install every bundle"),
			dryRun: z.boolean().optional().describe("Print install commands without running them"),
			noMise: z.boolean().optional().describe("Ignore mise even if present"),
			path: z.string().optional().describe("Repo cwd for mise-local pins; defaults to current working directory"),
		}),
		execute: async (_id, params: ToolParams, _signal, _onUpdate, ctx) => {
			try {
				const result = runSniffInstall({
					mode: params.mode,
					bundles: params.bundles,
					all: params.all,
					dryRun: params.dryRun,
					noMise: params.noMise,
					cwd: params.path ?? ctx?.cwd ?? process.cwd(),
				});
				return {
					content: [{ type: "text", text: result.report }],
					details: { ok: result.ok },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `sniff_install_tools failed: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	let mode: SniffInstallMode = "probe";
	let dryRun = false;
	let noMise = false;
	let all = false;
	const bundles: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--probe") mode = "probe";
		else if (a === "--list") mode = "list";
		else if (a === "--all") {
			mode = "install";
			all = true;
		} else if (a === "--install") {
			mode = "install";
		} else if (a === "--dry-run") dryRun = true;
		else if (a === "--no-mise") noMise = true;
		else if (a === "-h" || a === "--help") {
			console.log(
				"usage: sniff-install-tool.ts [--probe | --list | --install <bundle>... | --all] [--dry-run] [--no-mise]",
			);
			process.exit(0);
		} else if (!a.startsWith("--")) {
			bundles.push(a);
		} else {
			console.error(`unknown argument: ${a}`);
			process.exit(2);
		}
	}
	const result = runSniffInstall({ mode, bundles, all, dryRun, noMise });
	console.log(result.report);
	process.exit(result.ok ? 0 : 2);
}
