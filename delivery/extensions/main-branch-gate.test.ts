import { afterEach, describe, expect, test } from "bun:test";

import mainBranchGate, {
	currentBranch,
	decideCommit,
	denyReason,
	extractCommand,
	findCommitInvocations,
	type GitRun,
	setGitRunForTests,
	tokenize,
} from "./main-branch-gate.ts";

type Call = { argv: string[]; cwd: string };

/** A fake `git branch --show-current` over a fixed cwd -> branch table. */
function fakeGit(
	table: Record<string, string>,
	calls: Call[] = [],
): { run: GitRun; calls: Call[] } {
	const run: GitRun = (argv, cwd) => {
		calls.push({ argv, cwd });
		const branch = table[cwd];
		if (branch === undefined) return { exitCode: 128, stdout: "" };
		return { exitCode: 0, stdout: `${branch}\n` };
	};
	return { run, calls };
}

afterEach(() => {
	setGitRunForTests(null);
});

describe("extractCommand", () => {
	test("reads command then cmd", () => {
		expect(extractCommand({ command: "git commit" })).toBe("git commit");
		expect(extractCommand({ cmd: "git commit" })).toBe("git commit");
		expect(extractCommand({})).toBe("");
	});
});

describe("tokenize", () => {
	test("a quoted message stays one token", () => {
		expect(tokenize("git commit -m 'fix main bug'")).toEqual([
			"git",
			"commit",
			"-m",
			"fix main bug",
		]);
	});
});

