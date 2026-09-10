import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	BUNDLES,
	type BundleName,
	TOOLS,
	type ToolRec,
} from "./sniff-tool-catalog.ts";

const PROBE_TIMEOUT_MS = 1_500;
const INSTALL_TIMEOUT_MS = 300_000;
const ENV_REFRESH_TIMEOUT_MS = 10_000;

export type SniffToolStatus =
	| "usable"
	| "missing"
	| "shimmed"
	| "unrunnable"
	| "project-local-required"
	| "installation-failed"
	| "timed-out"
	| "policy-blocked"
	| "unavailable-route";

export type CommandResult = {
	argv: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	signalCode?: string;
	error?: string;
	timeoutMs: number;
};

export type ProbeAttempt = Pick<
	CommandResult,
	"argv" | "exitCode" | "stderr" | "timedOut" | "error" | "timeoutMs"
>;

export type SniffToolResult = {
	bundle: BundleName;
	tool: string;
	bin: string;
	required: boolean;
	status: SniffToolStatus;
	resolvedPath: string | null;
	remediation: string;
	attempts: ProbeAttempt[];
	install?: CommandResult;
};

type ProcessEnvironment = Record<string, string | undefined>;

type FreshEnvironment = {
	env: ProcessEnvironment;
	source: "process" | "mise";
	error?: string;
};

export type SniffInstallRuntime = {
	resolveCommand(
		bin: string,
		cwd: string,
		env: ProcessEnvironment,
	): string | null;
	readLauncher(path: string): string;
	run(
		argv: string[],
		cwd: string,
		env: ProcessEnvironment,
		timeoutMs: number,
	): CommandResult;
	freshEnvironment(
		cwd: string,
		env: ProcessEnvironment,
		miseAware: boolean,
	): FreshEnvironment;
};

export type SniffInstallResult = {
	ok: boolean;
	report: string;
	tools: SniffToolResult[];
};

function timeoutError(err: unknown): boolean {
	const candidate = err as { code?: string; name?: string; message?: string };
	return (
		candidate?.code === "ETIMEDOUT" ||
		candidate?.name === "TimeoutError" ||
		/\b(?:timed?\s*out|timeout)\b/i.test(candidate?.message ?? "")
	);
}

function runCommand(
	argv: string[],
	cwd: string,
	env: ProcessEnvironment,
	timeoutMs: number,
): CommandResult {
	try {
		const proc = Bun.spawnSync(argv, {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
			stdin: new Uint8Array(),
			timeout: timeoutMs,
		});
		return {
			argv,
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
			timedOut: proc.exitedDueToTimeout === true,
			signalCode: proc.signalCode ?? undefined,
			timeoutMs,
		};
	} catch (err) {
		return {
			argv,
			exitCode: null,
			stdout: "",
			stderr: "",
			timedOut: timeoutError(err),
			error: err instanceof Error ? err.message : String(err),
			timeoutMs,
		};
	}
}

function resolveCommand(
	bin: string,
	cwd: string,
	env: ProcessEnvironment,
): string | null {
	const candidates = bin.includes(sep)
		? [isAbsolute(bin) ? bin : resolve(cwd, bin)]
		: (env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((dir) => join(dir, bin));
	for (const candidate of candidates) {
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not an executable candidate.
		}
	}
	return null;
}

function readLauncher(path: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(realpathSync(path), "r");
		const buffer = Buffer.allocUnsafe(8_192);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, length).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

