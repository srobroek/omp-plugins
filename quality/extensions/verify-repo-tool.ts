import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SCRIPT = new URL(
	"../skills/verify/scripts/verify.sh",
	import.meta.url,
).pathname;

const TIMEOUT_MS = 600_000;

type VerifyParams = {
	path?: string;
	scope?: string;
};

function spawnVerify(cwd: string): {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
} {
	try {
		const proc = Bun.spawnSync(["bash", SCRIPT], {
			cwd,
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

export default function verifyRepoTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "verify_repo",
		label: "Verify repository",
		description:
			"Run the polyglot verify runner (just/make/package/cargo/go/python checks) and return the final report.",
		parameters: z.object({
			path: z
				.string()
				.optional()
				.describe("Repository cwd; defaults to the current working directory"),
			scope: z
				.string()
				.optional()
				.describe("Unused by verify.sh; reserved for caller notes"),
		}),
		execute: async (_toolCallId, params: VerifyParams, _signal, _onUpdate, ctx) => {
			const cwd = params.path ?? ctx?.cwd ?? process.cwd();
			const result = spawnVerify(cwd);
			if (result.error) {
				return {
					content: [
						{
							type: "text",
							text: `verify_repo failed to spawn: ${result.error}`,
						},
					],
					details: {
						ok: false,
						error: result.error,
						path: cwd,
						scope: params.scope,
					},
				};
			}
			const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
			const summary = combined.trim() || `(exit ${result.exitCode})`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					ok: result.ok,
					exitCode: result.exitCode,
					path: cwd,
					scope: params.scope,
					stdout: result.stdout,
					stderr: result.stderr,
				},
			};
		},
	});
}
