import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("managed root traversal", () => {
	/** A journeys tree with one approved journey holding two runs. */
	const seed = (root: string) => {
		mkdirSync(join(root, "J1-approved", "runs"), { recursive: true });
		writeFileSync(join(root, "J1-approved", "journey.md"), "---\nid: J1\ntitle: t\n---\n\n### S1 — Open {#S1}\n");
		writeFileSync(join(root, "J1-approved", "runs", "2026-01-01.md"), "old\n");
		writeFileSync(join(root, "J1-approved", "runs", "2026-01-02.md"), "new\n");
	};
	const python = (args: string[]) =>
		Bun.spawnSync(["python3", join(import.meta.dir, "../skills/journey-init/scripts/journeys.py"), ...args],
			{ stdout: "pipe", stderr: "pipe", timeout: 10000 });

	test("a root traversing a symlink via .. is refused by both implementations", () => {
		// `/top/link/../managed` normalises LEXICALLY to `/top/managed` while the
		// filesystem resolves it through `link` to somewhere else entirely. Checking
		// the normalised form and operating on the resolved one inspects one tree and
		// writes to another; the Python port deleted runs in the outside tree.
		// The path is built by concatenation on purpose: `join()` would collapse `..`
		// before the code under test ever sees it, which is how this escaped review.
		const top = mkdtempSync(join(tmpdir(), "journeys-top-"));
		const outside = mkdtempSync(join(tmpdir(), "journeys-outside-"));
		try {
			mkdirSync(join(outside, "child"));
			mkdirSync(join(top, "managed"));
			mkdirSync(join(outside, "managed"));
			seed(join(top, "managed"));
			seed(join(outside, "managed"));
			symlinkSync(join(outside, "child"), join(top, "link"));
			const raw = `${top}/link/../managed`;

			expect(runJourneys({ command: "index", journeysDir: raw }).ok).toBe(false);
			expect(python(["index", raw]).exitCode).not.toBe(0);
			expect(existsSync(join(top, "managed", "INDEX.md"))).toBe(false);
			expect(existsSync(join(outside, "managed", "INDEX.md"))).toBe(false);

			// The destructive form: a prune through that root must delete nothing.
			const runs = () => readdirSync(join(outside, "managed", "J1-approved", "runs")).length;
			const before = runs();
			expect(python(["prune", raw, "--keep", "0", "--journey", "J1-approved", "--yes"]).exitCode).not.toBe(0);
			expect(runs()).toBe(before);
		} finally {
			rmSync(top, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("a symlink inside the tree is still refused, and a plain temp root still works", () => {
		// The narrowing must not cost the protection, and must not reintroduce the
		// macOS breakage: /var and /tmp are themselves symlinks, so a temp root has a
		// symlinked ancestor and used to be refused outright.
		const planted = mkdtempSync(join(tmpdir(), "journeys-inner-"));
		const plain = mkdtempSync(join(tmpdir(), "journeys-plain-"));
		try {
			seed(planted);
			symlinkSync("/etc/hosts", join(planted, "J1-approved", "runs", "2026-01-03.md"));
			expect(runJourneys({ command: "lint", journeysDir: planted }).text).toContain("unsafe symlink");
			expect(python(["lint", planted]).exitCode).not.toBe(0);

			seed(plain);
			expect(runJourneys({ command: "index", journeysDir: plain }).ok).toBe(true);
			expect(python(["index", plain]).exitCode).toBe(0);
		} finally {
			rmSync(planted, { recursive: true, force: true });
			rmSync(plain, { recursive: true, force: true });
		}
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

