import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

type Runner = "pnpm" | "bun" | "npx" | "global";

function pickRunner(): Runner | null {
	if (have("pnpm")) return "pnpm";
	if (have("bun")) return "bun";
	if (have("npx")) return "npx";
	if (have("biome") || have("tsc") || have("eslint")) return "global";
	return null;
}

function wrap(runner: Runner, argv: string[]): string[] {
	if (runner === "pnpm") return ["pnpm", "exec", ...argv];
	if (runner === "bun") return ["bunx", ...argv];
	if (runner === "npx") return ["npx", "--yes", ...argv];
	return argv;
}

export function runTypescriptQuality(mode: QualityMode, cwd: string): QualityReport {
	const steps: StepResult[] = [];
	if (!existsSync(join(cwd, "package.json"))) {
		steps.push({ name: "biome", status: "skip", detail: "no package.json" });
		steps.push({ name: "tsc", status: "skip", detail: "no package.json" });
		steps.push({ name: "eslint", status: "skip", detail: "no package.json" });
		return { ok: true, cwd, mode, steps };
	}

	const runner = pickRunner();
	if (!runner) {
		steps.push({
			name: "biome/eslint/tsc",
			status: "skip",
			detail: "no pnpm/bun/npx or global biome/eslint/tsc",
		});
		return { ok: true, cwd, mode, steps };
	}

	const biomeAvail = runner !== "global" || have("biome");
	const tscAvail = runner !== "global" || have("tsc");
	const eslintAvail = have("eslint");

	if (mode === "fix") {
		if (biomeAvail) {
			record(steps, "biome check --write", run(wrap(runner, ["biome", "check", "--write", "."]), cwd));
		} else {
			steps.push({ name: "biome check --write", status: "skip", detail: "biome not available" });
		}
		if (!biomeAvail && eslintAvail) {
			record(steps, "eslint --fix", run(wrap(runner, ["eslint", ".", "--fix"]), cwd));
		} else if (!biomeAvail) {
			steps.push({ name: "eslint --fix", status: "skip", detail: "eslint not available" });
		}
	} else {
		if (biomeAvail) {
			record(steps, "biome check", run(wrap(runner, ["biome", "check", "."]), cwd));
		} else {
			steps.push({ name: "biome check", status: "skip", detail: "biome not available" });
			if (eslintAvail) {
				record(steps, "eslint", run(wrap(runner, ["eslint", "."]), cwd));
			} else {
				steps.push({ name: "eslint", status: "skip", detail: "eslint not available" });
			}
		}
		if (tscAvail) {
			record(steps, "tsc --noEmit", run(wrap(runner, ["tsc", "--noEmit"]), cwd));
		} else {
			steps.push({ name: "tsc --noEmit", status: "skip", detail: "tsc not available" });
		}
	}

	const ok = steps.every((s) => s.status !== "fail");
	return { ok, cwd, mode, steps };
}

export default function typescriptQualityTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "typescript_quality",
		label: "TypeScript quality",
		description:
			"Run biome/eslint and tsc (check) or biome --write (fix). Missing tools and missing package.json are skipped.",
		parameters: z.object({
			mode: z.enum(["check", "fix"]).describe("check: biome/eslint + tsc --noEmit; fix: biome check --write"),
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
