import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { detectProject } from "./detect";

export { detectProject, parseRequirement } from "./detect";

type VersionGapParams = { path?: string };

export default function versionGapTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "version_gap_scan",
		label: "Version Gap Scan",
		description:
			"Enumerate a project's root dependencies, offline and read-only: npm (package.json + package-lock.json), " +
			"Python (pyproject.toml or requirements.txt + uv.lock/poetry.lock), Cargo.toml, go.mod, Gemfile, composer.json. " +
			"One tab-separated row per dependency: ecosystem, name, declared spec, resolved lockfile version ('?' when " +
			"unlocked), direct|transitive. Use resolved as the installed version when present. Input for what's-new research.",
		parameters: z.object({
			path: z.string().optional().describe("Project root to scan; defaults to the session cwd"),
		}) as unknown as TSchema, // pi.zod and the host TypeBox schema types differ.
		approval: "read",
		async execute(_id, params: VersionGapParams, _signal, _onUpdate, ctx) {
			const dir = params.path ?? ctx.cwd;
			try {
                const { exit, rows, stderr, coverage } = await detectProject(dir);
				if (exit !== 0) {
					return {
						content: [{ type: "text" as const, text: `version_gap_scan failed (exit ${exit}):\n${stderr}` }],
						details: { exit, stderr },
					};
				}
                const deps = rows.map(({ ecosystem, name, declared, resolved, direct }) => ({ ecosystem, name, declared, resolved, direct }));
                const stdout = rows.map(({ ecosystem, name, declared, resolved, direct }) => [ecosystem, name, declared, resolved ?? "?", direct ? "direct" : "transitive"].join("\t")).join("\n");
                const text = [stdout, stderr.trim()].filter(Boolean).join("\n");
                return {
                    content: [{ type: "text" as const, text }],
                    details: { deps, coverage, count: deps.length },
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
