import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import speckitSetupTool, {
	ensureGitignore,
	FORMULAS,
	GITIGNORE_ENTRY,
	installFormulas,
	parseSpecifyMajorMinor,
	runSetup,
	setPluginRootForTests,
	setSpawnForTests,
	specifyVersionOk,
} from "./speckit-setup-tool.ts";

const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

describe("specifyVersionOk", () => {
	test("accepts 0.12+", () => {
		expect(specifyVersionOk("specify-cli 0.12.0")).toBe(true);
		expect(specifyVersionOk("1.0.0")).toBe(true);
		expect(specifyVersionOk("0.11.9")).toBe(false);
		expect(parseSpecifyMajorMinor("nope")).toBeNull();
	});
});

describe("ensureGitignore + formulas", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sk-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("appends once", () => {
		expect(ensureGitignore(dir)).toContain("appended");
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(GITIGNORE_ENTRY);
		expect(ensureGitignore(dir)).toContain("already");
	});

	test("copies formulas from plugin root", () => {
		const src = join(dir, "src-formulas");
		mkdirSync(src);
		for (const name of FORMULAS) {
			writeFileSync(join(src, `${name}.formula.toml`), "formula = true\n");
		}
		const lines = installFormulas(dir, src);
		expect(lines.every((l) => l.startsWith("copied"))).toBe(true);
		expect(existsSync(join(dir, ".beads/formulas/speckit-feature.formula.toml"))).toBe(true);
	});
});

describe("runSetup skipSpecify", () => {
	let dir: string;
	let plugin: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sks-"));
		plugin = mkdtempSync(join(tmpdir(), "skp-"));
		mkdirSync(join(plugin, "formulas"));
		for (const name of FORMULAS) {
			writeFileSync(join(plugin, "formulas", `${name}.formula.toml`), "# test\n");
		}
		setPluginRootForTests(plugin);
		setSpawnForTests((argv) => {
			if (argv[0] === "which" && argv[1] === "bd") return { exitCode: 0, stdout: "/bin/bd", stderr: "" };
			if (argv[0] === "bd" && argv[1] === "where") return { exitCode: 0, stdout: dir, stderr: "" };
			if (argv[0] === "which") return { exitCode: 1, stdout: "", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
	});
	afterEach(() => {
		setSpawnForTests(null);
		setPluginRootForTests(null);
		rmSync(dir, { recursive: true, force: true });
		rmSync(plugin, { recursive: true, force: true });
	});

	test("copies formulas and gitignore without specify", () => {
		const out = runSetup({ workspace: dir, skipSpecify: true });
		expect(out.ok).toBe(true);
		expect(out.text).toContain("copied speckit-feature");
		expect(existsSync(join(dir, ".beads/formulas/mol-speckit-bugfix.formula.toml"))).toBe(true);
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(GITIGNORE_ENTRY);
	});

	test("reports missing specify when not skipped", () => {
		setSpawnForTests((argv) => {
			if (argv[0] === "which") return { exitCode: 1, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		});
		const out = runSetup({ workspace: dir, skipSpecify: false });
		expect(out.ok).toBe(false);
		expect(out.text).toContain("specify not on PATH");
	});
});

describe("registerTool", () => {
	test("registers speckit_setup", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			zod: z,
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		speckitSetupTool(fakePi as never);
		expect(captured.name).toBe("speckit_setup");
		const execute = captured.execute as (
			id: string,
			params: { skipSpecify: boolean; workspace: string },
		) => Promise<{ details: { ok: boolean } }>;
		const tmp = mkdtempSync(join(tmpdir(), "ske-"));
		setSpawnForTests(() => ({ exitCode: 1, stdout: "", stderr: "" }));
		setPluginRootForTests(tmp);
		const result = await execute("1", { skipSpecify: true, workspace: tmp });
		expect(result.details.ok).toBe(true);
		rmSync(tmp, { recursive: true, force: true });
		setSpawnForTests(null);
		setPluginRootForTests(null);
	});
});
