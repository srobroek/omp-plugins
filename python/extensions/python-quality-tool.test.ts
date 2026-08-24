import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pythonQualityTool, { runPythonQuality } from "./python-quality-tool.ts";

function fakeZod(): { zod: unknown } {
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	chain.string = self;
	chain.optional = self;
	chain.describe = self;
	chain.object = self;
	chain.enum = self;
	return { zod: chain };
}

describe("runPythonQuality unit", () => {
	test("empty dir skips pytest for missing tests tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "pyq-"));
		const report = runPythonQuality("check", dir);
		expect(report.ok).toBe(true);
		const pytest = report.steps.find((s) => s.name === "pytest");
		expect(pytest?.status).toBe("skip");
	});

	test("fix mode only ruff steps", () => {
		const dir = mkdtempSync(join(tmpdir(), "pyq-"));
		const report = runPythonQuality("fix", dir);
		expect(report.steps.every((s) => s.name.startsWith("ruff"))).toBe(true);
	});
});

describe("python_quality integration", () => {
	test("execute check against empty dir", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		pythonQualityTool(fakePi as never);
		expect(captured.name).toBe("python_quality");
		const dir = mkdtempSync(join(tmpdir(), "pyq-int-"));
		const execute = captured.execute as (
			id: string,
			params: { mode: "check" | "fix"; path?: string },
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<{ content: { type: string; text: string }[]; details: { ok: boolean; steps: unknown[] } }>;
		const result = await execute("t1", { mode: "check", path: dir }, undefined, undefined, { cwd: dir });
		expect(result.content[0]?.type).toBe("text");
		expect(result.details.ok).toBe(true);
		expect(Array.isArray(result.details.steps)).toBe(true);
	});
});
