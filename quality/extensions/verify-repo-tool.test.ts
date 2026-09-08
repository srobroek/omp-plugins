import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runVerify } from "./verify-repo-tool.ts";

const temps: string[] = [];

afterAll(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});


describe("runVerify", () => {
	test("empty dir reports no workflow", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-repo-"));
		temps.push(dir);
		const result = runVerify(dir);
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.ran).toBe(0);
		expect(result.complete).toBe(false);
	});

	test("Makefile without verify target is not a workflow", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-make-"));
		temps.push(dir);
		writeFileSync(join(dir, "Makefile"), "all:\n\techo hi\n");
		const result = runVerify(dir);
		expect(result.ran).toBe(0);
		expect(result.ok).toBe(false);
	});

	test("package.json without scripts reports no ran checks", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-pkg-"));
		temps.push(dir);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
		const result = runVerify(dir);
		expect(result.ok).toBe(false);
		expect(result.ran).toBe(0);
	});
});

test("failed discovery and missing prerequisites remain failures with bounded output", () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-fake-"));
	temps.push(dir);
	symlinkSync("/bin/sh", join(dir, "sh"));
	const just = join(dir, "just");
	writeFileSync(join(dir, "justfile"), "verify:\n true\n");
	writeFileSync(just, '#!/bin/sh\n[ "$1" = "--list" ] && { echo " verify"; exit 9; }; exit 0\n');
	chmodSync(just, 0o755);
	const invoke = () => {
		const source = `import { runVerify } from ${JSON.stringify(import.meta.dir + "/verify-repo-tool.ts")}; console.log(JSON.stringify(runVerify(${JSON.stringify(dir)})));`;
		const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: dir }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
		expect(proc.exitCode).toBe(0);
		return JSON.parse(proc.stdout.toString());
	};
	expect(invoke().failed).toBe(1);
	writeFileSync(just, '#!/bin/sh\n[ "$1" = "--list" ] && { echo " verify"; exit 0; }; exit 0\n');
	writeFileSync(join(dir, "Cargo.toml"), "");
	const partial = invoke();
	expect(partial.ok).toBe(false);
	expect(partial.complete).toBe(false);
	writeFileSync(just, '#!/bin/sh\n[ "$1" = "--list" ] && { echo " verify"; exit 0; }; i=0; while [ "$i" -lt 5000 ]; do echo noisy-failure-output; i=$((i+1)); done; exit 8\n');
	const failed = invoke();
	expect(failed.ok).toBe(false);
	expect(failed.failed).toBe(1);
	expect(failed.report.length).toBeLessThan(40000);
});

test.each(["absolute", "relative", "session-relative"])("project Python tools win without activation: %s path", (mode) => {
	const dir = mkdtempSync(join(tmpdir(), "verify-python-"));
	temps.push(dir);
	const local = join(dir, ".venv", "bin");
	const path = join(dir, "path");
	mkdirSync(local, { recursive: true });
	mkdirSync(path);
	symlinkSync("/bin/sh", join(path, "sh"));
	writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'probe'\nversion = '0.0.0'\n");
	for (const bin of ["ruff", "pyright", "pytest"]) {
		writeFileSync(join(local, bin), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		writeFileSync(join(path, bin), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
	}
	const target = mode === "absolute" ? dir : basename(dir);
	const source = mode === "session-relative"
		? `import register from ${JSON.stringify(import.meta.dir + "/verify-repo-tool.ts")};
			const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain });
			let tool; register({ zod: chain, registerTool: value => tool = value });
			const result = await tool.execute("probe", { path: ${JSON.stringify(target)} }, undefined, undefined, { cwd: ${JSON.stringify(dirname(dir))} });
			console.log(JSON.stringify(result.details));`
		: `import { runVerify } from ${JSON.stringify(import.meta.dir + "/verify-repo-tool.ts")}; console.log(JSON.stringify(runVerify(${JSON.stringify(target)})));`;
	const invoke = () => {
		const proc = Bun.spawnSync([process.execPath, "-e", source], {
			cwd: mode === "session-relative" ? "/" : dirname(dir),
			env: { ...process.env, PATH: path }, stdout: "pipe", stderr: "pipe", timeout: 10000,
		});
		expect(proc.exitCode).toBe(0);
		return JSON.parse(proc.stdout.toString());
	};
	const passed = invoke();
	expect(passed.ok).toBe(true);
	expect(passed.complete).toBe(true);
	writeFileSync(join(local, "pytest"), "#!/bin/sh\nexit 23\n", { mode: 0o755 });
	const failed = invoke();
	expect(failed.ok).toBe(false);
	expect(failed.failed).toBe(1);
});

