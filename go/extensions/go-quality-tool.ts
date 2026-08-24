import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
		return { ok: true, cwd, mode, steps };
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

	const ok = steps.every((s) => s.status !== "fail");
	return { ok, cwd, mode, steps };
}

export default function goQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "go_quality",
		label: "Go quality",
		description:
			"Run Go format/lint/test (check) or gofmt -w (fix). Missing binaries are skipped.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: gofmt -l, golangci-lint, go test; fix: gofmt -w"),
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
