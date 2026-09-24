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
    test("package.json and package-lock.json expose declared and resolved versions", async () => {
        const dir = tmp();
        writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { leftpad: "^1.3.0", missing: "^2.0.0" } }));
        writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/leftpad": { version: "1.3.1" } } }));
        const { rows, coverage } = await detectProject(dir);
        expect(rows).toEqual([
            { ecosystem: "npm", name: "leftpad", declared: "^1.3.0", resolved: "1.3.1" },
            { ecosystem: "npm", name: "missing", declared: "^2.0.0", resolved: null },
        ]);
        expect(coverage.gaps).toContain("Cargo.lock");
    });
	test("malformed Python arrays fall back without losing valid declarations", async () => {
		const dir = tmp();
		try {
			writeFileSync(join(dir, "uv.lock"), "package = false");
			writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = 42\n[project.optional-dependencies]\nbad = false\ngood = ["requests==2.0.0"]\n[dependency-groups]\nbad = 1\ngood = ["pytest==8.0.0"]\n');
			const result = await detectProject(dir);

            expect(result.rows).toEqual([
                { ecosystem: "pypi", name: "requests", declared: "==2.0.0", resolved: null },
                { ecosystem: "pypi", name: "pytest", declared: "==8.0.0", resolved: null },
            ]);
			expect(result.stderr).toContain("Unscanned:");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

test("dependency detector copies remain byte-identical", () => {
    const local = readFileSync(join(import.meta.dir, "detect.ts"));
    const sibling = readFileSync(join(import.meta.dir, "../../dep-update/extensions/detect.ts"));
    expect(local.equals(sibling)).toBe(true);
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
        expect(first.text).toContain("npm\tleftpad\t1.3.0\t?");
	});
});
