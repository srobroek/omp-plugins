import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
    report,
    runSteps,
    type StepResult,
} from "./quality-runner.ts";

type RustQualityParams = { mode: QualityMode; path?: string };

const STEPS: Record<QualityMode, { name: string; args: string[] }[]> = {
    fix: [{ name: "cargo fmt", args: ["fmt"] }],
    check: [
        { name: "cargo fmt --check", args: ["fmt", "--check"] },
        { name: "cargo clippy", args: ["clippy", "--all-targets", "--all-features", "--", "-D", "warnings"] },
        { name: "cargo test", args: ["test"] },
    ],
};

export async function runRustQuality(mode: QualityMode, cwd: string, options: QualityOptions = {}): Promise<QualityReport> {
    if (!existsSync(resolve(cwd, "Cargo.toml"))) {
        return report(mode, cwd, STEPS[mode].map(({ name }): StepResult => ({ name, status: "skip", detail: "no Cargo.toml" })));
    }
    // Probe only once the manifest exists: with no Cargo.toml the probe is wasted work, and
    // three argument sets at 1,000 ms each outlast a CI test's own limit where no Rust
    // toolchain is installed.
    const cargo = (await have("cargo", Date.now() + PROBE_BUDGET_MS, options.signal)) ? "cargo" : null;
    const plan = STEPS[mode].map(({ name, args }): PlannedStep => ({ name, bin: cargo, args, missing: "cargo not on PATH" }));
    return report(mode, cwd, await runSteps(plan, cwd, options));
}

export default function rustQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "rust_quality",
		label: "Rust quality",
		description:
			"Run cargo fmt/clippy/test (check) or cargo fmt (fix). Missing projects or cargo, and commands that time out or are cancelled, produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: fmt --check, clippy -D warnings, test; fix: cargo fmt"),
			path: z.string().optional().describe("Project cwd; defaults to session cwd"),
		}) as unknown as TSchema,
		execute: async (_id, params: RustQualityParams, signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(ctx?.cwd ?? process.cwd(), params.path ?? ".");
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = await runRustQuality(params.mode, cwd, { signal });
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
