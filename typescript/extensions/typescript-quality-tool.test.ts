import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTypescriptQuality } from "./typescript-quality-tool.ts";

test("missing project cannot report successful verification or repair", () => {
 const dir = mkdtempSync(join(tmpdir(), "typescript-quality-"));
 try {
  for (const mode of ["check", "fix"] as const) {
   const report = runTypescriptQuality(mode, dir);
   expect(report.ok).toBe(false);
   expect(report.complete).toBe(false);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing requested tools and command failures cannot pass", () => {
 const dir = mkdtempSync(join(tmpdir(), "typescript-quality-"));
 try {
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(dir, "package.json"), '{}');
  const which = join(bin, "which");
  writeFileSync(which, '#!/bin/sh\n[ -x "' + bin + '/$1" ]\n'); chmodSync(which, 0o755);
  const invoke = () => {
   const source = `import { runTypescriptQuality } from ${JSON.stringify(import.meta.dir + "/typescript-quality-tool.ts")}; console.log(JSON.stringify(runTypescriptQuality("check", ${JSON.stringify(dir)})));`;
   const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
   expect(proc.exitCode).toBe(0);
   return JSON.parse(proc.stdout.toString());
  };
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
  writeFileSync(tool, "#!/bin/sh\necho failure >&2\nexit 7\n");
  const failed = invoke();
  expect(failed.ok).toBe(false);
  expect(failed.steps.some((step: { status: string }) => step.status === "fail")).toBe(true);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  for (const name of ["biome", "tsc"]) {
   const local = join(dir, "node_modules", ".bin", name);
   writeFileSync(local, "#!/bin/sh\nexit 0\n"); chmodSync(local, 0o755);
  }
  expect(invoke().ok).toBe(true);
  expect(existsSync(downloads)).toBe(false);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
