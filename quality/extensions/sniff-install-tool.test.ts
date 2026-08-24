import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sniffInstallTool, { runSniffInstall } from "./sniff-install-tool.ts";

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

describe("runSniffInstall", () => {
	test("list mode enumerates every bundle", () => {
		const result = runSniffInstall({ mode: "list" });
		expect(result.ok).toBe(true);
		for (const b of [
			"core",
			"dup",
			"security",
			"rust",
			"go",
			"python",
			"js-ts",
			"shell",
			"sql",
			"css",
			"data",
			"api",
			"infra",
			"docs",
		]) {
			expect(result.report).toContain(`[${b}]`);
		}
		expect(result.report).toContain("semgrep");
		expect(result.report).toContain("golangci-lint");
	});

	test(
		"probe mode reports ok/MISS/SHIM lines",
		() => {
			const result = runSniffInstall({ mode: "probe" });
			expect(result.ok).toBe(true);
			expect(result.report).toContain("sniff tool probe");
			expect(result.report).toMatch(/\bok\b|\bMISS\b|\bSHIM\b/);
		},
		30_000,
	);

	test("install without bundles fails", () => {
		const result = runSniffInstall({ mode: "install" });
		expect(result.ok).toBe(false);
		expect(result.report).toContain("at least one bundle");
	});

	test("unknown bundle fails", () => {
		const result = runSniffInstall({ mode: "install", bundles: ["nope"] });
		expect(result.ok).toBe(false);
		expect(result.report).toContain('unknown bundle "nope"');
	});

	test(
		"dry-run install core prints commands without requiring success",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "sniff-install-"));
			temps.push(dir);
			const result = runSniffInstall({
				mode: "install",
				bundles: ["core"],
				dryRun: true,
				noMise: true,
				cwd: dir,
			});
			expect(result.ok).toBe(true);
			expect(result.report).toContain("(dry run — no changes will be made)");
			expect(result.report).toContain("[core]");
		},
		20_000,
	);
});

describe("sniff_install_tools integration", () => {
	test("registers and execute list mode", async () => {
		const captured: {
			name?: string;
			execute?: (
				id: string,
				params: { mode?: string },
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
		sniffInstallTool(fakePi as never);
		expect(captured.name).toBe("sniff_install_tools");
		const dir = mkdtempSync(join(tmpdir(), "sniff-int-"));
		temps.push(dir);
		const out = await captured.execute!("id", { mode: "list" }, undefined, undefined, { cwd: dir });
		expect(out.details.ok).toBe(true);
		expect(out.content[0]?.text).toContain("[core]");
	});
});
