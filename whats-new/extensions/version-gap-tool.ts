import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * version_gap_scan: the deterministic half of the whats-new skill.
 *
 * Wraps skills/whats-new/scripts/detect.py: enumerate every declared dependency and
 * its version, offline, as `ecosystem<TAB>name<TAB>version` lines. The research
 * half (changelogs, breaking changes) stays judgment work in the skill.
 */

const SCRIPT = new URL("../skills/whats-new/scripts/detect.py", import.meta.url).pathname;
const TIMEOUT_MS = 60_000;

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
		async execute(_id, params, signal, _onUpdate, ctx) {
			const dir = params.path ?? ctx.cwd;
			try {
				const proc = Bun.spawn(["python3", SCRIPT, dir], {
					cwd: dir,
					stdout: "pipe",
					stderr: "pipe",
					signal,
				});
				const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				const exit = await proc.exited;
				clearTimeout(timer);

				if (exit !== 0) {
					return {
						content: [{ type: "text" as const, text: `version_gap_scan failed (exit ${exit}):\n${stderr.trim()}` }],
						details: { exit, stderr: stderr.trim() },
					};
				}

				const deps = stdout
					.split("\n")
					.filter((l) => l.includes("\t"))
					.map((l) => {
						const [ecosystem, name, version] = l.split("\t");
						return { ecosystem, name, version };
					});

				const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
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
