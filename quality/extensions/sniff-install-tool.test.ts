import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import sniffInstallTool, {
	type CommandResult,
	runSniffAnalyzer,
	runSniffInstall,
	type SniffInstallRuntime,
} from "./sniff-install-tool.ts";
import { TOOLS } from "./sniff-tool-catalog.ts";

const temps: string[] = [];

afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function executable(path: string, body: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

function commandResult(
	argv: string[],
	timeoutMs: number,
	overrides: Partial<CommandResult> = {},
): CommandResult {
	return {
		argv,
		exitCode: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		timeoutMs,
		...overrides,
	};
}

function fakeRuntime(
	overrides: Partial<SniffInstallRuntime> = {},
): SniffInstallRuntime {
	return {
		resolveCommand: (bin) => `/fake/bin/${bin}`,
		readLauncher: () => "",
		run: (argv, _cwd, _env, timeoutMs) => commandResult(argv, timeoutMs),
		freshEnvironment: (_cwd, env, miseAware) => ({
			env: { ...env, FRESH: "1" },
			source: miseAware ? "mise" : "process",
		}),
		...overrides,
	};
}

function fakeZod(enumCalls: string[][]): { zod: unknown } {
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	chain.string = self;
	chain.optional = self;
	chain.describe = self;
	chain.object = self;
	chain.array = self;
	chain.number = self;
	chain.boolean = self;
	chain.enum = (values: string[]) => {
		enumCalls.push(values);
		return chain;
	};
	return { zod: chain };
}

describe("sniff tool catalog", () => {
	test("runtime identities are unique and hosted plugins stay metadata", () => {
		const tools = Object.values(TOOLS).flat();
		const seen = new Set<string>();
		for (const tool of tools) {
			expect(seen.has(tool.name)).toBe(false);
			seen.add(tool.name);
		}
		expect(tools.some((tool) => tool.name === "stylelint-order")).toBe(false);
		expect(
			tools.some((tool) => tool.name === "stylelint-declaration-strict-value"),
		).toBe(false);
		const stylelint = tools.find((tool) => tool.name === "stylelint");
		expect(stylelint?.hostPackages).toContain("stylelint-order");
		expect(stylelint?.hostPackages).toContain(
			"stylelint-declaration-strict-value",
		);
		expect(stylelint?.configFiles).toContain("stylelint.config.js");
		expect(tools.find((tool) => tool.name === "graphql-inspector")?.pkg).toBe(
			"@graphql-inspector/cli",
		);
		expect(tools.find((tool) => tool.name === "go-vet")?.key).toBe("manual");
	});
});

describe("runSniffInstall", () => {
	test("list mode preserves bundle inventory", () => {
		const result = runSniffInstall({ mode: "list" });
		expect(result.ok).toBe(true);
		for (const bundle of [
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
		]) {
			expect(result.report).toContain(`[${bundle}]`);
		}
		expect(result.report).toContain("semgrep");
		expect(result.report).toContain("golangci-lint");
	});

	test("probe stays successful with missing and shimmed tools", () => {
		const dir = tempDir("sniff-probe-");
		const shimDir = join(dir, ".mise", "shims");
		executable(join(shimDir, "semgrep"), 'exec mise x -- semgrep "$@"');
		const result = runSniffInstall({
			mode: "probe",
			cwd: dir,
			env: { PATH: shimDir },
		});
		expect(result.ok).toBe(true);
		expect(result.tools.find((tool) => tool.tool === "semgrep")?.status).toBe(
			"shimmed",
		);
		expect(result.tools.find((tool) => tool.tool === "scc")?.status).toBe(
			"missing",
		);
		expect(result.report).toContain("SHIM semgrep");
		expect(result.report).toContain("MISS scc");
	});

	test("probe preserves SHIM text for a broken PATH executable", () => {
		const dir = tempDir("sniff-probe-broken-");
		const binDir = join(dir, "bin");
		executable(join(binDir, "lizard"), "exit 19");
		const result = runSniffInstall({
			mode: "probe",
			cwd: dir,
			env: { PATH: binDir },
		});
		expect(result.ok).toBe(true);
		expect(result.tools.find((tool) => tool.tool === "lizard")?.status).toBe(
			"unrunnable",
		);
		expect(result.report).toContain("SHIM lizard");
	});

	test("preflight succeeds when every selected required tool is usable", () => {
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["core"],
			runtime: fakeRuntime(),
		});
		expect(result.ok).toBe(true);
		expect(result.tools.map((tool) => tool.tool)).toEqual([
			"semgrep",
			"lizard",
			"scc",
			"ast-grep",
			"tokei",
		]);
		expect(
			result.tools.every((tool) => tool.required && tool.status === "usable"),
		).toBe(true);
	});

	test("preflight fails for a missing required tool", () => {
		const runtime = fakeRuntime({
			resolveCommand: (bin) => (bin === "semgrep" ? null : `/fake/bin/${bin}`),
		});
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["core"],
			runtime,
		});
		expect(result.ok).toBe(false);
		const missing = result.tools.find((tool) => tool.tool === "semgrep");
		expect(missing).toMatchObject({ status: "missing", resolvedPath: null });
		expect(missing?.remediation).toContain("pipx install semgrep");
	});

	test("PATH launcher shim is classified as shimmed", () => {
		const dir = tempDir("sniff-shim-");
		const shimDir = join(dir, ".mise", "shims");
		executable(join(shimDir, "jscpd"), 'exec mise x -- jscpd "$@"');
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["dup"],
			cwd: dir,
			env: { PATH: shimDir },
		});
		expect(result.ok).toBe(false);
		expect(result.tools[0]).toMatchObject({
			status: "shimmed",
			resolvedPath: join(shimDir, "jscpd"),
		});
	});

	test("runnable launcher shim is still classified as shimmed", () => {
		const runtime = fakeRuntime({
			resolveCommand: (bin) => `/fake/.mise/shims/${bin}`,
			readLauncher: () => '#!/bin/sh\nexec mise x -- "$0" "$@"',
			run: (argv, _cwd, _env, timeoutMs) => commandResult(argv, timeoutMs),
		});
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["dup"],
			runtime,
		});
		expect(result.ok).toBe(false);
		expect(result.tools[0]).toMatchObject({ status: "shimmed", attempts: [] });
	});

	test("real executable failure is unrunnable rather than shimmed", () => {
		const dir = tempDir("sniff-broken-");
		const binDir = join(dir, "bin");
		executable(join(binDir, "jscpd"), "exit 17");
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["dup"],
			cwd: dir,
			env: { PATH: binDir },
		});
		expect(result.ok).toBe(false);
		expect(result.tools[0]).toMatchObject({
			status: "unrunnable",
			resolvedPath: join(binDir, "jscpd"),
		});
	});

	test("real sleeping executable is classified as timed-out", () => {
		const dir = tempDir("sniff-sleep-");
		const binDir = join(dir, "bin");
		executable(join(binDir, "jscpd"), "sleep 5");
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["dup"],
			cwd: dir,
			env: { PATH: `${binDir}${delimiter}/bin:/usr/bin` },
		});
		expect(result.ok).toBe(false);
		expect(result.tools[0]?.status).toBe("timed-out");
		expect(result.tools[0]?.attempts.every((attempt) => attempt.timedOut)).toBe(
			true,
		);
	});

	test("project-local-only tools require a project dependency", () => {
		const dir = tempDir("sniff-local-");
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["js-ts"],
			cwd: dir,
			env: { PATH: "" },
		});
		expect(result.ok).toBe(false);
		expect(
			result.tools.every((tool) => tool.status === "project-local-required"),
		).toBe(true);
	});

	test("project-local tools never fall back to a global executable", () => {
		const dir = tempDir("sniff-local-global-");
		const globalBin = join(dir, "global-bin");
		executable(join(globalBin, "eslint"), "exit 0");
		const result = runSniffInstall({
			mode: "diagnose",
			bundles: ["js-ts"],
			cwd: dir,
			env: { PATH: globalBin },
		});
		expect(result.tools.find((tool) => tool.tool === "eslint")).toMatchObject({
			status: "project-local-required",
			resolvedPath: null,
		});
	});

	test("installation timeout is structured as timed-out", () => {
		const runtime = fakeRuntime({
			resolveCommand: (bin) => (bin === "jscpd" ? null : `/fake/bin/${bin}`),
			run: (argv, _cwd, _env, timeoutMs) =>
				commandResult(argv, timeoutMs, {
					exitCode: null,
					timedOut: true,
					error: "operation timed out",
				}),
		});
		const result = runSniffInstall({
			mode: "install",
			bundles: ["dup"],
			noMise: true,
			runtime,
		});
		expect(result.ok).toBe(false);
		expect(result.tools[0]?.status).toBe("timed-out");
		expect(result.tools[0]?.install?.timeoutMs).toBe(300_000);
	});

	test("supply-chain trust denial is policy-blocked", () => {
		const runtime = fakeRuntime({
			resolveCommand: (bin) => (bin === "jscpd" ? null : `/fake/bin/${bin}`),
			run: (argv, _cwd, _env, timeoutMs) =>
				commandResult(argv, timeoutMs, {
					exitCode: 1,
					stderr: "package trust policy denied downgrade",
				}),
		});
		const result = runSniffInstall({
			mode: "install",
			bundles: ["dup"],
			noMise: true,
			runtime,
		});
		expect(result.tools[0]?.status).toBe("policy-blocked");
	});

	test("invalid manager registry route is unavailable-route", () => {
		const runtime = fakeRuntime({
			resolveCommand: (bin) => (bin === "jscpd" ? null : `/fake/bin/${bin}`),
			run: (argv, _cwd, _env, timeoutMs) =>
				commandResult(argv, timeoutMs, {
					exitCode: 1,
					stderr: "unknown registry backend for package",
				}),
		});
		const result = runSniffInstall({
			mode: "install",
			bundles: ["dup"],
			runtime,
		});
		expect(result.tools[0]?.status).toBe("unavailable-route");
	});

	test("generic nonzero installation is installation-failed", () => {
		const runtime = fakeRuntime({
			resolveCommand: (bin) => (bin === "jscpd" ? null : `/fake/bin/${bin}`),
			run: (argv, _cwd, _env, timeoutMs) =>
				commandResult(argv, timeoutMs, {
					exitCode: 73,
					stderr: "compiler exited unsuccessfully",
				}),
		});
		const result = runSniffInstall({
			mode: "install",
			bundles: ["dup"],
			runtime,
		});
		expect(result.tools[0]?.status).toBe("installation-failed");
	});

	test("successful mise install is re-probed in a fresh environment", () => {
		const calls: string[][] = [];
		const refreshes: boolean[] = [];
		const runtime = fakeRuntime({
			resolveCommand: (bin, _cwd, env) => {
				if (bin === "jscpd")
					return env.FRESH === "1" ? "/fresh/bin/jscpd" : null;
				return `/fake/bin/${bin}`;
			},
			run: (argv, _cwd, _env, timeoutMs) => {
				calls.push(argv);
				return commandResult(argv, timeoutMs);
			},
			freshEnvironment: (_cwd, env, miseAware) => {
				refreshes.push(miseAware);
				return { env: { ...env, FRESH: "1" }, source: "mise" };
			},
		});
		const result = runSniffInstall({
			mode: "install",
			bundles: ["dup"],
			runtime,
		});
		expect(result.ok).toBe(true);
		expect(result.tools[0]).toMatchObject({
			status: "usable",
			resolvedPath: "/fresh/bin/jscpd",
		});
		expect(calls.some((argv) => argv.join(" ") === "mise use npm:jscpd")).toBe(
			true,
		);
		expect(
			calls.some((argv) => argv.join(" ") === "/fresh/bin/jscpd --version"),
		).toBe(true);
		expect(refreshes).toEqual([true]);
	});

	test("install fails when a successful manager command leaves a shim", () => {
		const runtime = fakeRuntime({
			resolveCommand: (bin, _cwd, env) => {
				if (bin === "jscpd")
					return env.FRESH === "1" ? "/fresh/.mise/shims/jscpd" : null;
				return `/fake/bin/${bin}`;
			},
			readLauncher: () => '#!/bin/sh\nexec mise x -- jscpd "$@"',
			run: (argv, _cwd, env, timeoutMs) => {
				if (argv[0] === "/fresh/.mise/shims/jscpd" && env.FRESH === "1") {
					return commandResult(argv, timeoutMs, {
						exitCode: 1,
						stderr: "inactive shim",
					});
				}
				return commandResult(argv, timeoutMs);
			},
		});
		const result = runSniffInstall({
			mode: "install",
			bundles: ["dup"],
			runtime,
		});
		expect(result.ok).toBe(false);
		expect(result.tools[0]?.status).toBe("shimmed");
	});

	test("install without bundles and unknown bundles fail", () => {
		expect(runSniffInstall({ mode: "install" }).ok).toBe(false);
		expect(
			runSniffInstall({ mode: "install", bundles: ["nope"] }).report,
		).toContain('unknown bundle "nope"');
	});

	test("dry-run install prints commands without requiring success", () => {
		const dir = tempDir("sniff-dry-");
		const result = runSniffInstall({
			mode: "install",
			bundles: ["core"],
			dryRun: true,
			noMise: true,
			cwd: dir,
			runtime: fakeRuntime({
				resolveCommand: (bin) => (bin === "brew" ? "/fake/bin/brew" : null),
			}),
		});
		expect(result.ok).toBe(true);
		expect(result.report).toContain("(dry run — no changes will be made)");
		expect(result.report).toContain("[core]");
	});
});

