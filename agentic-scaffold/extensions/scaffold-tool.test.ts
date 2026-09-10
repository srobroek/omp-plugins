import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScaffold, validateScaffoldArgs } from "./scaffold-tool.ts";

describe("scaffold argument boundary", () => {
	test("accepts the command and ordinary CLI arguments", () => {
		expect(validateScaffoldArgs("profiles", ["list"])).toBeNull();
		expect(validateScaffoldArgs("apply", ["--dry-run"])).toBeNull();
	});

	test("rejects unknown commands and non-string argument lists", () => {
		expect(validateScaffoldArgs("shell", [])).toContain("unknown scaffold command");
		expect(validateScaffoldArgs("apply", ["--root", "/tmp"])).toContain("reserved");
		expect(validateScaffoldArgs("apply", ["--cwd=/tmp"])).toContain("reserved");
	});

	test("rejects every path shape that can override the injected root", () => {
		for (const value of ["/etc/x", "~/x", "../x", "a/../b", "--root=/tmp", "--state", "-C/tmp", "a\0b", "a\nb"]) {
			expect(validateScaffoldArgs("apply", [value]), value).not.toBeNull();
		}
	});
});

describe("scaffold CLI execution", () => {
	test("injects the real session root and runs without a shell", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "scaffold-tool-"));
		let seen: { file: string; args: string[]; options: Record<string, unknown> } | undefined;
		const result = await runScaffold(cwd, "profiles", ["list"], undefined, async (file, args, options) => {
			seen = { file, args, options };
			return { stdout: JSON.stringify({ root: realpathSync(cwd) }), stderr: "" };
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.text).root).toBe(realpathSync(cwd));
		expect(seen?.file).toBe("python3");
		expect(seen?.args[1]).toBe("profiles");
		expect(seen?.args.slice(2, 4)).toEqual(["--root", cwd]);
		expect(seen?.options.shell).toBe(false);
		expect(seen?.options.timeout).toBe(600_000);
	});

	test("abort is reachable through the tool while a run marker exists", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "scaffold-tool-abort-"));
		Bun.spawnSync(["git", "init", "-q", cwd]);
		Bun.spawnSync(["mkdir", "-p", join(cwd, ".omp")]);
		await Bun.write(join(cwd, ".omp", "scaffold-run.json"), '{"stages": []}');
		const result = await runScaffold(cwd, "abort", []);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.text).hadRun).toBe(true);
		expect(await Bun.file(join(cwd, ".omp", "scaffold-run.json")).exists()).toBe(false);
	});

	test("runs the installed CLI path for an allowed command", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "scaffold-tool-real-"));
		const result = await runScaffold(cwd, "profiles", ["list"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.text).root).toBe(realpathSync(cwd));
	});

	test("discards CLI output when its root proof does not match", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "scaffold-tool-"));
		const result = await runScaffold(cwd, "doctor", [], undefined, async () => ({
			stdout: JSON.stringify({ root: "/tmp/other", ok: true }),
			stderr: "",
		}));
		expect(result.exitCode).toBe(6);
		expect(result.text).toContain("root mismatch");
	});

	test("surfaces a non-zero CLI exit code with its JSON", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "scaffold-tool-"));
		const result = await runScaffold(cwd, "doctor", [], undefined, async () => {
			throw { code: 2, stdout: JSON.stringify({ root: realpathSync(cwd), ok: false }), stderr: "drift" };
		});
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.text)).toEqual({ root: realpathSync(cwd), ok: false });
	});
});
