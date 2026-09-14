import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 600_000;

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

export function runRustQuality(mode: QualityMode, cwd: string): QualityReport {
	const steps: StepResult[] = [];
	const cargoOk = have("cargo");
	if (!existsSync(resolve(cwd, "Cargo.toml"))) {
		if (mode === "fix") {
			steps.push({ name: "cargo fmt", status: "skip", detail: "no Cargo.toml" });
		} else {
			steps.push({ name: "cargo fmt --check", status: "skip", detail: "no Cargo.toml" });
			steps.push({ name: "cargo clippy", status: "skip", detail: "no Cargo.toml" });
			steps.push({ name: "cargo test", status: "skip", detail: "no Cargo.toml" });
		}
		return { ok: false, complete: false, cwd, mode, steps };
	}


	if (!cargoOk) {
		if (mode === "fix") {
			steps.push({ name: "cargo fmt", status: "skip", detail: "cargo not on PATH" });
		} else {
			steps.push({ name: "cargo fmt --check", status: "skip", detail: "cargo not on PATH" });
			steps.push({ name: "cargo clippy", status: "skip", detail: "cargo not on PATH" });
			steps.push({ name: "cargo test", status: "skip", detail: "cargo not on PATH" });
		}
		return { ok: false, complete: false, cwd, mode, steps };
	}

	if (mode === "fix") {
		record(steps, "cargo fmt", run(["cargo", "fmt"], cwd));
	} else {
		record(steps, "cargo fmt --check", run(["cargo", "fmt", "--check"], cwd));
		record(
			steps,
			"cargo clippy",
			run(["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"], cwd),
		);
		record(steps, "cargo test", run(["cargo", "test"], cwd));
	}

	const complete = steps.length > 0 && steps.every((s) => s.status !== "skip");
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
