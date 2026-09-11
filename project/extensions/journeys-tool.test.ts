import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	cmdIndex,
	frontmatterIsUnterminated,
	installFormulas,
	lintJourney,
	parseFrontmatter,
	runJourneys,
} from "./journeys-tool.ts";



describe("parseFrontmatter", () => {
	test("parses scalars and lists", () => {
		const fm = parseFrontmatter("---\nid: J1\nsurfaces: [web, cli]\n---\nbody");
		expect(fm?.id).toBe("J1");
		expect(fm?.surfaces).toEqual(["web", "cli"]);
	});
	test("absent and unterminated are both unreadable, and stay distinguishable", () => {
		// null for either, so no caller mistakes a truncated file for an empty one.
		expect(parseFrontmatter("---\nid: J1\n")).toBeNull();
		expect(parseFrontmatter("no frontmatter here\n")).toBeNull();
		// Only a truncated block means fields were present and discarded. A file that
		// declared nothing lost nothing, and callers must keep treating it differently.
		expect(frontmatterIsUnterminated("---\nid: J1\n")).toBe(true);
		expect(frontmatterIsUnterminated("no frontmatter here\n")).toBe(false);
	});
	test("a block that terminated empty is readable, and empty", () => {
		expect(parseFrontmatter("---\n---\n")).toEqual({});
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

	test("a root that is itself a symlink is accepted, and operated on where it resolves", () => {
		// A deliberate contract change, recorded rather than left implicit: the guard
		// used to refuse this, and now resolves it. A root the user names IS the root,
		// and `~/journeys -> /data/journeys` is an ordinary layout -- refusing it is the
		// same class of breakage as refusing every /var temp directory. Safety does not
		// rest on this: the checked tree and the written tree are the same one after
		// resolution, symlinks INSIDE the tree are still refused (above), and traversal
		// through a link is refused by the `..` rule (above).
		const real = mkdtempSync(join(tmpdir(), "journeys-real-"));
		const link = `${real}-link`;
		try {
			seed(real);
			symlinkSync(real, link);
			expect(runJourneys({ command: "index", journeysDir: link }).ok).toBe(true);
			expect(python(["index", link]).exitCode).toBe(0);
			// The write lands in the resolved directory, not beside the link.
			expect(existsSync(join(real, "INDEX.md"))).toBe(true);
		} finally {
			rmSync(link, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});

	test("an ordinary entry beginning with .. is inside the root, in both implementations", () => {
		// `inside.startsWith("..")` rejected `..metadata` as an escape. The check is
		// component-aware now; Python's relative_to always was, so this pins the pair
		// together against that divergence returning.
		const root = mkdtempSync(join(tmpdir(), "journeys-dotdot-"));
		try {
			seed(root);
			mkdirSync(join(root, "..metadata"));
			const ts = runJourneys({ command: "index", journeysDir: root });
			const py = python(["index", root]);
			expect(ts.ok).toBe(true);
			expect(py.exitCode).toBe(0);
			expect(ts.text).not.toContain("outside the managed root");
		} finally {
			rmSync(root, { recursive: true, force: true });
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


describe("defects ported from journeys.py (omp-plugins-jh0)", () => {
	const mkroot = () => mkdtempSync(join(tmpdir(), "jh0-"));
	const journey = (root: string, name: string, body: string) => {
		mkdirSync(join(root, name), { recursive: true });
		writeFileSync(join(root, name, "journey.md"), body, "utf8");
		return join(root, name);
	};
	const FULL = "---\nid: J1\ntitle: alpha\nstatus: active\nversion: 1\nlast_reviewed: 2026-01-01\n---\n";

	test("journeys without an id do not collide", () => {
		// Both read as "", so an unconditional seenIds write made the second report
		// ``duplicate id ` ` `` beside the `missing id` error already naming the cause.
		const root = mkroot();
		journey(root, "J1-alpha", "---\ntitle: alpha\n---\n");
		journey(root, "J2-beta", "---\ntitle: beta\n---\n");
		const errors: string[] = [];
		const seen: Record<string, string> = {};
		for (const n of ["J1-alpha", "J2-beta"]) lintJourney(join(root, n), errors, seen);
		expect(errors.filter((e) => e.includes("duplicate id"))).toEqual([]);
		// The real defect is still reported, once per journey.
		expect(errors.filter((e) => e.includes("missing `id`"))).toHaveLength(2);
		rmSync(root, { recursive: true, force: true });
	});

	test("a shared id is still reported", () => {
		const root = mkroot();
		journey(root, "J1-alpha", "---\nid: J1\ntitle: alpha\n---\n");
		journey(root, "J1-beta", "---\nid: J1\ntitle: beta\n---\n");
		const errors: string[] = [];
		const seen: Record<string, string> = {};
		for (const n of ["J1-alpha", "J1-beta"]) lintJourney(join(root, n), errors, seen);
		expect(errors.filter((e) => e.includes("duplicate id `J1`"))).toHaveLength(1);
		rmSync(root, { recursive: true, force: true });
	});

	test("index names an unreadable run instead of rendering it as `? ?`", () => {
		// latestRun assigned _file onto the empty parse result, making failure truthy,
		// so cmdIndex could not tell a truncated run from one missing optional fields.
		const root = mkroot();
		const jdir = journey(root, "J1-alpha", FULL);
		mkdirSync(join(jdir, "runs"), { recursive: true });
		// Every field a reader wants is present; only the terminator is missing.
		writeFileSync(join(jdir, "runs", "r.md"), "---\njourney: J1\ndate: 2026-09-11\nresult: pass\nmode: full\n", "utf8");
		const result = cmdIndex(root);
		const row = readFileSync(join(root, "INDEX.md"), "utf8").split("\n").find((l) => l.startsWith("| [J1]")) ?? "";
		expect(row).toContain("unreadable");
		expect(row).not.toContain("? ?");
		expect(result.text).toContain("ERROR J1-alpha/runs/r.md");
		// index generates and lint validates, so the status is unchanged.
		expect(result.ok).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	test("a run with no frontmatter is not treated as lost data", () => {
		// Absent declared nothing, so nothing was discarded - only a truncated block
		// means fields were thrown away. Conflating them fails the seeded-run cases.
		const root = mkroot();
		const jdir = journey(root, "J1-alpha", FULL);
		mkdirSync(join(jdir, "runs"), { recursive: true });
		writeFileSync(join(jdir, "runs", "2026-01-01.md"), "old", "utf8");
		const result = cmdIndex(root);
		expect(result.text).not.toContain("ERROR");
		expect(result.ok).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	test("index is unchanged for a well-formed run", () => {
		const root = mkroot();
		const jdir = journey(root, "J1-alpha", FULL);
		mkdirSync(join(jdir, "runs"), { recursive: true });
		writeFileSync(join(jdir, "runs", "r.md"), "---\njourney: J1\ndate: 2026-09-11\nresult: pass\nmode: full\n---\n", "utf8");
		expect(cmdIndex(root).text).not.toContain("ERROR");
		const row = readFileSync(join(root, "INDEX.md"), "utf8").split("\n").find((l) => l.startsWith("| [J1]")) ?? "";
		expect(row).toContain("2026-09-11 pass (full)");
		rmSync(root, { recursive: true, force: true });
	});
});
