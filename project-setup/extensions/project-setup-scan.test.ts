import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import projectSetupScan, { scanProject } from "./project-setup-scan.ts";

const temps: string[] = [];

afterAll(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function fakeZod(): { zod: unknown } {
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	chain.string = self;
	chain.optional = self;
	chain.describe = self;
	chain.object = self;
	return { zod: chain };
}

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

describe("scanProject", () => {
	test("empty dir is init with no markers", () => {
		const dir = scratch("ps-empty-");
		const r = scanProject(dir);
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("init");
		expect(r.git.present).toBe(false);
		expect(r.license.present).toBe(false);
		expect(r.ci.present).toBe(false);
		expect(r.gitignore.present).toBe(false);
		expect(r.packageManagers).toEqual([]);
		expect(r.existingModules).toEqual([]);
		expect(r.projectSetup.dir).toBe(false);
	});

	test("detects gitignore license ci package manager and reproduce mode", () => {
		const dir = scratch("ps-full-");
		writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
		writeFileSync(
			join(dir, "LICENSE"),
			"Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n",
		);
		writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", omp: { extensions: [] } }));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
		mkdirSync(join(dir, ".project-setup", "modules", "lang-python"), { recursive: true });
		writeFileSync(join(dir, ".project-setup", "modules", "lang-python", "module.toml"), "[meta]\n");
		writeFileSync(join(dir, ".project-setup", "sources.toml"), "[[source]]\n");
		writeFileSync(
			join(dir, ".project-setup", "answers.toml"),
			'[modules]\nenabled = ["lang-python", "git-init"]\n',
		);
		const r = scanProject(dir);
		expect(r.mode).toBe("reproduce");
		expect(r.gitignore.present).toBe(true);
		expect(r.license.present).toBe(true);
		expect(r.license.guessed).toBe("apache-2.0");
		expect(r.ci.present).toBe(true);
		expect(r.ci.workflows).toEqual(["ci.yml"]);
		expect(r.packageManagers).toContain("pnpm");
		expect(r.languages).toContain("typescript");
		expect(r.projectSetup.enabled).toEqual(["lang-python", "git-init"]);
		expect(r.existingModules.map((m) => m.id)).toEqual(["lang-python"]);
		expect(r.omp.linkedHint).toBe(true);
	});

	test("missing path stays ok false via execute", async () => {
		const captured: {
			name?: string;
			approval?: string;
			execute?: (
				id: string,
				params: { path?: string },
				signal: undefined,
				onUpdate: undefined,
				ctx: { cwd: string },
			) => Promise<{ content: Array<{ type: string; text: string }>; details: { ok: boolean } }>;
		} = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: typeof captured) => Object.assign(captured, d),
			on: () => {},
		};
		projectSetupScan(fakePi as never);
		expect(captured.name).toBe("project_setup_scan");
		expect(captured.approval).toBe("read");
		const missing = join(tmpdir(), "ps-missing-nope");
		const out = await captured.execute!("id", { path: missing }, undefined, undefined, {
			cwd: missing,
		});
		expect(out.details.ok).toBe(false);
		expect(out.content[0]?.text).toContain("not a directory");
	});
});

describe("project_setup_scan integration", () => {
	test("registers and scans empty cwd", async () => {
		const captured: {
			name?: string;
			execute?: (
				id: string,
				params: { path?: string },
				signal: undefined,
				onUpdate: undefined,
				ctx: { cwd: string },
			) => Promise<{ details: { ok: boolean; mode?: string } }>;
		} = {};
		const fakePi = {
			...fakeZod(),
			registerTool: (d: typeof captured) => Object.assign(captured, d),
			on: () => {},
		};
		projectSetupScan(fakePi as never);
		const dir = scratch("ps-int-");
		const out = await captured.execute!("id", { path: dir }, undefined, undefined, { cwd: dir });
		expect(out.details.ok).toBe(true);
		expect(out.details.mode).toBe("init");
	});
});
