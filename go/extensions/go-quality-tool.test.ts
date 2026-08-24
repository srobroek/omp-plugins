import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goQualityTool, { runGoQuality } from "./go-quality-tool.ts";

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

describe("runGoQuality unit", () => {
	test("empty dir skips all steps cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "goq-"));
		const report = runGoQuality("check", dir);
		expect(report.ok).toBe(true);
		expect(report.steps.every((s) => s.status === "skip")).toBe(true);
	});

	test("fix mode only reports gofmt", () => {
		const dir = mkdtempSync(join(tmpdir(), "goq-"));
		const report = runGoQuality("fix", dir);
		expect(report.steps.every((s) => s.name.includes("gofmt"))).toBe(true);
	});
});

describe("go_quality integration", () => {
	test("execute check against empty dir", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		goQualityTool(fakePi as never);
		expect(captured.name).toBe("go_quality");
		const dir = mkdtempSync(join(tmpdir(), "goq-int-"));
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

	test("missing path returns structured error", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		goQualityTool(fakePi as never);
		const execute = captured.execute as (
			id: string,
			params: { mode: "check" | "fix"; path?: string },
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<{ details: { ok: boolean; error?: string } }>;
		const result = await execute(
			"t2",
			{ mode: "check", path: "/tmp/definitely-missing-goq-xyz" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		expect(result.details.ok).toBe(false);
		expect(result.details.error).toBe("missing_path");
	});
});
