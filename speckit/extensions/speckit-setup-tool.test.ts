import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import speckitSetupTool, {
	CATALOG_URL,
	EXTENSIONS,
	ensureGitignore,
	FORMULAS,
	GITIGNORE_ENTRY,
	installFormulas,
	PHASE_TIMEOUT_MS,
	parseSpecifyMajorMinor,
	runSetup,
	setPluginRootForTests,
	setSpawnForTests,
	specifyVersionOk,
} from "./speckit-setup-tool.ts";

type ToolResult = { details: { ok: boolean; phases?: { phase: string; status: string }[] }; isError?: boolean };
type Execute = (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<ToolResult>;

function registeredExecute(): Execute {
	let execute: Execute | undefined;
	speckitSetupTool({
		zod: fakeZod(),
		registerTool: (definition: { execute: Execute }) => {
			execute = definition.execute;
		},
	} as never);
	if (!execute) throw new Error("speckit_setup was not registered");
	return execute;
}

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


test("requires only installable community extensions", () => {
	expect(EXTENSIONS).toEqual([
		"agent-context",
		"bugfix",
		"cleanup",
		"critique",
		"fix-findings",
		"iterate",
		"qa",
		"refine",
		"retro",
		"security-review",
		"tinyspec",
	]);
});

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

	test("copies formulas and gitignore without specify", async () => {
		const out = await runSetup({ workspace: dir, skipSpecify: true }, "/unused");
		expect(out.ok).toBe(true);
		expect(existsSync(join(dir, ".beads/formulas/mol-speckit-bugfix.formula.toml"))).toBe(true);
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(GITIGNORE_ENTRY);
	});

	test("reports missing specify when not skipped", async () => {
		setSpawnForTests((argv) => {
			if (argv[0] === "which") return { exitCode: 1, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		});
		const out = await runSetup({ workspace: dir, skipSpecify: false }, "/unused");
		expect(out.ok).toBe(false);
		expect(out.text).toContain("specify not on PATH");
	});

	test("marks required-operation failures as tool errors", async () => {
		const out = await registeredExecute()("test", { workspace: dir, skipSpecify: false }, undefined, undefined, { cwd: "/unused" });
		expect(out.details.ok).toBe(false);
		expect(out.details.phases?.at(-1)).toMatchObject({ phase: "specify", status: "failed" });
		expect(out.isError).toBe(true);
	});

	test("defaults the workspace to the caller's cwd and resolves a relative one against it", async () => {
		const cwds: (string | undefined)[] = [];
		setSpawnForTests((argv, opts) => {
			if (argv[0] === "bd") cwds.push(opts.cwd);
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		expect((await registeredExecute()("test", { skipSpecify: true }, undefined, undefined, { cwd: dir })).details.ok).toBe(true);
		expect(existsSync(join(dir, ".beads/formulas/mol-speckit-bugfix.formula.toml"))).toBe(true);
		mkdirSync(join(dir, "sub"));
		expect((await runSetup({ workspace: "sub", skipSpecify: true }, dir)).ok).toBe(true);
		expect(existsSync(join(dir, "sub", ".beads/formulas/mol-speckit-bugfix.formula.toml"))).toBe(true);
		expect(cwds).toEqual([dir, join(dir, "sub")]);
	});
});

describe("runSetup specify phases", () => {
	let dir: string;
	let plugin: string;
	let calls: { argv: string[]; timeout: number }[];
	let onCall: (argv: string[]) => void;

	const specifyCalls = () => calls.map((call) => call.argv).filter((argv) => argv[0] === "specify").map((argv) => argv.slice(1).join(" "));

	beforeEach(() => {
		dir = mkdtempSync(join(SAFE_TMPDIR, "skx-"));
		plugin = mkdtempSync(join(SAFE_TMPDIR, "skq-"));
		mkdirSync(join(plugin, "formulas"));
		for (const name of FORMULAS) writeFileSync(join(plugin, "formulas", `${name}.formula.toml`), "# test\n");
		mkdirSync(join(dir, ".specify", "extensions"), { recursive: true });
		setPluginRootForTests(plugin);
		calls = [];
		onCall = () => {};
		setSpawnForTests((argv, opts) => {
			calls.push({ argv, timeout: opts.timeout });
			onCall(argv);
			return { exitCode: 0, stdout: argv[1] === "--version" ? "specify 1.0.6" : "", stderr: "" };
		});
	});
	afterEach(() => {
		setSystemTime();
		setSpawnForTests(null);
		setPluginRootForTests(null);
		rmSync(dir, { recursive: true, force: true });
		rmSync(plugin, { recursive: true, force: true });
	});

	test("never registers the community catalog as an install source unless opted in", async () => {
		const out = await runSetup({ workspace: dir }, "/unused");
		expect(out.ok).toBe(true);
		expect(calls.some(({ argv }) => argv.includes("--install-allowed"))).toBe(false);
		expect(specifyCalls().some((call) => call.startsWith("extension catalog"))).toBe(false);
		expect(out.phases.find((row) => row.phase === "catalog community")?.status).toBe("skipped");
	});

	test("registers the opted-in catalog once and skips it when already registered", async () => {
		await runSetup({ workspace: dir, installAllowed: true }, "/unused");
		expect(specifyCalls()).toContain(`extension catalog add --name community --install-allowed ${CATALOG_URL}`);
		writeFileSync(join(dir, ".specify", "extension-catalogs.yml"), `catalogs:\n- name: community\n  url: ${CATALOG_URL}\n  priority: 10\n  install_allowed: true\n  description: ''\n`);
		calls = [];
		const rerun = await runSetup({ workspace: dir, installAllowed: true }, "/unused");
		expect(rerun.ok).toBe(true);
		expect(specifyCalls().some((call) => call.startsWith("extension catalog"))).toBe(false);
	});

	test("refuses to change a community catalog entry with other settings", async () => {
		writeFileSync(join(dir, ".specify", "extension-catalogs.yml"), `catalogs:\n- name: community\n  url: ${CATALOG_URL}\n  install_allowed: false\n`);
		const out = await runSetup({ workspace: dir, installAllowed: true }, "/unused");
		expect(out.ok).toBe(false);
		expect(out.phases.at(-1)).toMatchObject({ phase: "catalog community", status: "failed" });
		expect(specifyCalls().some((call) => call.startsWith("extension"))).toBe(false);
	});

	test("skips extensions specify already records as installed", async () => {
		writeFileSync(join(dir, ".specify", "extensions", ".registry"), JSON.stringify({ schema_version: "1.0", extensions: { "agent-context": {}, bugfix: {}, "status-report": {} } }));
		const out = await runSetup({ workspace: dir }, "/unused");
		expect(out.ok).toBe(true);
		const adds = specifyCalls().filter((call) => call.startsWith("extension add"));
		expect(adds.map((call) => call.split(" ")[2])).toEqual(EXTENSIONS.filter((ext) => ext !== "agent-context" && ext !== "bugfix"));
		expect(out.phases.filter((row) => row.status === "skipped").map((row) => row.phase)).toContain("extension status-report");
	});

	test("gives every phase its own timeout", async () => {
		rmSync(join(dir, ".specify"), { recursive: true });
		onCall = (argv) => {
			// A slow phase: each call takes most of a phase budget.
			if (argv[0] === "specify" && argv[1] !== "--version") setSystemTime(new Date(Date.now() + PHASE_TIMEOUT_MS - 1_000));
		};
		const out = await runSetup({ workspace: dir }, "/unused");
		expect(out.ok).toBe(true);
		expect(calls.filter(({ argv }) => argv[0] === "specify" && argv[1] !== "--version").length).toBeGreaterThan(10);
		for (const { argv, timeout } of calls) if (argv[1] !== "--version") expect(timeout).toBeGreaterThan(PHASE_TIMEOUT_MS - 1_000);
	});
});

