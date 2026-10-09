import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Per-command bound. A registered tool's execute runs under no harness deadline, and
 * pyright alone has taken more than 120 s on a real project, so this bound only stops a
 * hung command. The caller's abort signal cancels sooner.
 */
export const COMMAND_TIMEOUT_MS = 600_000;

/** pytest's exit status when it collected no tests. */
const PYTEST_NO_TESTS = 5;

export type QualityMode = "check" | "fix";

export type StepResult = {
	name: string;
	status: "pass" | "fail" | "skip";
	detail: string;
};
type PythonQualityParams = { mode: QualityMode; path?: string };
export type QualityOptions = { signal?: AbortSignal; timeoutMs?: number };

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
async function have(bin: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
    for (const args of PROBE_ARGS) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const r = await run([bin, ...args], undefined, signal, Math.min(PROBE_TIMEOUT_MS, remaining));
        if ("exitCode" in r && r.exitCode === 0) return true;
    }
    return false;
}
async function installed(bin: string, cwd: string, deadline: number, signal?: AbortSignal): Promise<string | null> {
    for (const dir of [join(cwd, ".venv", "bin"), join(cwd, "node_modules", ".bin")]) {
        const path = join(dir, bin);
        if (existsSync(path)) return path;
    }
    return (await have(bin, deadline, signal)) ? bin : null;
}

/** A command that reached an exit status, or why it reached none. */
type RunResult = { exitCode: number; stdout: string; stderr: string } | { unrun: string };

async function run(argv: string[], cwd: string | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
    if (signal?.aborted) return { unrun: "cancelled" };
    const timer = new AbortController();
    // No handler ctx reaches this helper, so the raw timer stays; its callback must never throw,
    // because a throw here would surface as uncaughtException long after the call returned.
    const handle = setTimeout(() => {
        try {
            timer.abort();
        } catch {
            // Nothing to recover: the command is then bounded only by the caller's signal.
        }
    }, timeoutMs);
    const stop = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
    const stopped = new Promise<null>((done) => stop.addEventListener("abort", () => done(null), { once: true }));
    const reason = () => (signal?.aborted ? "cancelled" : `timed out after ${timeoutMs / 1000} s`);
    try {
        // Aborting `stop` kills the process; the race returns without waiting on it.
        const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: stop });
        // Drain both pipes while the command runs, so a chatty command cannot block on a full pipe.
        const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).catch(() => ["", ""]);
        const exitCode = await Promise.race([proc.exited, stopped]);
        if (exitCode === null || stop.aborted) return { unrun: reason() };
        const texts = await Promise.race([output, stopped]);
        if (texts === null) return { unrun: reason() };
        const [stdout = "", stderr = ""] = texts;
        return { exitCode, stdout: stdout.slice(0, 16_384), stderr: stderr.slice(0, 16_384) };
    } catch (err) {
        return { unrun: err instanceof Error ? err.message : String(err) };
    } finally {
        clearTimeout(handle);
    }
}

function fmtTable(steps: StepResult[]): string {
    return steps.map((s) => `${s.status.padEnd(4)}  ${s.name}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
}

function verdict(name: string, r: RunResult): StepResult {
    // A command that never reached an exit status made no finding: that is a skip, not a failure.
    if ("unrun" in r) return { name, status: "skip", detail: r.unrun };
    if (r.exitCode === 0) return { name, status: "pass", detail: "" };
    if (name === "pytest" && r.exitCode === PYTEST_NO_TESTS) return { name, status: "skip", detail: "no tests collected" };
    return { name, status: "fail", detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}` };
}

type PlannedStep = { name: string; tool: string; bin: string | null; args: string[] };

/** Runs every step on the whole project at `cwd`; there is no narrower scope. */
export async function runPythonQuality(mode: QualityMode, cwd: string, { signal, timeoutMs = COMMAND_TIMEOUT_MS }: QualityOptions = {}): Promise<QualityReport> {
    if (!existsSync(join(cwd, "pyproject.toml")) && !existsSync(join(cwd, "tests"))) {
        const names = mode === "fix" ? ["ruff check --fix", "ruff format"] : ["ruff check", "ruff format --check", "pyright", "pytest"];
        const steps = names.map((name): StepResult => ({ name, status: "skip", detail: "no pyproject.toml or tests/" }));
        return { ok: false, complete: false, cwd, mode, steps };
    }
    // Probe only once the project exists. With neither a pyproject.toml nor a tests/ directory
    // every probe is wasted work, and three binaries at three argument sets and 1,000 ms each
    // reach 9,000 ms, which outlasts a CI test's own 5,000 ms limit on a runner with no
    // Python tooling installed.
    const probeDeadline = Date.now() + PROBE_BUDGET_MS;
    const ruff = await installed("ruff", cwd, probeDeadline, signal);
    const plan: PlannedStep[] =
        mode === "fix"
            ? [
                  { name: "ruff check --fix", tool: "ruff", bin: ruff, args: ["check", "--fix", "."] },
                  { name: "ruff format", tool: "ruff", bin: ruff, args: ["format", "."] },
              ]
            : [
                  { name: "ruff check", tool: "ruff", bin: ruff, args: ["check", "."] },
                  { name: "ruff format --check", tool: "ruff", bin: ruff, args: ["format", "--check", "."] },
                  { name: "pyright", tool: "pyright", bin: await installed("pyright", cwd, probeDeadline, signal), args: [] },
                  { name: "pytest", tool: "pytest", bin: await installed("pytest", cwd, probeDeadline, signal), args: [] },
              ];
    const steps: StepResult[] = [];
    for (const { name, tool, bin, args } of plan) {
        if (signal?.aborted) steps.push({ name, status: "skip", detail: "not run: cancelled" });
        else if (!bin) steps.push({ name, status: "skip", detail: `${tool} not on PATH` });
        else steps.push(verdict(name, await run([bin, ...args], cwd, signal, timeoutMs)));
    }
    const complete = steps.every((s) => s.status !== "skip");
    const ok = complete && steps.every((s) => s.status === "pass");
    return { ok, complete, cwd, mode, steps };
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
