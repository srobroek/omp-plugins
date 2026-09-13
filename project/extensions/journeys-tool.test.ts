import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installFormulas, journeysScriptPath, runJourneys } from "./journeys-tool.ts";

const tempRoot = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

function seedJourney(root: string, name = "J1-login"): string {
	const journey = join(root, name);
	mkdirSync(join(journey, "runs"), { recursive: true });
	writeFileSync(
		join(journey, "journey.md"),
		"---\nid: J1\ntitle: Login\nversion: 1\nstatus: draft\nlast_reviewed: 2026-01-01\nsurfaces: [web]\ninterfaces: [browser]\n---\n\n### S1 — Open app {#S1}\n",
	);
	return journey;
}

describe("journeys Python wrapper", () => {
	test("maps each command and prune flags to the Python CLI and passes cwd", async () => {
		const cwd = tempRoot("journeys-wrapper-");
		try {
			const seen: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
			const runner = async (file: string, args: string[], options: Record<string, unknown>) => {
				seen.push({ file, args, options });
				return { stdout: "ok", stderr: "" };
			};

			await runJourneys(cwd, { command: "index", journeysDir: "/tmp/journeys" }, undefined, runner);
			await runJourneys(cwd, { command: "lint", journeysDir: "/tmp/journeys" }, undefined, runner);
			await runJourneys(
				cwd,
				{ command: "prune", journeysDir: "/tmp/journeys", keep: 3, journey: "J1-login", yes: true },
				undefined,
				runner,
			);

			expect(seen.map(({ file }) => file)).toEqual(["python3", "python3", "python3"]);
			expect(seen[0]?.args).toEqual([journeysScriptPath(), "index", "/tmp/journeys"]);
			expect(seen[1]?.args).toEqual([journeysScriptPath(), "lint", "/tmp/journeys"]);
			expect(seen[2]?.args).toEqual([
				journeysScriptPath(),
				"prune",
				"/tmp/journeys",
				"--keep",
				"3",
				"--journey",
				"J1-login",
				"--yes",
			]);
			expect(seen.every(({ options }) => options.cwd === cwd && options.shell === false)).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns stdout, stderr, and a non-zero subprocess exit code", async () => {
		const cwd = tempRoot("journeys-wrapper-error-");
		try {
			const result = await runJourneys(cwd, { command: "lint", journeysDir: cwd }, undefined, async () => {
				throw { code: 7, stdout: "partial output", stderr: "lint failed" };
			});
			expect(result).toEqual({ stdout: "partial output", stderr: "lint failed", exitCode: 7 });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("runs the bundled Python helper end to end", async () => {
		const root = tempRoot("journeys-wrapper-e2e-");
		try {
			seedJourney(root);
			const result = await runJourneys(root, { command: "index", journeysDir: root });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("INDEX.md: 1 journeys");
		expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain("[J1](J1-login/journey.md)");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps the Python fixes for missing ids and unreadable runs", async () => {
		const root = tempRoot("journeys-wrapper-defects-");
		try {
			for (const name of ["J1-alpha", "J2-beta"]) {
				const journey = join(root, name);
				mkdirSync(journey, { recursive: true });
				writeFileSync(join(journey, "journey.md"), `---\ntitle: ${name}\nversion: 1\nstatus: draft\nlast_reviewed: 2026-01-01\n---\n`);
			}
			const lint = await runJourneys(root, { command: "lint", journeysDir: root });
			expect(lint.exitCode).not.toBe(0);
		expect(lint.stdout.match(/duplicate id/g)).toBeNull();
		expect(lint.stdout.match(/frontmatter missing `id`/g)).toHaveLength(2);

			const valid = join(root, "J1-alpha", "journey.md");
			writeFileSync(valid, "---\nid: J1\ntitle: alpha\nversion: 1\nstatus: active\nlast_reviewed: 2026-01-01\n---\n");
			const runs = join(root, "J1-alpha", "runs");
			mkdirSync(runs);
			writeFileSync(join(runs, "2026-01-01.md"), "---\njourney: J1\ndate: 2026-01-01\nresult: pass\nmode: full\n");
			const index = await runJourneys(root, { command: "index", journeysDir: root });
			expect(index.exitCode).toBe(0);
			expect(index.stdout).toContain("ERROR J1-alpha/runs/2026-01-01.md: unreadable frontmatter");
			expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain("**unreadable**");
			expect(readFileSync(join(root, "INDEX.md"), "utf8")).not.toContain("? ?");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("journey formula installation", () => {
	test("refuses a repository without Beads", () => {
		const root = tempRoot("journeys-formulas-no-beads-");
		try {
			expect(installFormulas(root).ok).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("copies the required formula files", () => {
		const source = tempRoot("journeys-formulas-source-");
		const repo = tempRoot("journeys-formulas-repo-");
		try {
			for (const name of ["journey-step-agentic-verification", "journey-step-human-verification"]) {
				writeFileSync(join(source, `${name}.formula.toml`), `formula = '${name}'\n`);
			}
			mkdirSync(join(repo, ".beads"));
			const result = installFormulas(repo, false, source);
			expect(result).toMatchObject({ ok: true, copied: 2 });
			expect(readFileSync(join(repo, ".beads", "formulas", "journey-step-agentic-verification.formula.toml"), "utf8")).toBe(
				"formula = 'journey-step-agentic-verification'\n",
			);
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
