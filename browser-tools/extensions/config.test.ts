import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadStoredSettings, resolveConfig, SETTING_SCHEMA } from "./lib/config.ts";

const temps: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalEngine = process.env.HEADED_BROWSER_DEFAULT_ENGINE;

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalEngine === undefined) delete process.env.HEADED_BROWSER_DEFAULT_ENGINE;
	else process.env.HEADED_BROWSER_DEFAULT_ENGINE = originalEngine;
	await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "headed-config-test-"));
	temps.push(path);
	return path;
}

describe("headed browser configuration", () => {
	test("applies default, environment, stored, then per-call precedence", async () => {
		process.env.HEADED_BROWSER_DEFAULT_ENGINE = "chrome";
		const config = await resolveConfig(
			process.cwd(),
			{ engine: "firefox", headless: true },
			async () => ({ values: { defaultEngine: "chrome", defaultHeadless: false }, source: "test", warnings: [] }),
		);
		expect(config.engine).toBe("firefox");
		expect(config.headless).toBe(true);
		expect(config.profileMode).toBe("ephemeral-clone");
	});

	test("rejects invalid coercion and preserves the lower-precedence value", async () => {
		const config = await resolveConfig(
			process.cwd(),
			{ navigationTimeoutMs: "not-a-number" },
			async () => ({ values: { navigationTimeoutMs: 45000 }, source: "test", warnings: [] }),
		);
		expect(config.navigationTimeoutMs).toBe(45000);
		expect(config.warnings[0]).toContain("rejected invalid navigationTimeoutMs");
	});

	test("reads lock settings and project overrides when the public package is unavailable", async () => {
		const root = await temporary();
		const agentDir = join(root, "agent");
		const lockPath = join(root, "plugins", "omp-plugins.lock.json");
		const project = join(root, "project");
		await mkdir(dirname(lockPath), { recursive: true });
		await mkdir(join(project, ".omp"), { recursive: true });
		await writeFile(lockPath, JSON.stringify({ settings: { "@srobroek/browser-tools": { defaultHeadless: true, defaultEngine: "chrome" } } }));
		await writeFile(join(project, ".omp", "plugin-overrides.json"), JSON.stringify({ settings: { "@srobroek/browser-tools": { defaultEngine: "firefox" } } }));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			// The public API is installed in this repo, so the fallback is only reached
			// by injecting an importer that fails the way a missing package would.
			const stored = await loadStoredSettings(project, async () => {
				throw new Error("module not found");
			});
			expect(stored.values).toEqual({ defaultHeadless: true, defaultEngine: "firefox" });
			expect(stored.source).toContain("lock-file:");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	test("keeps package settings schema in sync with the runtime schema", async () => {
		const packageJson = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
		const declared = packageJson.omp.settings as Record<string, Record<string, unknown>>;
		expect(Object.keys(declared).sort()).toEqual(Object.keys(SETTING_SCHEMA).sort());
		for (const [key, schema] of Object.entries(SETTING_SCHEMA)) {
			expect(declared[key]?.type).toBe(schema.type);
			expect(declared[key]?.default).toEqual(schema.default);
			if (schema.type === "enum") expect(declared[key]?.values).toEqual(schema.values);
		}
	});
});
