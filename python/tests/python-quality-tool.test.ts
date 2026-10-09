import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as quality from "../extensions/python-quality-tool.ts";
import { COMMAND_TIMEOUT_MS } from "../extensions/quality-runner.ts";

const toolModule = join(import.meta.dir, "..", "extensions", "python-quality-tool.ts");

type Step = { name: string; status: string; detail: string };
type Report = { ok: boolean; complete: boolean; cwd: string; steps: Step[] };
type Execute = (
	id: string,
	params: { mode: "check" | "fix"; path?: string },
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: { cwd: string },
) => Promise<{ details: Report & { error?: string } }>;

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

function registeredExecute(): Execute {
	const captured: Record<string, unknown> = {};
	quality.default({ ...fakeZod(), registerTool: (d: Record<string, unknown>) => Object.assign(captured, d), on: () => {} } as never);
	return captured.execute as Execute;
}

/** A pyproject.toml project whose ruff, pyright and pytest are `.venv/bin` stubs, so no PATH probe runs. */
function venvProject(prefix: string, scripts: { ruff?: string; pyright?: string; pytest?: string }): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="fixture"\n');
	const bin = join(dir, ".venv", "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of ["ruff", "pyright", "pytest"] as const) {
		const path = join(bin, name);
		writeFileSync(path, scripts[name] ?? "#!/bin/sh\nexit 0\n");
		chmodSync(path, 0o755);
	}
	return dir;
}

function step(report: Report, name: string): Step | undefined {
	return report.steps.find((s) => s.name === name);
}

/** Runs the report in a child whose PATH holds only `bin`, so host tools cannot leak in. */
function checkWithPath(dir: string, bin: string): Report {
	const source = `import { runPythonQuality } from ${JSON.stringify(toolModule)}; console.log(JSON.stringify(await runPythonQuality("check", ${JSON.stringify(dir)})));`;
	const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	expect(proc.exitCode).toBe(0);
	return JSON.parse(proc.stdout.toString());
}

