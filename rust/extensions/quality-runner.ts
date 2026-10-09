/**
 * Probing, command running and step reporting shared by the python, typescript, go and
 * rust quality tools. Each plugin bundles in isolation, so each carries an identical copy
 * of this file, and scripts/check-shared-detector.py fails CI when one copy drifts.
 */

/**
 * Per-command bound. A registered tool's execute runs under no harness deadline, and
 * pyright alone has taken more than 120 s on a real project, so this bound only stops a
 * hung command. The caller's abort signal cancels sooner.
 */
export const COMMAND_TIMEOUT_MS = 600_000;

export type QualityMode = "check" | "fix";

export type StepResult = {
	name: string;
	status: "pass" | "fail" | "skip";
	detail: string;
};

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
export const PROBE_BUDGET_MS = 10_000;

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
export async function have(bin: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
    for (const args of PROBE_ARGS) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const r = await run([bin, ...args], undefined, signal, Math.min(PROBE_TIMEOUT_MS, remaining));
        if ("exitCode" in r && r.exitCode === 0) return true;
    }
    return false;
}

/** A command that reached an exit status, or why it reached none. */
export type RunResult = { exitCode: number; stdout: string; stderr: string } | { unrun: string };

export async function run(argv: string[], cwd: string | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
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

export function fmtTable(steps: StepResult[]): string {
    return steps.map((s) => `${s.status.padEnd(4)}  ${s.name}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
}

/** How a command result reads as a step; a tool passes its own to treat a tool-specific exit as no finding. */
export type Verdict = (name: string, r: RunResult) => StepResult;

export function verdict(name: string, r: RunResult): StepResult {
    // A command that never reached an exit status made no finding: that is a skip, not a failure.
    if ("unrun" in r) return { name, status: "skip", detail: r.unrun };
    if (r.exitCode === 0) return { name, status: "pass", detail: "" };
    return { name, status: "fail", detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}` };
}

/** A step to run as `[bin, ...args]`; with no `bin`, the step is a skip that reads `missing`. */
export type PlannedStep = { name: string; bin: string | null; args: string[]; missing: string };

/**
 * Runs `plan` in order. Each command gets its own bound, so a slow step costs no later
 * step its time; once the caller cancels, the running step and every later one is a skip.
 */
export async function runSteps(
    plan: PlannedStep[],
    cwd: string,
    { signal, timeoutMs = COMMAND_TIMEOUT_MS }: QualityOptions,
    judge: Verdict = verdict,
): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    for (const { name, bin, args, missing } of plan) {
        if (signal?.aborted) steps.push({ name, status: "skip", detail: "not run: cancelled" });
        else if (!bin) steps.push({ name, status: "skip", detail: missing });
        else steps.push(judge(name, await run([bin, ...args], cwd, signal, timeoutMs)));
    }
    return steps;
}

/** A report is complete only when every step reached a verdict, and ok only when every step passed. */
export function report(mode: QualityMode, cwd: string, steps: StepResult[]): QualityReport {
    const complete = steps.length > 0 && steps.every((s) => s.status !== "skip");
    const ok = complete && steps.every((s) => s.status === "pass");
    return { ok, complete, cwd, mode, steps };
}
