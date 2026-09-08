import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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
		ensureGitignore(dir);
		ensureGitignore(dir);
		expect(readFileSync(join(dir, ".gitignore"), "utf8").split("\n").filter((line) => line === GITIGNORE_ENTRY)).toHaveLength(1);
	});

	test("copies formulas from plugin root", () => {
		const src = join(dir, "src-formulas");
		mkdirSync(src);
		for (const name of FORMULAS) {
			writeFileSync(join(src, `${name}.formula.toml`), "formula = true\n");
		}
		installFormulas(dir, src);
		for (const name of FORMULAS) {
			expect(readFileSync(join(dir, ".beads/formulas", `${name}.formula.toml`), "utf8")).toBe("formula = true\n");
		}
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

