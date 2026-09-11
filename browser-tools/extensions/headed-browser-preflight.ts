import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { PreflightResult } from "./lib/preflight.ts";
import { runPreflight } from "./lib/preflight.ts";

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const ADVISED_KEY = Symbol.for("com.srobroek.browser-tools.headed-preflight.sent");

interface PreflightCache {
	checkedAt: number;
	key: string;
	ok: boolean;
}

export default function headedBrowserPreflight(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			const result = await runPreflight(ctx.cwd, ctx);
			const cachePath = preflightCachePath();
			const key = preflightCacheKey(result);
			const cached = await readCache(cachePath);
			if (cached?.ok && cached.key === key && Date.now() - cached.checkedAt < CACHE_TTL_MS) return;
			await writeCache(cachePath, { checkedAt: Date.now(), key, ok: result.ok });
			if (result.ok) return;
			const holder = globalThis as { [ADVISED_KEY]?: boolean };
			if (holder[ADVISED_KEY]) return;
			holder[ADVISED_KEY] = true;
			const failures = result.checks.filter((check) => check.status === "fail");
			const content = [
				"Headed browser preflight failed:",
				...failures.map((check) => `- ${check.name}: ${String(check.observed)}${check.remedy ? ` Remedy: ${check.remedy}` : ""}`),
				"Run headed_session op:\"preflight\" for the full structured report.",
			].join("\n");
			pi.sendMessage(
				{ customType: "com.srobroek.browser-tools.headed-preflight", content, display: true, attribution: "user" },
				{ triggerTurn: false },
			);
		} catch {
			// Advisory only: preflight failures must never prevent the agent session from starting.
		}
	});
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
