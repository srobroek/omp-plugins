import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
		expect(result.content[0].text).toContain("npm\tleftpad\t1.3.0");
	});
});
