import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const trustedSources = new Map<string, string>();

function authorizePrimary(root: string, body = "MUST authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository."): void {
	writeFileSync(join(root, "CLAUDE.md"), `${body}\n`);
	trustedSources.set(root, `${body}\n`);
}

function authorizeMain(root: string, body = "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."): void {
	writeFileSync(join(root, "CLAUDE.md"), `${body}\n`);
	trustedSources.set(root, `${body}\n`);
}

import { findGitInvocations, UNDECIDED_REASON } from "./main-branch-gate.ts";
import primaryCheckoutGate, {
	checkoutOf,
	decideCommit,
	decideEdit,
	decidePath,
	editedPaths,
	type GitRun,
	getWorktreesDir,
	isRuntimeCheckout,
	setGitRunForTests,
	setWorktreesDir,
} from "./primary-checkout-gate.ts";
import { steeringDirective } from "./target-repo-steering.ts";

type Repo = { topLevel: string; primary: boolean };
type RemoteState = { origin?: string; commonDir?: string; sha?: string; offline?: boolean; lsRemoteCalls?: number; index?: string[]; indexUnreadable?: true };

const DEFAULT_SHA = "a".repeat(40);
const ALT_SHA = "b".repeat(40);

/** Tracked paths every fake repository carries unless a test names its own index. */
const DEFAULT_INDEX = ["src/a.ts", "src/b.ts"];

