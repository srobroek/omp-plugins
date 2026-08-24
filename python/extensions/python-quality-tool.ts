import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const TIMEOUT_MS = 300_000;

export type QualityMode = "check" | "fix";

export type StepResult = {
	name: string;
	status: "pass" | "fail" | "skip";
	detail: string;
};

export type QualityReport = {
	ok: boolean;
	cwd: string;
	mode: QualityMode;
	steps: StepResult[];
};

function have(bin: string): boolean {
	const proc = Bun.spawnSync(["which", bin], { stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0;
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
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
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
	const ruffOk = have("ruff");
	const pyrightOk = have("pyright");
	const pytestOk = have("pytest");
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
		return { ok: true, cwd, mode, steps };
	}


	if (mode === "fix") {
		if (!ruffOk) {
			steps.push({ name: "ruff check --fix", status: "skip", detail: "ruff not on PATH" });
			steps.push({ name: "ruff format", status: "skip", detail: "ruff not on PATH" });
		} else {
			record(steps, "ruff check --fix", run(["ruff", "check", "--fix", "."], cwd));
			record(steps, "ruff format", run(["ruff", "format", "."], cwd));
		}
	} else {
		if (!ruffOk) {
			steps.push({ name: "ruff check", status: "skip", detail: "ruff not on PATH" });
			steps.push({ name: "ruff format --check", status: "skip", detail: "ruff not on PATH" });
		} else {
			record(steps, "ruff check", run(["ruff", "check", "."], cwd));
			record(steps, "ruff format --check", run(["ruff", "format", "--check", "."], cwd));
		}

		if (!pyrightOk) {
			steps.push({ name: "pyright", status: "skip", detail: "pyright not on PATH" });
		} else {
			record(steps, "pyright", run(["pyright"], cwd));
		}

		if (!hasTests) {
			steps.push({
				name: "pytest",
				status: "skip",
				detail: "no pyproject.toml or tests/",
			});
		} else if (!pytestOk) {
			steps.push({ name: "pytest", status: "skip", detail: "pytest not on PATH" });
		} else {
			record(steps, "pytest", run(["pytest"], cwd));
		}
	}

	const ok = steps.every((s) => s.status !== "fail");
	return { ok, cwd, mode, steps };
}

export default function pythonQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "python_quality",
		label: "Python quality",
		description:
			"Run ruff/pyright/pytest (check) or ruff --fix + format (fix). Missing binaries are skipped.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: ruff, pyright, pytest; fix: ruff check --fix + format"),
			path: z.string().optional().describe("Project cwd; defaults to session cwd"),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
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
