import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 300_000;

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
	const rows = steps.map((s) => `${s.status.padEnd(4)}  ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
	return rows.join("\n");
}

export function runGoQuality(mode: QualityMode, cwd: string): QualityReport {
	const steps: StepResult[] = [];
	const gofmtOk = have("gofmt");
	const goOk = have("go");
	const lintOk = have("golangci-lint");
	const hasMod = existsSync(resolve(cwd, "go.mod"));
	if (!hasMod) {
		if (mode === "fix") {
			steps.push({ name: "gofmt -w", status: "skip", detail: "no go.mod" });
		} else {
			steps.push({ name: "gofmt -l", status: "skip", detail: "no go.mod" });
			steps.push({ name: "golangci-lint", status: "skip", detail: "no go.mod" });
			steps.push({ name: "go test", status: "skip", detail: "no go.mod" });
		}
		return { ok: false, complete: false, cwd, mode, steps };
	}


	if (mode === "fix") {
		if (!gofmtOk) {
			steps.push({ name: "gofmt -w", status: "skip", detail: "gofmt not on PATH" });
		} else {
			const r = run(["gofmt", "-w", "."], cwd);
			if (r.error) {
				steps.push({ name: "gofmt -w", status: "fail", detail: r.error });
			} else if (r.exitCode === 0) {
				steps.push({ name: "gofmt -w", status: "pass", detail: "" });
			} else {
				steps.push({
					name: "gofmt -w",
					status: "fail",
					detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`,
				});
			}
		}
	} else {
		if (!gofmtOk) {
			steps.push({ name: "gofmt -l", status: "skip", detail: "gofmt not on PATH" });
		} else {
			const r = run(["gofmt", "-l", "."], cwd);
			if (r.error) {
				steps.push({ name: "gofmt -l", status: "fail", detail: r.error });
			} else if (r.exitCode !== 0) {
				steps.push({
					name: "gofmt -l",
					status: "fail",
					detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`,
				});
			} else if (r.stdout.trim()) {
				steps.push({ name: "gofmt -l", status: "fail", detail: r.stdout.trim() });
			} else {
				steps.push({ name: "gofmt -l", status: "pass", detail: "" });
			}
		}

		if (!lintOk) {
			steps.push({ name: "golangci-lint", status: "skip", detail: "golangci-lint not on PATH" });
		} else {
			const r = run(["golangci-lint", "run"], cwd);
			if (r.error) {
				steps.push({ name: "golangci-lint", status: "fail", detail: r.error });
			} else if (r.exitCode === 0) {
				steps.push({ name: "golangci-lint", status: "pass", detail: "" });
			} else {
				steps.push({
					name: "golangci-lint",
					status: "fail",
					detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`,
				});
			}
		}

		if (!goOk) {
			steps.push({ name: "go test", status: "skip", detail: "go not on PATH" });
		} else {
			const r = run(["go", "test", "./..."], cwd);
			if (r.error) {
				steps.push({ name: "go test", status: "fail", detail: r.error });
			} else if (r.exitCode === 0) {
				steps.push({ name: "go test", status: "pass", detail: "" });
			} else {
				steps.push({
					name: "go test",
					status: "fail",
					detail: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`,
				});
			}
		}
	}

	const complete = steps.length > 0 && steps.every((s) => s.status !== "skip");
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
