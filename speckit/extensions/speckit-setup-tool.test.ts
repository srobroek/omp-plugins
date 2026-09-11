import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

type ToolResult = { details: { ok: boolean }; isError?: boolean };

function fakeZod(): Record<string, unknown> {
	const scalar = () => {
		const chain = {
			optional: () => chain,
			describe: () => chain,
		};
		return chain;
	};
	return {
		string: scalar,
		boolean: scalar,
		object: (shape: unknown) => shape,
	};
}

const SAFE_TMPDIR = realpathSync(tmpdir());


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
		dir = mkdtempSync(join(SAFE_TMPDIR, "sk-"));
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
		dir = mkdtempSync(join(SAFE_TMPDIR, "sks-"));
		plugin = mkdtempSync(join(SAFE_TMPDIR, "skp-"));
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

	test("marks required-operation failures as tool errors", async () => {
		let execute: ((id: string, params: { workspace: string; skipSpecify: boolean }) => Promise<ToolResult>) | undefined;
		speckitSetupTool({
			zod: fakeZod(),
			registerTool: (definition: { execute: typeof execute }) => {
				execute = definition.execute;
			},
		} as never);
		if (!execute) throw new Error("speckit_setup was not registered");

		const out = await execute("test", { workspace: dir, skipSpecify: false });
		expect(out.details).toEqual({ ok: false });
		expect(out.isError).toBe(true);
	});
});

