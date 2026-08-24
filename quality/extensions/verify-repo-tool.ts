import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 600_000;

type VerifyParams = {
	path?: string;
	scope?: string;
};

export type VerifyResult = {
	ok: boolean;
	exitCode: number;
	report: string;
	ran: number;
	skipped: number;
	failed: number;
	failures: string[];
	error?: string;
};

function have(bin: string): boolean {
	const proc = Bun.spawnSync(["sh", "-c", `command -v ${JSON.stringify(bin)}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return proc.exitCode === 0;
}

function fileExists(cwd: string, name: string): boolean {
	return existsSync(join(cwd, name));
}

function runCmd(
	cwd: string,
	label: string,
	argv: string[],
	lines: string[],
	state: { ran: number; failed: number; failures: string[] },
): void {
	lines.push(`==> ${label}`);
	lines.push(`+ ${argv.join(" ")}`);
	try {
		const proc = Bun.spawnSync(argv, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		const out = proc.stdout.toString();
		const err = proc.stderr.toString();
		if (out) lines.push(out.replace(/\n$/, ""));
		if (err) lines.push(err.replace(/\n$/, ""));
		state.ran += 1;
		if (proc.exitCode !== 0) {
			state.failed += 1;
			state.failures.push(`${label} exited ${proc.exitCode}: ${argv.join(" ")}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		state.ran += 1;
		state.failed += 1;
		state.failures.push(`${label} exited spawn-error: ${message}`);
		lines.push(message);
	}
}

function skip(reason: string, lines: string[], state: { skipped: number }): void {
	lines.push(`==> skip: ${reason}`);
	state.skipped += 1;
}

type Pkg = { scripts?: Record<string, string> };

function readPkg(cwd: string): Pkg | null {
	try {
		return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Pkg;
	} catch {
		return null;
	}
}

function hasScript(pkg: Pkg, name: string): boolean {
	const v = pkg.scripts?.[name];
	return typeof v === "string" && v.length > 0;
}

function detectJsRunner(cwd: string): string | null {
	if (fileExists(cwd, "pnpm-lock.yaml") && have("pnpm")) return "pnpm";
	if ((fileExists(cwd, "bun.lock") || fileExists(cwd, "bun.lockb")) && have("bun")) {
		return "bun";
	}
	if (have("npm")) return "npm";
	if (have("pnpm")) return "pnpm";
	if (have("bun")) return "bun";
	return null;
}

function runJsScript(
	cwd: string,
	runner: string,
	script: string,
	lines: string[],
	state: { ran: number; failed: number; failures: string[] },
): void {
	const argv =
		runner === "pnpm"
			? ["pnpm", "run", script]
			: runner === "bun"
				? ["bun", "run", script]
				: ["npm", "run", script];
	runCmd(cwd, `package script: ${script}`, argv, lines, state);
}

function runJsExec(
	cwd: string,
	runner: string,
	label: string,
	toolArgv: string[],
	lines: string[],
	state: { ran: number; failed: number; failures: string[] },
): void {
	const argv =
		runner === "pnpm"
			? ["pnpm", "exec", ...toolArgv]
			: runner === "bun"
				? ["bunx", ...toolArgv]
				: ["npx", "--no-install", ...toolArgv];
	runCmd(cwd, label, argv, lines, state);
}

export function runVerify(cwd: string): VerifyResult {
	const lines: string[] = [];
	const state = { ran: 0, skipped: 0, failed: 0, failures: [] as string[] };

	if (fileExists(cwd, "justfile") || fileExists(cwd, "Justfile")) {
		if (have("just")) {
			const listed = Bun.spawnSync(["just", "--list"], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				timeout: 15_000,
			});
			const text = listed.stdout.toString() + listed.stderr.toString();
			if (/(^|\n)[ \t]*verify([ \t]|$)/.test(text)) {
				runCmd(cwd, "just verify", ["just", "verify"], lines, state);
			}
		} else {
			skip("justfile present but just is not installed", lines, state);
		}
	}

	if (fileExists(cwd, "Makefile")) {
		if (have("make")) {
			const mk = readFileSync(join(cwd, "Makefile"), "utf8");
			if (/^verify:/m.test(mk)) {
				runCmd(cwd, "make verify", ["make", "verify"], lines, state);
			}
		} else {
			skip("Makefile present but make is not installed", lines, state);
		}
	}

	if (fileExists(cwd, "package.json")) {
		const runner = detectJsRunner(cwd);
		const pkg = readPkg(cwd);
		if (!runner) {
			skip("package.json present but no supported JS package runner is installed", lines, state);
		} else if (!pkg) {
			skip("package.json present but could not be parsed", lines, state);
		} else if (hasScript(pkg, "verify")) {
			runJsScript(cwd, runner, "verify", lines, state);
		} else {
			for (const script of ["typecheck", "lint", "test", "build"]) {
				if (hasScript(pkg, script)) {
					runJsScript(cwd, runner, script, lines, state);
				}
			}
			if (fileExists(cwd, "tsconfig.json") && !hasScript(pkg, "typecheck")) {
				runJsExec(cwd, runner, "TypeScript check", ["tsc", "--noEmit"], lines, state);
			}
		}
	}

	if (fileExists(cwd, "Cargo.toml")) {
		if (have("cargo")) {
			runCmd(cwd, "cargo fmt", ["cargo", "fmt", "--check"], lines, state);
			runCmd(
				cwd,
				"cargo clippy",
				["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"],
				lines,
				state,
			);
			runCmd(cwd, "cargo test", ["cargo", "test"], lines, state);
		} else {
			skip("Cargo.toml present but cargo is not installed", lines, state);
		}
	}

	if (fileExists(cwd, "go.mod")) {
		if (have("go")) {
			if (have("golangci-lint")) {
				runCmd(cwd, "golangci-lint", ["golangci-lint", "run"], lines, state);
			} else {
				skip("golangci-lint is not installed", lines, state);
			}
			runCmd(cwd, "go test", ["go", "test", "./..."], lines, state);
			runCmd(cwd, "go build", ["go", "build", "./..."], lines, state);
		} else {
			skip("go.mod present but go is not installed", lines, state);
		}
	}

	if (fileExists(cwd, "pyproject.toml") || fileExists(cwd, "requirements.txt")) {
		if (have("ruff")) {
			runCmd(cwd, "ruff check", ["ruff", "check", "."], lines, state);
			runCmd(cwd, "ruff format", ["ruff", "format", "--check", "."], lines, state);
		} else {
			skip("ruff is not installed", lines, state);
		}
		if (have("pyright")) {
			runCmd(cwd, "pyright", ["pyright", "."], lines, state);
		} else {
			skip("pyright is not installed", lines, state);
		}
		if (have("pytest")) {
			runCmd(cwd, "pytest", ["pytest"], lines, state);
		} else {
			skip("pytest is not installed", lines, state);
		}
	}

	lines.push("==> summary");
	lines.push(`ran: ${state.ran}`);
	lines.push(`skipped: ${state.skipped}`);
	lines.push(`failed: ${state.failed}`);

	if (state.ran === 0) {
		lines.push("No supported verification workflow detected.");
		return {
			ok: false,
			exitCode: 1,
			report: lines.join("\n"),
			...state,
		};
	}

	if (state.failed !== 0) {
		lines.push("Failures:");
		for (const f of state.failures) lines.push(`- ${f}`);
		return {
			ok: false,
			exitCode: 1,
			report: lines.join("\n"),
			...state,
		};
	}

	return {
		ok: true,
		exitCode: 0,
		report: lines.join("\n"),
		...state,
	};
}

export default function verifyRepoTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "verify_repo",
		label: "Verify repository",
		description:
			"Detect and run the polyglot verify workflow (just/make/package/cargo/go/python checks) and return the final report.",
		parameters: z.object({
			path: z
				.string()
				.optional()
				.describe("Repository cwd; defaults to the current working directory"),
			scope: z
				.string()
				.optional()
				.describe("Unused by the runner; reserved for caller notes"),
		}),
		execute: async (_toolCallId, params: VerifyParams, _signal, _onUpdate, ctx) => {
			const cwd = params.path ?? ctx?.cwd ?? process.cwd();
			try {
				const result = runVerify(cwd);
				return {
					content: [{ type: "text", text: result.report }],
					details: {
						ok: result.ok,
						exitCode: result.exitCode,
						path: cwd,
						scope: params.scope,
						ran: result.ran,
						skipped: result.skipped,
						failed: result.failed,
						failures: result.failures,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `verify_repo failed: ${message}` }],
					details: { ok: false, error: message, path: cwd, scope: params.scope },
				};
			}
		},
	});
}

if (import.meta.main) {
	const cwd = process.argv[2] ?? process.cwd();
	const result = runVerify(cwd);
	console.log(result.report);
	process.exit(result.exitCode);
}
