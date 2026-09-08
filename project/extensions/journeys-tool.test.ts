import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	cmdLint,
	installFormulas,
	parseFrontmatter,
	runJourneys,
} from "./journeys-tool.ts";



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

	test("structurally valid journey lints without assessing readiness", () => {
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
		for (const name of ["journey-step-agentic-verification", "journey-step-human-verification"]) {
			writeFileSync(join(src, `${name}.formula.toml`), `formula = '${name}'\n`);
		}
		const repo = mkdtempSync(join(tmpdir(), "repo-"));
		mkdirSync(join(repo, ".beads"));
		const r = installFormulas(repo, false, src);
		expect(r.ok).toBe(true);
		expect(r.copied).toBe(2);
		expect(readFileSync(join(repo, ".beads", "formulas", "journey-step-agentic-verification.formula.toml"), "utf8"))
			.toBe("formula = 'journey-step-agentic-verification'\n");
		const again = installFormulas(repo, false, src);
		expect(again.unchanged).toBe(2);
	});
});

test.each(["native", "python"] as const)("pruning %s preserves unapproved journeys and rejects unknown selections", (implementation) => {
	const root = mkdtempSync(join(tmpdir(), "journeys-scope-"));
	try {
		for (const name of ["J1-approved", "J2-unapproved"]) {
			const dir = join(root, name);
			mkdirSync(join(dir, "runs"), { recursive: true });
			writeFileSync(join(dir, "journey.md"), `---\nid: ${name.split("-")[0]}\n---\n`);
			writeFileSync(join(dir, "runs", "2026-01-01.md"), "old");
			writeFileSync(join(dir, "runs", "2026-01-02.md"), "new");
		}
		const prune = (journey: string, yes: boolean): boolean => {
			if (implementation === "native") {
				return runJourneys({ command: "prune", journeysDir: root, keep: 1, journey, yes }).ok;
			}
			return Bun.spawnSync(["python3", join(import.meta.dir, "../skills/journey-init/scripts/journeys.py"),
				"prune", root, "--keep", "1", "--journey", journey, ...(yes ? ["--yes"] : [])],
				{ stdout: "pipe", stderr: "pipe", timeout: 10000 }).exitCode === 0;
		};
		const runs = (name: string) => readdirSync(join(root, name, "runs")).sort();
		expect(prune("../J2-unapproved", true)).toBe(false);
		expect(prune("J1-approved", false)).toBe(true);
		expect(runs("J1-approved")).toEqual(["2026-01-01.md", "2026-01-02.md"]);
		expect(prune("J1-approved", true)).toBe(true);
		expect(runs("J1-approved")).toEqual(["2026-01-02.md"]);
		expect(runs("J2-unapproved")).toEqual(["2026-01-01.md", "2026-01-02.md"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