const DEFAULT_RUNTIME: SniffInstallRuntime = {
	resolveCommand,
	readLauncher,
	run: runCommand,
	freshEnvironment(cwd, env, miseAware) {
		if (!miseAware) return { env: { ...env }, source: "process" };
		const result = runCommand(
			["mise", "env", "--json"],
			cwd,
			env,
			ENV_REFRESH_TIMEOUT_MS,
		);
		if (result.exitCode !== 0 || result.timedOut) {
			const reason = result.timedOut
				? `mise env timed out after ${ENV_REFRESH_TIMEOUT_MS}ms`
				: result.stderr.trim() ||
					result.error ||
					`mise env exited ${result.exitCode}`;
			return { env: { ...env }, source: "process", error: reason };
		}
		try {
			const miseEnv = JSON.parse(result.stdout) as Record<string, string>;
			return { env: { ...env, ...miseEnv }, source: "mise" };
		} catch (err) {
			return {
				env: { ...env },
				source: "process",
				error: `mise env returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	},
};

function projectEnvironment(
	rec: ToolRec,
	cwd: string,
	env: ProcessEnvironment,
): ProcessEnvironment {
	if (rec.key !== "npm-local") return env;
	const localBin = join(cwd, "node_modules", ".bin");
	return { ...env, PATH: `${localBin}${delimiter}${env.PATH ?? ""}` };
}

function resolutionEnvironment(
	rec: ToolRec,
	cwd: string,
	env: ProcessEnvironment,
): ProcessEnvironment {
	if (rec.key !== "npm-local") return env;
	return { ...env, PATH: join(cwd, "node_modules", ".bin") };
}

function isShimLauncher(path: string, launcher: string): boolean {
	const normalized = path.split(sep).join("/");
	if (
		/\/(?:\.mise|\.asdf|\.pyenv|\.rbenv|share\/mise)\/shims\//.test(normalized)
	)
		return true;
	return /\bexec\s+(?:[^\s]+\/)?(?:mise|asdf|pyenv|rbenv)\b/i.test(launcher);
}

function inspectTool(
	bundle: BundleName,
	rec: ToolRec,
	required: boolean,
	cwd: string,
	env: ProcessEnvironment,
	runtime: SniffInstallRuntime,
): SniffToolResult {
	const effectiveEnv = projectEnvironment(rec, cwd, env);
	const resolvedPath = runtime.resolveCommand(
		rec.bin,
		cwd,
		resolutionEnvironment(rec, cwd, env),
	);
	if (!resolvedPath) {
		return {
			bundle,
			tool: rec.name,
			bin: rec.bin,
			required,
			status: rec.key === "npm-local" ? "project-local-required" : "missing",
			resolvedPath: null,
			remediation: rec.hint,
			attempts: [],
		};
	}
	const launcher = runtime.readLauncher(resolvedPath);
	if (isShimLauncher(resolvedPath, launcher)) {
		return {
			bundle,
			tool: rec.name,
			bin: rec.bin,
			required,
			status: "shimmed",
			resolvedPath,
			remediation: rec.hint,
			attempts: [],
		};
	}

	const attempts: ProbeAttempt[] = [];
	const probeArgs = rec.probeArgs ?? [["--version"], ["--help"]];
	for (const args of probeArgs) {
		const result = runtime.run(
			[resolvedPath, ...args],
			cwd,
			effectiveEnv,
			PROBE_TIMEOUT_MS,
		);
		attempts.push({
			argv: result.argv,
			exitCode: result.exitCode,
			stderr: result.stderr,
			timedOut: result.timedOut,
			error: result.error,
			timeoutMs: result.timeoutMs,
		});
		if (result.exitCode === 0 && !result.timedOut) {
			return {
				bundle,
				tool: rec.name,
				bin: rec.bin,
				required,
				status: "usable",
				resolvedPath,
				remediation: "",
				attempts,
			};
		}
	}

	const status: SniffToolStatus = attempts.some((attempt) => attempt.timedOut)
		? "timed-out"
		: "unrunnable";
	return {
		bundle,
		tool: rec.name,
		bin: rec.bin,
		required,
		status,
		resolvedPath,
		remediation: rec.hint,
		attempts,
	};
}

function managerRoute(
	rec: ToolRec,
	preferMise: boolean,
	cwd: string,
	env: ProcessEnvironment,
	runtime: SniffInstallRuntime,
): string {
	if (rec.key === "npm-local") return "npm-local";
	if (preferMise) {
		if (rec.key === "cargo") return "mise-cargo";
		if (rec.key === "npm") return "mise-npm";
		if (rec.key === "pipx") return "mise-pipx";
		if (rec.key === "go" || rec.key === "brew") return "mise-reg";
	}
	const available = (bin: string): boolean =>
		runtime.resolveCommand(bin, cwd, env) !== null;
	switch (rec.key) {
		case "brew":
			return available("brew") ? "brew" : "";
		case "pipx":
			if (available("pipx")) return "pipx";
			if (available("uv")) return "uv-tool";
			return "";
		case "npm":
			return available("npm") ? "npm" : "";
		case "cargo":
			return available("cargo") ? "cargo" : "";
		case "go":
			return available("go") ? "go" : "";
		case "rustup":
			return available("rustup") ? "rustup" : "";
		default:
			return "";
	}
}

function installArgv(rec: ToolRec, manager: string): string[] | null {
	const pkg = rec.pkg ?? rec.name;
	const miseSpec = rec.miseSpec ?? rec.bin;
	switch (manager) {
		case "brew":
			return ["brew", "install", pkg];
		case "pipx":
			return ["pipx", "install", pkg];
		case "uv-tool":
			return ["uv", "tool", "install", pkg];
		case "npm":
			return ["npm", "install", "-g", pkg];
		case "cargo":
			return ["cargo", "install", pkg];
		case "go": {
			let goPath = miseSpec.startsWith("go:") ? miseSpec.slice(3) : miseSpec;
			if (!goPath.includes("@")) goPath = `${goPath}@latest`;
			return ["go", "install", goPath];
		}
		case "rustup":
			return ["rustup", "component", "add", "clippy"];
		case "mise-cargo":
			return ["mise", "use", `cargo:${pkg}`];
		case "mise-npm":
			return ["mise", "use", `npm:${pkg}`];
		case "mise-pipx":
			return ["mise", "use", `pipx:${pkg}`];
		case "mise-reg":
			return ["mise", "use", miseSpec];
		default:
			return null;
	}
}

function classifyInstallFailure(result: CommandResult): SniffToolStatus {
	if (result.timedOut) return "timed-out";
	const evidence = `${result.stderr}\n${result.stdout}\n${result.error ?? ""}`;
	if (
		/(?:trust|trusted|policy|signature|provenance|integrity|checksum).*(?:block|den|refus|downgrad|reject|fail)|(?:block|den|refus|reject).*(?:trust|policy|signature|provenance|integrity)/i.test(
			evidence,
		)
	) {
		return "policy-blocked";
	}
	if (
		/(?:unknown|invalid|unsupported|unavailable).*(?:backend|registry|route|plugin)|(?:backend|registry|route).*(?:not found|unavailable)|no versions? found|not available for (?:this|your) platform/i.test(
			evidence,
		)
	) {
		return "unavailable-route";
	}
	return "installation-failed";
}

function failedInstallResult(
	initial: SniffToolResult,
	status: SniffToolStatus,
	install?: CommandResult,
	remediation = initial.remediation,
): SniffToolResult {
	return { ...initial, status, remediation, install };
}

function installOne(
	bundle: BundleName,
	rec: ToolRec,
	cwd: string,
	preferMise: boolean,
	dryRun: boolean,
	env: ProcessEnvironment,
	runtime: SniffInstallRuntime,
	lines: string[],
): SniffToolResult {
	const initial = inspectTool(bundle, rec, true, cwd, env, runtime);
	if (initial.status === "usable") {
		lines.push(`  = ${rec.name} already installed (${initial.resolvedPath})`);
		return initial;
	}
	if (rec.key === "npm-local") {
		lines.push(
			`  ! ${rec.name} is project-local — install inside the repo, not globally:`,
		);
		lines.push(`      ${rec.hint}`);
		return initial;
	}

	const manager = managerRoute(rec, preferMise, cwd, env, runtime);
	const argv = installArgv(rec, manager);
	if (!manager || !argv) {
		lines.push(
			`  ! ${rec.name}: no supported installation route — ${rec.hint}`,
		);
		return failedInstallResult(initial, "unavailable-route");
	}
	lines.push(`  + ${argv.join(" ")} (timeout ${INSTALL_TIMEOUT_MS}ms)`);
	if (dryRun) return initial;

	const install = runtime.run(argv, cwd, env, INSTALL_TIMEOUT_MS);
	if (install.stdout.trim()) lines.push(install.stdout.trimEnd());
	if (install.stderr.trim()) lines.push(install.stderr.trimEnd());
	if (install.exitCode !== 0 || install.timedOut) {
		const status = classifyInstallFailure(install);
		lines.push(
			`      (${status}${install.exitCode === null ? "" : ` — exit ${install.exitCode}`})`,
		);
		return failedInstallResult(initial, status, install);
	}

	const fresh = runtime.freshEnvironment(cwd, env, preferMise);
	if (fresh.error) {
		lines.push(
			`      (unavailable-route — fresh environment failed: ${fresh.error})`,
		);
		return failedInstallResult(
			initial,
			"unavailable-route",
			install,
			`${fresh.error}; ${rec.hint}`,
		);
	}
	const verified = inspectTool(bundle, rec, true, cwd, fresh.env, runtime);
	verified.install = install;
	if (verified.status === "usable") {
		lines.push(
			`      verified usable in fresh ${fresh.source} environment (${verified.resolvedPath})`,
		);
	} else {
		lines.push(
			`      (${verified.status} after successful install; resolved=${verified.resolvedPath ?? "<unresolved>"})`,
		);
	}
	return verified;
}

function probeLabel(result: SniffToolResult): string {
	switch (result.status) {
		case "usable":
			return `  ok   ${result.tool}`;
		case "missing":
		case "project-local-required":
			return `  MISS ${result.tool}   — ${result.remediation}`;
		default:
			return `  SHIM ${result.tool}   — on PATH but not runnable; install to activate: ${result.remediation}`;
	}
}

function selectedBundles(
	opts: SniffInstallOptions,
	mode: "diagnose" | "install",
): BundleName[] | string {
	const targets = opts.all ? [...BUNDLES] : (opts.bundles ?? []);
	if (targets.length === 0) {
		return `sniff_install_tools: ${mode} needs at least one bundle name or all=true (known: ${BUNDLES.join(" ")})`;
	}
	for (const target of targets) {
		if (!(target in TOOLS))
			return `sniff: unknown bundle "${target}" (known: ${BUNDLES.join(" ")})`;
	}
	return [...new Set(targets)] as BundleName[];
}

export type SniffInstallMode = "probe" | "diagnose" | "list" | "install";

export type SniffInstallOptions = {
	mode?: SniffInstallMode;
	bundles?: string[];
	all?: boolean;
	dryRun?: boolean;
	noMise?: boolean;
	cwd?: string;
	env?: ProcessEnvironment;
	runtime?: SniffInstallRuntime;
};

export type SniffAnalyzerRunOptions = {
	tool: string;
	args: string[];
	hostPackages?: string[];
	acceptedExitCodes?: number[];
	cwd?: string;
	env?: ProcessEnvironment;
	runtime?: SniffInstallRuntime;
};

export type SniffHostCoverage = {
	requested: string[];
	allowed: string[];
	unrecognized: string[];
	missing: string[];
	unconfigured: string[];
	configCandidates: string[];
	detectedConfig: string | null;
};

export type SniffAnalyzerOutcome =
	| "completed"
	| "completed-with-findings"
	| "rejected-exit"
	| "not-run";

export type SniffAnalyzerRunResult = {
	ok: boolean;
	report: string;
	preflight: SniffToolResult | null;
	hostCoverage?: SniffHostCoverage;
	acceptedExitCodes?: number[];
	outcome: SniffAnalyzerOutcome;
	execution?: CommandResult;
};

function findTool(tool: string): { bundle: BundleName; rec: ToolRec } | null {
	for (const bundle of BUNDLES) {
		const rec = TOOLS[bundle].find((candidate) => candidate.name === tool);
		if (rec) return { bundle, rec };
	}
	return null;
}

function detectHostConfig(
	rec: ToolRec,
	cwd: string,
): { source: string; content: string } | null {
	for (const candidate of rec.configFiles ?? []) {
		const path = join(cwd, candidate);
		if (!existsSync(path)) continue;
		try {
			return { source: candidate, content: readFileSync(path, "utf8") };
		} catch {
			return null;
		}
	}
	if (!rec.packageConfigKeys?.length) return null;
	const manifest = join(cwd, "package.json");
	if (!existsSync(manifest)) return null;
	try {
		const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<
			string,
			unknown
		>;
		for (const key of rec.packageConfigKeys) {
			if (!Object.hasOwn(parsed, key)) continue;
			return {
				source: `package.json#${key}`,
				content: JSON.stringify(parsed[key]),
			};
		}
	} catch {
		return null;
	}
	return null;
}

