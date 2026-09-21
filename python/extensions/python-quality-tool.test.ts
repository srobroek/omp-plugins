import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPythonQuality } from "./python-quality-tool.ts";

test("missing project cannot report successful verification or repair", () => {
 const dir = mkdtempSync(join(tmpdir(), "python-quality-"));
 try {
  for (const mode of ["check", "fix"] as const) {
   const report = runPythonQuality(mode, dir);
   expect(report.ok).toBe(false);
   expect(report.complete).toBe(false);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing requested tools and command failures cannot pass", () => {
 const dir = mkdtempSync(join(tmpdir(), "python-quality-"));
 try {
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="fixture"\n');
  const which = join(bin, "which");
  writeFileSync(which, '#!/bin/sh\n[ -x "' + bin + '/$1" ]\n'); chmodSync(which, 0o755);
  const invoke = () => {
   const source = `import { runPythonQuality } from ${JSON.stringify(import.meta.dir + "/python-quality-tool.ts")}; console.log(JSON.stringify(runPythonQuality("check", ${JSON.stringify(dir)})));`;
   const proc = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
   expect(proc.exitCode).toBe(0);
   return JSON.parse(proc.stdout.toString());
  };
  expect(invoke().ok).toBe(false);
  const tool = join(bin, "ruff");
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
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
		const which = join(bin, "which");
		writeFileSync(which, `#!/bin/sh\n[ -x "${bin}/$1" ]\n`);
		chmodSync(which, 0o755);

		// Resolvable and executable, but fails whatever it is asked -- exactly a
		// shim for an uninstalled tool.
		const shim = join(bin, "ruff");
		writeFileSync(shim, '#!/bin/sh\necho "ERROR No version is set for shim: ruff" >&2\nexit 1\n');
		chmodSync(shim, 0o755);

		const source = `import { runPythonQuality } from ${JSON.stringify(import.meta.dir + "/python-quality-tool.ts")}; console.log(JSON.stringify(runPythonQuality("check", ${JSON.stringify(dir)})));`;
		const proc = Bun.spawnSync([process.execPath, "-e", source], {
			env: { ...process.env, PATH: bin },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10000,
		});
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(proc.stdout.toString());

		expect(report.ok).toBe(false);
		// Incomplete, because a tool is missing...
		expect(report.complete).toBe(false);
		// ...and NOT a failure, which would assert findings the analyzer never made.
		expect(report.steps.some((step: { status: string }) => step.status === "fail")).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
