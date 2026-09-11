import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	checkoutOf,
	decideCommit,
	decideEdit,
	editedPaths,
	type GitRun,
	setGitRunForTests,
} from "./primary-checkout-gate.ts";

type Repo = { topLevel: string; primary: boolean };

/** A fake `git rev-parse --show-toplevel --git-dir --git-common-dir` keyed by the repo that contains cwd. */
function fakeGit(repos: Repo[]): GitRun {
	return (_argv, cwd) => {
		const repo = repos.find((r) => cwd === r.topLevel || cwd.startsWith(`${r.topLevel}/`));
		if (!repo) return { exitCode: 128, stdout: "" };
		const gitDir = repo.primary ? `${repo.topLevel}/.git` : `/primary/.git/worktrees/${repo.topLevel.split("/").pop()}`;
		const common = repo.primary ? `${repo.topLevel}/.git` : "/primary/.git";
		return { exitCode: 0, stdout: `${repo.topLevel}\n${gitDir}\n${common}\n` };
	};
}

let scratch: string;
function setup(): { primary: string; linked: string; outside: string } {
	scratch = mkdtempSync(join(tmpdir(), "pcg-"));
	const primary = join(scratch, "repo");
	const linked = join(scratch, "worktrees", "repo", "feat-x");
	const outside = join(scratch, "elsewhere");
	for (const dir of [join(primary, "src"), join(primary, ".omp"), join(linked, "src"), outside]) mkdirSync(dir, { recursive: true });
	setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }, { topLevel: linked, primary: false }]));
	return { primary, linked, outside };
}

afterEach(() => {
	setGitRunForTests(null);
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("checkoutOf", () => {
	test("distinguishes a primary checkout from a linked worktree and from no repository", () => {
		const { primary, linked, outside } = setup();
		expect(checkoutOf(primary)).toEqual({ primary: true, topLevel: primary });
		expect(checkoutOf(join(linked, "src"))).toEqual({ primary: false, topLevel: linked });
		expect(checkoutOf(outside)).toBeNull();
	});
});

describe("decideEdit", () => {
	test("refuses an edit or write inside the primary checkout and names the wt command", () => {
		const { primary } = setup();
		const write = decideEdit("write", { path: join(primary, "src", "new.ts"), content: "x" }, "/", {});
		expect(write?.block).toBe(true);
		expect(write?.reason).toContain("wt switch --create");
		expect(write?.reason).toContain(primary);
		const edit = decideEdit("edit", { input: `[${primary}/src/a.ts#1A2B]\nPUT 1.=1:\n+x\n` }, "/", {});
		expect(edit?.block).toBe(true);
	});

	test("allows a linked worktree, a path outside any repository, agent state, and internal URIs", () => {
		const { primary, linked, outside } = setup();
		expect(decideEdit("edit", { input: `[${linked}/src/a.ts#1A2B]\nPUT 1.=1:\n+x\n` }, "/", {})).toBeUndefined();
		expect(decideEdit("write", { path: join(outside, "note.md"), content: "x" }, "/", {})).toBeUndefined();
		expect(decideEdit("write", { path: join(primary, ".omp", "scaffold-plan.md"), content: "x" }, "/", {})).toBeUndefined();
		expect(decideEdit("write", { path: "xd://ast_edit", content: "{}" }, primary, {})).toBeUndefined();
		expect(decideEdit("read", { path: join(primary, "src", "a.ts") }, "/", {})).toBeUndefined();
	});

	test("resolves a relative path against the call cwd", () => {
		const { primary, linked } = setup();
		expect(decideEdit("write", { path: "src/new.ts", content: "x" }, primary, {})?.block).toBe(true);
		expect(decideEdit("write", { path: "src/new.ts", content: "x" }, linked, {})).toBeUndefined();
	});

	test("the environment override lifts the gate; text does not", () => {
		const { primary } = setup();
		const input = { path: join(primary, "src", "new.ts"), content: "DELIVERY_ALLOW_PRIMARY_CHECKOUT=1" };
		expect(decideEdit("write", input, "/", {})?.block).toBe(true);
		expect(decideEdit("write", input, "/", { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })).toBeUndefined();
	});

	test("fails open when git cannot answer", () => {
		const { primary } = setup();
		setGitRunForTests(() => {
			throw new Error("no git");
		});
		expect(decideEdit("write", { path: join(primary, "src", "new.ts"), content: "x" }, "/", {})).toBeUndefined();
	});
});

describe("decideCommit", () => {
	test("refuses a commit whose repository is the primary checkout, follows -C, and honours dry-run and override", () => {
		const { primary, linked } = setup();
		expect(decideCommit("git commit -m 'fix'", primary, {})?.block).toBe(true);
		expect(decideCommit("git commit -m 'fix'", linked, {})).toBeUndefined();
		expect(decideCommit(`git -C ${primary} commit -m 'fix'`, linked, {})?.block).toBe(true);
		expect(decideCommit("git commit --dry-run -m 'fix'", primary, {})).toBeUndefined();
		expect(decideCommit("git status && echo commit", primary, {})).toBeUndefined();
		expect(decideCommit("git commit -m 'fix'", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })).toBeUndefined();
	});
});

describe("editedPaths", () => {
	test("collects write paths, path lists, and hashline section headers once each", () => {
		expect(editedPaths({ path: "a.ts", paths: ["b.ts", "a.ts"], input: "[c.ts#ABCD]\nPUT 1.=1:\n+x\n['d e.ts'#ABCD]\n" })).toEqual(["a.ts", "b.ts", "c.ts", "d e.ts"]);
	});
});