function yamlListConfigured(
	key: "plugins" | "extends",
	value: string,
	content: string,
): boolean {
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const header = /^(\s*)["']?(plugins|extends)["']?\s*:\s*(?:#.*)?$/.exec(
			lines[index] ?? "",
		);
		if (!header || header[2] !== key) continue;
		const baseIndent = header[1]?.length ?? 0;
		for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
			const line = lines[itemIndex] ?? "";
			if (/^\s*(?:#.*)?$/.test(line)) continue;
			const indent = /^\s*/.exec(line)?.[0].length ?? 0;
			if (indent <= baseIndent) break;
			const item = /^\s*-\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(line);
			if (item?.[1] === value) return true;
		}
	}
	return false;
}

function fullPackageConfigured(packageName: string, content: string): boolean {
	const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const moduleReference = new RegExp(
		`(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)["']${escaped}["']`,
	);
	const configArray = new RegExp(
		`(?:^|[,{\\s])["']?(?:plugins|extends)["']?\\s*:\\s*\\[[^\\]]*["']${escaped}["']`,
		"s",
	);
	const extendsScalar = new RegExp(
		`(?:^|[,{\\s])["']?extends["']?\\s*:\\s*["']${escaped}["']`,
		"s",
	);
	return (
		moduleReference.test(content) ||
		configArray.test(content) ||
		extendsScalar.test(content) ||
		yamlListConfigured("plugins", packageName, content) ||
		yamlListConfigured("extends", packageName, content)
	);
}

