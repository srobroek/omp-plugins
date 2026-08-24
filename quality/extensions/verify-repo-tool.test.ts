import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifyRepoTool, { runVerify } from "./verify-repo-tool.ts";

const temps: string[] = [];

afterAll(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function fakeZod(): { zod: unknown } {
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	chain.string = self;
	chain.optional = self;
	chain.describe = self;
	chain.object = self;
	chain.enum = self;
	chain.array = self;
	chain.boolean = self;
	return { zod: chain };
}

describe("runVerify", () => {
	test("empty dir reports no workflow", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-repo-"));
		temps.push(dir);
		const result = runVerify(dir);
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.ran).toBe(0);
		expect(result.report).toContain("No supported verification workflow detected.");
	});

	test("Makefile without verify target is not a workflow", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-make-"));
		temps.push(dir);
		writeFileSync(join(dir, "Makefile"), "all:\n\techo hi\n");
		const result = runVerify(dir);
		expect(result.ran).toBe(0);
		expect(result.report).toContain("No supported verification workflow detected.");
	});

	test("package.json without scripts reports no ran checks", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-pkg-"));
		temps.push(dir);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
		const result = runVerify(dir);
		expect(result.report).toContain("==> summary");
		expect(result.ran).toBe(0);
	});
});

describe("verify_repo integration", () => {
	test("registers and execute reports no-workflow on empty cwd", async () => {
		const captured: {
			name?: string;
			execute?: (
				id: string,
				params: { path?: string },
				signal: undefined,
				onUpdate: undefined,
				ctx: { cwd: string },
			) => Promise<{ content: Array<{ type: string; text: string }>; details: { ok: boolean } }>;
		} = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: typeof captured) => Object.assign(captured, d),
			on: () => {},
		};
		verifyRepoTool(fakePi as never);
		expect(captured.name).toBe("verify_repo");
		expect(typeof captured.execute).toBe("function");
		const dir = mkdtempSync(join(tmpdir(), "verify-int-"));
		temps.push(dir);
		const out = await captured.execute!("id", { path: dir }, undefined, undefined, { cwd: dir });
		expect(out.content[0]?.text).toContain("No supported verification workflow detected.");
		expect(out.details.ok).toBe(false);
	});
});
