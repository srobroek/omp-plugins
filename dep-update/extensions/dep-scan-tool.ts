import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { applyBump, type BumpRecord, researchProject } from "./lib";

export { classify, detectProject, normalizeVersion, parseRequirement, queryRegistry } from "./lib";

type DepScanParams = { path?: string; offline_fixture_dir?: string };
type DepApplyParams = { ecosystem: string; name: string; version: string; path?: string };

export default function depScanTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "dep_scan",
		label: "Dependency Scan",
        description:
            "Enumerate a project's declared dependencies, query PyPI/npm for the latest versions, and " +
            "classify exact-version bumps as PATCH-SAFE, MINOR-CHECK, or MAJOR-ADVISORY. " +
            "Read-only; each scan has a 25 s aggregate deadline inside the 30 s tool_call budget and " +
            "returns a partial report when a large manifest exceeds it. Rust and go deps are advisory-only.",
		parameters: z.object({
			path: z.string().optional().describe("Project root to scan; defaults to the session cwd"),
			offline_fixture_dir: z.string().optional().describe("DEP_UPDATE_FIXTURE_DIR: read registry responses from fixture files instead of the network"),
		}) as unknown as TSchema, // pi.zod and the host TypeBox schema types differ.
		approval: "read",
		async execute(_id, params: DepScanParams, signal, _onUpdate, ctx) {
			const dir = params.path ?? ctx.cwd;
			try {
                const { exit, records, stderr, complete } = await researchProject(dir, params.offline_fixture_dir, signal);
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
				for (const record of records) {
					if (record.status === "UNRESOLVABLE" || record.status === "DISCONFIRMED") {
						lines.push(`${record.status.padEnd(15)} ${record.name}  ${record.installed} -> ${record.latest ?? "unknown"}  (${record.ecosystem}): ${record.reason ?? "not classified"}`);
					}
				}
				const skipped = records.length - upgradable.length;
				lines.push(`-- ${upgradable.length} upgradable, ${skipped} current/unresolvable --`);
				if (stderr.trim()) lines.push(stderr.trim());
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
                    details: { records, complete, summary: { upgradable: upgradable.length, skipped } },
				};
			} catch (error) {
				signal?.throwIfAborted();
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
            "Apply one confirmed dependency bump via the ecosystem package manager. " +
            "The mutation is bounded to 25 s inside the 30 s tool_call budget; if interrupted, " +
            "the result reports that partial changes may remain so the caller can inspect manifests and lockfiles.",
		parameters: z.object({
			ecosystem: z.string().describe("pypi, npm, cargo, or go"),
			name: z.string().describe("Package name"),
			version: z.string().describe("Target version to pin"),
			path: z.string().optional().describe("Project root; defaults to session cwd"),
		}) as unknown as TSchema, // pi.zod and the host TypeBox schema types differ.
		approval: { tier: "exec", policy: "prompt" },
		async execute(_id, params: DepApplyParams, signal, _onUpdate, ctx) {
			try {
				if (signal?.aborted) throw new Error("Cancelled before approval; no process started");
				if (!ctx.hasUI) throw new Error("Interactive approval is required; no process started");
				const approved = await ctx.ui.confirm(
					"Apply dependency bump",
					`${params.ecosystem}: ${params.name} -> ${params.version}\nProject: ${params.path ?? ctx.cwd}\nPackage-manager failure or cancellation can leave partial changes.`,
                    { signal, timeout: 20_000 },
				);
				if (!approved) throw new Error("Dependency bump denied; no process started");
				const result = await applyBump(params.ecosystem, params.name, params.version, params.path ?? ctx.cwd, {
					signal,
					setTimeout: ctx.setTimeout.bind(ctx),
					clearTimer: ctx.clearTimer.bind(ctx),
				});
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
