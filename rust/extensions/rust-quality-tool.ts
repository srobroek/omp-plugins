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
type RustQualityParams = { mode: QualityMode; path?: string };

export type QualityReport = {
	ok: boolean;
	complete: boolean;
	cwd: string;
	mode: QualityMode;
	steps: StepResult[];
};

/**
 * Per-probe bound. Each probe is one spawn, and every one of these binaries is a
 * mise shim that pays its own resolution on each spawn, so the cost is not a
 * local lookup. Measured warm, first successful argument set: pyright 2689 ms,
 * tsc 2388 ms, biome 2089 ms, rustfmt 1651 ms, cargo 1110 ms, ruff 953 ms, go
 * 736 ms. At 1000 ms five of those seven installed tools were killed and
 * reported not runnable, which inverts what this probe is for: it exists so a
 * resolvable-but-broken shim cannot count as present, not so a working tool can
 * be called absent. 5000 ms clears the slowest measured probe by 1.9x.
 *
 * Affordable only because the manifest is checked first. A repository with no
 * project for this language probes nothing, so an empty runner pays zero rather
 * than three binaries times three argument sets.
 */
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

export function runRustQuality(mode: QualityMode, cwd: string): QualityReport {
    const deadline = Date.now() + TIMEOUT_MS;
    const steps: StepResult[] = [];
    if (!existsSync(resolve(cwd, "Cargo.toml"))) {
        if (mode === "fix") steps.push({ name: "cargo fmt", status: "skip", detail: "no Cargo.toml" });
        else {
            steps.push({ name: "cargo fmt --check", status: "skip", detail: "no Cargo.toml" });
            steps.push({ name: "cargo clippy", status: "skip", detail: "no Cargo.toml" });
            steps.push({ name: "cargo test", status: "skip", detail: "no Cargo.toml" });
        }
        return { ok: false, complete: false, cwd, mode, steps };
    }
    // Probe only once the manifest exists: with no Cargo.toml the probe is wasted work, and
    // three argument sets at 1,000 ms each outlast a CI test's own limit where no Rust
    // toolchain is installed.
    const cargoOk = have("cargo", deadline);
    if (!cargoOk) {
        if (mode === "fix") steps.push({ name: "cargo fmt", status: "skip", detail: "cargo not on PATH" });
        else {
            steps.push({ name: "cargo fmt --check", status: "skip", detail: "cargo not on PATH" });
            steps.push({ name: "cargo clippy", status: "skip", detail: "cargo not on PATH" });
            steps.push({ name: "cargo test", status: "skip", detail: "cargo not on PATH" });
        }
        return { ok: false, complete: false, cwd, mode, steps };
    }
    if (mode === "fix") record(steps, "cargo fmt", run(["cargo", "fmt"], cwd, deadline));
    else {
        record(steps, "cargo fmt --check", run(["cargo", "fmt", "--check"], cwd, deadline));
        record(steps, "cargo clippy", run(["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"], cwd, deadline));
        record(steps, "cargo test", run(["cargo", "test"], cwd, deadline));
    }
    const complete = steps.length > 0 && steps.every((s) => s.status !== "skip") && Date.now() < deadline;
    const ok = complete && steps.every((s) => s.status === "pass");
    return { ok, complete, cwd, mode, steps };
}

export default function rustQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "rust_quality",
		label: "Rust quality",
		description:
			"Run cargo fmt/clippy/test (check) or cargo fmt (fix). Missing projects or cargo produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: fmt --check, clippy -D warnings, test; fix: cargo fmt"),
			path: z.string().optional().describe("Project cwd; defaults to session cwd"),
		}) as unknown as TSchema,
		execute: async (_id, params: RustQualityParams, _signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(params.path ?? ctx?.cwd ?? process.cwd());
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = runRustQuality(params.mode, cwd);
				return {
					content: [{ type: "text" as const, text: fmtTable(report.steps) }],
					details: report,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `rust_quality error: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}
