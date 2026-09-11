import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetChezmoiGuardForTests, seedChezmoiCacheForTests } from "./chezmoi-guard.ts";
import secretCommitGate, {
	chezmoiRepo,
	committedPaths,
	decideCommit,
	gitCommits,
	nestsShell,
	resetSecretCommitGateForTests,
	secretStagedPaths,
	setGitSpawnForTests,
	targetName,
} from "./secret-commit-gate.ts";

const ROOT = "/home/u/.local/share/chezmoi";
const SOURCE = join(ROOT, "dotfiles");
const ELSEWHERE = "/home/u/projects/app";

afterEach(() => {
	resetSecretCommitGateForTests();
	resetChezmoiGuardForTests();
});

/** Seed the source dir and answer `rev-parse` plus the two diff reads. */
function seedRepo(staged: string[], tracked: string[] = []): void {
	seedChezmoiCacheForTests(null, SOURCE);
	setGitSpawnForTests((args) => {
		const dir = args[args.indexOf("-C") + 1] ?? "";
		// git fails outside a repository, which is how another cwd is recognised.
		if (args.includes("--show-toplevel")) return dir.startsWith(ROOT) ? `${ROOT}\n` : null;
		if (args.includes("--show-prefix")) return "dotfiles/\n";
		if (args.includes("--cached")) return `${staged.join("\0")}\0`;
		if (args.includes("--name-only")) return `${[...new Set([...staged, ...tracked])].join("\0")}\0`;
		return "";
	});
}

type Handler = (event: Record<string, unknown>, ctx: { cwd?: string }) => unknown;

function fakePi(): { handlers: Record<string, Handler[]>; pi: unknown } {
	const handlers: Record<string, Handler[]> = {};
	return {
		handlers,
		pi: {
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: Handler) => {
				const registered = handlers[event] ?? [];
				registered.push(handler);
				handlers[event] = registered;
			},
		},
	};
}

/** The gate registers exactly one `tool_call` handler; fail loudly if it did not. */
function toolCallHandler(handlers: Record<string, Handler[]>): Handler {
	const handler = handlers.tool_call?.[0];
	if (!handler) throw new Error("secretCommitGate registered no tool_call handler");
	return handler;
}