describe("runSniffAnalyzer", () => {
	test("preflights the exact tool before every execution", () => {
		const calls: string[][] = [];
		const runtime = fakeRuntime({
			run: (argv, _cwd, _env, timeoutMs) => {
				calls.push(argv);
				return commandResult(argv, timeoutMs, {
					stdout: argv.at(-1) === "--version" ? "1.0" : "scan",
				});
			},
		});
		const first = runSniffAnalyzer({
			tool: "semgrep",
			args: ["--json", "src"],
			runtime,
		});
		const second = runSniffAnalyzer({
			tool: "semgrep",
			args: ["--json", "tests"],
			runtime,
		});
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(calls).toEqual([
			["/fake/bin/semgrep", "--version"],
			["/fake/bin/semgrep", "--json", "src"],
			["/fake/bin/semgrep", "--version"],
			["/fake/bin/semgrep", "--json", "tests"],
		]);
	});

	test("npm-local execution uses the same project PATH as preflight", () => {
		const dir = tempDir("sniff-local-run-");
		const localBin = join(dir, "node_modules", ".bin");
		mkdirSync(localBin, { recursive: true });
		writeFileSync(join(localBin, "eslint"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		const paths: string[] = [];
		const runtime = fakeRuntime({
			resolveCommand: (bin, _cwd, env) =>
				bin === "eslint" && env.PATH === localBin
					? join(localBin, "eslint")
					: null,
			run: (argv, _cwd, env, timeoutMs) => {
				paths.push(env.PATH ?? "");
				return commandResult(argv, timeoutMs);
			},
		});
		const result = runSniffAnalyzer({
			tool: "eslint",
			args: ["--format", "json", "."],
			cwd: dir,
			env: { PATH: "/usr/bin" },
			runtime,
		});
		expect(result.ok).toBe(true);
		expect(paths).toEqual([
			`${localBin}${delimiter}/usr/bin`,
			`${localBin}${delimiter}/usr/bin`,
		]);
	});

	test("selected hosted packages and analyzer config are required", () => {
		const dir = tempDir("sniff-hosted-");
		const localBin = join(dir, "node_modules", ".bin");
		mkdirSync(localBin, { recursive: true });
		writeFileSync(join(localBin, "eslint"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		const runtime = fakeRuntime({
			resolveCommand: (bin) =>
				bin === "eslint" ? join(localBin, "eslint") : `/fake/bin/${bin}`,
		});
		const missingPackage = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(missingPackage).toMatchObject({
			ok: false,
			outcome: "not-run",
			hostCoverage: { missing: ["eslint-plugin-unicorn"] },
		});

		const pluginDir = join(dir, "node_modules", "eslint-plugin-unicorn");
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(join(pluginDir, "package.json"), "{}");
		const missingConfig = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(missingConfig).toMatchObject({
			ok: false,
			outcome: "not-run",
			hostCoverage: { missing: [], detectedConfig: null },
		});

		writeFileSync(
			join(dir, "eslint.config.js"),
			"// eslint-plugin-unicorn is not configured here\nexport default [];\n",
		);
		const unrelatedConfig = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(unrelatedConfig).toMatchObject({
			ok: false,
			outcome: "not-run",
			hostCoverage: {
				missing: [],
				unconfigured: ["eslint-plugin-unicorn"],
				detectedConfig: "eslint.config.js",
			},
		});

		rmSync(join(dir, "eslint.config.js"));
		writeFileSync(
			join(dir, ".eslintrc.js"),
			'module.exports = { plugins: ["unicorn"] };\n',
		);
		const legacyReady = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(legacyReady).toMatchObject({
			ok: true,
			outcome: "completed",
			hostCoverage: {
				unconfigured: [],
				detectedConfig: ".eslintrc.js",
			},
		});

		writeFileSync(
			join(dir, ".eslintrc.js"),
			'module.exports = { settings: { label: "unicorn" } };\n',
		);
		const incidentalAlias = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(incidentalAlias).toMatchObject({
			ok: false,
			outcome: "not-run",
			hostCoverage: { unconfigured: ["eslint-plugin-unicorn"] },
		});

		rmSync(join(dir, ".eslintrc.js"));
		writeFileSync(join(dir, ".eslintrc.json"), '{"plugins":["unicorn"]}\n');
		const jsonReady = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(jsonReady).toMatchObject({
			ok: true,
			outcome: "completed",
			hostCoverage: {
				unconfigured: [],
				detectedConfig: ".eslintrc.json",
			},
		});

		writeFileSync(join(dir, ".eslintrc.json"), '{"myplugins":["unicorn"]}\n');
		const incidentalJsonKey = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(incidentalJsonKey).toMatchObject({
			ok: false,
			outcome: "not-run",
			hostCoverage: { unconfigured: ["eslint-plugin-unicorn"] },
		});

		rmSync(join(dir, ".eslintrc.json"));
		writeFileSync(join(dir, ".eslintrc.yaml"), "plugins:\n  - unicorn\n");
		const yamlReady = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(yamlReady).toMatchObject({
			ok: true,
			outcome: "completed",
			hostCoverage: {
				unconfigured: [],
				detectedConfig: ".eslintrc.yaml",
			},
		});

		rmSync(join(dir, ".eslintrc.yaml"));
		writeFileSync(join(dir, ".eslintrc.yml"), "plugins:\n  - unicorn\n");
		const ymlReady = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(ymlReady).toMatchObject({
			ok: true,
			outcome: "completed",
			hostCoverage: {
				unconfigured: [],
				detectedConfig: ".eslintrc.yml",
			},
		});
		writeFileSync(
			join(dir, "eslint.config.js"),
			'import unicorn from "eslint-plugin-unicorn";\nexport default [{ plugins: { unicorn } }];\n',
		);
		const ready = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-unicorn"],
			cwd: dir,
			runtime,
		});
		expect(ready).toMatchObject({
			ok: true,
			outcome: "completed",
			hostCoverage: {
				missing: [],
				unrecognized: [],
				unconfigured: [],
				detectedConfig: "eslint.config.js",
			},
		});
	});

	test("uncatalogued hosted packages are refused", () => {
		const result = runSniffAnalyzer({
			tool: "eslint",
			args: ["."],
			hostPackages: ["eslint-plugin-not-approved"],
			runtime: fakeRuntime(),
		});
		expect(result).toMatchObject({
			ok: false,
			outcome: "not-run",
			hostCoverage: { unrecognized: ["eslint-plugin-not-approved"] },
		});
	});

	test("execution exit must satisfy the per-run contract", () => {
		const runtime = fakeRuntime({
			run: (argv, _cwd, _env, timeoutMs) =>
				commandResult(argv, timeoutMs, {
					exitCode: argv.at(-1) === "--version" ? 0 : 3,
				}),
		});
		const rejected = runSniffAnalyzer({
			tool: "actionlint",
			args: [".github/workflows"],
			runtime,
		});
		expect(rejected).toMatchObject({
			ok: false,
			outcome: "rejected-exit",
			acceptedExitCodes: [0],
			execution: { exitCode: 3 },
		});

		const findingsRuntime = fakeRuntime({
			run: (argv, _cwd, _env, timeoutMs) =>
				commandResult(argv, timeoutMs, {
					exitCode: argv.at(-1) === "--version" ? 0 : 1,
				}),
		});
		const accepted = runSniffAnalyzer({
			tool: "actionlint",
			args: [".github/workflows"],
			acceptedExitCodes: [0, 1],
			runtime: findingsRuntime,
		});
		expect(accepted).toMatchObject({
			ok: true,
			outcome: "completed-with-findings",
			execution: { exitCode: 1 },
		});
	});

	test("invalid exit contracts are refused before preflight", () => {
		let touched = false;
		const result = runSniffAnalyzer({
			tool: "semgrep",
			args: ["src"],
			acceptedExitCodes: [1, 3],
			runtime: fakeRuntime({
				resolveCommand: () => {
					touched = true;
					return "/fake/bin/semgrep";
				},
			}),
		});
		expect(result).toMatchObject({ ok: false, outcome: "not-run" });
		expect(touched).toBe(false);
	});

	test("a failed per-tool preflight cannot fall through to execution", () => {
		const calls: string[][] = [];
		const runtime = fakeRuntime({
			resolveCommand: () => "/fake/bin/jscpd",
			run: (argv, _cwd, _env, timeoutMs) => {
				calls.push(argv);
				return commandResult(argv, timeoutMs, {
					exitCode: 1,
					stderr: "broken shim",
				});
			},
		});
		const result = runSniffAnalyzer({
			tool: "jscpd",
			args: ["--reporters", "json", "."],
			runtime,
		});
		expect(result.ok).toBe(false);
		expect(result.preflight?.status).toBe("unrunnable");
		expect(result.execution).toBeUndefined();
		expect(calls).toEqual([
			["/fake/bin/jscpd", "--version"],
			["/fake/bin/jscpd", "--help"],
		]);
	});

	test("unknown tools are refused without resolving or executing", () => {
		let touched = false;
		const runtime = fakeRuntime({
			resolveCommand: () => {
				touched = true;
				return null;
			},
		});
		const result = runSniffAnalyzer({
			tool: "not-in-catalog",
			args: [],
			runtime,
		});
		expect(result.ok).toBe(false);
		expect(result.preflight).toBeNull();
		expect(touched).toBe(false);
	});

	test("tool-specific probe and run prefixes stay coupled", () => {
		const calls: string[][] = [];
		const runtime = fakeRuntime({
			resolveCommand: (bin) => `/fake/bin/${bin}`,
			run: (argv, _cwd, _env, timeoutMs) => {
				calls.push(argv);
				return commandResult(argv, timeoutMs);
			},
		});
		const result = runSniffAnalyzer({
			tool: "cargo-clippy",
			args: ["--all-targets"],
			runtime,
		});
		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			["/fake/bin/cargo", "clippy", "--version"],
			["/fake/bin/cargo", "clippy", "--all-targets"],
		]);
	});
});

