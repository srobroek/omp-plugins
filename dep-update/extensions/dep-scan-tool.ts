import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * dep_scan: the deterministic half of the dep-update skill.
 *
 * Wraps skills/dep-update/scripts/research.py, which itself runs detect.py against
 * the project directory: enumerate declared dependencies (no network), query each
 * registry, classify the bump. The scripts stay authoritative; this tool only
 * replaces the invocation choreography that used to live in SKILL.md prose.
 *
 * Read-only: nothing is applied. The apply loop stays interactive in the skill.
 */

const SCRIPT = new URL("../skills/dep-update/scripts/research.py", import.meta.url).pathname;
const TIMEOUT_MS = 120_000;

interface BumpRecord {
	ecosystem: string;
	name: string;
	installed: string;
	latest: string;
	class: string;
	status: string;
}

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
		async execute(_id, params, signal, _onUpdate, ctx) {
			const dir = params.path ?? ctx.cwd;
			const env: Record<string, string> = { ...process.env } as Record<string, string>;
			if (params.offline_fixture_dir) env.DEP_UPDATE_FIXTURE_DIR = params.offline_fixture_dir;

			try {
				const proc = Bun.spawn(["python3", SCRIPT, dir], {
					cwd: dir,
					env,
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
						content: [{ type: "text" as const, text: `dep_scan failed (exit ${exit}):\n${stderr.trim()}` }],
						details: { exit, stderr: stderr.trim() },
					};
				}

				const records: BumpRecord[] = [];
				for (const line of stdout.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						records.push(JSON.parse(trimmed) as BumpRecord);
					} catch {
						// non-JSON noise line; ignore
					}
				}

				const upgradable = records.filter((r) => r.status === "OK");
				const byClass = new Map<string, BumpRecord[]>();
				for (const r of upgradable) {
					const bucket = byClass.get(r.class) ?? [];
					bucket.push(r);
					byClass.set(r.class, bucket);
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
}
