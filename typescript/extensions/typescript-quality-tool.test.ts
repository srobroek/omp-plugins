import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import typescriptQualityTool, { runTypescriptQuality } from "./typescript-quality-tool.ts";

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

describe("runTypescriptQuality unit", () => {
	test("empty dir without package.json skips cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "tsq-"));
		const report = runTypescriptQuality("check", dir);
		expect(report.ok).toBe(true);
		expect(report.steps.every((s) => s.status === "skip")).toBe(true);
		expect(report.steps.some((s) => s.detail.includes("package.json"))).toBe(true);
	});
});

describe("typescript_quality integration", () => {
	test("execute check against empty dir", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		typescriptQualityTool(fakePi as never);
		expect(captured.name).toBe("typescript_quality");
		const dir = mkdtempSync(join(tmpdir(), "tsq-int-"));
		const execute = captured.execute as (
			id: string,
			params: { mode: "check" | "fix"; path?: string },
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<{ content: { type: string; text: string }[]; details: { ok: boolean; steps: { status: string }[] } }>;
		const result = await execute("t1", { mode: "check", path: dir }, undefined, undefined, { cwd: dir });
		expect(result.content[0]?.type).toBe("text");
		expect(result.details.ok).toBe(true);
		expect(result.details.steps.every((s) => s.status === "skip")).toBe(true);
	});
});
