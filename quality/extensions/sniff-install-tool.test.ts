import { describe, expect, test } from "bun:test";
import { runSniffInstall } from "./sniff-install-tool.ts";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



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

	test("prototype names are not bundle names", () => {
		for (const bundle of ["constructor", "toString", "__proto__"]) {
			expect(runSniffInstall({ mode: "install", bundles: [bundle] }).ok).toBe(false);
		}
	});

});

test("failed installer exits are not successful installation", () => {
	const dir = mkdtempSync(join(tmpdir(), "sniff-fake-"));
	try {
		symlinkSync("/bin/sh", join(dir, "sh"));
		const mise = join(dir, "mise");
		writeFileSync(mise, "#!/bin/sh\necho installation-failed >&2\nexit 7\n");
		chmodSync(mise, 0o755);
		const source = `import { runSniffInstall } from ${JSON.stringify(import.meta.dir + "/sniff-install-tool.ts")}; console.log(JSON.stringify(runSniffInstall({ mode: "install", bundles: ["core"], cwd: ${JSON.stringify(dir)} })));`;
		const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: dir }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
		expect(proc.exitCode).toBe(0);
		const result = JSON.parse(proc.stdout.toString());
		expect(result.ok).toBe(false);
		expect(result.report).toContain("exit 7");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

