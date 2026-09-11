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
