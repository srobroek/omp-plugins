import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 300_000;

export type QualityMode = "check" | "fix";

export type StepResult = {
	name: string;
	status: "pass" | "fail" | "skip";
	detail: string;
};
type TypescriptQualityParams = { mode: QualityMode; path?: string };

export type QualityReport = {
	ok: boolean;
	complete: boolean;
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

function installed(bin: string, cwd: string): string | null {
	const local = join(cwd, "node_modules", ".bin", bin);
	if (existsSync(local)) return local;
	return have(bin) ? bin : null;
}

export function runTypescriptQuality(mode: QualityMode, cwd: string): QualityReport {
	const steps: StepResult[] = [];
	if (!existsSync(join(cwd, "package.json"))) {
		steps.push({ name: "biome", status: "skip", detail: "no package.json" });
		steps.push({ name: "tsc", status: "skip", detail: "no package.json" });
		steps.push({ name: "eslint", status: "skip", detail: "no package.json" });
		return { ok: false, complete: false, cwd, mode, steps };
	}

	const biome = installed("biome", cwd);
	const eslint = installed("eslint", cwd);
	const tsc = installed("tsc", cwd);
	const lint = biome ?? eslint;
	if (lint) {
		const args = biome
			? ["check", ...(mode === "fix" ? ["--write"] : []), "."]
			: [".", ...(mode === "fix" ? ["--fix"] : [])];
		record(steps, biome ? "biome" : "eslint", run([lint, ...args], cwd));
	} else {
		steps.push({ name: "biome/eslint", status: "skip", detail: "no installed biome or eslint" });
	}
	if (mode === "check") {
		if (tsc) record(steps, "tsc --noEmit", run([tsc, "--noEmit"], cwd));
		else steps.push({ name: "tsc --noEmit", status: "skip", detail: "no installed tsc" });
	}
	const complete = steps.length > 0 && steps.every((s) => s.status !== "skip");
	const ok = complete && steps.every((s) => s.status === "pass");
	return { ok, complete, cwd, mode, steps };
}

export default function typescriptQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "typescript_quality",
		label: "TypeScript quality",
		description:
			"Run installed biome/eslint and tsc (check) or biome/eslint fixes (fix), without downloads. Missing projects or tools produce incomplete, unsuccessful reports.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: biome/eslint + tsc --noEmit; fix: biome check --write"),
			path: z.string().optional().describe("Project cwd; defaults to session cwd"),
		}) as unknown as TSchema,
		execute: async (_id, params: TypescriptQualityParams, _signal, _onUpdate, ctx) => {
			try {
				const cwd = resolve(params.path ?? ctx?.cwd ?? process.cwd());
				if (!existsSync(cwd)) {
					return {
						content: [{ type: "text" as const, text: `path does not exist: ${cwd}` }],
						details: { ok: false, error: "missing_path", cwd },
					};
				}
				const report = runTypescriptQuality(params.mode, cwd);
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