function hostPackageConfigured(
	rec: ToolRec,
	packageName: string,
	content: string,
): boolean {
	if (fullPackageConfigured(packageName, content)) return true;
	const aliases = rec.hostPackageConfigNames?.[packageName] ?? [];
	return aliases.some((alias) => {
		if (content.includes(`plugin:${alias}/`)) return true;
		if (yamlListConfigured("plugins", alias, content)) return true;
		const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(
			`(?:^|[,{\\s])["']?plugins["']?\\s*:\\s*\\[[^\\]]*["']${escaped}["']`,
			"s",
		).test(content);
	});
}

function inspectHostCoverage(
	rec: ToolRec,
	requested: string[],
	cwd: string,
): SniffHostCoverage {
	const allowed = [...(rec.hostPackages ?? [])];
	const uniqueRequested = [...new Set(requested)];
	const unrecognized = uniqueRequested.filter(
		(packageName) => !allowed.includes(packageName),
	);
	const missing = uniqueRequested.filter((packageName) => {
		if (unrecognized.includes(packageName)) return false;
		const manifest = join(
			cwd,
			"node_modules",
			...packageName.split("/"),
			"package.json",
		);
		return !existsSync(manifest);
	});
	const configCandidates = [
		...(rec.configFiles ?? []),
		...(rec.packageConfigKeys ?? []).map((key) => `package.json#${key}`),
	];
	const config =
		uniqueRequested.length > 0 && configCandidates.length > 0
			? detectHostConfig(rec, cwd)
			: null;
	const unconfigured = config
		? uniqueRequested.filter(
				(packageName) =>
					!missing.includes(packageName) &&
					!unrecognized.includes(packageName) &&
					!hostPackageConfigured(rec, packageName, config.content),
			)
		: [];
	return {
		requested: uniqueRequested,
		allowed,
		unrecognized,
		missing,
		unconfigured,
		configCandidates,
		detectedConfig: config?.source ?? null,
	};
}

