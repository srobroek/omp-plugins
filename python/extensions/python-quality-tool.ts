import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
    fmtTable,
    have,
    type PlannedStep,
    PROBE_BUDGET_MS,
    type QualityMode,
    type QualityOptions,
    type QualityReport,
    type RunResult,
    report,
    runSteps,
    type StepResult,
    verdict,
} from "./quality-runner.ts";

/** pytest's exit status when it collected no tests. */
const PYTEST_NO_TESTS = 5;

type PythonQualityParams = { mode: QualityMode; path?: string };

async function installed(bin: string, cwd: string, deadline: number, signal?: AbortSignal): Promise<string | null> {
    for (const dir of [join(cwd, ".venv", "bin"), join(cwd, "node_modules", ".bin")]) {
        const path = join(dir, bin);
        if (existsSync(path)) return path;
    }
    return (await have(bin, deadline, signal)) ? bin : null;
}

function pythonVerdict(name: string, r: RunResult): StepResult {
    if (name === "pytest" && "exitCode" in r && r.exitCode === PYTEST_NO_TESTS) return { name, status: "skip", detail: "no tests collected" };
    return verdict(name, r);
}

/** Runs every step on the whole project at `cwd`; there is no narrower scope. */
export async function runPythonQuality(mode: QualityMode, cwd: string, options: QualityOptions = {}): Promise<QualityReport> {
    if (!existsSync(join(cwd, "pyproject.toml")) && !existsSync(join(cwd, "tests"))) {
        const names = mode === "fix" ? ["ruff check --fix", "ruff format"] : ["ruff check", "ruff format --check", "pyright", "pytest"];
        return report(mode, cwd, names.map((name): StepResult => ({ name, status: "skip", detail: "no pyproject.toml or tests/" })));
    }
    // Probe only once the project exists. With neither a pyproject.toml nor a tests/ directory
    // every probe is wasted work, and three binaries at three argument sets and 1,000 ms each
    // reach 9,000 ms, which outlasts a CI test's own 5,000 ms limit on a runner with no
    // Python tooling installed.
    const { signal } = options;
    const probeDeadline = Date.now() + PROBE_BUDGET_MS;
    const ruff = await installed("ruff", cwd, probeDeadline, signal);
    const plan: PlannedStep[] =
        mode === "fix"
            ? [
                  { name: "ruff check --fix", bin: ruff, args: ["check", "--fix", "."], missing: "ruff not on PATH" },
                  { name: "ruff format", bin: ruff, args: ["format", "."], missing: "ruff not on PATH" },
              ]
            : [
                  { name: "ruff check", bin: ruff, args: ["check", "."], missing: "ruff not on PATH" },
                  { name: "ruff format --check", bin: ruff, args: ["format", "--check", "."], missing: "ruff not on PATH" },
                  { name: "pyright", bin: await installed("pyright", cwd, probeDeadline, signal), args: [], missing: "pyright not on PATH" },
                  { name: "pytest", bin: await installed("pytest", cwd, probeDeadline, signal), args: [], missing: "pytest not on PATH" },
              ];
    return report(mode, cwd, await runSteps(plan, cwd, options, pythonVerdict));
}

export default function pythonQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "python_quality",
		label: "Python quality",
		description:
			"Run installed ruff/pyright/pytest (check) or ruff --fix + format (fix) on the whole project at `path`. Missing projects, missing tools, and commands that time out or are cancelled produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: ruff, pyright, pytest; fix: ruff check --fix + format"),
			path: z.string().optional().describe("Project root holding pyproject.toml or tests/; relative paths resolve against the session cwd, the default"),
		}) as unknown as TSchema,
		execute: async (_id, params: PythonQualityParams, signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(ctx?.cwd ?? process.cwd(), params.path ?? ".");
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = await runPythonQuality(params.mode, cwd, { signal });
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
