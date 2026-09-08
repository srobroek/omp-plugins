import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBump, checkNodeVersion, detectProject } from "./lib";

test("malformed Python collections do not hide valid declarations or crash detection", async () => {
	const root = mkdtempSync(join(tmpdir(), "dep-shape-"));
	try {
		writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = 42\n[project.optional-dependencies]\nbad = false\ngood = ["requests==2.0.0"]\n[dependency-groups]\nbad = 1\ngood = ["pytest==8.0.0"]\n');
		writeFileSync(join(root, "package.json"), '{"dependencies":{"constructor":"1.0.0","__proto__":"2.0.0"},"devDependencies":["invalid"]}');
		const result = await detectProject(root);
		expect(result.rows).toEqual([["npm", "constructor", "1.0.0"], ["npm", "__proto__", "2.0.0"], ["pypi", "requests", "==2.0.0"], ["pypi", "pytest", "==8.0.0"]]);
		expect(await checkNodeVersion(root, "constructor", "1.0.0")).toBe(true);
		expect(await checkNodeVersion(root, "toString", "1.0.0")).toBe(false);
		expect(result.stderr).toContain("Unscanned:");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply rejects options, honors cancellation, bounds children/output, and pins scoped npm operands", async () => {
	const root = mkdtempSync(join(tmpdir(), "dep-apply-safe-"));
	const oldPath = process.env.PATH;
	// Real processes and inherited pipes require the platform clock, not fake JS timers.
	const oldPm = process.env.DEP_UPDATE_PKG_MANAGER;
	const marker = join(root, "spawned");
	const stub = join(root, "pnpm");
	const installStub = (body: string) => {
		writeFileSync(stub, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n${body}\n`);
		chmodSync(stub, 0o755);
	};
	try {
		process.env.PATH = root;
		process.env.DEP_UPDATE_PKG_MANAGER = "pnpm";
		installStub("setInterval(() => {}, 1000);");
		for (const [ecosystem, name, version] of [["npm", "--help", "1.0.0"], ["npm", "x", "--recursive"], ["pypi", "-r", "1.0.0"], ["npm", "x", "file:/tmp/x"]]) {
			expect((await applyBump(ecosystem, name, version, root)).exit).toBe(2);
		}
		const cancelled = new AbortController(); cancelled.abort();
		expect((await applyBump("npm", "x", "1.0.0", root, { signal: cancelled.signal })).exit).toBe(1);
		expect(existsSync(marker)).toBe(false);

		const timed = await applyBump("npm", "x", "1.0.0", root, { timeoutMs: 100 });
		expect(timed.exit).toBe(1);
		expect(timed.text).toContain("deadline exceeded");
		expect(timed.text).toContain("partial");

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 100);
		try {
			const aborted = await applyBump("npm", "x", "1.0.0", root, { signal: controller.signal });
			expect(aborted.exit).toBe(1);
			expect(aborted.text).toContain("Cancelled");
		} finally { clearTimeout(timer); }

		installStub("process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000);");
		const loud = await applyBump("npm", "x", "1.0.0", root, { maxOutputBytes: 512 });
		expect(loud.exit).toBe(1);
		expect(loud.text).toContain("output limit exceeded");
		expect(loud.text.length).toBeLessThan(1500);

		installStub(`writeFileSync('package.json', JSON.stringify({dependencies:{'@scope/pkg':'1.2.3'}}));`);
		const success = await applyBump("npm", "@scope/pkg", "1.2.3", root);
		expect(success.exit).toBe(0);
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["update", "@scope/pkg@1.2.3"]);
	} finally {
		if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
		if (oldPm === undefined) delete process.env.DEP_UPDATE_PKG_MANAGER; else process.env.DEP_UPDATE_PKG_MANAGER = oldPm;
		rmSync(root, { recursive: true, force: true });
	}
}, 10000);
