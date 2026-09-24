import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** A tool_call has a 30,000 ms budget; leave 5,000 ms for dispatch and reporting. */
export const TIMEOUT_MS = 25_000;

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

/**
 * Probe budget shared by all tool availability checks. A slow or broken shim
 * must not consume the quality command budget before checks begin.
 */
const PROBE_BUDGET_MS = 10_000;

/** Per-probe bound for a mise shim's resolution and version check. */
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
function have(bin: string, deadline = Date.now() + TIMEOUT_MS): boolean {
    for (const args of PROBE_ARGS) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        try {
            const proc = Bun.spawnSync([bin, ...args], { stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe", timeout: Math.min(PROBE_TIMEOUT_MS, remaining) });
            if (proc.exitCode === 0 && proc.exitedDueToTimeout !== true && Date.now() < deadline) return true;
        } catch {
            return false;
        }
    }
    return false;
}
function installed(bin: string, cwd: string, deadline: number): string | null {
    for (const dir of [join(cwd, ".venv", "bin"), join(cwd, "node_modules", ".bin")]) {
        const path = join(dir, bin);
        if (existsSync(path)) return path;
    }
    return have(bin, deadline) ? bin : null;
}

function run(
    argv: string[],
    cwd: string,
    deadline = Date.now() + TIMEOUT_MS,
): { exitCode: number | null; stdout: string; stderr: string; error?: string } {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { exitCode: null, stdout: "", stderr: "", error: "quality event budget exhausted" };
    try {
        const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: Math.min(TIMEOUT_MS, remaining) });
        return { exitCode: proc.exitCode, stdout: proc.stdout.toString().slice(0, 16_384), stderr: proc.stderr.toString().slice(0, 16_384), ...(proc.exitedDueToTimeout === true ? { error: "quality command timed out" } : {}) };
    } catch (err) {
        return { exitCode: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) };
    }
}

function fmtTable(steps: StepResult[]): string {
    return steps.map((s) => `${s.status.padEnd(4)}  ${s.name}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
}

function record(steps: StepResult[], name: string, r: { exitCode: number | null; stdout: string; stderr: string; error?: string }): void {
    if (r.error) {
        steps.push({ name, status: "fail", detail: r.error });
        return;
    }
    if (r.exitCode === 0) {
        steps.push({ name, status: "pass", detail: "" });
        return;
    }
    steps.push({ name, status: "fail", detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}` });
}

export function runPythonQuality(mode: QualityMode, cwd: string): QualityReport {
    const deadline = Date.now() + TIMEOUT_MS;
    const steps: StepResult[] = [];
    const hasPyProject = existsSync(join(cwd, "pyproject.toml"));
    const hasTests = hasPyProject || existsSync(join(cwd, "tests"));
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
    // Probe only once the project exists. With neither a pyproject.toml nor a tests/ directory
    // every probe is wasted work, and three binaries at three argument sets and 1,000 ms each
    // reach 9,000 ms, which outlasts a CI test's own 5,000 ms limit on a runner with no
    // Python tooling installed.
    const probeDeadline = Math.min(deadline, Date.now() + PROBE_BUDGET_MS);
    const ruff = installed("ruff", cwd, probeDeadline);
    const pyright = installed("pyright", cwd, probeDeadline);
    const pytest = installed("pytest", cwd, probeDeadline);
    if (mode === "fix") {
        if (!ruff) {
            steps.push({ name: "ruff check --fix", status: "skip", detail: "ruff not on PATH" });
            steps.push({ name: "ruff format", status: "skip", detail: "ruff not on PATH" });
        } else {
            record(steps, "ruff check --fix", run([ruff, "check", "--fix", "."], cwd, deadline));
            record(steps, "ruff format", run([ruff, "format", "."], cwd, deadline));
        }
    } else {
        if (!ruff) {
            steps.push({ name: "ruff check", status: "skip", detail: "ruff not on PATH" });
            steps.push({ name: "ruff format --check", status: "skip", detail: "ruff not on PATH" });
        } else {
            record(steps, "ruff check", run([ruff, "check", "."], cwd, deadline));
            record(steps, "ruff format --check", run([ruff, "format", "--check", "."], cwd, deadline));
        }
        if (!pyright) steps.push({ name: "pyright", status: "skip", detail: "pyright not on PATH" });
        else record(steps, "pyright", run([pyright], cwd, deadline));
        if (!hasTests) steps.push({ name: "pytest", status: "skip", detail: "no pyproject.toml or tests/" });
        else if (!pytest) steps.push({ name: "pytest", status: "skip", detail: "pytest not on PATH" });
        else record(steps, "pytest", run([pytest], cwd, deadline));
    }
    const complete = steps.length > 0 && steps.every((s) => s.status !== "skip") && Date.now() < deadline;
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
