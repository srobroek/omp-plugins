import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveConfig } from "./lib/config.ts";
import type { PreflightResult } from "./lib/preflight.ts";
import { runPreflight } from "./lib/preflight.ts";

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Leave margin below the 30s session_start handler budget. */
export const PREFLIGHT_SESSION_START_BUDGET_MS = 25_000;
const ADVISED_KEY = Symbol.for("com.srobroek.browser-tools.headed-preflight.sent");

interface PreflightRuntime {
	resolveConfig?: typeof resolveConfig;
	runPreflight?: typeof runPreflight;
	readCache?: typeof readCache;
	writeCache?: typeof writeCache;
	cachePath?: () => string;
	now?: () => number;
	budgetMs?: number;
}

type SessionStartOutcome =
	| { kind: "ok" }
	| { kind: "timeout" }
	| { kind: "failed"; result: PreflightResult }
	| { kind: "error" };

interface PreflightCache {
	checkedAt: number;
	key: string;
	ok: boolean;
}

export default function headedBrowserPreflight(pi: ExtensionAPI, runtime: PreflightRuntime = {}): void {
	pi.on("session_start", async (_event, ctx) => {
		const now = runtime.now ?? Date.now;
		const budgetMs = runtime.budgetMs ?? PREFLIGHT_SESSION_START_BUDGET_MS;
		const deadline = now() + budgetMs;
		const run = (async (): Promise<SessionStartOutcome> => {
			try {
				const cachePath = runtime.cachePath?.() ?? preflightCachePath();
				const config = await (runtime.resolveConfig ?? resolveConfig)(ctx.cwd, {});
				if (now() >= deadline) return { kind: "timeout" };
				const cached = await (runtime.readCache ?? readCache)(cachePath);
				if (now() >= deadline) return { kind: "timeout" };
				const configKey = preflightConfigKey(config);
				if (cached?.ok && cached.key === configKey && now() - cached.checkedAt < CACHE_TTL_MS) return { kind: "ok" };
				const result = await (runtime.runPreflight ?? runPreflight)(ctx.cwd, ctx);
				// Do not update the cache after the aggregate deadline; a late result is unknown.
				if (now() >= deadline) return { kind: "timeout" };
				await (runtime.writeCache ?? writeCache)(cachePath, { checkedAt: now(), key: configKey, ok: result.ok });
				return result.ok ? { kind: "ok" } : { kind: "failed", result };
			} catch {
				return { kind: "error" };
			}
		})();
		const outcome = await Promise.race([
			run,
			Bun.sleep(Math.max(1, deadline - now())).then((): SessionStartOutcome => ({ kind: "timeout" })),
		]);
		if (outcome.kind === "timeout") {
			sendPreflightAdvisory(pi, `Headed browser preflight could not complete within ${budgetMs} ms; the preflight cache was not updated. Run headed_session op:"preflight" for the full structured report.`);
			return;
		}
		if (outcome.kind !== "failed") return;
		const failures = outcome.result.checks.filter((check) => check.status === "fail");
		const content = [
			"Headed browser preflight failed:",
			...failures.map((check) => `- ${check.name}: ${String(check.observed)}${check.remedy ? ` Remedy: ${check.remedy}` : ""}`),
			"Run headed_session op:\"preflight\" for the full structured report.",
		].join("\n");
		sendPreflightAdvisory(pi, content);
	});
}

function sendPreflightAdvisory(pi: ExtensionAPI, content: string): void {
	const holder = globalThis as { [ADVISED_KEY]?: boolean };
	if (holder[ADVISED_KEY]) return;
	holder[ADVISED_KEY] = true;
	try {
		pi.sendMessage(
			{ customType: "com.srobroek.browser-tools.headed-preflight", content, display: true, attribution: "user" },
			{ triggerTurn: false },
		);
	} catch {
		// Advisory only: a message transport failure must not block session_start.
	}
}

export function preflightCacheKey(result: PreflightResult): string {
	const selected = result.checks.find((check) => check.name === `auto-${result.config.engine}`)?.observed;
	const source = result.checks.find((check) => check.name === "source-profile")?.observed;
	return JSON.stringify({
		platform: process.platform,
		defaultEngine: result.config.engine,
		resolvedChannel: selected,
		executablePath: result.config.executablePath,
		profileRoot: source,
	});
}

export function preflightConfigKey(config: { engine: string; browserChannel: string; executablePath: string; sourceProfileName: string; profileRootOverride?: string }): string {
	return JSON.stringify({ platform: process.platform, defaultEngine: config.engine, browserChannel: config.browserChannel, executablePath: config.executablePath, sourceProfileName: config.sourceProfileName, profileRoot: config.profileRootOverride });
}

export function preflightCachePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	return join(agentDir, "headed-browser-preflight.json");
}
async function readCache(path: string): Promise<PreflightCache | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!value || typeof value !== "object") return undefined;
		if (!("checkedAt" in value) || typeof value.checkedAt !== "number") return undefined;
		if (!("key" in value) || typeof value.key !== "string") return undefined;
		if (!("ok" in value) || typeof value.ok !== "boolean") return undefined;
		return { checkedAt: value.checkedAt, key: value.key, ok: value.ok };
	} catch {
		return undefined;
	}
}

async function writeCache(path: string, cache: PreflightCache): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}
