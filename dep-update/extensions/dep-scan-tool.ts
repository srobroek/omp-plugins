import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { applyBump, researchProject, type BumpRecord } from "./lib";

export { classify, detectProject, normalizeVersion, parseRequirement, queryRegistry } from "./lib";

export default function depScanTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "dep_scan",
		label: "Dependency Scan",
		description:
			"Enumerate a project's declared dependencies, query PyPI/npm for the latest versions, and " +
			"classify every bump as PATCH-SAFE, MINOR-CHECK, or MAJOR-ADVISORY. Read-only: applies " +
			"nothing. Rust and go deps are enumerated but not classified (advisory-only by policy).",
		parameters: z.object({
			path: z.string().optional().describe("Project root to scan; defaults to the session cwd"),
			offline_fixture_dir: z
				.string()
				.optional()
				.describe("DEP_UPDATE_FIXTURE_DIR: read registry responses from fixture files instead of the network"),
		}),
		approval: "read",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = params.path ?? ctx.cwd;
			try {
				const { exit, records, stderr } = await researchProject(dir, params.offline_fixture_dir);
				if (exit !== 0) {
					return {
						content: [{ type: "text" as const, text: `dep_scan failed (exit ${exit}):\n${stderr}` }],
						details: { exit, stderr },
					};
				}
				const upgradable = records.filter((r: BumpRecord) => r.status === "OK");
				const byClass = new Map<string, BumpRecord[]>();
				for (const r of upgradable) {
					const bucket = byClass.get(r.class ?? "") ?? [];
					bucket.push(r);
					byClass.set(r.class ?? "", bucket);
				}
				const order = ["PATCH-SAFE", "MINOR-CHECK", "MAJOR-ADVISORY"];
				const lines: string[] = [];
				for (const cls of order) {
					for (const r of (byClass.get(cls) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
						lines.push(`${cls.padEnd(15)} ${r.name}  ${r.installed} -> ${r.latest}  (${r.ecosystem})`);
					}
				}
				const skipped = records.length - upgradable.length;
				lines.push(`-- ${upgradable.length} upgradable, ${skipped} current/unresolvable --`);
				if (stderr.trim()) lines.push(stderr.trim());
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { records, summary: { upgradable: upgradable.length, skipped } },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `dep_scan error: ${message}` }],
					details: { error: message },
				};
			}
		},
	});

	pi.registerTool({
		name: "dep_apply",
		label: "Apply Dependency Bump",
		description:
			"Apply one confirmed dependency bump via the ecosystem package manager (uv/pnpm/npm/yarn/bun). " +
			"Cargo and go print an advisory command only. One bump per call.",
		parameters: z.object({
			ecosystem: z.string().describe("pypi, npm, cargo, or go"),
			name: z.string().describe("Package name"),
			version: z.string().describe("Target version to pin"),
			path: z.string().optional().describe("Project root; defaults to session cwd"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const result = await applyBump(params.ecosystem, params.name, params.version, params.path ?? ctx.cwd);
				return {
					content: [{ type: "text" as const, text: result.text }],
					details: { exit: result.exit },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `dep_apply error: ${message}` }],
					details: { error: message },
				};
			}
		},
	});
}
