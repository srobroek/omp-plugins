import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { detectProject } from "./detect";

export { detectProject, parseRequirement } from "./detect";

export default function versionGapTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "version_gap_scan",
		label: "Version Gap Scan",
		description:
			"Enumerate a project's declared dependencies and versions across ecosystems (npm, python, " +
			"cargo, go, ruby, and more), offline and read-only. Input for what's-new research.",
		parameters: z.object({
			path: z.string().optional().describe("Project root to scan; defaults to the session cwd"),
		}),
		approval: "read",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = params.path ?? ctx.cwd;
			try {
				const { exit, rows, stderr } = await detectProject(dir);
				if (exit !== 0) {
					return {
						content: [{ type: "text" as const, text: `version_gap_scan failed (exit ${exit}):\n${stderr}` }],
						details: { exit, stderr },
					};
				}
				const deps = rows.map(([ecosystem, name, version]) => ({ ecosystem, name, version }));
				const stdout = rows.map((r) => r.join("\t")).join("\n");
				const text = [stdout, stderr.trim()].filter(Boolean).join("\n");
				return {
					content: [{ type: "text" as const, text }],
					details: { deps, count: deps.length },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `version_gap_scan error: ${message}` }],
					details: { error: message },
				};
			}
		},
	});
}