function validExitContract(codes: number[]): boolean {
	return (
		codes.length > 0 &&
		codes.includes(0) &&
		new Set(codes).size === codes.length &&
		codes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)
	);
}

export function runSniffAnalyzer(
	opts: SniffAnalyzerRunOptions,
): SniffAnalyzerRunResult {
	const cwd = opts.cwd ?? process.cwd();
	const env = { ...process.env, ...opts.env };
	const runtime = opts.runtime ?? DEFAULT_RUNTIME;
	const catalog = findTool(opts.tool);
	if (!catalog) {
		return {
			ok: false,
			report: `sniff analyzer: unknown tool "${opts.tool}"; choose a tool from sniff_install_tools mode=list`,
			preflight: null,
			outcome: "not-run",
		};
	}
	const acceptedExitCodes = opts.acceptedExitCodes ?? [0];
	if (!validExitContract(acceptedExitCodes)) {
		return {
			ok: false,
			report:
				"sniff analyzer: acceptedExitCodes must be unique integers from 0 to 255 and include 0",
			preflight: null,
			acceptedExitCodes,
			outcome: "not-run",
		};
	}

	const preflight = inspectTool(
		catalog.bundle,
		catalog.rec,
		true,
		cwd,
		env,
		runtime,
	);
	if (preflight.status !== "usable" || !preflight.resolvedPath) {
		return {
			ok: false,
			report: `sniff analyzer preflight blocked ${opts.tool}: ${preflight.status}; ${preflight.remediation}`,
			preflight,
			acceptedExitCodes,
			outcome: "not-run",
		};
	}
	const hostCoverage = inspectHostCoverage(
		catalog.rec,
		opts.hostPackages ?? [],
		cwd,
	);
	const missingConfig =
		hostCoverage.requested.length > 0 &&
		hostCoverage.configCandidates.length > 0 &&
		hostCoverage.detectedConfig === null;
	if (
		hostCoverage.unrecognized.length > 0 ||
		hostCoverage.missing.length > 0 ||
		hostCoverage.unconfigured.length > 0 ||
		missingConfig
	) {
		const gaps = [
			hostCoverage.unrecognized.length > 0
				? `unsupported host packages: ${hostCoverage.unrecognized.join(", ")}`
				: "",
			hostCoverage.missing.length > 0
				? `missing project packages: ${hostCoverage.missing.join(", ")}`
				: "",
			hostCoverage.unconfigured.length > 0
				? `selected packages absent from config: ${hostCoverage.unconfigured.join(", ")}`
				: "",
			missingConfig
				? `missing analyzer config (${hostCoverage.configCandidates.join(", ")})`
				: "",
		].filter(Boolean);
		return {
			ok: false,
			report: `sniff analyzer coverage blocked ${opts.tool}: ${gaps.join("; ")}`,
			preflight,
			hostCoverage,
			acceptedExitCodes,
			outcome: "not-run",
		};
	}
	const execution = runtime.run(
		[preflight.resolvedPath, ...(catalog.rec.runPrefix ?? []), ...opts.args],
		cwd,
		projectEnvironment(catalog.rec, cwd, env),
		INSTALL_TIMEOUT_MS,
	);
	const completed =
		!execution.timedOut && !execution.error && execution.exitCode !== null;
	const accepted =
		completed && acceptedExitCodes.includes(execution.exitCode as number);
	const outcome: SniffAnalyzerOutcome = accepted
		? execution.exitCode === 0
			? "completed"
			: "completed-with-findings"
		: completed
			? "rejected-exit"
			: "not-run";
	return {
		ok: accepted,
		report: accepted
			? `sniff analyzer ran ${opts.tool} after usable preflight (exit ${execution.exitCode}, accepted by [${acceptedExitCodes.join(", ")}])`
			: completed
				? `sniff analyzer coverage invalid ${opts.tool}: exit ${execution.exitCode} is outside accepted contract [${acceptedExitCodes.join(", ")}]`
				: `sniff analyzer could not run ${opts.tool} after preflight: ${execution.error ?? (execution.timedOut ? "timed out" : "no exit status")}`,
		preflight,
		hostCoverage,
		acceptedExitCodes,
		outcome,
		execution,
	};
}
export function runSniffInstall(opts: SniffInstallOptions): SniffInstallResult {
	const mode: SniffInstallMode = opts.mode ?? "probe";
	const cwd = opts.cwd ?? process.cwd();
	const env = { ...process.env, ...opts.env };
	const runtime = opts.runtime ?? DEFAULT_RUNTIME;
	const preferMise =
		!opts.noMise && runtime.resolveCommand("mise", cwd, env) !== null;
	const lines: string[] = [];
	const tools: SniffToolResult[] = [];

	if (mode === "probe") {
		lines.push(
			"sniff tool probe (all tools optional; missing ones are skipped, not fatal)",
		);
		for (const bundle of BUNDLES) {
			lines.push("", `[${bundle}]`);
			const bundleResults = TOOLS[bundle].map((rec) =>
				inspectTool(bundle, rec, false, cwd, env, runtime),
			);
			tools.push(...bundleResults);
			for (const result of bundleResults) lines.push(probeLabel(result));
			const counts = new Map<SniffToolStatus, number>();
			for (const result of bundleResults)
				counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
			lines.push(
				`  (${[...counts].map(([status, count]) => `${count} ${status}`).join(", ")})`,
			);
		}
		lines.push(
			"",
			"Install a bundle with: sniff_install_tools mode=install bundles=[<bundle>]",
		);
		return { ok: true, report: lines.join("\n"), tools };
	}

	if (mode === "list") {
		for (const bundle of BUNDLES) {
			lines.push("", `[${bundle}]`);
			for (const rec of TOOLS[bundle]) {
				const hosted = rec.hostPackages?.length
					? ` [host packages: ${rec.hostPackages.join(", ")}]`
					: "";
				lines.push(`  ${rec.name.padEnd(18)} ${rec.hint}${hosted}`);
			}
		}
		return { ok: true, report: lines.join("\n"), tools };
	}

	const selected = selectedBundles(opts, mode);
	if (typeof selected === "string")
		return { ok: false, report: selected, tools };
	if (mode === "diagnose") {
		lines.push(
			"sniff bundle diagnostics (inventory only; does not authorize analyzer execution)",
		);
		for (const bundle of selected) {
			lines.push("", `[${bundle}]`);
			for (const rec of TOOLS[bundle]) {
				const result = inspectTool(bundle, rec, true, cwd, env, runtime);
				tools.push(result);
				lines.push(
					`  ${result.status.padEnd(22)} ${result.tool} path=${result.resolvedPath ?? "<unresolved>"}${result.status === "usable" ? "" : ` — ${result.remediation}`}`,
				);
			}
		}
		const failures = tools.filter((result) => result.status !== "usable");
		lines.push(
			"",
			`diagnose: ${tools.length - failures.length} usable, ${failures.length} unavailable catalog entry/entries; use sniff_run_analyzer for authoritative per-run preflight`,
		);
		return { ok: failures.length === 0, report: lines.join("\n"), tools };
	}

	if (opts.dryRun) lines.push("(dry run — no changes will be made)");
	for (const bundle of selected) {
		lines.push("", `[${bundle}]`);
		for (const rec of TOOLS[bundle]) {
			tools.push(
				installOne(
					bundle,
					rec,
					cwd,
					preferMise,
					Boolean(opts.dryRun),
					env,
					runtime,
					lines,
				),
			);
		}
	}
	const failures = tools.filter((result) => result.status !== "usable");
	if (opts.dryRun) {
		lines.push("", "Dry run complete; no tool state changed.");
		return { ok: true, report: lines.join("\n"), tools };
	}
	lines.push(
		"",
		`install: ${tools.length - failures.length} usable, ${failures.length} failure(s) after verification`,
	);
	return { ok: failures.length === 0, report: lines.join("\n"), tools };
}

