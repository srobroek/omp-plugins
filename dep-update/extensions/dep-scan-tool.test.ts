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
import depScanTool, { classify, detectProject, normalizeVersion, parseRequirement, queryRegistry } from "./dep-scan-tool";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "dep-scan-"));
}

describe("unit: versions", () => {
	test("normalizeVersion", () => {
		expect(normalizeVersion("1.2.3")).toEqual([1, 2, 3]);
		expect(normalizeVersion("v1.2.3")).toEqual([1, 2, 3]);
		expect(normalizeVersion("1.2")).toEqual([1, 2, 0]);
		expect(normalizeVersion("not-a-version")).toBeNull();
	});

	test("classify", () => {
		expect(classify("1.2.3", "1.2.4")).toBe("PATCH-SAFE");
		expect(classify("1.2.3", "1.3.0")).toBe("MINOR-CHECK");
		expect(classify("1.2.3", "2.0.0")).toBe("MAJOR-ADVISORY");
		expect(classify("1.2.3", "1.2.3")).toBe("CURRENT");
		expect(classify("not-a-version", "1.2.3")).toBe("UNRESOLVABLE");
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
		expect(new Set(rows.map((r) => r.join("\t")))).toEqual(
			new Set(["npm\treact\t^18.2.0", "npm\ttypescript\t~5.4.0"]),
		);
	});

	test("requirements.txt", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "requirements.txt"), "requests==2.31.0\n");
		const { rows } = await detectProject(dir);
		expect(rows).toEqual([["pypi", "requests", "==2.31.0"]]);
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

	test.each([
		["pypi", "==1.0.0", "MAJOR-ADVISORY"],
		["npm", "=1.0.0", "MAJOR-ADVISORY"],
		["pypi", "==2.0.0", "CURRENT"],
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

		const result = await execute("id", { path: project, offline_fixture_dir: fixtures }, undefined, undefined, {
			cwd: project,
		});
		expect(result.details.records[0].name).toBe("left-pad");
		expect(result.details.records[0].class).toBe("CURRENT");
		expect(result.content[0].text).toContain("upgradable");
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
		expect(result.content[0].text).toContain("ADVISORY-ONLY");
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

});