test("missing project cannot report successful verification or repair", async () => {
	const dir = mkdtempSync(join(tmpdir(), "python-quality-"));
	try {
		for (const mode of ["check", "fix"] as const) {
			const report = await quality.runPythonQuality(mode, dir);
			expect(report.ok).toBe(false);
			expect(report.complete).toBe(false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000); // shared probe budget caps availability cascades at 10s

test("missing requested tools and command failures cannot pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "python-quality-"));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="fixture"\n');
		expect(checkWithPath(dir, bin).ok).toBe(false);
		const tool = join(bin, "ruff");
		writeFileSync(tool, "#!/bin/sh\nexit 0\n");
		chmodSync(tool, 0o755);
		const partial = checkWithPath(dir, bin);
		expect(partial.ok).toBe(false);
		expect(partial.complete).toBe(false);
		// A real linter answers `--version` even when it reports findings, and the
		// runnability probe relies on exactly that distinction. A stub that failed
		// every argument would read as an uninstalled tool, which is a different
		// outcome from a tool that ran and found problems.
		writeFileSync(tool, '#!/bin/sh\ncase "$1" in --version) exit 0 ;; esac\necho failure >&2\nexit 7\n');
		const failed = checkWithPath(dir, bin);
		expect(failed.ok).toBe(false);
		expect(failed.steps.some((s) => s.status === "fail")).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000); // shared probe budget caps availability cascades at 10s

test("a shim that resolves but cannot run counts as absent, not as a failure", () => {
	// mise puts a shim on PATH for every tool it knows, installed or not. A
	// resolve-only presence check therefore reported the tool present, the step
	// failed when it executed, and the report recorded an analyzer FAILURE where
	// the truth was a missing tool -- implying code problems that did not exist.
	// Measured on one machine: mypy, pylint and vulture all resolved and all
	// failed with `mise ERROR No version is set for shim`.
	const dir = mkdtempSync(join(tmpdir(), "python-quality-shim-"));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="fixture"\n');

		// Resolvable and executable, but fails whatever it is asked -- exactly a
		// shim for an uninstalled tool.
		const shim = join(bin, "ruff");
		writeFileSync(shim, '#!/bin/sh\necho "ERROR No version is set for shim: ruff" >&2\nexit 1\n');
		chmodSync(shim, 0o755);

		const report = checkWithPath(dir, bin);
		expect(report.ok).toBe(false);
		// Incomplete, because a tool is missing...
		expect(report.complete).toBe(false);
		// ...and NOT a failure, which would assert findings the analyzer never made.
		expect(report.steps.some((s) => s.status === "fail")).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000); // shared probe budget caps availability cascades at 10s

test("a probe that times out reports the timeout, not a binary absent from PATH", () => {
	// A hung probe says nothing about whether the binary exists, so reading it as
	// `not on PATH` sent the user hunting for an install that was already there.
	const dir = mkdtempSync(join(tmpdir(), "python-quality-hang-"));
	try {
		const hang = join(dir, "ruff");
		writeFileSync(hang, "#!/bin/sh\nexec /bin/sleep 30\n");
		chmodSync(hang, 0o755);
		// A child bun, because Bun resolves PATH at startup; the 1 s deadline is the injected probe bound.
		const runner = join(import.meta.dir, "..", "extensions", "quality-runner.ts");
		const source = `import { unavailable } from ${JSON.stringify(runner)}; console.log(JSON.stringify([await unavailable("ruff", Date.now() + 1_000), await unavailable("pyright", Date.now() + 1_000)]));`;
		const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: dir }, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
		expect(proc.stderr.toString()).toBe("");
		const [ruff, pyright] = JSON.parse(proc.stdout.toString());
		expect(ruff).toMatch(/^ruff probe timed out after [\d.]+ s$/);
		expect(pyright).toBe("pyright not on PATH");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("pytest collecting no tests is a skip, not a failure", async () => {
	// pytest exits 5 when it collects nothing, which every project without tests
	// does. Reporting that as FAIL claims a finding the code does not have.
	const dir = venvProject("python-quality-notests-", { pytest: "#!/bin/sh\necho 'no tests ran' >&2\nexit 5\n" });
	try {
		const report = await quality.runPythonQuality("check", dir);
		expect(step(report, "pytest")).toEqual({ name: "pytest", status: "skip", detail: "no tests collected" });
		expect(report.steps.some((s) => s.status === "fail")).toBe(false);
		expect(report.complete).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a step that times out is a skip, and the steps after it still run", async () => {
	// pyright alone took more than 120 s on one real project, so the default
	// per-command bound has to outlast that.
	expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(120_000);
	const dir = venvProject("python-quality-timeout-", { pyright: "#!/bin/sh\nexec sleep 30\n" });
	try {
		// macOS spends about 400 ms on a freshly written script's first exec, so the bound sits well above that.
		const report = await quality.runPythonQuality("check", dir, { timeoutMs: 3_000 });
		expect(step(report, "pyright")?.status).toBe("skip");
		expect(step(report, "pyright")?.detail).toContain("timed out");
		expect(step(report, "pytest")?.status).toBe("pass");
		expect(report.steps.some((s) => s.status === "fail")).toBe(false);
		expect(report.complete).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("the abort signal stops the running step and nothing after it runs", async () => {
	const dir = venvProject("python-quality-abort-", { pyright: "#!/bin/sh\nexec sleep 30\n" });
	try {
		const controller = new AbortController();
		// This timer can only fire while a step runs if the run does not block the event loop.
		// macOS spends about 400 ms on a freshly written script's first exec, so the margin sits well above that.
		setTimeout(() => controller.abort(), 2_000);
		const started = Date.now();
		const result = await registeredExecute()("t1", { mode: "check" }, controller.signal, undefined, { cwd: dir });
		expect(Date.now() - started).toBeLessThan(10_000);
		const report = result.details;
		expect(step(report, "ruff check")?.status).toBe("pass");
		expect(step(report, "pyright")).toEqual({ name: "pyright", status: "skip", detail: "cancelled" });
		expect(step(report, "pytest")).toEqual({ name: "pytest", status: "skip", detail: "not run: cancelled" });
		expect(report.ok).toBe(false);
		expect(report.complete).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("a relative path resolves against the session cwd", async () => {
	const dir = mkdtempSync(join(tmpdir(), "python-quality-cwd-"));
	try {
		mkdirSync(join(dir, "sub"));
		const result = await registeredExecute()("t2", { mode: "check", path: "sub" }, undefined, undefined, { cwd: dir });
		expect(result.details.error).toBeUndefined();
		expect(result.details.cwd).toBe(join(dir, "sub"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
