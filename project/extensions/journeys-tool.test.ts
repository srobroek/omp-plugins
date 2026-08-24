import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import journeysTool, {
	cmdIndex,
	cmdLint,
	installFormulas,
	parseFrontmatter,
	runJourneys,
} from "./journeys-tool.ts";


// Structural stand-in for pi.zod: the module only builds a parameter schema with
// it (object/string/array/boolean chains); execute() receives already-parsed params.
const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

describe("parseFrontmatter", () => {
	test("parses scalars and lists", () => {
		const fm = parseFrontmatter("---\nid: J1\nsurfaces: [web, cli]\n---\nbody");
		expect(fm.id).toBe("J1");
		expect(fm.surfaces).toEqual(["web", "cli"]);
	});
	test("unterminated returns empty", () => {
		expect(parseFrontmatter("---\nid: J1\n")).toEqual({});
	});
});

describe("index/lint fixture", () => {
	test("empty dir lints and indexes", () => {
		const dir = mkdtempSync(join(tmpdir(), "journeys-"));
		const lint = cmdLint(dir);
		expect(lint.ok).toBe(true);
		expect(lint.text).toContain("0 journeys");
		const idx = cmdIndex(dir);
		expect(idx.count).toBe(0);
		expect(readFileSync(join(dir, "INDEX.md"), "utf8")).toContain("Journey index");
	});

	test("valid journey lints clean", () => {
		const dir = mkdtempSync(join(tmpdir(), "journeys-"));
		const jdir = join(dir, "J1-login");
		mkdirSync(jdir);
		writeFileSync(
			join(jdir, "journey.md"),
			`---
id: J1
title: Login
version: 1
status: draft
last_reviewed: 2026-01-01
surfaces: [web]
interfaces: [browser]
---

### S1 — Open app {#S1}
`,
		);
		const lint = runJourneys({ command: "lint", journeysDir: dir });
		expect(lint.ok).toBe(true);
		const idx = runJourneys({ command: "index", journeysDir: dir });
		expect(idx.text).toContain("1 journeys");
	});
});

describe("installFormulas", () => {
	test("refuses non-beads", () => {
		const dir = mkdtempSync(join(tmpdir(), "nobead-"));
		const r = installFormulas(dir);
		expect(r.ok).toBe(false);
		expect(r.text).toContain("not a Beads workspace");
	});

	test("copies formulas", () => {
		const src = mkdtempSync(join(tmpdir(), "forms-"));
		writeFileSync(join(src, "demo.formula.toml"), "name = 'demo'\n");
		const repo = mkdtempSync(join(tmpdir(), "repo-"));
		mkdirSync(join(repo, ".beads"));
		const r = installFormulas(repo, false, src);
		expect(r.ok).toBe(true);
		expect(r.copied).toBe(1);
		expect(existsSync(join(repo, ".beads", "formulas", "demo.formula.toml"))).toBe(true);
		const again = installFormulas(repo, false, src);
		expect(again.unchanged).toBe(1);
	});
});

describe("registerTool", () => {
	test("execute lint via fake pi", async () => {
		const captured: Record<string, unknown>[] = [];
		const fakePi = {
			zod: z,
			registerTool: (d: Record<string, unknown>) => {
				captured.push(d);
			},
			on: () => {},
		};
		journeysTool(fakePi as never);
		expect(captured.map((c) => c.name)).toEqual(["journeys_index", "journey_install_formulas"]);
		const lintTool = captured[0] as {
			execute: (
				id: string,
				p: Record<string, unknown>,
				a?: unknown,
				b?: unknown,
				c?: { cwd?: string },
			) => Promise<{ details: { ok: boolean } }>;
		};
		const dir = mkdtempSync(join(tmpdir(), "jex-"));
		const out = await lintTool.execute("id", { command: "lint", journeysDir: dir });
		expect(out.details.ok).toBe(true);
	});
});
