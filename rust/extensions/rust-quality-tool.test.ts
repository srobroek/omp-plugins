import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rustQualityTool, { runRustQuality } from "./rust-quality-tool.ts";

test("missing project cannot report successful verification or repair", async () => {
 const dir = mkdtempSync(join(tmpdir(), "rust-quality-"));
 try {
  for (const mode of ["check", "fix"] as const) {
   const report = await runRustQuality(mode, dir);
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
   const source = `import { runRustQuality } from ${JSON.stringify(import.meta.dir + "/rust-quality-tool.ts")}; console.log(JSON.stringify(await runRustQuality("check", ${JSON.stringify(dir)})));`;
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

type Step = { name: string; status: string; detail: string };

/**
 * A Cargo.toml project whose `cargo` is a stub on a PATH holding nothing else, so host
 * tools cannot leak in. The stub answers the probe, hangs on clippy, and passes the rest.
 */
function hangingClippyProject(prefix: string): { dir: string; bin: string } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.0.0"\n');
	writeFileSync(join(bin, "cargo"), '#!/bin/sh\ncase "$1" in clippy) exec /bin/sleep 30 ;; esac\nexit 0\n');
	chmodSync(join(bin, "cargo"), 0o755);
	return { dir, bin };
}

/** Runs `body` as a module in a child bun whose PATH is `bin` and prints what it logs as JSON. */
function inChild<T>(bin: string, body: string): T {
	// A child that outlives its own bound has hit the 25 s budget this suite exists to reject.
	const proc = Bun.spawnSync([process.execPath, "-e", body], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
	expect(proc.exitCode).toBe(0);
	return JSON.parse(proc.stdout.toString());
}

const toolModule = JSON.stringify(join(import.meta.dir, "rust-quality-tool.ts"));

test("a step that times out is a skip, and the steps after it still run", () => {
	// A cold `cargo clippy` outlasts a 25 s budget, which used to report a FAIL clippy
	// never made and fail every later step without running it.
	const { dir, bin } = hangingClippyProject("rust-quality-timeout-");
	try {
		const report = inChild<{ complete: boolean; steps: Step[] }>(
			bin,
			`import { runRustQuality } from ${toolModule}; console.log(JSON.stringify(await runRustQuality("check", ${JSON.stringify(dir)}, { timeoutMs: 3_000 })));`,
		);
		expect(report.steps.find((s) => s.name === "cargo clippy")?.status).toBe("skip");
		expect(report.steps.find((s) => s.name === "cargo clippy")?.detail).toContain("timed out");
		expect(report.steps.find((s) => s.name === "cargo test")?.status).toBe("pass");
		expect(report.steps.some((s) => s.status === "fail")).toBe(false);
		expect(report.complete).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("the abort signal stops the running step and nothing after it runs", () => {
	const { dir, bin } = hangingClippyProject("rust-quality-abort-");
	try {
		// This timer can only fire while a step runs if the run does not block the event loop.
		// macOS spends about 400 ms on a freshly written script's first exec, so the margins sit well above that.
		const body = `import tool from ${toolModule};
const z = {}; for (const k of ["string", "optional", "describe", "object", "enum"]) z[k] = () => z;
let execute; tool({ zod: z, registerTool: (d) => { execute = d.execute; }, on: () => {} });
const controller = new AbortController(); setTimeout(() => controller.abort(), 2_000);
const started = Date.now();
const { details } = await execute("t2", { mode: "check" }, controller.signal, undefined, { cwd: ${JSON.stringify(dir)} });
console.log(JSON.stringify({ elapsed: Date.now() - started, details }));`;
		const { elapsed, details } = inChild<{ elapsed: number; details: { ok: boolean; complete: boolean; steps: Step[] } }>(bin, body);
		expect(elapsed).toBeLessThan(10_000);
		expect(details.steps).toEqual([
			{ name: "cargo fmt --check", status: "pass", detail: "" },
			{ name: "cargo clippy", status: "skip", detail: "cancelled" },
			{ name: "cargo test", status: "skip", detail: "not run: cancelled" },
		]);
		expect(details.ok).toBe(false);
		expect(details.complete).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
