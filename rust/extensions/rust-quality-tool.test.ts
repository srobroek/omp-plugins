import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rustQualityTool, { runRustQuality } from "./rust-quality-tool.ts";

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

describe("runRustQuality unit", () => {
	test("empty dir skips all steps cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "rsq-"));
		const report = runRustQuality("check", dir);
		expect(report.ok).toBe(true);
		expect(report.steps.every((s) => s.status === "skip")).toBe(true);
	});

	test("fix mode only cargo fmt", () => {
		const dir = mkdtempSync(join(tmpdir(), "rsq-"));
		const report = runRustQuality("fix", dir);
		expect(report.steps.every((s) => s.name.includes("fmt"))).toBe(true);
	});
});

describe("rust_quality integration", () => {
	test("execute check against empty dir", async () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		rustQualityTool(fakePi as never);
		expect(captured.name).toBe("rust_quality");
		const dir = mkdtempSync(join(tmpdir(), "rsq-int-"));
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
