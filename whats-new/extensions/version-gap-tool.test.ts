import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


const zod = {
	string: () => {
		const s = { optional: () => s, describe: () => s };
		return s;
	},
	object: (shape: unknown) => shape,
};

import versionGapTool, { detectProject, parseRequirement } from "./version-gap-tool";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "vgap-"));
}

describe("unit: parseRequirement", () => {
	test("extras and markers", () => {
		expect(parseRequirement("uvicorn[standard]==0.30.0")).toEqual(["uvicorn", "==0.30.0"]);
	});
});

describe("unit: detect", () => {
	test("package.json", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.3.0" } }));
		const { rows } = await detectProject(dir);
		expect(rows).toEqual([["npm", "leftpad", "1.3.0"]]);
	});
	test("package-lock resolves declared dependencies and exposes coverage gaps", async () => {
		const dir = tmp();
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { leftpad: "^1.3.0", missing: "^2.0.0" } }));
			writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/leftpad": { version: "1.3.1" } } }));
			const result = await detectProject(dir);
			expect(result.resolvedRows).toEqual([
				{ ecosystem: "npm", name: "leftpad", declared: "^1.3.0", resolved: "1.3.1" },
				{ ecosystem: "npm", name: "missing", declared: "^2.0.0", resolved: "?" },
			]);
			expect(result.coverage).toEqual({ resolvedSources: ["package-lock.json"], gaps: ["other lockfiles", "workspace children"] });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("dep-update and whats-new detectors remain byte-identical", () => {
		const whatsNew = readFileSync(join(import.meta.dir, "detect.ts"), "utf8");
		const depUpdate = readFileSync(join(import.meta.dir, "../../dep-update/extensions/detect.ts"), "utf8");
		expect(whatsNew).toBe(depUpdate);
	});
	test("malformed Python arrays fall back without losing valid declarations", async () => {
		const dir = tmp();
		try {
			writeFileSync(join(dir, "uv.lock"), "package = false");
			writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = 42\n[project.optional-dependencies]\nbad = false\ngood = ["requests==2.0.0"]\n[dependency-groups]\nbad = 1\ngood = ["pytest==8.0.0"]\n');
			const result = await detectProject(dir);
			expect(result.rows).toEqual([["pypi", "requests", "==2.0.0"], ["pypi", "pytest", "==8.0.0"]]);
			expect(result.stderr).toContain("Unscanned:");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("integration: version_gap_scan", () => {
	test("enumerates fixture package.json", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			zod,
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		versionGapTool(fakePi as never);
		const execute = captured.execute as (
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<{ content: Array<{ text: string }>; details: { count: number } }>;
		const project = tmp();
		writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.3.0" } }));
		const result = await execute("id", { path: project }, undefined, undefined, { cwd: project });
		expect(result.details.count).toBe(1);
		const first = result.content[0];
		if (!first) throw new Error("missing tool output");
		expect(first.text).toContain("npm\tleftpad\t1.3.0");
	});
});
