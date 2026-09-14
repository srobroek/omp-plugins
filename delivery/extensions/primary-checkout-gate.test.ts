import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { setWorktreesDir } from "@oh-my-pi/pi-utils";

import {
	checkoutOf,
	decideCommit,
	decideEdit,
	editedPaths,
	getWorktreesDir,
	isRuntimeCheckout,
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
	setWorktreesDir(undefined);
	delete process.env.OMP_WORKTREE_DIR;
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("getWorktreesDir", () => {
	test("uses an absolute env path, expands tilde, and ignores relative values", () => {
		const absolute = join(scratch ?? tmpdir(), "env-wt");
		process.env.OMP_WORKTREE_DIR = absolute;
		expect(getWorktreesDir()).toBe(absolute);
		process.env.OMP_WORKTREE_DIR = "~/env-wt";
		expect(getWorktreesDir()).toBe(join(homedir(), "env-wt"));
		process.env.OMP_WORKTREE_DIR = "relative-wt";
		expect(getWorktreesDir()).not.toBe(join(process.cwd(), "relative-wt"));
	});

	test("gives OMP_WORKTREE_DIR precedence over the worktree.base override", () => {
		const override = join(scratch ?? tmpdir(), "setting-wt");
		const env = join(scratch ?? tmpdir(), "env-wt");
		setWorktreesDir(override);
		process.env.OMP_WORKTREE_DIR = env;
		expect(getWorktreesDir()).toBe(env);
		delete process.env.OMP_WORKTREE_DIR;
		expect(getWorktreesDir()).toBe(override);
	});

	test("uses the profile-aware XDG data root for the fallback", () => {
		const home = mkdtempSync(join(tmpdir(), "pcg-home-"));
		const xdg = join(home, "xdg");
		const profileRoot = join(xdg, "omp", "profiles", "acme");
		mkdirSync(profileRoot, { recursive: true });
		const source = join(process.cwd(), "delivery/extensions/primary-checkout-gate.ts");
		const script = `import { getWorktreesDir } from ${JSON.stringify(source)}; console.log(getWorktreesDir());`;
		const result = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, HOME: home, OMP_PROFILE: "acme", XDG_DATA_HOME: xdg, OMP_WORKTREE_DIR: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString().trim()).toBe(join(profileRoot, "wt"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("checkoutOf", () => {
	test("distinguishes a primary checkout from a linked worktree and from no repository", () => {
		const { primary, linked, outside } = setup();
		expect(checkoutOf(primary)).toEqual({ primary: true, topLevel: primary });
		expect(checkoutOf(join(linked, "src"))).toEqual({ primary: false, topLevel: linked });
		expect(checkoutOf(outside)).toBeNull();
	});
});

describe("isRuntimeCheckout", () => {
	test("recognizes descendants of the configured harness root only", () => {
		const root = join(scratch ?? "/tmp", "omp-wt");
		expect(isRuntimeCheckout(join(root, "task-1", "repo"), root)).toBe(true);
		expect(isRuntimeCheckout(root, root)).toBe(false);
		expect(isRuntimeCheckout(join(root, "-other", "repo"), `${root}-other`)).toBe(false);
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

	test("blocks a tilde path inside the human primary checkout", () => {
		const primary = mkdtempSync(join(homedir(), "pcg-home-"));
		try {
			mkdirSync(join(primary, "src"), { recursive: true });
			setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }]));
			const tildePath = `~/${primary.slice(homedir().length + 1)}/src/new.ts`;

			expect(decideEdit("write", { path: tildePath, content: "x" }, "/", {})).toMatchObject({ block: true });
		} finally {
			rmSync(primary, { recursive: true, force: true });
		}
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

	test("does not block the read-only git inspection reproducer", () => {
		const { primary } = setup();
		const inspection = `for r in omp-orchestrate sniff agentic-scaffold slopvac; do
		d=/Users/sjors/personal/dev/$r; git -C "$d" fetch -q 2>/dev/null; b=$(git -C "$d" rev-parse --abbrev-ref HEAD); u=$(git -C "$d" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo origin/main); behind=$(git -C "$d" rev-list --count HEAD.."$u" 2>/dev/null); ahead=$(git -C "$d" rev-list --count "$u"..HEAD 2>/dev/null); rules=$(git -C "$d" diff --name-only HEAD "$u" -- 'rules/*' 'AGENTS.md' 'CLAUDE.md' '*/AGENTS.md' 2>/dev/null | wc -l | tr -d ' '); printf '%-18s %-40s behind=%s ahead=%s rules/steering files differing=%s\\n' "$r" "$b -> $u" "$behind" "$ahead" "$rules"; done`;
		expect(decideCommit(inspection, primary, {})).toBeUndefined();
        expect(decideCommit('git -C "$d" commit -m x', primary, {})).toBeUndefined();
	});

	test("does not block quoted git prose", () => {
        const { primary } = setup();
        expect(decideCommit("printf '<text containing the words git commit>' >> file && bd create --body-file file", primary, {})).toBeUndefined();
	});

	test("blocks actual commits in the primary checkout", () => {
		const { primary } = setup();
		expect(decideCommit("git commit -m x", primary, {})?.block).toBe(true);
		expect(decideCommit(`cd ${primary} && git commit -m x`, primary, {})?.block).toBe(true);
    });
});

describe("editedPaths", () => {
	test("collects write paths, path lists, and hashline section headers once each", () => {
		expect(editedPaths({ path: "a.ts", paths: ["b.ts", "a.ts"], input: "[c.ts#ABCD]\nPUT 1.=1:\n+x\n['d e.ts'#ABCD]\n" })).toEqual(["a.ts", "b.ts", "c.ts", "d e.ts"]);
	});
});