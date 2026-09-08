import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goQualityTool, { runGoQuality } from "./go-quality-tool.ts";

test("missing project cannot report successful verification or repair", () => {
 const dir = mkdtempSync(join(tmpdir(), "go-quality-"));
 try {
  for (const mode of ["check", "fix"] as const) {
   const report = runGoQuality(mode, dir);
   expect(report.ok).toBe(false);
   expect(report.complete).toBe(false);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing requested tools and command failures cannot pass", () => {
 const dir = mkdtempSync(join(tmpdir(), "go-quality-"));
 try {
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(dir, "go.mod"), 'module example.test\n');
  const which = join(bin, "which");
  writeFileSync(which, '#!/bin/sh\n[ -x "' + bin + '/$1" ]\n'); chmodSync(which, 0o755);
  const invoke = () => {
   const source = `import goQualityTool, { runGoQuality } from ${JSON.stringify(import.meta.dir + "/go-quality-tool.ts")}; console.log(JSON.stringify(runGoQuality("check", ${JSON.stringify(dir)})));`;
   const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
   expect(proc.exitCode).toBe(0);
   return JSON.parse(proc.stdout.toString());
  };
  expect(invoke().ok).toBe(false);
  const tool = join(bin, "gofmt");
  writeFileSync(tool, "#!/bin/sh\nexit 0\n"); chmodSync(tool, 0o755);
  const partial = invoke();
  expect(partial.ok).toBe(false); expect(partial.complete).toBe(false);
  writeFileSync(tool, "#!/bin/sh\necho failure >&2\nexit 7\n");
  const failed = invoke();
  expect(failed.ok).toBe(false);
  expect(failed.steps.some((step: { status: string }) => step.status === "fail")).toBe(true);
 } finally { rmSync(dir, { recursive: true, force: true }); }
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