/** A fake Git seam keyed by repository, including the trusted remote-default steering tree. */
function fakeGit(repos: Repo[], state: RemoteState = {}): GitRun {
	return (argv, cwd) => {
		const repo = repos.find((r) => cwd === r.topLevel || cwd.startsWith(`${r.topLevel}/`));
		if (!repo) return { exitCode: 128, stdout: "" };
		if (argv[1] === "rev-parse" && argv.includes("--show-toplevel")) {
			const gitDir = repo.primary ? (state.commonDir ?? `${repo.topLevel}/.git`) : `/primary/.git/worktrees/${repo.topLevel.split("/").pop()}`;
			const common = state.commonDir ?? (repo.primary ? `${repo.topLevel}/.git` : "/primary/.git");
			return { exitCode: 0, stdout: `${repo.topLevel}\n${gitDir}\n${common}\n` };
		}
		if (argv[1] === "rev-parse" && argv.includes("--git-common-dir")) return { exitCode: 0, stdout: `${state.commonDir ?? (repo.primary ? `${repo.topLevel}/.git` : "/primary/.git")}\n` };
		if (argv[1] === "config" && argv[2] === "--get-all" && argv[3] === "remote.origin.url")
			return { exitCode: 0, stdout: `${state.origin ?? `https://example.test/${repo.topLevel.replaceAll("/", "_")}.git`}\n` };
		if (argv[1] === "ls-remote") {
			state.lsRemoteCalls = (state.lsRemoteCalls ?? 0) + 1;
			if (state.offline) return { exitCode: 128, stdout: "" };
			const sha = state.sha ?? DEFAULT_SHA;
			return { exitCode: 0, stdout: `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n` };
		}
		if (argv[1] === "rev-parse" && argv.includes("--verify")) return { exitCode: 0, stdout: `${state.sha ?? DEFAULT_SHA}\n` };
		if (argv.includes("ls-files")) {
			if (state.indexUnreadable === true) return { exitCode: 128, stdout: "" };
			const pathspec = argv.at(-1) as string;
			const tracked = state.index ?? DEFAULT_INDEX;
			// Git matches a literal pathspec as itself or as a directory prefix of tracked entries.
			const matched = tracked.filter((entry) => entry === pathspec || entry.startsWith(`${pathspec}/`));
			return { exitCode: 0, stdout: matched.map((entry) => `${entry}\0`).join("") };
		}
		if (argv[1] === "ls-tree") {
			const text = trustedSources.get(repo.topLevel);
			return { exitCode: 0, stdout: text === undefined ? "" : `100644 blob ${state.sha ?? DEFAULT_SHA}\tCLAUDE.md\0` };
		}
		if (argv[1] === "show") return { exitCode: 0, stdout: trustedSources.get(repo.topLevel) ?? "" };
		return { exitCode: 1, stdout: "" };
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
	trustedSources.clear();
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
		const source = join(import.meta.dir, "primary-checkout-gate.ts");
		const script = `import { getWorktreesDir } from ${JSON.stringify(source)}; console.log(getWorktreesDir());`;
		const bun = Bun.which("bun") ?? process.execPath;
		const result = Bun.spawnSync([bun, "-e", script], {
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

	test("a subdirectory of a primary checkout reached through a symlink is still primary", () => {
		const { primary } = setup();
		const link = join(scratch, "via-link");
		// The filesystem is the only thing that can answer whether two spellings are one directory,
		// so the directories the probe names have to exist as they do in a real checkout.
		mkdirSync(join(primary, ".git", "worktrees", "feat"), { recursive: true });
		symlinkSync(primary, link);
		const canonical = realpathSync.native(primary);
		// Real Git prints `--git-dir` with symlinks resolved and `--git-common-dir` relative to the
		// directory the probe ran in, measured on git 2.55.0 from a subdirectory of a checkout under
		// a symlinked path. Comparing that text alone called the subdirectory a linked worktree.
		setGitRunForTests(() => ({ exitCode: 0, stdout: `${canonical}\n${canonical}/.git\n../.git\n` }));
		expect(checkoutOf(join(link, "src"))).toEqual({ primary: true, topLevel: canonical });
		expect(checkoutOf(join(canonical, "src"))).toEqual({ primary: true, topLevel: canonical });
		// A linked worktree still answers with two different directories, so it stays non-primary.
		setGitRunForTests(() => ({ exitCode: 0, stdout: `${canonical}\n${canonical}/.git/worktrees/feat\n${canonical}/.git\n` }));
		expect(checkoutOf(join(link, "src"))).toEqual({ primary: false, topLevel: canonical });
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
	test("refuses an edit or write inside the primary checkout and names OMP isolation", () => {
		const { primary } = setup();
		const write = decideEdit("write", { path: join(primary, "src", "new.ts"), content: "x" }, "/", {});
		expect(write?.block).toBe(true);
		expect(write?.reason).toContain("isolated: true");
		expect(write?.reason).toContain("configured isolation root");
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
		expect(decideEdit("write", input, "/", { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.block).toBe(true);
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
		expect(decideCommit("git commit -m 'fix'", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.block).toBe(true);
	});

	test("refuses the unresolved dynamic -C inspection chain", () => {
		const { primary } = setup();
		const inspection = `for r in omp-orchestrate sniff agentic-scaffold slopvac; do
		d=/Users/sjors/personal/dev/$r; git -C "$d" fetch -q 2>/dev/null; b=$(git -C "$d" rev-parse --abbrev-ref HEAD); done`;
		expect(decideCommit(inspection, primary, {})).toMatchObject({ block: true });
		expect(decideCommit(inspection, primary, {})?.reason).toContain("not readable here");
	});
	test("static -C read-only commands remain allowed", () => {
		const { primary } = setup();
		expect(decideCommit("git -C /elsewhere status", primary, {})).toBeUndefined();
	});

	test("allows untrusted primary reads but blocks untrusted push", () => {
		const { primary } = setup();
		const state: RemoteState = { offline: true };
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], state));
		for (const command of ["git status", "git diff", "git log -1", "git show HEAD", "git fetch --dry-run origin"]) {
			expect(decideCommit(command, primary, {}), command).toBeUndefined();
		}
		expect(decideCommit("git push origin main", primary, {})).toMatchObject({
			block: true,
			reason: expect.stringContaining("unpinned repository origin"),
		});
		state.offline = false;
		expect(decideCommit("git push origin main", primary, {})).toBeUndefined();
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

	test("index operations run unauthorized in a linked worktree", () => {
		const { linked } = setup();
		for (const command of ["git add -- src/a.ts", "git restore --staged -- src/a.ts"])
			expect(decideCommit(command, linked, {}), command).toBeUndefined();
	});

	test("an index operation in an unauthorized primary checkout is refused with or without the env factor", () => {
		const { primary } = setup();
		for (const command of ["git add -- src/a.ts", "git restore --staged -- src/a.ts"]) {
			expect(decideCommit(command, primary, {})?.block, command).toBe(true);
			expect(decideCommit(command, primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.block, command).toBe(true);
		}
		const refusal = decideCommit("git add -- src/a.ts", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.reason;
		expect(refusal).toContain("This index mutation is inside the primary checkout");
		expect(refusal).toContain(steeringDirective("DELIVERY_ALLOW_PRIMARY_CHECKOUT"));
	});

	test("an authorized primary checkout still needs the env factor on the index command", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		for (const command of ["git add -- src/a.ts", "git restore --staged -- src/a.ts"]) {
			expect(decideCommit(command, primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" }), command).toBeUndefined();
			expect(decideCommit(command, primary, {})?.block, command).toBe(true);
		}
	});

	test("an index operation is governed by its -C target, not the caller's checkout", () => {
		const { primary, linked } = setup();
		authorizePrimary(primary);
		expect(decideCommit(`git -C ${primary} add -- src/a.ts`, linked, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })).toBeUndefined();
		expect(decideCommit(`git -C ${primary} add -- src/a.ts`, linked, {})?.block).toBe(true);
	});

	test("index authorization never authorizes a commit", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		expect(decideCommit("git add -- src/a.ts && git commit -m x", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.reason).toContain(
			"This commit is inside the primary checkout",
		);
	});

	test("an authorized index operation on an unpinned primary checkout is still refused", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], { offline: true }));
		const decision = decideCommit("git add -- src/a.ts", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("unpinned repository origin");
	});

	test("a directory operand is refused even where the same file list would be allowed", () => {
		const { primary, linked } = setup();
		authorizePrimary(primary);
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		expect(decideCommit("git add -- src", primary, env)?.reason).toContain("a directory operand");
		expect(decideCommit("git restore --staged -- src", linked, {})?.reason).toContain("a directory operand");
		expect(decideCommit("git add -- src/a.ts", primary, env)).toBeUndefined();
	});

	test("an escaped separator does not shrink the operand list the gate checks", () => {
		const { primary, linked } = setup();
		authorizePrimary(primary);
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		// Git receives `;` and `src` as pathspecs here, so this stages the whole `src` subtree.
		// Reading `\;` as a command boundary hid both operands and passed the call as a bounded
		// stage of src/a.ts alone.
		expect(decideCommit("git add -- src/a.ts \\; src", primary, env)?.block).toBe(true);
		expect(decideCommit("git add -- src/a.ts \\; src", linked, {})?.block).toBe(true);
		expect(decideCommit("git restore --staged -- src/a.ts \\&\\& src", linked, {})?.block).toBe(true);
		expect(decideCommit('git add -- src/a.ts ";" src', linked, {})?.block).toBe(true);
		// A real separator still ends the command, so the stage that precedes it stays bounded.
		expect(decideCommit("git add -- src/a.ts ; echo done", linked, {})).toBeUndefined();
		expect(decideCommit("git add -- src/a.ts", linked, {})).toBeUndefined();
	});

	test("a relative -C after a cwd transition names the directory the cd reached", () => {
		const { primary, linked } = setup();
		const relative = `cd ${primary} && /usr/bin/git -C . add -- src/a.ts`;
		// The call runs from the isolated worktree, but the shell moved to the human's primary
		// checkout first, so `-C .` is that checkout and not this one.
		expect(decideCommit(relative, linked, {})?.block).toBe(true);
		expect(decideCommit(`cd ${primary} && /usr/bin/git -C src restore --staged -- src/a.ts`, linked, {})?.block).toBe(true);
		expect(decideCommit(`cd ${primary} && /usr/bin/git add -- src/a.ts`, linked, {})?.block).toBe(true);
		authorizePrimary(primary);
		expect(decideCommit(relative, linked, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })).toBeUndefined();
		expect(decideCommit(relative, linked, {})?.reason).toContain("This index mutation is inside the primary checkout");
	});

	test("a shell-level Git selector refuses an index operation in a linked worktree", () => {
		const { linked } = setup();
		for (const command of [
			"export GIT_DIR=/other/.git; git add -- src/a.ts",
			"GIT_INDEX_FILE=/tmp/other-index; git add -- src/a.ts",
			"declare -x GIT_CONFIG_GLOBAL=/tmp/evil.config && git restore --staged -- src/a.ts",
		])
			expect(decideCommit(command, linked, {})?.reason, command).toContain("an opaque Git invocation");
		expect(decideCommit("git add -- src/a.ts", linked, { GIT_ICASE_PATHSPECS: "1" })?.reason).toContain("an opaque Git invocation");
		expect(decideCommit("git add -- src/a.ts", linked, { GIT_CONFIG_GLOBAL: "/tmp/evil.config" })?.reason).toContain("an opaque Git invocation");
	});

	test("an absent operand that Git would expand to a tracked subtree is refused", () => {
		const { primary, linked } = setup();
		authorizePrimary(primary);
		const state: RemoteState = { index: ["gone/x.ts", "gone/y.ts"] };
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }, { topLevel: linked, primary: false }], state));
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		expect(decideCommit("git add -- gone", primary, env)?.reason).toContain("a tracked subtree operand");
		expect(decideCommit("git restore --staged -- gone", primary, env)?.reason).toContain("a tracked subtree operand");
		expect(decideCommit("git add -- gone", linked, {})?.reason).toContain("a tracked subtree operand");
	});

	test("an absent operand with a single tracked entry beneath it is still a subtree", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], { index: ["nested/one.ts"] }));
		expect(decideCommit("git add -- nested", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.reason).toContain("a tracked subtree operand");
	});

	test("one exact deleted tracked file is the file the operand names", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], { index: ["src/a.ts"] }));
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		expect(existsSync(join(primary, "src", "a.ts"))).toBe(false);
		expect(decideCommit("git add -- src/a.ts", primary, env)).toBeUndefined();
		expect(decideCommit("git restore --staged -- src/a.ts", primary, env)).toBeUndefined();
	});

	test("an operand that matches neither the worktree nor the index is refused", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		expect(decideCommit("git add -- typo.ts", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.reason).toContain("an operand no file or index entry matches");
	});

	test("a file that replaced a tracked directory is refused", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		writeFileSync(join(primary, "legacy"), "now a file\n");
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], { index: ["legacy/one.ts"] }));
		expect(decideCommit("git add -- legacy", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.reason).toContain("a tracked subtree operand");
	});

	test("an index the gate cannot read refuses the operand", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], { indexUnreadable: true }));
		expect(decideCommit("git add -- src/a.ts", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.reason).toContain("an unreadable index");
	});

	test("a new file and a symlink to a file pass while a symlink to a directory does not", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		writeFileSync(join(primary, "fresh.ts"), "new\n");
		symlinkSync(join(primary, "fresh.ts"), join(primary, "alias.ts"));
		symlinkSync(join(primary, "src"), join(primary, "src-link"));
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		expect(decideCommit("git add -- fresh.ts", primary, env)).toBeUndefined();
		expect(decideCommit("git add -- alias.ts", primary, env)).toBeUndefined();
		expect(decideCommit("git add -- src-link", primary, env)?.reason).toContain("a directory operand");
	});

	/** Operands whose identity the filesystem refuses to answer for; `stat` throws past a missing entry. */
	function unanswerableOperands(root: string): { operand: string; selector: string }[] {
		writeFileSync(join(root, "src", "a.ts"), "tracked\n");
		symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
		symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
		return [
			{ operand: "src/a.ts/segment", selector: "an operand this gate cannot inspect" },
			{ operand: "loop-a", selector: "an operand this gate cannot inspect" },
			{ operand: `src/${"n".repeat(600)}.ts`, selector: "an operand this gate cannot inspect" },
			{ operand: "src/a\u0000b.ts", selector: "an opaque Git invocation" },
		];
	}

	test("an operand the filesystem cannot answer for is refused, never skipped", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		for (const { operand, selector } of unanswerableOperands(primary)) {
			for (const command of [`git add -- ${operand}`, `git restore --staged -- ${operand}`]) {
				const decision = decideCommit(command, primary, env);
				expect(decision?.block, command).toBe(true);
				expect(decision?.reason, command).toContain(selector);
			}
		}
	});

	test("an unanswerable operand is refused with no authorization factor and on an unpinned origin", () => {
		const { primary, linked } = setup();
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }, { topLevel: linked, primary: false }], { offline: true }));
		for (const { operand, selector } of unanswerableOperands(primary)) {
			// The primary checkout carries neither the directive nor a pinned origin, so its own
			// refusals could hide an operand this gate never inspected.
			expect(decideCommit(`git add -- ${operand}`, primary, {})?.reason, operand).toContain(selector);
		}
		for (const { operand, selector } of unanswerableOperands(linked)) {
			// A linked worktree needs no factor for a readable index operation, so only the operand refuses this one.
			expect(decideCommit(`git add -- ${operand}`, linked, {})?.reason, operand).toContain(selector);
		}
	});

	test.each([";", "||", "&&", "&", "\n"])(
		"a malformed operand does not launder a later verb across %j",
		(separator) => {
			const { primary } = setup();
			authorizePrimary(primary);
			writeFileSync(join(primary, "src", "a.ts"), "tracked\n");
			for (const later of ["git commit -m x", "git reset --hard", "git push origin main"]) {
				const command = `git add -- src/a.ts/segment ${separator} ${later}`;
				const decision = decideCommit(command, primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" });
				expect(decision?.block, command).toBe(true);
				expect(decision?.reason, command).toContain("an operand this gate cannot inspect");
			}
		},
	);

	test("a Git seam that throws or answers with nothing refuses an index operation", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		writeFileSync(join(primary, "src", "a.ts"), "tracked\n");
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		setGitRunForTests(() => {
			throw new Error("git seam exploded");
		});
		expect(decideCommit("git add -- src/a.ts", primary, env)?.reason).toContain("an unreadable index");
		setGitRunForTests((() => undefined) as unknown as GitRun);
		expect(decideCommit("git add -- src/a.ts", primary, env)?.reason).toContain("an unreadable index");
		setGitRunForTests((() => ({ exitCode: 0, stdout: null })) as unknown as GitRun);
		expect(decideCommit("git add -- src/a.ts", primary, env)?.reason).toContain("an unreadable index");
	});

	test.each([
		"git add .",
		"git add -- .",
		"git add -A -- src/a.ts",
		"git add -- src/",
		"git add -- 'src/*.ts'",
		"git add -- $FILE",
		"git restore --staged src/a.ts",
		"git restore --staged --worktree -- src/a.ts",
		"git stash push -m sync -- src/a.ts",
		"git rebase origin/main",
		"git reset --hard",
		"git stash -- src/a.ts",
		"git rebase -- src/a.ts",
		"git reset -- src/a.ts",
		"git -C ~/repo add -- src/a.ts",
		"git -C '/tmp/re*o' add -- src/a.ts",
		"git -C /tmp/{a,b} restore --staged -- src/a.ts",
		"GIT_DIR=/elsewhere/.git git add -- src/a.ts",
		"eval git add -- src/a.ts",
	])("an unsupported index shape stays refused even when authorized: %s", (command) => {
		const { primary } = setup();
		authorizePrimary(primary);
		const decision = decideCommit(command, primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" });
		expect(decision?.block, command).toBe(true);
		expect(decision?.reason, command).toContain("an opaque Git invocation");
	});

	test("an index operation whose -C the shell would expand is refused with no factors at all", () => {
		const { linked } = setup();
		for (const command of ["git -C ~/repo add -- src/a.ts", "git -C ~/repo restore --staged -- src/a.ts", "git -C /tmp/re*o add -- src/a.ts"])
			expect(decideCommit(command, linked, {})?.reason, command).toContain("an opaque Git invocation");
	});
});

