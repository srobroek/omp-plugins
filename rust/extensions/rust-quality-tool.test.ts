import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rustQualityTool, { runRustQuality } from "./rust-quality-tool.ts";

test("missing project cannot report successful verification or repair", () => {
 const dir = mkdtempSync(join(tmpdir(), "rust-quality-"));
 try {
  for (const mode of ["check", "fix"] as const) {
   const report = runRustQuality(mode, dir);
   expect(report.ok).toBe(false);
   expect(report.complete).toBe(false);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000); // shared probe budget caps availability cascades at 10s

test("missing requested tools and command failures cannot pass", () => {
 const dir = mkdtempSync(join(tmpdir(), "rust-quality-"));
 try {
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.0.0"\n');
  const which = join(bin, "which");
  writeFileSync(which, '#!/bin/sh\n[ -x "' + bin + '/$1" ]\n'); chmodSync(which, 0o755);
  const invoke = () => {
   const source = `import { runRustQuality } from ${JSON.stringify(import.meta.dir + "/rust-quality-tool.ts")}; console.log(JSON.stringify(runRustQuality("check", ${JSON.stringify(dir)})));`;
   const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
   expect(proc.exitCode).toBe(0);
   return JSON.parse(proc.stdout.toString());
  };
  expect(invoke().ok).toBe(false);
  const tool = join(bin, "cargo");
  writeFileSync(tool, "#!/bin/sh\nexit 0\n"); chmodSync(tool, 0o755);
  const partial = invoke();
  expect(partial.ok).toBe(true);
  // A real linter answers `--version` even when it reports findings, and the
		// runnability probe relies on exactly that distinction. A stub that failed
		// every argument would read as an uninstalled tool, which is a different
		// outcome from a tool that ran and found problems.
		writeFileSync(tool, '#!/bin/sh\ncase "$1" in --version) exit 0 ;; esac\necho failure >&2\nexit 7\n');
  const failed = invoke();
  expect(failed.ok).toBe(false);
  expect(failed.steps.some((step: { status: string }) => step.status === "fail")).toBe(true);
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000); // shared probe budget caps availability cascades at 10s

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
	const dir = mkdtempSync(join(tmpdir(), "rust-quality-cwd-"));
	try {
		mkdirSync(join(dir, "sub"));
		const captured: Record<string, unknown> = {};
		rustQualityTool({ ...fakeZod(), registerTool: (d: Record<string, unknown>) => Object.assign(captured, d), on: () => {} } as never);
		const execute = captured.execute as (
			id: string,
			params: { mode: "check" | "fix"; path?: string },
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
