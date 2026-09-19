import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 300_000;

export type QualityMode = "check" | "fix";

export type StepResult = {
	name: string;
	status: "pass" | "fail" | "skip";
	detail: string;
};
type PythonQualityParams = { mode: QualityMode; path?: string };

export type QualityReport = {
	ok: boolean;
	complete: boolean;
	cwd: string;
	mode: QualityMode;
	steps: StepResult[];
};

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Argument sets tried in order until one exits 0, which is how
 * `sniff-install-tool` probes its own catalog.
 *
 * No single flag covers these binaries: `ruff`, `cargo`, `tsc` and `rustfmt`
 * answer `--version`; `go` answers `version` and rejects `--version`; `gofmt`
 * has no version verb at all and only answers help. A generic `--version` probe
 * therefore reports `go` and `gofmt` missing and silently skips Go checks, which
 * is worse than the bug it replaces.
 */
const PROBE_ARGS: readonly (readonly string[])[] = [["--version"], ["version"], ["-h"]];

/**
 * Whether `bin` can actually RUN, not merely resolve on PATH.
 *
 * `which` succeeds for a mise shim whose tool is not installed. A resolve-only
 * check therefore reports the tool present, the step fails when it executes, and
 * the report records an analyzer FAILURE where the truth is a missing tool --
 * the inverse of this tool's contract, which is that missing tools produce an
 * incomplete report rather than findings. Measured on one machine: mypy, pylint
 * and vulture each resolved and each failed, so the report implied code problems
 * that did not exist.
 *
 * A shim for an uninstalled tool fails every argument set, so the cascade cannot
 * be fooled into reporting one usable.
 */
function have(bin: string): boolean {
	for (const args of PROBE_ARGS) {
		try {
			const proc = Bun.spawnSync([bin, ...args], {
				// Closed stdin, because a probe must never wait on input: `gofmt` with
				// no arguments reads stdin, and an inherited terminal would block until
				// the timeout on every call.
				stdin: new Uint8Array(),
				stdout: "pipe",
				stderr: "pipe",
				timeout: PROBE_TIMEOUT_MS,
			});
			// A timeout is not a usable tool, whatever exit code accompanies it. This
			// mirrors `sniff-install-tool`, which treats `exitedDueToTimeout` as its
			// own status rather than folding it into the exit code.
			if (proc.exitCode === 0 && proc.exitedDueToTimeout !== true) return true;
		} catch {
			return false;
		}
	}
	return false;
}

function installed(bin: string, cwd: string): string | null {
	for (const dir of [join(cwd, ".venv", "bin"), join(cwd, "node_modules", ".bin")]) {
		const path = join(dir, bin);
		if (existsSync(path)) return path;
	}
	return have(bin) ? bin : null;
}

function run(
	argv: string[],
	cwd: string,
): { exitCode: number | null; stdout: string; stderr: string; error?: string } {
	try {
		const proc = Bun.spawnSync(argv, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		return {
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString().slice(0, 16_384),
			stderr: proc.stderr.toString().slice(0, 16_384),
		};
	} catch (err) {
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function fmtTable(steps: StepResult[]): string {
	return steps
		.map((s) => `${s.status.padEnd(4)}  ${s.name}${s.detail ? ` — ${s.detail}` : ""}`)
		.join("\n");
}

function record(
	steps: StepResult[],
	name: string,
	r: { exitCode: number | null; stdout: string; stderr: string; error?: string },
): void {
	if (r.error) {
		steps.push({ name, status: "fail", detail: r.error });
		return;
	}
	if (r.exitCode === 0) {
		steps.push({ name, status: "pass", detail: "" });
		return;
	}
	steps.push({
		name,
		status: "fail",
		detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`,
	});
}

export function runPythonQuality(mode: QualityMode, cwd: string): QualityReport {
	const steps: StepResult[] = [];
	const ruff = installed("ruff", cwd);
	const pyright = installed("pyright", cwd);
	const pytest = installed("pytest", cwd);
	const hasTests = existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "tests"));
	const hasPyProject = existsSync(join(cwd, "pyproject.toml"));
	if (!hasPyProject && !hasTests) {
		if (mode === "fix") {
			steps.push({ name: "ruff check --fix", status: "skip", detail: "no pyproject.toml or tests/" });
			steps.push({ name: "ruff format", status: "skip", detail: "no pyproject.toml or tests/" });
		} else {
			steps.push({ name: "ruff check", status: "skip", detail: "no pyproject.toml or tests/" });
			steps.push({ name: "ruff format --check", status: "skip", detail: "no pyproject.toml or tests/" });
			steps.push({ name: "pyright", status: "skip", detail: "no pyproject.toml or tests/" });
			steps.push({ name: "pytest", status: "skip", detail: "no pyproject.toml or tests/" });
		}
		return { ok: false, complete: false, cwd, mode, steps };
	}


	if (mode === "fix") {
		if (!ruff) {
			steps.push({ name: "ruff check --fix", status: "skip", detail: "ruff not on PATH" });
			steps.push({ name: "ruff format", status: "skip", detail: "ruff not on PATH" });
		} else {
			record(steps, "ruff check --fix", run([ruff, "check", "--fix", "."], cwd));
			record(steps, "ruff format", run([ruff, "format", "."], cwd));
		}
	} else {
		if (!ruff) {
			steps.push({ name: "ruff check", status: "skip", detail: "ruff not on PATH" });
			steps.push({ name: "ruff format --check", status: "skip", detail: "ruff not on PATH" });
		} else {
			record(steps, "ruff check", run([ruff, "check", "."], cwd));
			record(steps, "ruff format --check", run([ruff, "format", "--check", "."], cwd));
		}

		if (!pyright) {
			steps.push({ name: "pyright", status: "skip", detail: "pyright not on PATH" });
		} else {
			record(steps, "pyright", run([pyright], cwd));
		}

		if (!hasTests) {
			steps.push({
				name: "pytest",
				status: "skip",
				detail: "no pyproject.toml or tests/",
			});
		} else if (!pytest) {
			steps.push({ name: "pytest", status: "skip", detail: "pytest not on PATH" });
		} else {
			record(steps, "pytest", run([pytest], cwd));
		}
	}

	const complete = steps.length > 0 && steps.every((s) => s.status !== "skip");
	const ok = complete && steps.every((s) => s.status === "pass");
	return { ok, complete, cwd, mode, steps };
}

export default function pythonQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "python_quality",
		label: "Python quality",
		description:
			"Run installed ruff/pyright/pytest (check) or ruff --fix + format (fix). Missing projects or requested tools produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: ruff, pyright, pytest; fix: ruff check --fix + format"),
			path: z.string().optional().describe("Project cwd; defaults to session cwd"),
		}) as unknown as TSchema,
		execute: async (_id, params: PythonQualityParams, _signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(params.path ?? ctx?.cwd ?? process.cwd());
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = runPythonQuality(params.mode, cwd);
				return {
					content: [{ type: "text" as const, text: fmtTable(report.steps) }],
					details: report,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `python_quality error: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}