type ToolParams = {
	mode?: SniffInstallMode;
	bundles?: string[];
	all?: boolean;
	dryRun?: boolean;
	noMise?: boolean;
	path?: string;
};

type AnalyzerParams = {
	tool: string;
	args: string[];
	hostPackages?: string[];
	acceptedExitCodes?: number[];
	path?: string;
};

export default function sniffInstallTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "sniff_install_tools",
		label: "Sniff install tools",
		description:
			"Probe, diagnose, list, or install sniff analyzer catalog entries. Diagnose is inventory-only and never authorizes execution. Install re-probes in a fresh mise-aware environment. Never sudo or bypass trust policy. Default mode is probe.",
		parameters: z.object({
			mode: z
				.enum(["probe", "diagnose", "list", "install"])
				.optional()
				.describe("probe (default), inventory-only diagnose, list, or install"),
			bundles: z
				.array(z.string())
				.optional()
				.describe(
					"Required/install bundle names: core dup security rust go python js-ts shell sql css data api infra docs",
				),
			all: z.boolean().optional().describe("Select every bundle"),
			dryRun: z
				.boolean()
				.optional()
				.describe("Print install commands without running them"),
			noMise: z.boolean().optional().describe("Ignore mise even if present"),
			path: z
				.string()
				.optional()
				.describe("Repo cwd for project-local tools and mise-local pins"),
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
					details: { ok: result.ok, tools: result.tools },
					isError: !result.ok,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{ type: "text", text: `sniff_install_tools failed: ${message}` },
					],
					details: { ok: false, error: message, tools: [] },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "sniff_run_analyzer",
		label: "Sniff run analyzer",
		description:
			"Run one catalogued sniff analyzer. Every invocation validates the executable, selected host packages, analyzer configuration, and exit contract immediately before execution; bundles are not runtime gates.",
		parameters: z.object({
			tool: z
				.string()
				.describe(
					"Canonical analyzer tool id from sniff_install_tools mode=list",
				),
			args: z
				.array(z.string())
				.describe("Analyzer arguments, excluding the executable"),
			hostPackages: z
				.array(z.string())
				.optional()
				.describe(
					"Selected hosted plugins required by this run; each must be catalogued and installed in the target project",
				),
			acceptedExitCodes: z
				.array(z.number())
				.optional()
				.describe(
					"Exact analyzer completion exits for this invocation; defaults to [0], must include 0",
				),
			path: z
				.string()
				.optional()
				.describe("Exact target cwd for preflight and execution"),
		}),
		execute: async (_id, params: AnalyzerParams, _signal, _onUpdate, ctx) => {
			try {
				const result = runSniffAnalyzer({
					tool: params.tool,
					args: params.args,
					hostPackages: params.hostPackages,
					acceptedExitCodes: params.acceptedExitCodes,
					cwd: params.path ?? ctx?.cwd ?? process.cwd(),
				});
				const text = result.execution
					? `${result.report}\n\nstdout:\n${result.execution.stdout}\n\nstderr:\n${result.execution.stderr}`
					: result.report;
				return {
					content: [{ type: "text", text }],
					details: {
						ok: result.ok,
						preflight: result.preflight,
						hostCoverage: result.hostCoverage,
						acceptedExitCodes: result.acceptedExitCodes,
						outcome: result.outcome,
						execution: result.execution,
					},
					isError: !result.ok,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{ type: "text", text: `sniff_run_analyzer failed: ${message}` },
					],
					details: { ok: false, error: message, preflight: null },
					isError: true,
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
		const arg = argv[i];
		if (arg === "--probe") mode = "probe";
		else if (arg === "--diagnose" || arg === "--preflight") mode = "diagnose";
		else if (arg === "--list") mode = "list";
		else if (arg === "--all") {
			all = true;
		} else if (arg === "--install") {
			mode = "install";
		} else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--no-mise") noMise = true;
		else if (arg === "-h" || arg === "--help") {
			console.log(
				"usage: sniff-install-tool.ts [--probe | --diagnose <bundle>... | --list | --install <bundle>... | --all] [--dry-run] [--no-mise]\n       --preflight remains a compatibility alias for --diagnose",
			);
			process.exit(0);
		} else if (!arg.startsWith("--")) {
			bundles.push(arg);
		} else {
			console.error(`unknown argument: ${arg}`);
			process.exit(2);
		}
	}
	const result = runSniffInstall({ mode, bundles, all, dryRun, noMise });
	console.log(result.report);
	process.exit(result.ok ? 0 : 2);
}
