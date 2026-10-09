import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import typescriptQualityTool, { type QualityMode, type QualityReport, runTypescriptQuality } from "./typescript-quality-tool.ts";

/** Runs the report in a child whose PATH holds only `bin`, so host tools cannot leak in. */
function reportWithPath(dir: string, bin: string, mode: QualityMode): QualityReport {
	const source = `import { runTypescriptQuality } from ${JSON.stringify(join(import.meta.dir, "typescript-quality-tool.ts"))}; console.log(JSON.stringify(runTypescriptQuality(${JSON.stringify(mode)}, ${JSON.stringify(dir)})));`;
	const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	expect(proc.exitCode).toBe(0);
	return JSON.parse(proc.stdout.toString());
}

function writeScript(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

test("missing project cannot report successful verification or repair", () => {
 const dir = mkdtempSync(join(tmpdir(), "typescript-quality-"));
 try {
  for (const mode of ["check", "fix"] as const) {
   const report = runTypescriptQuality(mode, dir);
   expect(report.ok).toBe(false);
   expect(report.complete).toBe(false);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000); // shared probe budget caps availability cascades at 10s

test("missing requested tools and command failures cannot pass", () => {
 const dir = mkdtempSync(join(tmpdir(), "typescript-quality-"));
 try {
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(dir, "package.json"), '{}');
  const which = join(bin, "which");
  writeFileSync(which, '#!/bin/sh\n[ -x "' + bin + '/$1" ]\n'); chmodSync(which, 0o755);
  const invoke = () => reportWithPath(dir, bin, "check");
  const downloads = join(dir, "downloads");
  for (const name of ["pnpm", "bun", "bunx", "npx"]) {
   const runner = join(bin, name);
   writeFileSync(runner, `#!/bin/sh\necho invoked >> "${downloads}"\nexit 0\n`);
   chmodSync(runner, 0o755);
  }
  expect(invoke().ok).toBe(false);
  expect(existsSync(downloads)).toBe(false);
  const tool = join(bin, "biome");
  writeFileSync(tool, "#!/bin/sh\nexit 0\n"); chmodSync(tool, 0o755);
  const partial = invoke();
  expect(partial.ok).toBe(false); expect(partial.complete).toBe(false);
  // A real linter answers `--version` even when it reports findings, and the
		// runnability probe relies on exactly that distinction. A stub that failed
		// every argument would read as an uninstalled tool, which is a different
		// outcome from a tool that ran and found problems.
		writeFileSync(tool, '#!/bin/sh\ncase "$1" in --version) exit 0 ;; esac\necho failure >&2\nexit 7\n');
  const failed = invoke();
  expect(failed.ok).toBe(false);
  expect(failed.steps.some((step: { status: string }) => step.status === "fail")).toBe(true);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  for (const name of ["biome", "tsc"]) {
   const local = join(dir, "node_modules", ".bin", name);
   writeFileSync(local, "#!/bin/sh\nexit 0\n"); chmodSync(local, 0o755);
  }
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  expect(invoke().ok).toBe(true);
  expect(existsSync(downloads)).toBe(false);
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000); // shared probe budget caps availability cascades at 10s

test("a project-local ESLint wins over a Biome that is only on PATH", () => {
	// A PATH Biome running `check --write` on an ESLint project rewrites files
	// under rules the project never chose.
	const dir = mkdtempSync(join(tmpdir(), "typescript-quality-eslint-"));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "eslint.config.js"), "export default [];\n");
		writeScript(join(bin, "biome"), `case "$1" in --version) exit 0 ;; esac\necho ran > "${dir}/biome-ran"`);
		writeScript(join(dir, "node_modules", ".bin", "eslint"), `echo ran > "${dir}/eslint-ran"`);
		const report = reportWithPath(dir, bin, "fix");
		expect(report.steps).toEqual([{ name: "eslint", status: "pass", detail: "" }]);
		expect(existsSync(join(dir, "eslint-ran"))).toBe(true);
		expect(existsSync(join(dir, "biome-ran"))).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000); // shared probe budget caps availability cascades at 10s

test("tsc without a tsconfig.json is a skip, not a failure", () => {
	// With no tsconfig.json, `tsc --noEmit` prints its help and exits 1: a JS
	// project would report a type-check failure for code it has none of.
	const dir = mkdtempSync(join(tmpdir(), "typescript-quality-notsconfig-"));
	try {
		const local = join(dir, "node_modules", ".bin");
		mkdirSync(local, { recursive: true });
		writeFileSync(join(dir, "package.json"), "{}");
		writeScript(join(local, "biome"), "exit 0");
		writeScript(join(local, "tsc"), "echo 'COMMON COMMANDS'\nexit 1");
		const report = runTypescriptQuality("check", dir);
		expect(report.steps.find((s) => s.name === "tsc --noEmit")).toEqual({ name: "tsc --noEmit", status: "skip", detail: "no tsconfig.json" });
		expect(report.steps.some((s) => s.status === "fail")).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

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

test("a relative path resolves against the session cwd", async () => {
	const dir = mkdtempSync(join(tmpdir(), "typescript-quality-cwd-"));
	try {
		mkdirSync(join(dir, "sub"));
		const captured: Record<string, unknown> = {};
		typescriptQualityTool({ ...fakeZod(), registerTool: (d: Record<string, unknown>) => Object.assign(captured, d), on: () => {} } as never);
		const execute = captured.execute as (
			id: string,
			params: { mode: QualityMode; path?: string },
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<{ details: { cwd: string; error?: string } }>;
		const result = await execute("t1", { mode: "check", path: "sub" }, undefined, undefined, { cwd: dir });
		expect(result.details.error).toBeUndefined();
		expect(result.details.cwd).toBe(join(dir, "sub"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