describe("canonical-main primary commits", () => {
	test("requires the command-local main env and trusted default-branch directive", () => {
		const { primary } = setup();
		authorizeMain(primary);
		expect(decideCommit("git commit -m x", primary, { DELIVERY_ALLOW_MAIN_COMMIT: "1" })).toBeUndefined();
		expect(decideCommit("git commit -m x", primary, {} )?.block).toBe(true);

		const noDirective = join(scratch, "no-directive");
		mkdirSync(join(noDirective, "src"), { recursive: true });
		setGitRunForTests(fakeGit([
			{ topLevel: primary, primary: true },
			{ topLevel: noDirective, primary: true },
		]));
		expect(decideCommit("git commit -m x", noDirective, { DELIVERY_ALLOW_MAIN_COMMIT: "1" })?.block).toBe(true);
	});

	test.each([
		["working-tree-only", "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
		["feature-branch text", "feature branch: MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
		["fenced text", "```markdown\nMUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n```"],
	])("rejects %s steering", (_name, body) => {
		const { primary } = setup();
		writeFileSync(join(primary, "CLAUDE.md"), `${body}\n`);
		// No trusted remote-default tree entry is installed for the first case; for the other
		// cases the fake tree carries only the non-standalone or fenced text.
		if (_name !== "working-tree-only") trustedSources.set(primary, `${body}\n`);
		expect(decideCommit("git commit -m x", primary, { DELIVERY_ALLOW_MAIN_COMMIT: "1" })?.block).toBe(true);
	});

	test("does not borrow canonical-main steering from another repository", () => {
		const { primary } = setup();
		const other = join(scratch, "other-repo");
		mkdirSync(join(other, "src"), { recursive: true });
		authorizeMain(other);
		setGitRunForTests(fakeGit([
			{ topLevel: primary, primary: true },
			{ topLevel: other, primary: true },
		]));
		expect(decideCommit("git commit -m x", primary, { DELIVERY_ALLOW_MAIN_COMMIT: "1" })?.block).toBe(true);
		expect(decideCommit("git commit -m x", other, { DELIVERY_ALLOW_MAIN_COMMIT: "1" })).toBeUndefined();
	});

	test("does not treat primary env as a main-commit authorization", () => {
		const { primary } = setup();
		authorizeMain(primary);
		expect(decideCommit("git commit -m x", primary, { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.block).toBe(true);
		expect(decideEdit("write", { path: join(primary, "src", "new.ts") }, "/", { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" })?.block).toBe(true);
	});

    test("canonical-main authorization does not authorize checkout, switch, merge, or push", () => {
        const { primary } = setup();
        authorizeMain(primary);
        for (const command of [
            "git checkout main",
            "git switch main",
            "git merge feature",
            "git push origin main",
        ]) {
            const decision = decideCommit(command, primary, { DELIVERY_ALLOW_MAIN_COMMIT: "1" });
            if (command.startsWith("git push")) expect(decision, command).toBeUndefined();
            else expect(decision, command).toMatchObject({ block: true });
        }
    });
});

describe("editedPaths", () => {
	test("collects write paths, path lists, and hashline section headers once each", () => {
		expect(editedPaths({ path: "a.ts", paths: ["b.ts", "a.ts"], input: "[c.ts#ABCD]\nPUT 1.=1:\n+x\n['d e.ts'#ABCD]\n" })).toEqual(["a.ts", "b.ts", "c.ts", "d e.ts"]);
	});
});

describe("integration", () => {
	type Handler = (event: unknown, context?: unknown) => unknown;

	function register(): { toolCall: Handler; sessionStart: Handler } {
		const handlers: Record<string, Handler[]> = {};
		const fakePi = {
			on: (event: string, handler: Handler) => {
				const eventHandlers = handlers[event] ?? [];
				eventHandlers.push(handler);
				handlers[event] = eventHandlers;
			},
		};
		primaryCheckoutGate(fakePi as never);
		const toolCall = handlers.tool_call?.[0];
		const sessionStart = handlers.session_start?.[0];
		if (toolCall === undefined || sessionStart === undefined) {
			throw new Error("primary checkout gate handlers were not registered");
		}
		return { toolCall, sessionStart };
	}

	test("requires the main override on the same bash call", () => {
		const { primary } = setup();
		authorizeMain(primary);
		const { toolCall } = register();
		expect(
			toolCall({
				toolName: "bash",
				input: { cwd: primary, command: "git commit -m x", env: { DELIVERY_ALLOW_MAIN_COMMIT: "1" } },
			}),
		).toBeUndefined();
		expect(
			toolCall({ toolName: "bash", input: { cwd: primary, command: "git commit -m x" } }),
		).toMatchObject({ block: true });
	});

    test("unrelated tool calls do not crash or receive canonical-main authorization", () => {
        const { primary } = setup();
        authorizeMain(primary);
        const { toolCall } = register();
        expect(toolCall({ toolName: "github", input: { op: "repo_view" } })).toBeUndefined();
        expect(toolCall({ toolName: "eval", input: { code: "1 + 1" } })).toBeUndefined();
        expect(
            toolCall({
                toolName: "bash",
                input: { cwd: primary, command: "git checkout main", env: { DELIVERY_ALLOW_MAIN_COMMIT: "1" } },
            }),
        ).toMatchObject({ block: true });
    });
    test("registered primary handler rejects a nested checkout mutation chain", () => {
        const { primary } = setup();
        const { toolCall } = register();
        expect(toolCall({
            toolName: "bash",
            input: { cwd: primary, command: 'echo "$(git checkout main)"' },
        })).toMatchObject({ block: true });
    });

	test("a bash-call env grant allows later edits in the same primary checkout", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const { toolCall } = register();
		expect(toolCall({ toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } })).toBeUndefined();
		expect(toolCall({ toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } })).toBeUndefined();
	});

	test("a registered index operation is authorized by the call's own env, never by the process env", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const { toolCall } = register();
		expect(
			toolCall({ toolName: "bash", input: { cwd: primary, command: "git add -- src/a.ts", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } }),
		).toBeUndefined();
		process.env.DELIVERY_ALLOW_PRIMARY_CHECKOUT = "1";
		try {
			expect(toolCall({ toolName: "bash", input: { cwd: primary, command: "git add -- src/a.ts" } })).toMatchObject({ block: true });
			expect(toolCall({ toolName: "bash", input: { cwd: primary, command: "git restore --staged -- src/a.ts" } })).toMatchObject({ block: true });
		} finally {
			delete process.env.DELIVERY_ALLOW_PRIMARY_CHECKOUT;
		}
	});

	test("the registered handler refuses an index operation whose -C or operand it cannot resolve", () => {
		const { primary, linked } = setup();
		authorizePrimary(primary);
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }, { topLevel: linked, primary: false }], { index: ["gone/x.ts", "gone/y.ts"] }));
		const { toolCall } = register();
		const env = { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" };
		expect(toolCall({ toolName: "bash", input: { cwd: linked, command: "git -C ~/repo add -- src/a.ts" } })).toMatchObject({ block: true });
		expect(toolCall({ toolName: "bash", input: { cwd: primary, command: "git add -- gone", env } })).toMatchObject({ block: true });
		expect(toolCall({ toolName: "bash", input: { cwd: linked, command: "git add -- gone" } })).toMatchObject({ block: true });
	});

	test("revokes a grant when origin changes and requires a new grant after restoration", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const state: RemoteState = {};
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], state));
		const { toolCall } = register();
		const context = { cwd: "/", sessionManager: { getSessionId: () => "origin-sequence" } };
		const grant = { toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } };
		const write = { toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } };
		expect(toolCall(grant, context)).toBeUndefined();
		expect(toolCall(write, context)).toBeUndefined();
		state.origin = "https://evil.test/redirect.git";
		expect(toolCall(write, context)).toMatchObject({ block: true });
		state.origin = `https://example.test/${primary.replaceAll("/", "_")}.git`;
		expect(toolCall(write, context)).toMatchObject({ block: true });
		expect(toolCall(grant, context)).toBeUndefined();
		expect(toolCall(write, context)).toBeUndefined();
	});

	test("revokes a grant when the common directory changes and requires a new grant after restoration", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const state: RemoteState = {};
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], state));
		const { toolCall } = register();
		const context = { cwd: "/", sessionManager: { getSessionId: () => "common-dir-sequence" } };
		const grant = { toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } };
		const write = { toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } };
		expect(toolCall(grant, context)).toBeUndefined();
		expect(toolCall(write, context)).toBeUndefined();
		state.commonDir = `${primary}/alternate.git`;
		expect(toolCall(write, context)).toMatchObject({ block: true });
		state.commonDir = `${primary}/.git`;
		expect(toolCall(write, context)).toMatchObject({ block: true });
		expect(toolCall(grant, context)).toBeUndefined();
		expect(toolCall(write, context)).toBeUndefined();
	});

	test.each([
		["directive removed", "not an authorization"],
		["veto added", `${steeringDirective("DELIVERY_ALLOW_PRIMARY_CHECKOUT")}\nMUST NOT authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository.`],
	])("revokes a grant when the remote SHA changes and the primary directive is %s", (_name, body) => {
		const { primary } = setup();
		authorizePrimary(primary);
		const state: RemoteState = {};
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], state));
		const { toolCall } = register();
		const context = { cwd: "/", sessionManager: { getSessionId: () => `sha-${_name}` } };
		const grant = { toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } };
		const write = { toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } };
		expect(toolCall(grant, context)).toBeUndefined();
		expect(toolCall(write, context)).toBeUndefined();
		state.sha = ALT_SHA;
		trustedSources.set(primary, `${body}\n`);
		expect(toolCall(write, context)).toMatchObject({ block: true });
		state.sha = DEFAULT_SHA;
		authorizePrimary(primary);
		expect(toolCall(write, context)).toMatchObject({ block: true });
	});

	test("revokes a grant while remote authority is offline", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const state: RemoteState = {};
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], state));
		const { toolCall } = register();
		const context = { cwd: "/", sessionManager: { getSessionId: () => "offline-sequence" } };
		const grant = { toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } };
		const write = { toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } };
		expect(toolCall(grant, context)).toBeUndefined();
		state.offline = true;
		expect(toolCall(write, context)).toMatchObject({ block: true });
		state.offline = false;
		expect(toolCall(write, context)).toMatchObject({ block: true });
	});

	test("revalidates unchanged anchors once per edit without reparsing the tree", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const state: RemoteState = {};
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }], state));
		const { toolCall } = register();
		const context = { cwd: "/", sessionManager: { getSessionId: () => "bounded-sequence" } };
		const grant = { toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } };
		const write = { toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } };
		expect(toolCall(grant, context)).toBeUndefined();
		expect(toolCall(write, context)).toBeUndefined();
		expect(toolCall(write, context)).toBeUndefined();
		expect(state.lsRemoteCalls).toBe(3);
	});

	test("a grant is scoped to its primary checkout", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const other = join(scratch, "other-repo");
		mkdirSync(join(other, "src"), { recursive: true });
		setGitRunForTests(fakeGit([{ topLevel: primary, primary: true }, { topLevel: other, primary: true }]));
		const { toolCall } = register();
		expect(toolCall({ toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } })).toBeUndefined();
		expect(toolCall({ toolName: "write", input: { path: join(other, "src", "new.ts"), content: "" } })).toMatchObject({ block: true });
	});

	test("a bash-call env grant does not require command or file content", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const { toolCall } = register();
		expect(toolCall({ toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } })).toBeUndefined();
		expect(toolCall({ toolName: "edit", input: { input: `[${primary}/src/a.ts#1A2B]\nPUT 1.=1:\n+DELIVERY_ALLOW_PRIMARY_CHECKOUT=1\n` } })).toBeUndefined();
	});

	test("a non-primary cwd does not grant a primary checkout", () => {
		const { primary, linked } = setup();
		const { toolCall } = register();
		expect(toolCall({ toolName: "bash", input: { cwd: linked, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } })).toBeUndefined();
		expect(toolCall({ toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } })).toMatchObject({ block: true });
	});

	test("session start clears repository grants", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const { toolCall, sessionStart } = register();
		expect(toolCall({ toolName: "bash", input: { cwd: primary, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } })).toBeUndefined();
		expect(sessionStart({})).toBeUndefined();
		expect(toolCall({ toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } })).toMatchObject({ block: true });
	});

	test("the registered handler refuses an operand the filesystem cannot answer for", () => {
		const { primary, linked } = setup();
		authorizePrimary(primary);
		writeFileSync(join(linked, "src", "a.ts"), "tracked\n");
		symlinkSync(join(linked, "loop-b"), join(linked, "loop-a"));
		symlinkSync(join(linked, "loop-a"), join(linked, "loop-b"));
		const { toolCall } = register();
		// A linked worktree needs no factor for a readable index operation, so nothing but the
		// operand can refuse these; before the operand was inspected they were allowed outright.
		for (const operand of ["src/a.ts/segment", "loop-a", `src/${"n".repeat(600)}.ts`, "src/a\u0000b.ts"]) {
			for (const later of ["git commit -m x", "git reset --hard", "git push origin main"]) {
				for (const separator of [";", "||", "&&", "&", "\n"]) {
					const command = `git add -- ${operand} ${separator} ${later}`;
					expect(toolCall({ toolName: "bash", input: { cwd: linked, command } }), command).toMatchObject({ block: true });
				}
			}
			const authorized = { cwd: primary, command: `git restore --staged -- ${operand}`, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } };
			expect(toolCall({ toolName: "bash", input: authorized }), operand).toMatchObject({ block: true });
		}
	});

	test("the registered handler refuses a call it cannot classify and still passes unrelated tools", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		const { toolCall } = register();
		const hostile = {
			cwd: "/",
			sessionManager: {
				getSessionId: () => {
					throw new Error("session manager unavailable");
				},
			},
		};
		expect(toolCall({ toolName: "bash", input: { cwd: primary, command: "git add -- src/a.ts && git commit -m x" } }, hostile)).toMatchObject({ block: true });
		expect(toolCall({ toolName: "write", input: { path: join(primary, "src", "new.ts"), content: "" } }, hostile)).toMatchObject({ block: true });
		expect(toolCall({ toolName: "github", input: { op: "repo_view" } }, hostile)).toBeUndefined();
		expect(toolCall({ toolName: "eval", input: { code: "1 + 1" } }, hostile)).toBeUndefined();
		expect(toolCall({ toolName: "read", input: { path: join(primary, "src", "a.ts") } }, hostile)).toBeUndefined();
	});

	test("the registered handler refuses a bash call whose Git seam answers with a shape it did not ask for", () => {
		const { primary } = setup();
		authorizePrimary(primary);
		writeFileSync(join(primary, "src", "a.ts"), "tracked\n");
		const { toolCall } = register();
		const call = { toolName: "bash", input: { cwd: primary, command: "git add -- src/a.ts ; git commit -m x", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } } };
		for (const malformed of [
			() => {
				throw new Error("git seam exploded");
			},
			() => undefined,
			() => ({ exitCode: 0, stdout: null }),
			() => ({ exitCode: null, stdout: "" }),
		]) {
			setGitRunForTests(malformed as unknown as GitRun);
			expect(toolCall(call), String(malformed)).toMatchObject({ block: true });
		}
	});
});