describe("sniff tools integration", () => {
	test("registration exposes catalog preflight and atomic analyzer runner", async () => {
		const enumCalls: string[][] = [];
		type RegisteredTool = {
			name: string;
			description: string;
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				context: { cwd: string },
			) => Promise<{
				details: { ok: boolean; tools: Array<Record<string, unknown>> };
				isError?: boolean;
			}>;
		};
		const captured = new Map<string, RegisteredTool>();
		const fakePi = {
			...fakeZod(enumCalls),
			registerTool: (definition: RegisteredTool) => {
				captured.set(definition.name, definition);
			},
			on: () => {},
		};
		sniffInstallTool(fakePi as never);
		expect(captured.has("sniff_install_tools")).toBe(true);
		expect(captured.get("sniff_run_analyzer")?.description).toContain(
			"immediately before execution",
		);
		expect(enumCalls).toContainEqual(["probe", "diagnose", "list", "install"]);

		const dir = tempDir("sniff-int-");
		const registeredTool = captured.get("sniff_install_tools");
		if (!registeredTool)
			throw new Error("sniff_install_tools was not registered");
		const out = await registeredTool.execute(
			"id",
			{ mode: "diagnose", bundles: ["js-ts"], path: dir },
			undefined,
			undefined,
			{ cwd: dir },
		);
		expect(out.details.ok).toBe(false);
		expect(out.isError).toBe(true);
		expect(out.details.tools.length).toBeGreaterThan(0);
		expect(out.details.tools[0]).toHaveProperty("status");
	});
});