describe("gitCommits", () => {
	test("plain commit runs in the given cwd", () => {
		expect(gitCommits("git commit -m 'x'", ROOT)).toEqual([{ cwd: ROOT, all: false }]);
	});

	test("-C retargets, inline or spaced", () => {
		expect(gitCommits(`git -C ${ROOT} commit -m x`, ELSEWHERE)).toEqual([{ cwd: ROOT, all: false }]);
		expect(gitCommits(`git -C"${ROOT}" commit`, ELSEWHERE)).toEqual([{ cwd: ROOT, all: false }]);
	});

	test("cd is followed across segments", () => {
		const dir = mkdtempSync(join(tmpdir(), "secret-cd-"));
		try {
			expect(gitCommits(`cd '${dir}' && git commit -m x`, ELSEWHERE)).toEqual([{ cwd: dir, all: false }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(gitCommits("cd $DIR && git commit", ELSEWHERE)).toEqual([{ cwd: null, all: false }]);
		expect(gitCommits("cd $DIR && git -C /tmp commit", ELSEWHERE)).toEqual([{ cwd: "/tmp", all: false }]);
	});

	test("conditional branches preserve the shell cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "secret-conditional-cd-"));
		const other = join(dir, "other");
		mkdirSync(other);
		try {
			expect(gitCommits(`cd '${other}' || git commit`, dir)).toEqual([]);
			expect(gitCommits(`cd '${other}' || true && git commit`, dir)).toEqual([{ cwd: other, all: false }]);
			expect(gitCommits(`cd '${other}' && cd missing || git commit`, dir)).toEqual([{ cwd: other, all: false }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a backgrounded list keeps its cd out of the parent shell", () => {
		// `&` backgrounds the whole preceding list, so its `cd` runs in a subshell. Every
		// expectation below was read off real bash with `git` shadowed to print $PWD; a
		// parser that leaks the subshell's directory would inspect the WRONG tree for the
		// foreground commit, which is how a real plaintext secret escapes the guard.
		const dir = mkdtempSync(join(tmpdir(), "secret-bg-cd-"));
		const other = join(dir, "other");
		mkdirSync(other);
		try {
			// bash: the backgrounded commit runs in `other`, the foreground one in `dir`.
			expect(gitCommits(`cd '${other}' && git commit & git commit`, dir).map((c) => c.cwd).sort()).toEqual([dir, other].sort());
			// bash: the first `cd` is foreground and DOES move the parent, so the
			// foreground commit runs in `other` even though a background job follows.
			expect(gitCommits(`cd '${other}'; cd '${dir}' & git commit`, dir)).toEqual([{ cwd: other, all: false }]);
			// bash: a bare backgrounded `cd` never moves the parent.
			expect(gitCommits(`cd '${other}' & git commit`, dir)).toEqual([{ cwd: dir, all: false }]);
			// A PIPELINE inside a backgrounded list. Independent review reproduced a
			// bypass here: the pipeline stage reset to the parent's directory, so BOTH
			// commits were reported outside and a staged plaintext secret in `other`
			// went uninspected. bash runs the backgrounded pipeline's commit in `other`
			// and the foreground one in `dir`, because the job's own `cd` applies inside
			// the job while never reaching the parent.
			expect(gitCommits(`cd '${other}' && printf x | git commit & git commit`, dir).map((c) => c.cwd).sort()).toEqual([dir, other].sort());
			// Both stages of a backgrounded pipeline see the job's directory.
			expect(gitCommits(`cd '${other}' && printf x | git commit & printf y | git commit`, dir).map((c) => c.cwd).sort()).toEqual([dir, other].sort());
			// A pipeline whose own first stage cds: that cd is subshell-local, so the
			// commit stays in the parent's directory and the following `;` does too.
			expect(gitCommits(`cd '${other}' | git commit; git commit`, dir).map((c) => c.cwd)).toEqual([dir, dir]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("-a and combined short flags stage tracked edits", () => {
		expect(gitCommits("git commit -am x", ROOT)[0]?.all).toBe(true);
		expect(gitCommits("git commit --all", ROOT)[0]?.all).toBe(true);
		expect(gitCommits("git commit -m x", ROOT)[0]?.all).toBe(false);
	});

	test("value-consuming globals do not hide the subcommand", () => {
		expect(gitCommits("git -c user.name=x commit -m y", ROOT)).toEqual([{ cwd: ROOT, all: false }]);
	});

	test("other git subcommands and other binaries are not commits", () => {
		expect(gitCommits("git log --oneline", ROOT)).toEqual([]);
		expect(gitCommits("bd commit", ROOT)).toEqual([]);
		expect(gitCommits("echo commit", ROOT)).toEqual([]);
	});
});

describe("targetName", () => {
	test("strips attribute prefixes and restores the dot", () => {
		expect(targetName("private_dot_env")).toEqual({ name: ".env", encrypted: false });
		expect(targetName("private_id_ed25519")).toEqual({ name: "id_ed25519", encrypted: false });
		expect(targetName("dot_gitconfig.tmpl")).toEqual({ name: ".gitconfig.tmpl", encrypted: false });
	});

	test("reports chezmoi encryption", () => {
		expect(targetName("encrypted_private_id_rsa")).toEqual({ name: "id_rsa", encrypted: true });
	});

	test("an unknown prefix is part of the name", () => {
		expect(targetName("my_token")).toEqual({ name: "my_token", encrypted: false });
	});
});

describe("secretStagedPaths", () => {
	test("flags credential-named source files", () => {
		const staged = [
			"dotfiles/private_dot_ssh/private_id_ed25519",
			"dotfiles/dot_config/app/client.pem",
			"dotfiles/dot_config/app/tls.key",
			"dotfiles/dot_config/app/store.p12",
			"dotfiles/private_dot_ssh/private_work_rsa",
			"dotfiles/dot_config/gh/api_token",
			"dotfiles/dot_config/app/secret",
			"dotfiles/dot_config/app/credentials",
			"dotfiles/private_dot_env",
		];
		expect(secretStagedPaths(staged, "dotfiles/")).toEqual(staged);
	});

	test("templates and encrypted copies are the sanctioned path", () => {
		const staged = [
			"dotfiles/private_dot_env.tmpl",
			"dotfiles/dot_config/private_fish/conf.d/05_secrets.fish.tmpl",
			"dotfiles/private_dot_ssh/encrypted_private_id_ed25519",
		];
		expect(secretStagedPaths(staged, "dotfiles/")).toEqual([]);
	});

	test("repository tooling outside the source tree is not a dotfile", () => {
		const staged = ["scripts/check-secret-resolution.sh", "docs/secrets.md", ".gitleaksignore"];
		expect(secretStagedPaths(staged, "dotfiles/")).toEqual([]);
	});

	test("ordinary dotfiles pass", () => {
		const staged = ["dotfiles/dot_zshrc", "dotfiles/dot_config/ghostty/config"];
		expect(secretStagedPaths(staged, "dotfiles/")).toEqual([]);
	});
});

describe("committedPaths", () => {
	test("-a adds tracked modifications to the index list", () => {
		seedRepo(["dotfiles/dot_zshrc"], ["dotfiles/private_dot_env"]);
		expect(committedPaths(ROOT, false)).toContain("dotfiles/dot_zshrc");
		expect(committedPaths(ROOT, false)).not.toContain("dotfiles/private_dot_env");
		expect(committedPaths(ROOT, true)).toContain("dotfiles/private_dot_env");
	});
});

describe("decideCommit", () => {
	test("blocks a plaintext secret and names it", () => {
		seedRepo(["dotfiles/private_dot_ssh/private_id_ed25519"]);
		const decision = decideCommit("git commit -m 'add key'", ROOT);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("private_id_ed25519");
		expect(decision?.reason).toContain("onepasswordRead");
		expect(decision?.reason).toContain("chezmoi add --encrypt");
	});

	test("blocks from the source subdirectory and via -C from elsewhere", () => {
		seedRepo(["dotfiles/dot_config/app/tls.key"]);
		expect(decideCommit("git commit -m x", join(SOURCE, "dot_config"))?.block).toBe(true);
		expect(decideCommit(`git -C ${ROOT} commit -m x`, ELSEWHERE)?.block).toBe(true);
	});

	test("catches the -a bypass", () => {
		seedRepo([], ["dotfiles/private_dot_env"]);
		expect(decideCommit("git commit -am wip", ROOT)?.block).toBe(true);
		expect(decideCommit("git commit -m wip", ROOT)).toBeUndefined();
	});

	test("blocks when cd leaves the commit cwd unknown", () => {
		seedRepo(["dotfiles/private_dot_env"]);
		const decision = decideCommit("cd $DIR && git commit -m x", ROOT);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("working directory safely");
	});

	test("allows a clean commit, another repository, and a non-commit", () => {
		seedRepo(["dotfiles/private_dot_env.tmpl", "dotfiles/dot_zshrc"]);
		expect(decideCommit("git commit -m x", ROOT)).toBeUndefined();
		expect(decideCommit("git commit -m x", ELSEWHERE)).toBeUndefined();
		expect(decideCommit("git log", ROOT)).toBeUndefined();
	});

	test("a symlinked cwd still matches, because git answers where the commit lands", () => {
		seedChezmoiCacheForTests(null, SOURCE);
		setGitSpawnForTests((args) => {
			if (args.includes("--show-toplevel")) return "/private/tmp/chezmoi\n";
			if (args.includes("--show-prefix")) return "dotfiles/\n";
			if (args.includes("--cached")) return "dotfiles/private_dot_env\0";
			return "";
		});
		expect(decideCommit("git commit -m x", "/tmp/chezmoi")?.block).toBe(true);
	});

	test("allows when chezmoi or git cannot answer", () => {
		seedChezmoiCacheForTests(null, null);
		setGitSpawnForTests(() => null);
		expect(decideCommit("git commit -m x", ROOT)).toBeUndefined();

		seedChezmoiCacheForTests(null, SOURCE);
		setGitSpawnForTests(() => null);
		expect(chezmoiRepo()).toBeNull();
		expect(decideCommit("git commit -m x", ROOT)).toBeUndefined();
	});

	test("refuses a commit reached through a nested shell, which the walk cannot follow", () => {
		// Independent review reproduced all three of these committing inside the chezmoi
		// tree while the guard allowed them: the subshell and brace group were
		// attributed to the parent directory, and eval produced no commit call at all.
		// Confirmed against real bash with git shadowed to print $PWD -- from /usr, each
		// of the three runs its commit in /tmp.
		seedRepo(["dotfiles/dot_config/gh/api_token"]);
		for (const command of [
			`( cd '${SOURCE}' && git commit -m x )`,
			`{ cd '${SOURCE}'; git commit -m x; }`,
			`eval 'cd ${SOURCE} && git commit -m x'`,
			`sh -c "cd ${SOURCE} && git commit -m x"`,
			`echo "$(cd ${SOURCE} && git commit -m x)"`,
			`cd x&&(cd '${SOURCE}');git commit -m x`,
			`env sh -c 'cd ${SOURCE} && git commit -m x'`,
			`cd x; sh -c 'cd ${SOURCE} && git commit -m x'`,
		]) {
			const decision = decideCommit(command, ELSEWHERE);
			expect(decision?.block).toBe(true);
			expect(decision?.reason).toContain("nests a shell");
		}
	});

	test("a nested shell outside a chezmoi tree, and quoted punctuation, are left alone", () => {
		// The refusal must not become a general ban on subshells. It is scoped to a
		// chezmoi source tree, where the gate has something to protect, and it must not
		// fire on punctuation that only looks like shell syntax.
		seedChezmoiCacheForTests(null, null);
		expect(decideCommit(`( cd /some/repo && git commit -m x )`, ELSEWHERE)).toBeUndefined();

		seedRepo([]);
		// Parens and braces inside quotes are literal; `${VAR}` is an expansion, and
		// find's `{}` is a placeholder. None of these starts a shell.
		expect(decideCommit(`git commit -m "fix (typo) and {braces}"`, ROOT)).toBeUndefined();
		expect(decideCommit(`git commit -m '(fix) thing'`, ROOT)).toBeUndefined();
		expect(decideCommit("git commit -m ${MSG}", ROOT)).toBeUndefined();
		expect(decideCommit("find . -name x -exec rm {} ; git commit -m y", ROOT)).toBeUndefined();
		// Single quotes are literal, so a substitution written inside them is inert.
		expect(decideCommit(`git commit -m 'literal $(cd elsewhere)'`, ROOT)).toBeUndefined();
		// Shell-looking words inside quotes are asserted directly against nestsShell
		// below: routing them through decideCommit cannot prove anything, because its
		// earlier exits also return undefined, which made a first attempt vacuous.
	});

	test("nestsShell reads only the text outside quotes", () => {
		// Each row was checked against real bash. The false side matters as much as the
		// true side: this detector refuses commits, so a wrong `true` blocks honest work.
		const nests: Array<[string, boolean]> = [
			// Real nesting, outside quotes.
			["( cd src && git commit )", true],
			["{ cd src; git commit; }", true],
			["eval 'cd src && git commit'", true],
			["cd x&&(cd y);git commit", true],
			['sh -c "cd src && git commit"', true],
			["env sh -c 'cd src && git commit'", true],
			["cd src; sh -c 'git commit'", true],
			// Interpreter reached by path, and assignments or env between the prefix and
			// the shell. Each of these was a live bypass of the regex this replaced, and
			// each was verified to run its commit in the target directory.
			["/bin/sh -c 'cd src && git commit'", true],
			["env FOO=1 sh -c 'cd src && git commit'", true],
			["FOO=1 sh -c 'cd src && git commit'", true],
			["/usr/bin/env bash -c 'cd src && git commit'", true],
			["command sh -c 'cd src && git commit'", true],
			// A shell named without -c runs no script of its own.
			["sh /tmp/script.sh; git commit -m x", false],
			// A path that merely CONTAINS a shell name is not an interpreter.
			["git commit -m x -- tools/bash/readme.md", false],
			// Substitution expands inside DOUBLE quotes, so it nests.
			['git commit -m "$(cd src && pwd)"', true],
			['git commit -m "`cd src && pwd`"', true],
			// Literal punctuation and shell-looking WORDS inside quotes do not.
			['git commit -m "fix (typo) and {braces}"', false],
			["git commit -m '(fix) thing'", false],
			["git commit -m 'literal; sh -c harmless'", false],
			["git commit -m 'env sh -c text'", false],
			["git commit -m 'see eval notes'", false],
			['git commit -m "pipe | eval thing"', false],
			["git commit -m 'literal $(cd elsewhere)'", false],
			// Expansion and find's placeholder are not groups.
			["git commit -m ${MSG}", false],
			["find . -name x -exec rm {} ; git commit -m y", false],
			// The shapes the walk already models correctly must stay allowed.
			["cd src && git commit -m x", false],
			["cd src; git commit -m x", false],
			["cd src && git commit & git commit", false],
			["cd src && printf x | git commit", false],
			["git -C src commit -m x", false],
		];
		for (const [command, expected] of nests) {
			expect(nestsShell(command), command).toBe(expected);
		}
	});
});

describe("integration", () => {
	test("blocks the bash call, honouring the per-call cwd", () => {
		const { handlers, pi } = fakePi();
		seedRepo(["dotfiles/dot_config/gh/api_token"]);
		secretCommitGate(pi as never);
		const handler = toolCallHandler(handlers);

		const blocked = handler(
			{ toolName: "bash", toolCallId: "c1", input: { command: "git commit -m x", cwd: ROOT } },
			{ cwd: ELSEWHERE },
		);
		expect(blocked).toEqual(
			expect.objectContaining({ block: true, reason: expect.stringContaining("api_token") }),
		);

		const elsewhere = handler(
			{ toolName: "bash", toolCallId: "c2", input: { command: "git commit -m x" } },
			{ cwd: ELSEWHERE },
		);
		expect(elsewhere).toBeUndefined();
	});

	test("unrelated tools and malformed input pass", () => {
		const { handlers, pi } = fakePi();
		seedRepo(["dotfiles/private_dot_env"]);
		secretCommitGate(pi as never);
		const handler = toolCallHandler(handlers);

		expect(handler({ toolName: "write", input: { path: "a" } }, { cwd: ROOT })).toBeUndefined();
		expect(handler({ toolName: "bash", input: {} }, { cwd: ROOT })).toBeUndefined();
		expect(handler({ toolName: "bash", input: { command: "git commit" } }, {})).toBeUndefined();
	});
});

test("real Git candidates honor paths, worktree content, deletions, and NUL filenames", () => {
	const dir = mkdtempSync(join(tmpdir(), "secret-candidates-"));
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null",
			"-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	try {
		git("init", "-b", "topic");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.invalid");
		mkdirSync(join(dir, "odd\nname"));
		writeFileSync(join(dir, "safe"), "base\n");
		writeFileSync(join(dir, "odd\nname", "private_dot_env"), "old\n");
		git("add", ".");
		git("commit", "-m", "base");
		seedChezmoiCacheForTests(null, dir);
		writeFileSync(join(dir, "safe"), "changed\n");
		writeFileSync(join(dir, "odd\nname", "private_dot_env"), "new\n");
		expect(decideCommit("git commit -m x -- 'odd\nname/private_dot_env'", dir)?.block).toBe(true);
		expect(decideCommit("git commit -am x", dir)?.block).toBe(true);
		git("add", ".");
		expect(decideCommit("git commit -m x -- safe", dir)).toBeUndefined();
		expect(decideCommit("git commit -m x", dir)?.block).toBe(true);
		unlinkSync(join(dir, "odd\nname", "private_dot_env"));
		expect(decideCommit("git commit -am x", dir)).toBeUndefined();
		expect(decideCommit("git commit -m x -- 'odd\nname/private_dot_env'", dir)).toBeUndefined();
		git("add", "-u");
		expect(decideCommit("git commit -m x", dir)).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("literal shell cwd keeps secrets guarded after failed and pipeline-local cd", () => {
	const dir = mkdtempSync(join(tmpdir(), "secret-shell-"));
	const other = join(dir, "other");
	mkdirSync(other);
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	try {
		git("init", "-b", "topic");
		writeFileSync(join(dir, "private_dot_env"), "SYNTHETIC_SECRET=not-a-credential\n");
		git("add", "private_dot_env");
		git("-C", other, "init", "-b", "topic");
		seedChezmoiCacheForTests(null, dir);
		for (const command of [
			"cd missing || git commit",
			"cd missing; git commit",
			"cd missing && cd other || git commit",
			"cd other | cat; git commit",
			"printf x | cd other; git commit",
			"cd other | git commit",
		]) {
			// Replace git with a shell function: observe the real cwd without committing.
			const observed = Bun.spawnSync(["bash", "-c", `git() { pwd; }; ${command}`],
				{ cwd: dir, stdout: "pipe", stderr: "pipe" });
			expect(observed.stdout.toString().trim()).toBe(realpathSync(dir));
			expect(gitCommits(command, dir)).toEqual([{ cwd: dir, all: false }]);
			expect(decideCommit(command, dir)?.block).toBe(true);
		}
		expect(decideCommit("cd other && git commit", dir)).toBeUndefined();
		expect(decideCommit("cd missing && git commit", dir)).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