describe("final primary parser bypass controls", () => {
	test("direct git helpers fail closed before the generic non-Git skip", () => {
		const { primary } = setup();
		for (const command of [
			"/usr/libexec/git-core/git-commit -m x",
			"/usr/libexec/git-core/git-checkout feature",
			"/usr/libexec/git-core/git-switch feature",
			"/usr/libexec/git-core/git-merge feature",
			"/usr/libexec/git-core/git-unknown-helper x",
		]) expect(decideCommit(command, primary)?.block, command).toBe(true);
		expect(decideCommit("echo git-notes.txt", primary)).toBeUndefined();
		expect(findGitInvocations("/usr/libexec/git-core/git-unknown-helper x")).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	test("remote origin mutations are primary mutations while reads stay allowed", () => {
		const { primary } = setup();
		for (const command of [
			"git remote set-url origin https://evil.test/repo.git",
			"git remote remove origin",
			"git remote rename origin evil",
			"git config remote.origin.url https://evil.test/repo.git",
			"alias mutate='git remote set-url origin evil'; mutate",
			"env git remote set-url origin evil",
		]) expect(decideCommit(command, primary)?.block, command).toBe(true);
		expect(decideCommit("git remote -v", primary)).toBeUndefined();
		// `git fetch origin` writes remote-tracking refs in this checkout, so it is a repository
		// mutation now. Only the spellings that write nothing at all stay reads.
		expect(decideCommit("git fetch origin", primary)?.block).toBe(true);
		expect(decideCommit("git fetch --dry-run origin", primary)).toBeUndefined();
	});

	test.each([
		"cd /primary && git commit -m x",
		"cd /primary ; git checkout feature",
		"pushd /primary && git merge feature",
		"{ git commit -m x; }",
		"(git commit -m x)",
		"cd /does-not-exist ; git commit -m x",
		"cd /does-not-exist && git commit -m x",
	])("registered primary cwd/grouping chain fails closed: %s", (command) => {
		const { primary } = setup();
		expect(decideCommit(command, primary)?.block, command).toBe(true);
	});
});
test("absolute Git after a cwd transition resolves the transitioned primary checkout", () => {
		const { primary, linked } = setup();
		const command = `cd ${primary} && /usr/bin/git commit -m x`;
		expect(decideCommit(command, linked)?.block, command).toBe(true);
	});

	test.each(["/usr/bin/git commit -m x", "/bin/git commit -m x", "/opt/homebrew/bin/git commit -m x"])(
		"absolute Git executable after a cwd transition is not treated as ordinary text: %s",
		(git) => {
			const { primary, linked } = setup();
			const command = `cd ${primary} && ${git}`;
			expect(decideCommit(command, linked)?.block, command).toBe(true);
		},
	);

	test("mixed cwd transitions never reuse the first transition", () => {
		const { primary, linked } = setup();
		for (const command of [
			`cd ${linked} && /usr/bin/git status; cd ${primary} && git commit -m x`,
			`cd ${linked} && /usr/bin/git status && cd ${primary} && git commit -m x`,
			`cd ${linked} && /usr/bin/git status || cd ${primary} && git commit -m x`,
			`cd ${linked} && /usr/bin/git status\ncd ${primary} && git commit -m x`,
			`cd ${linked} && (/usr/bin/git status; cd ${primary} && git commit -m x)`,
			`cd ${linked} && /usr/bin/git status; cd ${primary} && /bin/git commit -m x`,
		]) {
			expect(decideCommit(command, linked)?.block, command).toBe(true);
		}
	});

describe("production Git runner", () => {
	test("authorized primary checkout reaches remote authority with the remote budget", () => {
		const { primary } = setup();
		setGitRunForTests(null);
		const sha = "a".repeat(40);
		const directive = "MUST authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository.\n";
		const seen: Array<{ argv: string[]; timeout: number }> = [];
		const original = Bun.spawnSync;
		Object.defineProperty(Bun, "spawnSync", { value: (argv: string[], options: { cwd: string; stdout: "pipe"; stderr: "pipe"; timeout: number }) => {
			seen.push({ argv, timeout: options.timeout });
			if (argv[1] === "rev-parse" && argv.includes("--show-toplevel")) return { exitCode: 0, stdout: { toString: () => `${primary}\n${primary}/.git\n${primary}/.git\n` } };
			if (argv[1] === "rev-parse" && argv.includes("--git-common-dir")) return { exitCode: 0, stdout: { toString: () => `${primary}/.git\n` } };
			if (argv[1] === "config") return { exitCode: 0, stdout: { toString: () => "https://example.test/primary.git\n" } };
			if (argv[1] === "ls-remote") return { exitCode: 0, stdout: { toString: () => `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n` } };
			if (argv[1] === "rev-parse" && argv.includes("--verify")) return { exitCode: 0, stdout: { toString: () => `${sha}\n` } };
			if (argv[1] === "ls-tree") return { exitCode: 0, stdout: { toString: () => `100644 blob ${sha}\tCLAUDE.md\0` } };
			if (argv[1] === "show") return { exitCode: 0, stdout: { toString: () => directive } };
			return { exitCode: 1, stdout: { toString: () => "" } };
		} });
		try {
			expect(decideEdit("write", { path: join(primary, "src", "new.ts"), content: "x" }, "/", { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" }, "/var/empty")).toBeUndefined();
			const remote = seen.find((call) => call.argv[1] === "ls-remote");
			expect(remote).toEqual({ argv: ["git", "ls-remote", "--symref", "https://example.test/primary.git", "HEAD"], timeout: 10_000 });
			expect(seen.filter((call) => call.argv[1] !== "ls-remote").every((call) => call.timeout === 2_000)).toBe(true);
		} finally {
			Object.defineProperty(Bun, "spawnSync", { value: original });
		}
	});
});

describe("destructive ref spellings reach the primary-checkout policy", () => {
	test.each([
		"git branch -D main",
		"git branch -f main HEAD",
		"git branch -m main other",
		"git branch --delete main",
		"git branch topic",
		"git worktree remove ../w",
		"git worktree prune",
		"git worktree add ../w main",
		"git fetch --prune",
		"git fetch origin +refs/heads/main:refs/heads/main",
		"git symbolic-ref HEAD refs/heads/other",
		"git symbolic-ref -d HEAD",
		// A branch CREATION hiding behind an option whose argument is optional. `--color`, `--column`
		// and `--abbrev` take a value only when attached with `=`, and `-l` is `--create-reflog` on
		// older Git, so none of them may swallow the new ref and leave a report of nothing.
		"git branch -l newbranch",
		"git branch --color newbranch",
		"git branch --column newbranch",
		"git branch --abbrev newbranch",
		// A refspec fetch whose redirection TARGET is merely named `--dry-run`: that is a file name,
		// so the fetch still writes remote-tracking refs.
		"git fetch origin main > --dry-run",
		// Git's parse-options accepts the generated negation, so the LAST spelling decides. A latch
		// that only asked whether `--dry-run` appeared permitted the first of these.
		"git fetch --dry-run --no-dry-run origin",
		"git fetch --dry-run --no-dry-run --prune origin main",
		"git fetch --no-dry-run",
		"git fetch --no-dry-run origin",
		// Bare `git fetch` defaults to `origin` and writes remote-tracking refs, so no operand count
		// earns it a read either.
		"git fetch",
		"git fetch -v",
		"git fetch --quiet origin",
	])("a protected primary checkout refuses it as a repository mutation: %s", (command) => {
		const { primary } = setup();
		expect(findGitInvocations(command), command).toEqual([{ operation: "ref-mutation", repoDir: null }]);
		// Classifying it is only half the fix: `decideCommit` ends its loop in `continue`, so an
		// operation it does not name explicitly is allowed.
		expect(decideCommit(command, primary)?.reason, command).toContain("This repository mutation");
	});

	test.each([
		"git branch",
		"git branch -a",
		"git branch --list",
		"git branch --show-current",
		"git branch --contains HEAD",
		"git branch --sort=committerdate",
		"git branch --list topic-*",
		"git branch --list -- -topic",
		// `--list` makes every operand a pattern, so it reports even beside an optional-arg option.
		"git branch --list --color newbranch",
		"git branch -l",
		"git branch --color",
		"git branch --abbrev=7",
		// `--dry-run` makes the WHOLE fetch a report, so it outranks every later option and operand
		// and the answer cannot depend on their order.
		"git fetch --dry-run --prune",
		"git fetch --prune --dry-run",
		"git fetch --dry-run --force origin +refs/heads/main:refs/heads/main",
		"git fetch origin +refs/heads/main:refs/heads/main --dry-run",
		"git fetch --dry-run --prune --force origin main",
		"git fetch --no-dry-run --dry-run origin",
		"git fetch --no-dry-run --prune --dry-run origin main",
		"git fetch --prune --dry-run -- origin main",
		"git worktree list",
		"git worktree list --porcelain",
		"git symbolic-ref HEAD",
		"git symbolic-ref --short HEAD",
		"git fetch --dry-run",
		"git fetch --dry-run origin",
		"git fetch --dry-run origin main",
		"git fetch origin --dry-run",
		"git fetch --dry-run -- origin main",
		"git status",
		"git log --oneline",
		"git rev-parse --show-toplevel",
	])("a true read spelling is still allowed in the primary checkout: %s", (command) => {
		const { primary } = setup();
		expect(findGitInvocations(command), command).toEqual([{ operation: "read", repoDir: null }]);
		expect(decideCommit(command, primary), command).toBeUndefined();
	});

	test("a linked worktree keeps every destructive spelling", () => {
		const { linked } = setup();
		for (const command of ["git branch -D main", "git worktree prune", "git fetch --prune", "git symbolic-ref -d HEAD"])
			expect(decideCommit(command, linked), command).toBeUndefined();
	});
});

describe("redirection targets carrying command substitution", () => {
	// Bash expands a redirection target BEFORE it opens the file, so the nested Git call runs even
	// though no argv either walker parses ever contains it. Checked at both positions and with a
	// non-Git outer command, since a caller reaching only one seam must not get the weaker answer.
	const hidden = [
		'git status > "$(git checkout other)"',
		'git status >> "$(git checkout other)"',
		'git status 2> "$(git checkout other)"',
		'git status > "`git checkout other`"',
		'> "$(git checkout other)" git status',
		'echo ok > "$(git commit -m x)"',
		'cat < "$(git checkout other)"',
		// Concatenated so no single literal spells `${…}`. The command text is exactly
		// `printf x 3>"$(g${EMPTY}it checkout other)"`, a substitution naming no readable `git`.
		'printf x 3>"$(g$' + '{EMPTY}it checkout other)"',
		'RUNNER=git; >"$($RUNNER checkout other)" printf x',
		"RUNNER=git; >\"`$RUNNER checkout other`\" printf x",
	];

	test.each(hidden)("findGitInvocations surfaces the hidden Git call: %s", (command) => {
		expect(findGitInvocations(command)).toContainEqual({ operation: "opaque", repoDir: null, retargeted: true });
	});

	test.each(hidden)("a protected primary checkout refuses it: %s", (command) => {
		const { primary } = setup();
		expect(decideCommit(command, primary)?.block, command).toBe(true);
	});

	test.each([
		"git status > out.txt",
		"git status 2>&1",
		'git status > "$HOME/out.txt"',
		"git status >/dev/null",
		"> out.txt git status",
	])("a harmless redirection stays a read: %s", (command) => {
		const { primary } = setup();
		expect(findGitInvocations(command), command).toEqual([{ operation: "read", repoDir: null }]);
		expect(decideCommit(command, primary), command).toBeUndefined();
	});

	test("a process substitution is refused as grouping", () => {
		const { primary } = setup();
		for (const command of ["git status > >(git checkout other)", "git status < <(git checkout other)"])
			expect(decideCommit(command, primary)?.block, command).toBe(true);
	});
});

describe("registered handler on an unexpected failure", () => {
	type Handler = (event: unknown, context?: unknown) => unknown;
	function register(): Handler {
		const handlers: Handler[] = [];
		primaryCheckoutGate({
			on: (event: string, handler: Handler) => {
				if (event === "tool_call") handlers.push(handler);
			},
		} as never);
		return handlers[0] as Handler;
	}

	test("a tool name that throws on first access is refused, not allowed", () => {
		const exploding = {
			get toolName(): string {
				throw new Error("classification exploded");
			},
			get input(): never {
				throw new Error("input must not be read");
			},
		};
		expect(register()(exploding)).toEqual({ block: true, reason: UNDECIDED_REASON });
	});

	test("a tool name read twice cannot launder a governed call into an ungoverned one", () => {
		const { primary } = setup();
		let reads = 0;
		const stateful = {
			get toolName(): string {
				reads++;
				return reads === 1 ? "write" : "read";
			},
			input: { path: join(primary, "src", "new.ts"), content: "x" },
		};
		expect(register()(stateful, { cwd: primary })).toMatchObject({ block: true });
		expect(reads).toBe(1);
	});

	test("a tool this gate does not govern is never inspected", () => {
		const untouched = {
			toolName: "read",
			get input(): never {
				throw new Error("input must not be read");
			},
		};
		expect(register()(untouched)).toBeUndefined();
	});

	test("a classification failure inside a governed call is refused", () => {
		const exploding = {
			toolName: "write",
			input: {
				get path(): string {
					throw new Error("classification exploded");
				},
			},
		};
		expect(register()(exploding)).toEqual({ block: true, reason: UNDECIDED_REASON });
	});
});

describe("symlinked spellings of a primary checkout", () => {
	/**
	 * Real Git resolves symlinks itself and reports the checkout's REAL top level, which is what
	 * lets an aliased path fail a raw prefix comparison. This seam reproduces that: it answers for
	 * any directory whose realpath is inside the primary checkout, and reports the real top level.
	 */
	function realpathAwareGit(primary: string): GitRun {
		const realPrimary = realpathSync(primary);
		return (argv, cwd) => {
			let real: string;
			try {
				real = realpathSync(cwd);
			} catch {
				return { exitCode: 128, stdout: "" };
			}
			if (real !== realPrimary && !real.startsWith(`${realPrimary}/`)) return { exitCode: 128, stdout: "" };
			if (argv[1] === "rev-parse" && argv.includes("--show-toplevel"))
				return { exitCode: 0, stdout: `${realPrimary}\n${realPrimary}/.git\n${realPrimary}/.git\n` };
			if (argv[1] === "rev-parse" && argv.includes("--git-common-dir")) return { exitCode: 0, stdout: `${realPrimary}/.git\n` };
			return { exitCode: 1, stdout: "" };
		};
	}

	test("an alias of the primary checkout blocks write and edit like the canonical spelling", () => {
		const { primary } = setup();
		const alias = join(scratch, "alias");
		symlinkSync(primary, alias);
		setGitRunForTests(realpathAwareGit(primary));
		expect(decidePath(join(primary, "src", "a.ts"), "/")).toMatchObject({ block: true });
		expect(decidePath(join(alias, "src", "a.ts"), "/")).toMatchObject({ block: true });
		expect(decideEdit("write", { path: join(alias, "src", "new.ts"), content: "" }, "/", {})).toMatchObject({ block: true });
		expect(decideEdit("edit", { input: `[${join(alias, "src", "a.ts")}#1A2B]\nPUT 1.=1:\n+x\n` }, "/", {})).toMatchObject({ block: true });
	});

	test("a nested alias and a path whose last components do not exist yet still block", () => {
		const { primary } = setup();
		const alias = join(scratch, "alias");
		const nested = join(scratch, "nested");
		symlinkSync(primary, alias);
		symlinkSync(alias, nested);
		setGitRunForTests(realpathAwareGit(primary));
		expect(decidePath(join(nested, "src", "a.ts"), "/")).toMatchObject({ block: true });
		expect(decidePath(join(nested, "src", "deep", "deeper", "new.ts"), "/")).toMatchObject({ block: true });
		expect(decideEdit("write", { path: join(nested, "src", "deep", "deeper", "new.ts"), content: "" }, "/", {})).toMatchObject({ block: true });
	});

	test("a state directory that symlinks into the source tree is not agent state", () => {
		const { primary } = setup();
		symlinkSync(join(primary, "src"), join(primary, ".omp", "escape"));
		setGitRunForTests(realpathAwareGit(primary));
		expect(decidePath(join(primary, ".omp", "state.json"), "/")).toBeUndefined();
		expect(decidePath(join(primary, ".omp", "escape", "a.ts"), "/")).toMatchObject({ block: true });
		expect(decideEdit("write", { path: join(primary, ".omp", "escape", "new.ts"), content: "" }, "/", {})).toMatchObject({ block: true });
	});

	test("aliasing leaves the linked, outside, internal-URI and read controls alone", () => {
		const { primary, linked, outside } = setup();
		const alias = join(scratch, "alias");
		symlinkSync(primary, alias);
		setGitRunForTests(realpathAwareGit(primary));
		expect(decidePath(join(linked, "src", "a.ts"), "/")).toBeUndefined();
		expect(decidePath(join(outside, "a.ts"), "/")).toBeUndefined();
		expect(decidePath("xd://ast_edit", "/")).toBeUndefined();
		expect(decideEdit("read", { path: join(alias, "src", "a.ts") }, "/", {})).toBeUndefined();
	});

	test("a runtime clone stays a runtime clone through an aliased harness root", () => {
		scratch = mkdtempSync(join(tmpdir(), "pcg-"));
		const root = join(scratch, "omp-wt");
		const clone = join(root, "task-1", "repo");
		mkdirSync(clone, { recursive: true });
		const aliasRoot = join(scratch, "wt-alias");
		symlinkSync(root, aliasRoot);
		// Either side may carry the aliased spelling, and `/var` against `/private/var` is the same
		// question: a runtime clone that failed this test was refused as a human's primary checkout.
		expect(isRuntimeCheckout(clone, aliasRoot)).toBe(true);
		expect(isRuntimeCheckout(join(aliasRoot, "task-1", "repo"), root)).toBe(true);
		expect(isRuntimeCheckout(realpathSync(clone), aliasRoot)).toBe(true);
		expect(isRuntimeCheckout(realpathSync(clone), root)).toBe(true);
		expect(isRuntimeCheckout(join(scratch, "elsewhere", "repo"), root)).toBe(false);
	});
});
