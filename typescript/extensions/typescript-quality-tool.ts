import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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

type TypescriptQualityParams = { mode: QualityMode; path?: string };

function local(bin: string, cwd: string): string | null {
    const path = join(cwd, "node_modules", ".bin", bin);
    return existsSync(path) ? path : null;
}

async function installed(bin: string, cwd: string, deadline: number, signal?: AbortSignal): Promise<string | null> {
    return local(bin, cwd) ?? ((await have(bin, deadline, signal)) ? bin : null);
}

const LINTERS = ["biome", "eslint"] as const;

/**
 * The project's own linter, of either kind, wins over any linter on PATH: a PATH
 * Biome running `check --write` on an ESLint project rewrites files under rules
 * the project never chose.
 */
async function linter(cwd: string, deadline: number, signal?: AbortSignal): Promise<{ name: (typeof LINTERS)[number]; bin: string } | null> {
    for (const name of LINTERS) {
        const bin = local(name, cwd);
        if (bin) return { name, bin };
    }
    for (const name of LINTERS) if (await have(name, deadline, signal)) return { name, bin: name };
    return null;
}

export async function runTypescriptQuality(mode: QualityMode, cwd: string, options: QualityOptions = {}): Promise<QualityReport> {
    if (!existsSync(join(cwd, "package.json"))) {
        return report(mode, cwd, ["biome", "tsc", "eslint"].map((name): StepResult => ({ name, status: "skip", detail: "no package.json" })));
    }
    const { signal } = options;
    const probeDeadline = Date.now() + PROBE_BUDGET_MS;
    const lint = await linter(cwd, probeDeadline, signal);
    const plan: PlannedStep[] = [
        lint
            ? {
                  name: lint.name,
                  bin: lint.bin,
                  args: lint.name === "biome" ? ["check", ...(mode === "fix" ? ["--write"] : []), "."] : [".", ...(mode === "fix" ? ["--fix"] : [])],
                  missing: "",
              }
            : { name: "biome/eslint", bin: null, args: [], missing: "no installed biome or eslint" },
    ];
    if (mode === "check") {
        // Without a tsconfig.json, `tsc --noEmit` prints its help and exits 1: there is nothing to type-check.
        const hasConfig = existsSync(join(cwd, "tsconfig.json"));
        plan.push({
            name: "tsc --noEmit",
            bin: hasConfig ? await installed("tsc", cwd, probeDeadline, signal) : null,
            args: ["--noEmit"],
            missing: hasConfig ? "no installed tsc" : "no tsconfig.json",
        });
    }
    return report(mode, cwd, await runSteps(plan, cwd, options));
}

export default function typescriptQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "typescript_quality",
		label: "TypeScript quality",
		description:
			"Run installed biome/eslint and tsc (check) or biome/eslint fixes (fix), without downloads. Missing projects or tools, and commands that time out or are cancelled, produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: biome/eslint + tsc --noEmit; fix: biome check --write or eslint --fix"),
			path: z.string().optional().describe("Project root holding package.json; relative paths resolve against the session cwd, the default"),
		}) as unknown as TSchema,
		execute: async (_id, params: TypescriptQualityParams, signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(ctx?.cwd ?? process.cwd(), params.path ?? ".");
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = await runTypescriptQuality(params.mode, cwd, { signal });
				return {
					content: [{ type: "text" as const, text: fmtTable(report.steps) }],
					details: report,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `typescript_quality error: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}
