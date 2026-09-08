import { spawn } from "node:child_process";
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
	signal?: AbortSignal;
	setTimeout?: (callback: () => void, ms: number) => Timer;
	clearTimer?: (timer: Timer) => void;
};

export type ScanParams = {
	query: string;
	surfaces?: string[];
};

const NETWORK_MS = 10_000;

export function defaultRun(
	argv: string[],
	timeoutMs: number,
	options: Pick<ScanDeps, "signal" | "setTimeout" | "clearTimer"> = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	if (options.signal?.aborted) return Promise.resolve({ ok: false, stdout: "", stderr: "Cancelled before spawn" });
	const schedule = options.setTimeout ?? setTimeout;
	const clear = options.clearTimer ?? clearTimeout;
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; stdout: string; stderr: string }>();
	try {
		const proc = spawn(argv[0], argv.slice(1), {
			stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let stopped = "";
		let settled = false;
		let cleanup: Timer | undefined;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clear(deadline);
			if (cleanup) clear(cleanup);
			options.signal?.removeEventListener("abort", abort);
			proc.stdout.destroy();
			proc.stderr.destroy();
			resolve({
				ok: !stopped && code === 0,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: [Buffer.concat(stderr).toString("utf8"), stopped].filter(Boolean).join("\n"),
			});
		};
		const stop = (reason: string) => {
			if (stopped || settled) return;
			stopped = reason;
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
				else proc.kill("SIGKILL");
			} catch { /* already exited */ }
			cleanup = schedule(() => finish(1), 1_000);
		};
		const abort = () => stop("Cancelled");
		const deadline = schedule(() => stop("Discovery command deadline exceeded"),
			Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, NETWORK_MS)) : NETWORK_MS);
		const collect = (target: Buffer[], chunk: Buffer) => {
			if (stopped || settled) return;
			const remaining = 65_536 - bytes;
			if (remaining > 0) {
				const kept = chunk.subarray(0, remaining);
				target.push(Buffer.from(kept));
				bytes += kept.length;
			}
			if (chunk.length > remaining) stop("Discovery command output limit exceeded");
		};
		proc.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		proc.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		proc.on("error", (error) => { stopped = `Discovery command failed to start: ${error.message}`; finish(1); });
		proc.on("close", (code) => finish(code ?? 1));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	} catch (error) {
		resolve({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
	}
	return promise;
}

function defaultWhich(bin: string): boolean {
	return Bun.which(bin) !== null;
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
		let detail = "invalid MCP inventory; configuration omitted";
		try {
			const parsed: unknown = JSON.parse(mcp);
			const servers = parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>).mcpServers : null;
			if (servers && typeof servers === "object" && !Array.isArray(servers)) {
				const counts = { configured: 0, disabled: 0, stdio: 0, remote: 0 };
				for (const value of Object.values(servers)) {
					if (!value || typeof value !== "object" || Array.isArray(value)) continue;
					const server = value as Record<string, unknown>;
					counts.configured++;
					if (server.enabled === false || server.disabled === true) counts.disabled++;
					if (typeof server.command === "string") counts.stdio++;
					else if (typeof server.url === "string") counts.remote++;
				}
				detail = JSON.stringify(counts);
			}
		} catch {
			// Parser diagnostics can contain configuration fragments.
		}
		hits.push({ name: "~/.omp/agent/mcp.json", detail });
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

async function scanSkillsCli(): Promise<SurfaceResult> {
	return {
		surface: "skills_cli", ok: true, skipped: true, hits: [],
		reason: "Unavailable in read discovery: skills CLI execution requires separate explicit approval. Vet the package and request an approved execution separately; this scan never acquires or runs it.",
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
			if (!Array.isArray(json?.objects)) {
				return { surface: "npm", ok: false, reason: `Invalid search response for ${kw}`, hits };
			}
			for (const obj of json.objects ?? []) {
				const p = obj.package;
				if (!p?.name) continue;
				hits.push({ name: p.name, detail: p.description, url: p.links?.npm });
			}
		} catch {
			return { surface: "npm", ok: false, reason: `Invalid search response for ${kw}`, hits };
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
	const sourceFetch = deps.fetchFn ?? fetch;
	const fetchFn: typeof fetch = deps.signal
		? ((input, init) => sourceFetch(input, {
			...init,
			signal: init?.signal ? AbortSignal.any([deps.signal!, init.signal]) : deps.signal,
		})) as typeof fetch
		: sourceFetch;
	const run: NonNullable<ScanDeps["run"]> = (argv, timeoutMs) => {
		if (deps.signal?.aborted) return Promise.resolve({ ok: false, stdout: "", stderr: "Cancelled before spawn" });
		return deps.run ? deps.run(argv, timeoutMs) : defaultRun(argv, timeoutMs, deps);
	};
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
	push("skills_cli", scanSkillsCli);
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
			"Read-only discovery across local inventory, omp discover, MCP Registry, npm, GitHub, and Smithery. Skills CLI reports an approval-required gap; no package acquisition or execution. Isolated per-surface failures.",
		parameters: z.object({
			query: z.string().describe("Capability query"),
			surfaces: z.array(z.string()).optional().describe("Optional subset of surface names"),
		}),
		approval: "read",
		execute: async (_id, params: ScanParams, signal, _onUpdate, ctx) => {
			try {
				const { results, gaps } = await scanSurfaces(params, {
					signal, setTimeout: ctx.setTimeout.bind(ctx), clearTimer: ctx.clearTimer.bind(ctx),
				});
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
