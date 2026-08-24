import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SCRIPT = new URL(
	"../skills/build-formula/scripts/assert-formula.py",
	import.meta.url,
).pathname;

const TIMEOUT_MS = 120_000;

type FormulaCheckParams = {
	formula: string;
	varargs?: string[];
	deep?: boolean;
	workspace?: string;
};

function spawnAssert(params: FormulaCheckParams): {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
} {
	const argv: string[] = [SCRIPT, params.formula];
	for (const v of params.varargs ?? []) {
		argv.push("--var", v);
	}
	if (params.deep) {
		argv.push("--deep");
	}
	if (params.workspace) {
		argv.push("--workspace", params.workspace);
	}

	try {
		const proc = Bun.spawnSync(["python3", ...argv], {
			cwd: params.workspace,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		return {
			ok: proc.exitCode === 0,
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: message };
	}
}

export default function formulaCheckTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "bd_formula_check",
		label: "Assert bd formula pour",
		description:
			"Run assert-formula.py: cook-validate, parse `bd mol pour --dry-run`, check gates and unsubstituted braces. Default is dry-run (read). deep=true performs a real pour in the workspace and uses exec approval.",
		parameters: z.object({
			formula: z.string().describe("Formula stem to assert"),
			varargs: z
				.array(z.string())
				.optional()
				.describe("Selection vars as k=v pairs (passed as --var)"),
			deep: z
				.boolean()
				.optional()
				.describe(
					"If true, pour for real and assert a single entry point (mutates workspace; exec approval)",
				),
			workspace: z
				.string()
				.optional()
				.describe("Repo cwd for bd; defaults to the current working directory"),
		}),
		approval: (toolCall) => {
			const deep = Boolean(
				(toolCall.input as FormulaCheckParams | undefined)?.deep,
			);
			return deep ? undefined : "read";
		},
		execute: async (_toolCallId, params: FormulaCheckParams) => {
			const result = spawnAssert(params);
			const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
			if (result.error) {
				return {
					content: [
						{
							type: "text",
							text: `bd_formula_check failed to spawn: ${result.error}`,
						},
					],
					details: { ok: false, error: result.error, formula: params.formula },
				};
			}
			const summary = combined.trim() || `(exit ${result.exitCode})`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					ok: result.ok,
					exitCode: result.exitCode,
					formula: params.formula,
					varargs: params.varargs ?? [],
					deep: Boolean(params.deep),
					stdout: result.stdout,
					stderr: result.stderr,
				},
			};
		},
	});
}
