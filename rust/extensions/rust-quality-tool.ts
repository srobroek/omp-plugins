import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const TIMEOUT_MS = 600_000;

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
		return { ok: true, cwd, mode, steps };
	}


	if (!cargoOk) {
		if (mode === "fix") {
			steps.push({ name: "cargo fmt", status: "skip", detail: "cargo not on PATH" });
		} else {
			steps.push({ name: "cargo fmt --check", status: "skip", detail: "cargo not on PATH" });
			steps.push({ name: "cargo clippy", status: "skip", detail: "cargo not on PATH" });
			steps.push({ name: "cargo test", status: "skip", detail: "cargo not on PATH" });
		}
		return { ok: true, cwd, mode, steps };
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

	const ok = steps.every((s) => s.status !== "fail");
	return { ok, cwd, mode, steps };
}

export default function rustQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "rust_quality",
		label: "Rust quality",
		description:
			"Run cargo fmt/clippy/test (check) or cargo fmt (fix). Missing cargo is skipped.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: fmt --check, clippy -D warnings, test; fix: cargo fmt"),
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