describe("findCommitInvocations", () => {
	test("plain commit", () => {
		expect(findCommitInvocations("git commit -m 'chore: x'")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	test("dgit is the same command shape", () => {
		expect(findCommitInvocations("dgit commit -m x")).toEqual([{ repoDir: null, dryRun: false }]);
	});

	test("-C names the target repository, and repeats fold", () => {
		expect(findCommitInvocations("git -C /repo commit -m x")).toEqual([
			{ repoDir: "/repo", dryRun: false },
		]);
		expect(findCommitInvocations("git -C /repo -C sub commit -m x")).toEqual([
			{ repoDir: "/repo/sub", dryRun: false },
		]);
	});

	test("pre-verb value options do not swallow the verb", () => {
		expect(findCommitInvocations("git -c user.name=x commit -m y")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations("git --git-dir /r/.git --work-tree /r commit -m y")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	test("--dry-run is recorded", () => {
		expect(findCommitInvocations("git commit --dry-run")).toEqual([
			{ repoDir: null, dryRun: true },
		]);
	});

	test("command position: chained, multi-line, env-prefixed", () => {
		expect(findCommitInvocations("git add . && git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations("cd /repo\ngit commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations("GIT_AUTHOR_NAME=x git commit -m y")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations("git commit -m a; git -C /r commit -m b")).toEqual([
			{ repoDir: null, dryRun: false },
			{ repoDir: "/r", dryRun: false },
		]);
	});

	// The FP class that made the old TTSR block real work: the words are in the
	// message, not in the argv position that decides anything.
	test("the same words quoted or in another command are not a commit", () => {
		for (const command of [
			"echo 'git commit -m x'",
			"git log --oneline -3",
			"git status --short",
			"bd close bdp-1a --reason 'git commit on main'",
			"rg -n 'git commit' delivery/",
			"gh pr merge 12 --squash",
		]) {
			expect(findCommitInvocations(command)).toEqual([]);
		}
	});
});

describe("currentBranch", () => {
	test("reads the branch of the given directory", () => {
		const { run, calls } = fakeGit({ "/work": "feat/x" });
		setGitRunForTests(run);
		expect(currentBranch("/work")).toBe("feat/x");
		expect(calls).toEqual([{ argv: ["git", "branch", "--show-current"], cwd: "/work" }]);
	});

	test("non-zero exit, empty output, and a throwing seam all read as unknown", () => {
		setGitRunForTests(() => ({ exitCode: 128, stdout: "" }));
		expect(currentBranch("/work")).toBeNull();

		setGitRunForTests(() => ({ exitCode: 0, stdout: "\n" }));
		expect(currentBranch("/work")).toBeNull();

		setGitRunForTests(() => {
			throw new Error("spawn failed");
		});
		expect(currentBranch("/work")).toBeNull();
	});
});

describe("decideCommit", () => {
	test("blocks a commit on main and on master", () => {
		const { run } = fakeGit({ "/work": "main", "/other": "master" });
		setGitRunForTests(run);
		expect(decideCommit("git commit -m x", "/work", {})).toEqual(
			expect.objectContaining({ block: true, reason: expect.stringContaining("main") }),
		);
		expect(decideCommit("git commit -m x", "/other", {})?.block).toBe(true);
	});

	test("allows a feature branch", () => {
		const { run } = fakeGit({ "/work": "fix/ttsr-audit" });
		setGitRunForTests(run);
		expect(decideCommit("git commit -m x", "/work", {})).toBeUndefined();
	});

	test("the branch comes from git, so the message text decides nothing", () => {
		const { run } = fakeGit({ "/work": "feat/x" });
		setGitRunForTests(run);
		for (const command of [
			"git commit -m 'fix main bug'",
			"git commit -m 'on main'",
			"git commit -m 'master plan'",
			"git commit -m 'revert main branch rename'",
		]) {
			expect(decideCommit(command, "/work", {})).toBeUndefined();
		}
	});

	test("-C picks the repository whose branch is read, resolved against the call cwd", () => {
		const { run, calls } = fakeGit({ "/work": "feat/x", "/work/sub": "main" });
		setGitRunForTests(run);
		expect(decideCommit("git -C sub commit -m x", "/work", {})?.block).toBe(true);
		expect(calls.map(c => c.cwd)).toEqual(["/work/sub"]);
	});

	test("blocks the second of two commits when only that repo is on main", () => {
		const { run } = fakeGit({ "/work": "feat/x", "/main-repo": "main" });
		setGitRunForTests(run);
		expect(decideCommit("git commit -m a && git -C /main-repo commit -m b", "/work", {})?.block).toBe(
			true,
		);
	});

	test("--dry-run commits nothing, so it is never blocked and never spawns", () => {
		const { run, calls } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		expect(decideCommit("git commit --dry-run", "/work", {})).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("fails open when git cannot name a branch", () => {
		setGitRunForTests(() => ({ exitCode: 128, stdout: "fatal: not a git repository" }));
		expect(decideCommit("git commit -m x", "/tmp/scratch", {})).toBeUndefined();

		setGitRunForTests(() => ({ exitCode: 0, stdout: "" }));
		expect(decideCommit("git commit -m x", "/detached", {})).toBeUndefined();

		setGitRunForTests(() => {
			throw new Error("no git binary");
		});
		expect(decideCommit("git commit -m x", "/work", {})).toBeUndefined();
	});

	test("the explicit override lifts it, from the environment or inline", () => {
		const { run, calls } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("git commit -m x", "/work", { DELIVERY_ALLOW_MAIN_COMMIT: "1" }),
		).toBeUndefined();
		expect(
			decideCommit("DELIVERY_ALLOW_MAIN_COMMIT=1 git commit -m x", "/work", {}),
		).toBeUndefined();
		expect(calls).toEqual([]);

		expect(
			decideCommit("git commit -m x", "/work", { DELIVERY_ALLOW_MAIN_COMMIT: "0" })?.block,
		).toBe(true);
	});

	test("the prefilter keeps unrelated commands away from the seam", () => {
		const { run, calls } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		for (const command of ["git status", "bun test", "echo commit", "git log --oneline"]) {
			expect(decideCommit(command, "/work", {})).toBeUndefined();
		}
		expect(calls).toEqual([]);
	});
});

describe("denyReason", () => {
	test("names the branch, the fix, the evidence, and the override", () => {
		const reason = denyReason("main");
		expect(reason).toContain("main");
		expect(reason).toContain("git switch -c");
		expect(reason).toContain("git branch --show-current");
		expect(reason).toContain("DELIVERY_ALLOW_MAIN_COMMIT=1");
	});
});

describe("integration", () => {
	function register(): Array<(e: unknown) => unknown> {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		mainBranchGate(fakePi as never);
		return handlers.tool_call as Array<(e: unknown) => unknown>;
	}

	test("blocks a commit in the bash call's cwd when that repo is on main", () => {
		const { run, calls } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		const [handler] = register();

		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c1",
				input: { command: "git commit -m x", cwd: "/main-repo" },
			}),
		).toEqual(expect.objectContaining({ block: true }));
		expect(calls.map(c => c.cwd)).toEqual(["/main-repo"]);
	});

	test("ignores other tools and empty input", () => {
		const { run, calls } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		const [handler] = register();

		expect(
			handler?.({
				toolName: "edit",
				toolCallId: "c2",
				input: { command: "git commit -m x", cwd: "/main-repo" },
			}),
		).toBeUndefined();
		expect(handler?.({ toolName: "bash", toolCallId: "c3", input: {} })).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("a throwing seam allows the call instead of taking bash down", () => {
		setGitRunForTests(() => {
			throw new Error("spawn failed");
		});
		const [handler] = register();
		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c4",
				input: { command: "git commit -m x", cwd: "/main-repo" },
			}),
		).toBeUndefined();
	});
});
