import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
type GoQualityParams = { mode: QualityMode; path?: string };

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

export function runGoQuality(mode: QualityMode, cwd: string): QualityReport {
    const deadline = Date.now() + TIMEOUT_MS;
    const steps: StepResult[] = [];
    const hasMod = existsSync(resolve(cwd, "go.mod"));
    if (!hasMod) {
        if (mode === "fix") steps.push({ name: "gofmt -w", status: "skip", detail: "no go.mod" });
        else {
            steps.push({ name: "gofmt -l", status: "skip", detail: "no go.mod" });
            steps.push({ name: "golangci-lint", status: "skip", detail: "no go.mod" });
            steps.push({ name: "go test", status: "skip", detail: "no go.mod" });
        }
        return { ok: false, complete: false, cwd, mode, steps };
    }
    // Probe only once the project exists. With no go.mod every probe is wasted.
    const probeDeadline = Math.min(deadline, Date.now() + PROBE_BUDGET_MS);
    const gofmtOk = have("gofmt", probeDeadline);
    const goOk = have("go", probeDeadline);
    const lintOk = have("golangci-lint", probeDeadline);
    if (mode === "fix") {
        if (!gofmtOk) steps.push({ name: "gofmt -w", status: "skip", detail: "gofmt not on PATH" });
        else {
            const r = run(["gofmt", "-w", "."], cwd, deadline);
            steps.push({ name: "gofmt -w", status: r.error || r.exitCode !== 0 ? "fail" : "pass", detail: r.error ?? (r.exitCode === 0 ? "" : (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`) });
        }
    } else {
        if (!gofmtOk) steps.push({ name: "gofmt -l", status: "skip", detail: "gofmt not on PATH" });
        else {
            const r = run(["gofmt", "-l", "."], cwd, deadline);
            steps.push({ name: "gofmt -l", status: r.error || r.exitCode !== 0 || Boolean(r.stdout.trim()) ? "fail" : "pass", detail: r.error ?? (r.stderr || r.stdout).trim() });
        }
        if (!lintOk) steps.push({ name: "golangci-lint", status: "skip", detail: "golangci-lint not on PATH" });
        else {
            const r = run(["golangci-lint", "run"], cwd, deadline);
            steps.push({ name: "golangci-lint", status: r.error || r.exitCode !== 0 ? "fail" : "pass", detail: r.error ?? (r.exitCode === 0 ? "" : (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`) });
        }
        if (!goOk) steps.push({ name: "go test", status: "skip", detail: "go not on PATH" });
        else {
            const r = run(["go", "test", "./..."], cwd, deadline);
            steps.push({ name: "go test", status: r.error || r.exitCode !== 0 ? "fail" : "pass", detail: r.error ?? (r.exitCode === 0 ? "" : (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`) });
        }
    }
    const complete = steps.length > 0 && steps.every((s) => s.status !== "skip") && Date.now() < deadline;
    const ok = complete && steps.every((s) => s.status === "pass");
    return { ok, complete, cwd, mode, steps };
}

export default function goQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "go_quality",
		label: "Go quality",
		description:
			"Run Go format/lint/test (check) or gofmt -w (fix). Missing projects or requested tools produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: gofmt -l, golangci-lint, go test; fix: gofmt -w"),
			path: z.string().optional().describe("Project cwd; defaults to session cwd"),
		}) as unknown as TSchema,
		execute: async (_id, params: GoQualityParams, _signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(params.path ?? ctx?.cwd ?? process.cwd());
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = runGoQuality(params.mode, cwd);
				return {
					content: [{ type: "text" as const, text: fmtTable(report.steps) }],
					details: report,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `go_quality error: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}
