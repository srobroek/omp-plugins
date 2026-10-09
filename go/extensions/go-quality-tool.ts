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
    type RunResult,
    report,
    runSteps,
    type StepResult,
    verdict,
} from "./quality-runner.ts";

type GoQualityParams = { mode: QualityMode; path?: string };

const STEPS: Record<QualityMode, { name: string; bin: string; args: string[] }[]> = {
    fix: [{ name: "gofmt -w", bin: "gofmt", args: ["-w", "."] }],
    check: [
        { name: "gofmt -l", bin: "gofmt", args: ["-l", "."] },
        { name: "golangci-lint", bin: "golangci-lint", args: ["run"] },
        { name: "go test", bin: "go", args: ["test", "./..."] },
    ],
};

/** `gofmt -l` exits 0 even when it lists unformatted files, so any listed file is the finding. */
function goVerdict(name: string, r: RunResult): StepResult {
    if (name === "gofmt -l" && "exitCode" in r && r.exitCode === 0 && r.stdout.trim()) return { name, status: "fail", detail: r.stdout.trim() };
    return verdict(name, r);
}

export async function runGoQuality(mode: QualityMode, cwd: string, options: QualityOptions = {}): Promise<QualityReport> {
    if (!existsSync(resolve(cwd, "go.mod"))) {
        return report(mode, cwd, STEPS[mode].map(({ name }): StepResult => ({ name, status: "skip", detail: "no go.mod" })));
    }
    // Probe only once the project exists. With no go.mod every probe is wasted work, and
    // three binaries at three argument sets and 1,000 ms each can reach 9,000 ms, which
    // outlasts a CI test's own 5,000 ms limit on a runner where no Go toolchain is present.
    const probeDeadline = Date.now() + PROBE_BUDGET_MS;
    const plan: PlannedStep[] = [];
    for (const { name, bin, args } of STEPS[mode]) {
        const found = await have(bin, probeDeadline, options.signal);
        plan.push({ name, bin: found ? bin : null, args, missing: `${bin} not on PATH` });
    }
    return report(mode, cwd, await runSteps(plan, cwd, options, goVerdict));
}

export default function goQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "go_quality",
		label: "Go quality",
		description:
			"Run Go format/lint/test (check) or gofmt -w (fix). Missing projects or requested tools, and commands that time out or are cancelled, produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: gofmt -l, golangci-lint, go test; fix: gofmt -w"),
			path: z.string().optional().describe("Project cwd; defaults to session cwd"),
		}) as unknown as TSchema,
		execute: async (_id, params: GoQualityParams, signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(ctx?.cwd ?? process.cwd(), params.path ?? ".");
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = await runGoQuality(params.mode, cwd, { signal });
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
