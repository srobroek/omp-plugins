import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const zod = {
	string: () => {
		const s = { optional: () => s, describe: () => s };
		return s;
	},
	object: (shape: unknown) => shape,
};

import { resolveApproval, resolveToolTier } from "@oh-my-pi/pi-coding-agent/tools/approval";
import depScanTool, { classify, detectProject, normalizeVersion, parseRequirement, queryRegistry } from "./dep-scan-tool";
import { compareVersions, isPrerelease, pickStable, researchProject } from "./lib";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "dep-scan-"));
}

describe("unit: versions", () => {
	test("normalizeVersion", () => {
		expect(normalizeVersion("1.2.3")).toEqual([1, 2, 3]);
		expect(normalizeVersion("v1.2.3")).toEqual([1, 2, 3]);
		expect(normalizeVersion("1.2")).toBeNull();
		expect(normalizeVersion("1.2", "pypi")).toEqual([1, 2, 0]);
		expect(normalizeVersion("==1.2", "pypi")).toEqual([1, 2, 0]);
		expect(normalizeVersion("not-a-version")).toBeNull();
	});

	test("classify", () => {
		expect(classify("1.2.3", "1.2.4")).toBe("PATCH-SAFE");
		expect(classify("1.2.3", "1.3.0")).toBe("MINOR-CHECK");
		expect(classify("1.2.3", "2.0.0")).toBe("MAJOR-ADVISORY");
		expect(classify("1.2.3", "1.2.3")).toBe("CURRENT");
		expect(classify("not-a-version", "1.2.3")).toBe("UNRESOLVABLE");
	});

	test("same-triple pre- and post-releases are upgrades, not CURRENT", () => {
		expect(classify("1.0.0-rc.1", "1.0.0")).toBe("PATCH-SAFE");
		expect(classify("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe("PATCH-SAFE");
		expect(classify("1.0.0-alpha", "1.0.0-alpha.1")).toBe("PATCH-SAFE");
		expect(classify("1.0.0-beta", "1.0.0-alpha.1")).toBe("CURRENT");
		expect(classify("1.0.0", "1.0.0-rc.1")).toBe("CURRENT");
		expect(classify("1.0.0", "1.0.0.post1", "pypi")).toBe("PATCH-SAFE");
		expect(classify("1.0rc1", "1.0", "pypi")).toBe("PATCH-SAFE");
		expect(classify("1.0a1", "1.0b1", "pypi")).toBe("PATCH-SAFE");
		expect(classify("1.0.dev1", "1.0a1", "pypi")).toBe("PATCH-SAFE");
		expect(classify("1.0a1.dev1", "1.0a1", "pypi")).toBe("PATCH-SAFE");
		expect(classify("1.0.post1", "1.0", "pypi")).toBe("CURRENT");
		expect(classify("1.0.post1.dev1", "1.0.post1", "pypi")).toBe("PATCH-SAFE");
		expect(compareVersions("1.0", "1.0.post1.dev1", "pypi")).toBe(-1);
		expect(compareVersions("1.0+local", "1.0", "pypi")).toBe(0);
		expect(pickStable("2.0rc1", "1.0", ["1.1", "1.1.post1", "2.0rc1"], "pypi")).toBe("1.1.post1");
	});

	test.each([
		"1.x", "1.X", "1.*", "1.2.x", "1", "1.2", "1.2.3.4",
		"1.2.3 || 2.0.0", "1.2.3 <2.0.0", "1.2.3, <2.0.0",
		"1.2.3 - 2.0.0", "1.2.3garbage", "1.2.3\n", "==1.2.3",
		"01.2.3", "1.2.3-01", "1.2.3-", "1.2.3+",
	])("rejects the complete unresolved Node input %j on either side", (version) => {
		expect(normalizeVersion(version)).toBeNull();
		expect(classify(version, "2.0.0")).toBe("UNRESOLVABLE");
		expect(classify("1.0.0", version)).toBe("UNRESOLVABLE");
	});

	test("exact prereleases and build metadata remain parseable, not ranges", () => {
		expect(normalizeVersion("1.2.3-beta.1+build.5")).toEqual([1, 2, 3]);
		expect(normalizeVersion("1.2.3-2.0.0")).toEqual([1, 2, 3]);
		expect(normalizeVersion("==1.2rc1", "pypi")).toEqual([1, 2, 0]);
		expect(isPrerelease("1.2.3-preview")).toBe(true);
		expect(isPrerelease("1.2.3+beta.1")).toBe(false);
		expect(isPrerelease("1.2rc1", "pypi")).toBe(true);
		expect(isPrerelease("1.2.dev1", "pypi")).toBe(true);
		expect(isPrerelease("1.2.post1", "pypi")).toBe(false);
		expect(pickStable("2.0.0-preview", "1.0.0", ["2.x", "1.1.0", "2.0.0-preview"])).toBe("1.1.0");
		expect(pickStable("2.0.0-preview", "1.0.0-beta.1", ["1.1.0", "2.0.0-preview"])).toBe("2.0.0-preview");
		expect(pickStable("2.0rc1", "1.0", ["2.*", "1.1", "2.0rc1"], "pypi")).toBe("1.1");
	});

	test("parseRequirement extras", () => {
		expect(parseRequirement('requests[socks]>=2.31.0; python_version < "3.12"')).toEqual([
			"requests",
			">=2.31.0",
		]);
	});
});

describe("unit: detect", () => {
	test("package.json deps", async () => {
		const dir = tmp();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				dependencies: { react: "^18.2.0" },
				devDependencies: { typescript: "~5.4.0" },
			}),
		);
		const { rows } = await detectProject(dir);
        expect(rows).toEqual([
            { ecosystem: "npm", name: "react", declared: "^18.2.0", resolved: null, direct: true },
            { ecosystem: "npm", name: "typescript", declared: "~5.4.0", resolved: null, direct: true },
        ]);
	});

	test("requirements.txt", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "requirements.txt"), "requests==2.31.0\n");
		const { rows } = await detectProject(dir);
        expect(rows).toEqual([{ ecosystem: "pypi", name: "requests", declared: "==2.31.0", resolved: null, direct: true }]);
	});

	test("Python: pyproject declares, uv.lock resolves, transitive and local entries are told apart", async () => {
		const dir = tmp();
		try {
			writeFileSync(join(dir, "pyproject.toml"), [
				"[project]", 'name = "app"', 'dependencies = ["httpx>=0.27", "Typing_Extensions>=4", "mylib", "vendored @ file:///tmp/vendored"]',
				"[dependency-groups]", 'dev = ["pytest==8.0.0"]',
			].join("\n"));
			writeFileSync(join(dir, "requirements.txt"), "flask==3.0.0\n");
			writeFileSync(join(dir, "uv.lock"), [
				"version = 1",
				'[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }',
				'[[package]]\nname = "httpx"\nversion = "0.27.2"\nsource = { registry = "https://pypi.org/simple" }',
				'[[package]]\nname = "typing-extensions"\nversion = "4.12.2"\nsource = { registry = "https://pypi.org/simple" }',
				'[[package]]\nname = "anyio"\nversion = "4.4.0"\nsource = { registry = "https://pypi.org/simple" }',
				'[[package]]\nname = "mylib"\nversion = "0.0.1"\nsource = { directory = "../mylib" }',
				'[[package]]\nname = "pytest"\nversion = "8.0.0"\nsource = { registry = "https://pypi.org/simple" }',
			].join("\n"));
			const { rows } = await detectProject(dir);
			expect(rows).toEqual([
				{ ecosystem: "pypi", name: "httpx", declared: ">=0.27", resolved: "0.27.2", direct: true },
				{ ecosystem: "pypi", name: "Typing_Extensions", declared: ">=4", resolved: "4.12.2", direct: true },
				{ ecosystem: "pypi", name: "pytest", declared: "==8.0.0", resolved: "8.0.0", direct: true },
				{ ecosystem: "pypi", name: "anyio", declared: "?", resolved: "4.4.0", direct: false },
			]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("Python: poetry tables declare, poetry.lock resolves, path and directory sources are skipped", async () => {
		const dir = tmp();
		try {
			writeFileSync(join(dir, "pyproject.toml"), [
				"[tool.poetry.dependencies]", 'python = "^3.11"', 'requests = "^2.31"', 'mylib = { path = "../mylib", develop = true }',
				"[tool.poetry.group.dev.dependencies]", 'pytest = { version = "8.0.0" }',
			].join("\n"));
			writeFileSync(join(dir, "poetry.lock"), [
				'[[package]]\nname = "requests"\nversion = "2.32.3"',
				'[[package]]\nname = "urllib3"\nversion = "2.2.2"',
				'[[package]]\nname = "pytest"\nversion = "8.0.0"',
				'[[package]]\nname = "mylib"\nversion = "0.1.0"\ndevelop = true\n[package.source]\ntype = "directory"\nurl = "../mylib"',
			].join("\n"));
			const { rows } = await detectProject(dir);
			expect(rows).toEqual([
				{ ecosystem: "pypi", name: "requests", declared: "^2.31", resolved: "2.32.3", direct: true },
				{ ecosystem: "pypi", name: "pytest", declared: "8.0.0", resolved: "8.0.0", direct: true },
				{ ecosystem: "pypi", name: "urllib3", declared: "?", resolved: "2.2.2", direct: false },
			]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("Python: requirements.txt declares only when pyproject declares nothing", async () => {
		const dir = tmp();
		try {
			writeFileSync(join(dir, "pyproject.toml"), '[build-system]\nrequires = ["setuptools"]\n');
			writeFileSync(join(dir, "requirements.txt"), "flask==3.0.0\n");
			const { rows } = await detectProject(dir);
			expect(rows).toEqual([{ ecosystem: "pypi", name: "flask", declared: "==3.0.0", resolved: null, direct: true }]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("research queries declared rows only, never transitive lock entries", async () => {
		const dir = tmp();
		const fixtures = tmp();
		try {
			writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "app"\ndependencies = ["httpx==0.27.0"]\n');
			writeFileSync(join(dir, "uv.lock"), '[[package]]\nname = "httpx"\nversion = "0.27.0"\n[[package]]\nname = "anyio"\nversion = "4.0.0"\n');
			for (const name of ["httpx", "anyio"]) {
				writeFileSync(join(fixtures, `pypi_${name}.json`), JSON.stringify({ info: { version: "9.0.0" }, releases: { "9.0.0": [{ yanked: false }] } }));
			}
			const result = await researchProject(dir, fixtures);
			expect(result.records.map((r) => r.name)).toEqual(["httpx"]);
			expect(result.stderr).toContain("transitive (not queried): 1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(fixtures, { recursive: true, force: true });
		}
	});
});

describe("unit: fixture registry", () => {
	test("pypi patch-safe via fixture", async () => {
		const fixtures = tmp();
		writeFileSync(
			join(fixtures, "pypi_requests.json"),
			JSON.stringify({ info: { version: "2.32.3" }, releases: { "2.32.3": [{ yanked: false }] } }),
		);
		const record = await queryRegistry("pypi", "requests", "2.32.0", fixtures);
		expect(record.status).toBe("OK");
		expect(record.class).toBe("PATCH-SAFE");
		expect(record.latest).toBe("2.32.3");
	});

	test("a same-triple post-release from the registry is recommended, not dropped as CURRENT", async () => {
		const fixtures = tmp();
		try {
			writeFileSync(join(fixtures, "pypi_example.json"), JSON.stringify({ info: { version: "1.0.0.post1" }, releases: { "1.0.0.post1": [{ yanked: false }] } }));
			const record = await queryRegistry("pypi", "example", "1.0.0", fixtures);
			expect(record.status).toBe("OK");
			expect(record.class).toBe("PATCH-SAFE");
		} finally { rmSync(fixtures, { recursive: true, force: true }); }
	});

	test.each([
		["pypi", "==1.0.0", "MAJOR-ADVISORY"],
		["npm", "=1.0.0", "MAJOR-ADVISORY"],
		["pypi", "==2.0.0", "CURRENT"],
		["pypi", "=1.0.0", "MAJOR-ADVISORY"],
		["pypi", "==1.0", "MAJOR-ADVISORY"],
		["pypi", "1", "MAJOR-ADVISORY"],
		["pypi", "==1.0rc1", "MAJOR-ADVISORY"],
		["npm", "==1.0.0", "UNRESOLVABLE"],
		["npm", "1.0rc1", "UNRESOLVABLE"],
		["pypi", "1.x", "UNRESOLVABLE"],
		["pypi", "1.0 - 2.0", "UNRESOLVABLE"],
		["pypi", "==1.0,!=1.0.1", "UNRESOLVABLE"],
		["pypi", "1.0garbage", "UNRESOLVABLE"],
		["pypi", "==1.*", "UNRESOLVABLE"],
		["pypi", ">=1.0.0", "UNRESOLVABLE"],
	])("%s classifies %s without treating ranges as resolved versions", async (ecosystem, installed, expected) => {
		const fixtures = tmp();
		try {
			const response = ecosystem === "pypi"
				? { info: { version: "2.0.0" }, releases: { "2.0.0": [{ yanked: false }] } }
				: { "dist-tags": { latest: "2.0.0" }, versions: { "2.0.0": {} } };
			writeFileSync(join(fixtures, `${ecosystem}_example.json`), JSON.stringify(response));
			const record = await queryRegistry(ecosystem, "example", installed, fixtures);
			expect(record.class).toBe(expected);
			expect(record.status).toBe(expected === "UNRESOLVABLE" || expected === "CURRENT" ? expected : "OK");
		} finally {
			rmSync(fixtures, { recursive: true, force: true });
		}
	});

	test.each(["npm", "node"])("%s unresolved declarations cannot become recommended OK upgrades", async (ecosystem) => {
		const fixtures = tmp();
		try {
			writeFileSync(join(fixtures, `${ecosystem}_example.json`), JSON.stringify({
				"dist-tags": { latest: "1.1.0" }, versions: { "1.1.0": {} },
			}));
			for (const installed of ["1.x", "1.*", "1", "1.0", "1.0.0 || 2.0.0", "1.0.0 - 2.0.0"]) {
				const record = await queryRegistry(ecosystem, "example", installed, fixtures);
				expect(record.status).toBe("UNRESOLVABLE");
				expect(record.class).toBe("UNRESOLVABLE");
				expect(record.reason).toContain("Exact versions are required");
			}
			const exact = await queryRegistry(ecosystem, "example", "1.0.0", fixtures);
			expect(exact.status).toBe("OK");
			expect(exact.class).toBe("MINOR-CHECK");
		} finally {
			rmSync(fixtures, { recursive: true, force: true });
		}
	});

	test("yanked is disconfirmed", async () => {
		const fixtures = tmp();
		writeFileSync(
			join(fixtures, "pypi_requests.json"),
			JSON.stringify({ info: { version: "2.32.3" }, releases: { "2.32.3": [{ yanked: true }] } }),
		);
		const record = await queryRegistry("pypi", "requests", "2.31.0", fixtures);
		expect(record.status).toBe("DISCONFIRMED");
	});

	test("missing fixture is unresolvable", async () => {
		const fixtures = tmp();
		const record = await queryRegistry("pypi", "absent", "1.0.0", fixtures);
		expect(record.status).toBe("UNRESOLVABLE");
		expect(record.reason ?? "").toContain("network error");
	});
});

describe("integration: dep_scan", () => {
	test("offline fixture classifies left-pad", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			zod,
			registerTool: (d: Record<string, unknown>) => {
				if (d.name === "dep_scan") Object.assign(captured, d);
			},
			on: () => { },
		};
		depScanTool(fakePi as never);
		const execute = captured.execute as (
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<{ content: Array<{ text: string }>; details: { records: Array<{ class?: string; name: string }> } }>;

		const project = tmp();
		writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }));
		const fixtures = tmp();
		writeFileSync(
			join(fixtures, "npm_left-pad.json"),
			JSON.stringify({ "dist-tags": { latest: "1.3.0" }, versions: { "1.3.0": {} } }),
		);

		// The fixture seam is test-only: an env var, never a model-visible parameter.
		expect(Object.keys(captured.parameters as Record<string, unknown>)).toEqual(["path"]);
		const previous = process.env.DEP_UPDATE_FIXTURE_DIR;
		process.env.DEP_UPDATE_FIXTURE_DIR = fixtures;
		try {
			const result = await execute("id", { path: project }, undefined, undefined, { cwd: project });
			const record = result.details.records[0];
			if (!record) throw new Error("dep_scan returned no dependency records");
			expect(record.name).toBe("left-pad");
			expect(record.class).toBe("CURRENT");
			expect(result.content[0]?.text).toContain("upgradable");
		} finally {
			if (previous === undefined) delete process.env.DEP_UPDATE_FIXTURE_DIR; else process.env.DEP_UPDATE_FIXTURE_DIR = previous;
		}
	});
});

describe("integration: dep_apply", () => {
	test("advisory cargo does not need a toolchain", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			zod,
			registerTool: (d: Record<string, unknown>) => {
				if (d.name === "dep_apply") Object.assign(captured, d);
			},
			on: () => { },
		};
		depScanTool(fakePi as never);
		const execute = captured.execute as (
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string; hasUI: boolean; ui: { confirm: () => Promise<boolean> }; setTimeout: typeof setTimeout; clearTimer: typeof clearTimeout },
		) => Promise<{ content: Array<{ text: string }>; details: { exit: number } }>;
		const project = tmp();
		mkdirSync(project, { recursive: true });
		const result = await execute(
			"id",
			{ ecosystem: "cargo", name: "serde", version: "1.0.200", path: project },
			undefined,
			undefined,
			{ cwd: project, hasUI: true, ui: { confirm: async () => true }, setTimeout, clearTimer: clearTimeout },
		);
		expect(result.details.exit).toBe(0);
		const text = result.content[0]?.text;
		expect(text).toContain("ADVISORY-ONLY");
	});
	test("headless and denied confirmation stop before dependency execution", async () => {
		const captured: Record<string, unknown> = {};
		depScanTool({
			zod, registerTool: (d: Record<string, unknown>) => {
				if (d.name === "dep_apply") Object.assign(captured, d);
			}
		} as never);
		const execute = captured.execute as (
			id: string, params: Record<string, unknown>, signal: undefined, update: undefined,
			ctx: { cwd: string; hasUI: boolean; ui: { confirm: (title: string, message: string) => Promise<boolean> } },
		) => Promise<{ details: { error?: string } }>;
		const params = { ecosystem: "npm", name: "@scope/pkg", version: "1.2.3", path: "/synthetic-project" };
		const headless = await execute("headless", params, undefined, undefined, {
			cwd: "/", hasUI: false, ui: { confirm: async () => { throw new Error("unexpected prompt"); } },
		});
		expect(headless.details.error).toContain("Interactive approval is required");
		let prompt = "";
		const denied = await execute("denied", params, undefined, undefined, {
			cwd: "/", hasUI: true, ui: { confirm: async (_title, message) => { prompt = message; return false; } },
		});
		expect(denied.details.error).toContain("Dependency bump denied");
		expect(prompt).toContain("@scope/pkg -> 1.2.3");
		expect(prompt).toContain("/synthetic-project");
	});

	test("one approval per bump on the direct and the xd:// path; user deny still blocks", async () => {
		const captured: Record<string, unknown> = {};
		depScanTool({
			zod, registerTool: (d: Record<string, unknown>) => {
				if (d.name === "dep_apply") Object.assign(captured, d);
			}
		} as never);
		const tool = { name: "dep_apply", approval: captured.approval as never };
		const args = { ecosystem: "cargo", name: "serde", version: "1.0.200" };
		const owner = { bash: "allow", write: "allow", read: "allow" };
		const hostPrompts = (mode: "yolo" | "write" | "always-ask", policies: Record<string, unknown>, xd: boolean): number => {
			const inner = resolveApproval(tool, args, mode, policies);
			if (!xd) return inner.policy === "prompt" ? 1 : 0;
			// write xd://dep_apply: the write gate resolves the device's tier under its policyKey,
			// then the wrapped tool prompts only for an override or a user policy (xdevApproved).
			const outer = resolveApproval({ name: "write", approval: { tier: resolveToolTier(tool, args), policyKey: "dep_apply" } }, args, mode, policies);
			const innerPrompt = inner.policy === "prompt" && (inner.override || Object.hasOwn(policies, "dep_apply"));
			return (outer.policy === "prompt" ? 1 : 0) + (innerPrompt ? 1 : 0);
		};
		for (const policies of [{}, owner]) {
			expect(hostPrompts("yolo", policies, false)).toBe(0);
			expect(hostPrompts("yolo", policies, true)).toBe(0);
			expect(hostPrompts("write", policies, false)).toBe(0);
			expect(hostPrompts("always-ask", policies, false)).toBe(0);
		}
		expect(resolveApproval(tool, args, "yolo", { ...owner, dep_apply: "deny" }).policy).toBe("deny");

		const execute = captured.execute as (
			id: string, params: Record<string, unknown>, signal: undefined, update: undefined,
			ctx: { cwd: string; hasUI: boolean; ui: { confirm: (title: string, message: string) => Promise<boolean> }; setTimeout: typeof setTimeout; clearTimer: typeof clearTimeout },
		) => Promise<{ details: { exit?: number } }>;
		const project = tmp();
		try {
			const prompts: string[] = [];
			const result = await execute("one", { ...args, path: project }, undefined, undefined, {
				cwd: project, hasUI: true, ui: { confirm: async (_title, message) => { prompts.push(message); return true; } },
				setTimeout, clearTimer: clearTimeout,
			});
			expect(result.details.exit).toBe(0);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("serde -> 1.0.200");
		} finally { rmSync(project, { recursive: true, force: true }); }
	});

});
