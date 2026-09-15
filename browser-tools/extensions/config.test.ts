import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadStoredSettings, resolveConfig, SETTING_SCHEMA } from "./lib/config.ts";

const temps: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalEngine = process.env.HEADED_BROWSER_DEFAULT_ENGINE;
const originalDriver = process.env.HEADED_BROWSER_DRIVER_MODULE_PATH;
afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalEngine === undefined) delete process.env.HEADED_BROWSER_DEFAULT_ENGINE;
	else process.env.HEADED_BROWSER_DEFAULT_ENGINE = originalEngine;
	if (originalDriver === undefined) delete process.env.HEADED_BROWSER_DRIVER_MODULE_PATH;
	else process.env.HEADED_BROWSER_DRIVER_MODULE_PATH = originalDriver;
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

	test("keeps driver module path in trusted config and ignores per-call overrides", async () => {
		const config = await resolveConfig(
			process.cwd(),
			{ driverModulePath: "relative.js" } as never,
			async () => ({ values: { driverModulePath: "/tmp/trusted/driver.js" }, source: "operator", warnings: [] }),
		);
		expect(config.driverModulePath).toBe("/tmp/trusted/driver.js");
		const rejected = await resolveConfig(
			process.cwd(),
			{},
			async () => ({ values: { driverModulePath: "relative.js" }, source: "operator", warnings: [] }),
		);
		expect(rejected.driverModulePath).toBe("");
		expect(rejected.warnings.join(" ")).toContain("rejected invalid driverModulePath");
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
	test("reads lock settings and project overrides while filtering untrusted driver paths", async () => {
		const root = await temporary();
		const agentDir = join(root, "agent");
		const lockPath = join(root, "plugins", "omp-plugins.lock.json");
		const project = join(root, "project");
		await mkdir(dirname(lockPath), { recursive: true });
		await mkdir(join(project, ".omp"), { recursive: true });
		await writeFile(
			lockPath,
			JSON.stringify({ settings: { "@srobroek/browser-tools": { defaultHeadless: true, defaultEngine: "chrome", driverModulePath: "/trusted/global.js" } } }),
		);
		await writeFile(
			join(project, ".omp", "plugin-overrides.json"),
			JSON.stringify({ settings: { "@srobroek/browser-tools": { defaultEngine: "firefox", driverModulePath: "/untrusted/project.js" } } }),
		);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const stored = await loadStoredSettings(project, async () => {
				throw new Error("module not found");
			});
			expect(stored.values).toEqual({ defaultHeadless: true, defaultEngine: "firefox", driverModulePath: "/trusted/global.js" });
			expect(stored.source).toContain("lock-file:");
			const globalConfig = await resolveConfig(project, {}, async () => stored);
			expect(globalConfig.driverModulePath).toBe("/trusted/global.js");
			expect(globalConfig.engine).toBe("firefox");

			process.env.HEADED_BROWSER_DRIVER_MODULE_PATH = "/trusted/environment.js";
			const environmentConfig = await resolveConfig(
				project,
				{},
				async () => ({ values: { defaultEngine: "firefox" }, source: stored.source, warnings: [] }),
			);
			expect(environmentConfig.driverModulePath).toBe("/trusted/environment.js");
			expect(environmentConfig.engine).toBe("firefox");
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
