import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { applyBump } from "./lib";

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
		expect(classify("not-a-version", "1.2.3")).toBe("MINOR-CHECK");
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
			on: () => {},
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
			on: () => {},
		};
		depScanTool(fakePi as never);
		const execute = captured.execute as (
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<{ content: Array<{ text: string }>; details: { exit: number } }>;
		const project = tmp();
		mkdirSync(project, { recursive: true });
		const result = await execute(
			"id",
			{ ecosystem: "cargo", name: "serde", version: "1.0.200", path: project },
			undefined,
			undefined,
			{ cwd: project },
		);
		expect(result.details.exit).toBe(0);
		expect(result.content[0].text).toContain("ADVISORY-ONLY");
	});

	test("applyBump skip when uv missing", async () => {
		const project = tmp();
		const result = await applyBump("pypi", "requests", "2.32.3", project);
		// either applied or skipped; never throws
		expect([0, 1]).toContain(result.exit);
	});
});
