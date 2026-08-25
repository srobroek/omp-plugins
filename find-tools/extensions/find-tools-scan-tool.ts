import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const SURFACES = [
	"local",
	"discover",
	"mcp_registry",
	"skills_cli",
	"npm",
	"github",
	"smithery",
] as const;

export type SurfaceName = (typeof SURFACES)[number];

export type SurfaceHit = {
	name: string;
	detail?: string;
	url?: string;
};

export type SurfaceResult = {
	surface: SurfaceName;
	ok: boolean;
	skipped?: boolean;
	reason?: string;
	hits: SurfaceHit[];
};

export type ScanDeps = {
	fetchFn?: typeof fetch;
	run?: (argv: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
	readFile?: (path: string) => string | null;
	env?: Record<string, string | undefined>;
	which?: (bin: string) => boolean;
};

export type ScanParams = {
	query: string;
	surfaces?: string[];
};

const NETWORK_MS = 10_000;

export function defaultRun(
	argv: string[],
	timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return (async () => {
		try {
			const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
			const killer = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					/* ignore */
				}
			}, timeoutMs);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			clearTimeout(killer);
			return { ok: exit === 0, stdout, stderr };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, stdout: "", stderr: message };
		}
	})();
}

function defaultWhich(bin: string): boolean {
	const proc = Bun.spawnSync(["sh", "-c", `command -v ${JSON.stringify(bin)}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return proc.exitCode === 0;
}

function defaultRead(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

async function timedFetch(
	fetchFn: typeof fetch,
	url: string,
	init?: RequestInit,
): Promise<{ ok: boolean; text: string; status: number }> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), NETWORK_MS);
	try {
		const res = await fetchFn(url, { ...init, signal: ac.signal });
		const text = await res.text();
		return { ok: res.ok, text, status: res.status };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, text: message, status: 0 };
	} finally {
		clearTimeout(t);
	}
}

function wanted(selected: Set<string> | null, name: SurfaceName): boolean {
	return !selected || selected.has(name);
}

async function scanLocal(deps: Required<Pick<ScanDeps, "run" | "readFile" | "which">>): Promise<SurfaceResult> {
	const hits: SurfaceHit[] = [];
	if (deps.which("omp")) {
		const listed = await deps.run(["omp", "plugin", "list"], NETWORK_MS);
		if (listed.ok && listed.stdout.trim()) {
			hits.push({ name: "omp plugin list", detail: listed.stdout.trim().slice(0, 4000) });
		}
		const markets = await deps.run(["omp", "plugin", "marketplace", "list"], NETWORK_MS);
		if (markets.ok && markets.stdout.trim()) {
			hits.push({ name: "omp plugin marketplace list", detail: markets.stdout.trim().slice(0, 4000) });
		}
	} else {
		hits.push({ name: "omp", detail: "omp binary not found" });
	}
	const mcpPath = join(homedir(), ".omp", "agent", "mcp.json");
	const mcp = deps.readFile(mcpPath);
	if (mcp !== null) {
		hits.push({ name: "~/.omp/agent/mcp.json", detail: mcp.slice(0, 4000) });
	} else if (existsSync(mcpPath) === false) {
		hits.push({ name: "~/.omp/agent/mcp.json", detail: "absent" });
	}
	return { surface: "local", ok: true, hits };
}

async function scanDiscover(deps: Required<Pick<ScanDeps, "run" | "which">>, query: string): Promise<SurfaceResult> {
	if (!deps.which("omp")) {
		return { surface: "discover", ok: true, skipped: true, reason: "omp binary not found", hits: [] };
	}
	const r = await deps.run(["omp", "plugin", "discover", query], NETWORK_MS);
	if (!r.ok) {
		return { surface: "discover", ok: false, reason: r.stderr.slice(0, 500) || "discover failed", hits: [] };
	}
	return {
		surface: "discover",
		ok: true,
		hits: r.stdout.trim()
			? [{ name: "omp plugin discover", detail: r.stdout.trim().slice(0, 4000) }]
			: [],
	};
}

async function scanMcpRegistry(
	fetchFn: typeof fetch,
	query: string,
): Promise<SurfaceResult> {
	const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(query)}&version=latest`;
	const res = await timedFetch(fetchFn, url);
	if (!res.ok) {
		return { surface: "mcp_registry", ok: false, reason: `HTTP ${res.status}: ${res.text.slice(0, 200)}`, hits: [] };
	}
	try {
		const json = JSON.parse(res.text) as { servers?: Array<{ name?: string; description?: string }> };
		const servers = json.servers ?? [];
		return {
			surface: "mcp_registry",
			ok: true,
			hits: servers.slice(0, 20).map((s) => ({
				name: s.name ?? "unknown",
				detail: s.description,
			})),
		};
	} catch {
		return { surface: "mcp_registry", ok: true, hits: [{ name: "raw", detail: res.text.slice(0, 1000) }] };
	}
}

async function scanSkillsCli(
	deps: Required<Pick<ScanDeps, "run" | "which">>,
	query: string,
): Promise<SurfaceResult> {
	if (!deps.which("npx")) {
		return { surface: "skills_cli", ok: true, skipped: true, reason: "npx not found", hits: [] };
	}
	const r = await deps.run(["npx", "--yes", "skills", "find", query], NETWORK_MS);
	if (!r.ok) {
		return { surface: "skills_cli", ok: false, reason: r.stderr.slice(0, 500) || "skills find failed", hits: [] };
	}
	return {
		surface: "skills_cli",
		ok: true,
		hits: r.stdout.trim() ? [{ name: "npx skills find", detail: r.stdout.trim().slice(0, 4000) }] : [],
	};
}

async function scanNpm(fetchFn: typeof fetch, query: string): Promise<SurfaceResult> {
	const keywords = ["mcp-server", "claude-plugin", "claude-skill", "agent-skill", "omp-plugin", "oh-my-pi"];
	const hits: SurfaceHit[] = [];
	for (const kw of keywords) {
		const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`keywords:${kw} ${query}`)}&size=5`;
		const res = await timedFetch(fetchFn, url);
		if (!res.ok) {
			return { surface: "npm", ok: false, reason: `HTTP ${res.status} for ${kw}`, hits };
		}
		try {
			const json = JSON.parse(res.text) as {
				objects?: Array<{ package?: { name?: string; description?: string; links?: { npm?: string } } }>;
			};
			for (const obj of json.objects ?? []) {
				const p = obj.package;
				if (!p?.name) continue;
				hits.push({ name: p.name, detail: p.description, url: p.links?.npm });
			}
		} catch {
			/* ignore parse of one keyword */
		}
	}
	return { surface: "npm", ok: true, hits };
}

async function scanGithub(
	deps: Required<Pick<ScanDeps, "run" | "which" | "env">>,
	query: string,
): Promise<SurfaceResult> {
	if (!deps.which("gh")) {
		return { surface: "github", ok: true, skipped: true, reason: "gh not found", hits: [] };
	}
	const q = `${query} filename:marketplace.json path:.omp-plugin OR path:.claude-plugin`;
	const r = await deps.run(["gh", "api", `search/code?q=${encodeURIComponent(q)}`], NETWORK_MS);
	if (!r.ok) {
		return { surface: "github", ok: false, reason: r.stderr.slice(0, 500) || "gh api failed", hits: [] };
	}
	try {
		const json = JSON.parse(r.stdout) as { items?: Array<{ name?: string; html_url?: string; repository?: { full_name?: string } }> };
		return {
			surface: "github",
			ok: true,
			hits: (json.items ?? []).slice(0, 20).map((it) => ({
				name: it.repository?.full_name ?? it.name ?? "item",
				url: it.html_url,
			})),
		};
	} catch {
		return { surface: "github", ok: true, hits: [{ name: "raw", detail: r.stdout.slice(0, 1000) }] };
	}
}

async function scanSmithery(
	fetchFn: typeof fetch,
	deps: Required<Pick<ScanDeps, "env">>,
	query: string,
): Promise<SurfaceResult> {
	const key = deps.env.SMITHERY_API_KEY;
	if (!key) {
		return { surface: "smithery", ok: true, skipped: true, reason: "SMITHERY_API_KEY unset", hits: [] };
	}
	const url = `https://api.smithery.ai/servers?q=${encodeURIComponent(query)}`;
	const res = await timedFetch(fetchFn, url, { headers: { Authorization: `Bearer ${key}` } });
	if (!res.ok) {
		return { surface: "smithery", ok: false, reason: `HTTP ${res.status}: ${res.text.slice(0, 200)}`, hits: [] };
	}
	try {
		const json = JSON.parse(res.text) as { servers?: Array<{ qualifiedName?: string; displayName?: string }> };
		return {
			surface: "smithery",
			ok: true,
			hits: (json.servers ?? []).slice(0, 20).map((s) => ({
				name: s.qualifiedName ?? s.displayName ?? "server",
			})),
		};
	} catch {
		return { surface: "smithery", ok: true, hits: [{ name: "raw", detail: res.text.slice(0, 1000) }] };
	}
}

export async function scanSurfaces(params: ScanParams, deps: ScanDeps = {}): Promise<{
	results: SurfaceResult[];
	gaps: Array<{ surface: SurfaceName; reason: string }>;
}> {
	const fetchFn = deps.fetchFn ?? fetch;
	const run = deps.run ?? defaultRun;
	const readFile = deps.readFile ?? defaultRead;
	const env = deps.env ?? process.env;
	const which = deps.which ?? defaultWhich;
	const selected = params.surfaces?.length
		? new Set(params.surfaces.map((s) => s.trim()).filter(Boolean))
		: null;

	const results: SurfaceResult[] = [];
	const jobs: Array<Promise<void>> = [];

	const push = (name: SurfaceName, job: () => Promise<SurfaceResult>) => {
		if (!wanted(selected, name)) {
			results.push({ surface: name, ok: true, skipped: true, reason: "not requested", hits: [] });
			return;
		}
		jobs.push(
			job()
				.then((r) => {
					results.push(r);
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					results.push({ surface: name, ok: false, reason: message, hits: [] });
				}),
		);
	};

	push("local", () => scanLocal({ run, readFile, which }));
	push("discover", () => scanDiscover({ run, which }, params.query));
	push("mcp_registry", () => scanMcpRegistry(fetchFn, params.query));
	push("skills_cli", () => scanSkillsCli({ run, which }, params.query));
	push("npm", () => scanNpm(fetchFn, params.query));
	push("github", () => scanGithub({ run, which, env }, params.query));
	push("smithery", () => scanSmithery(fetchFn, { env }, params.query));

	await Promise.all(jobs);
	results.sort((a, b) => SURFACES.indexOf(a.surface) - SURFACES.indexOf(b.surface));
	const gaps = results
		.filter((r) => r.skipped || !r.ok)
		.map((r) => ({ surface: r.surface, reason: r.reason ?? (r.skipped ? "skipped" : "failed") }));
	return { results, gaps };
}

export default function findToolsScanTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "find_tools_scan",
		label: "Scan discovery surfaces",
		description:
			"Fan out a capability query across local inventory, omp discover, MCP Registry, skills CLI, npm, GitHub, and Smithery. Isolated per-surface failures.",
		parameters: z.object({
			query: z.string().describe("Capability query"),
			surfaces: z.array(z.string()).optional().describe("Optional subset of surface names"),
		}),
		approval: "read",
		execute: async (_id, params: ScanParams) => {
			try {
				const { results, gaps } = await scanSurfaces(params);
				const lines: string[] = [];
				for (const r of results) {
					const flag = r.skipped ? "skip" : r.ok ? "ok" : "fail";
					lines.push(`[${flag}] ${r.surface}${r.reason ? ` — ${r.reason}` : ""} (${r.hits.length} hits)`);
					for (const h of r.hits.slice(0, 8)) {
						lines.push(`  - ${h.name}${h.detail ? `: ${h.detail.slice(0, 120)}` : ""}`);
					}
				}
				if (gaps.length) {
					lines.push("gaps:");
					for (const g of gaps) lines.push(`  - ${g.surface}: ${g.reason}`);
				}
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { ok: true, results, gaps },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `find_tools_scan error: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});
}
