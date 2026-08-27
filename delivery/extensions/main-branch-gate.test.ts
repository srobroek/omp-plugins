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
		expect(tokenize("git commit -m 'fix main bug'").map(t => t.text)).toEqual([
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
		expect(findCommitInvocations("dgit commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
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

	// A `cd` is not followed, whatever separator carries it. Three attempts to infer the
	// directory from one each produced silent permits: the gate read a directory the commit
	// never ran in and cleared a commit on a protected branch. Every shape below therefore
	// reports the same thing, and the caller states the repository with `cwd` or `-C`.
	test("no cd shape moves the repository the gate reads", () => {
		for (const command of [
			"cd /repo && git commit -m x",
			"cd /repo; git commit -m x",
			"cd /repo\ngit commit -m x",
			"cd /repo && cd sub && git commit -m x",
			"cd /missing; git commit -m x",
			"true || cd /feature && git commit -m x",
			"cd /feature && true & git commit -m x",
			"{ cd /protected && git commit -m x; }",
			"for d in a; do cd /protected; git commit -m x; done",
			"pushd /x && git commit -m x",
			"cd - && git commit -m x",
			"cd $TARGET && git commit -m x",
			"cd && git commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
	});

	test("-C is the one directory the command states, so it is the one applied", () => {
		expect(findCommitInvocations("cd /repo && git -C sub commit -m x")).toEqual([
			{ repoDir: "sub", dryRun: false },
		]);
		expect(findCommitInvocations("git -C /abs commit -m x")).toEqual([
			{ repoDir: "/abs", dryRun: false },
		]);
		// Quoting removes syntax meaning, not argv meaning: this still honours `-C`.
		expect(findCommitInvocations("git '-C' /abs commit -m x")).toEqual([
			{ repoDir: "/abs", dryRun: false },
		]);
		// A quoted operand is not an operator, so the scan does not stop at it.
		expect(findCommitInvocations("git -C '&&' commit -m x")).toEqual([
			{ repoDir: "&&", dryRun: false },
		]);
	});

	test("a quoted command name still runs, so it counts", () => {
		expect(findCommitInvocations("'git' commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	// Quoting splits a verb without changing argv, so the raw text carries no literal `commit`.
	// The walker always saw these; the prefilter in `decideCommit` is where the bug lived, so
	// that assertion is below in the decideCommit suite.
	test("a verb split by quoting is still a commit", () => {
		for (const command of ["git com'mit' -m x", 'git "commit" -m x', "git co''mmit -m x"]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
	});


	// Any substitution triggers a second, ADDITIVE pass with quotes neutralised. Deciding which
	// substitutions are inert cannot be done here: a stray apostrophe in a here-document body or
	// a comment is literal text yet poisons quote tracking, and a backtick nests through
	// backslashes. So every one is scanned, and over-detection only adds a block.
	test("a substitution is scanned however it is quoted or escaped", () => {
		for (const command of [
			'printf "%s" "$(git commit -m x)"',
			"printf '%s' \"$(\ngit commit -m x\n)\"",
			"printf '%s' \"$(printf ')'; git commit -m x)\"",
			"echo \"`git commit -m x`\"",
			"echo `git commit -m x`",
			"echo $(git commit -m x)",
			// The escape shapes that defeated a quote-aware detector.
			"printf '%s\\' \"$(git commit -m x)\"",
			"echo `echo \\`git commit -m x\\``",
			"cat <<EOF\n'$(git commit -m x)\nEOF",
			// A reserved word must not consume the command slot inside the substitution.
			'echo "$(if :; then git commit -m x; fi)"',
		]) {
			expect(findCommitInvocations(command).length, command).toBeGreaterThanOrEqual(1);
		}
	});

	// The additive pass may never WEAKEN what the first scan saw plainly. Each of these was a
	// silent permit when the lossy pass replaced the first one instead of adding to it.
	test("the fallback never removes a commit the first scan found", () => {
		// `--dry-run` here is message data that the quote-stripping pass promotes to an option.
		const promoted = findCommitInvocations('git commit -m "document --dry-run $(date)"');
		expect(promoted.some(c => !c.dryRun)).toBe(true);
		// An empty `-C` operand disappears when quotes go, letting the flag swallow the verb.
		expect(findCommitInvocations('git -C "" commit -m "$(date)"').length).toBeGreaterThanOrEqual(1);
		// A verb split across adjacent quoted fragments.
		expect(findCommitInvocations("git com'mit' -m x; echo \"$(date)\"").length).toBeGreaterThanOrEqual(1);
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

	test("a quoted operand that spans a newline is not a commit", () => {
		const quoted = [
			"bd comment omp-x --message '",
			"blocked by delivery (work lands on a branch, never on main): the repository this commit",
			"targets has main checked out. A later git commit verb in this prose is not an invocation.",
			"git commit -m x",
			"'",
		].join("\n");
		expect(findCommitInvocations(quoted)).toEqual([]);
	});

	// The deliberate cost of the additive pass. The same prose with a BACKTICK in it triggers a
	// second scan with quotes neutralised, which reads the quoted words as a command. Blocking
	// here is visible and retryable, by sending the prose without backticks or as two calls;
	// the alternative is clearing a commit hidden in a substitution that nobody read.
	test("prose carrying a backtick is blocked, and that is the trade", () => {
		const quoted = [
			"bd comment omp-x --message '",
			"targets has `main` checked out.",
			"git commit -m x",
			"'",
		].join("\n");
		expect(findCommitInvocations(quoted).length).toBeGreaterThanOrEqual(1);
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

	test("quoted git commit verb in another command is allowed on main", () => {
		const { run, calls } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		const quoted = [
			"bd comment omp-x --message '",
			"the repository this commit targets has main checked out.",
			"git commit -m x",
			"'",
		].join("\n");
		expect(decideCommit(quoted, "/work", {})).toBeUndefined();
		expect(calls).toEqual([]);
	});

	// The same prose with a BACKTICK is blocked, because a backtick may open a substitution and
	// the additive scan cannot tell prose from one. Visible and retryable: drop the backticks or
	// send the prose as its own call. The alternative is clearing a commit hidden in a
	// substitution, which nobody would see.
	test("the same prose with a backtick is refused, deliberately", () => {
		const { run } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		const quoted = ["bd comment omp-x --message '", "has `main` checked out.", "git commit -m x", "'"].join(
			"\n",
		);
		expect(decideCommit(quoted, "/work", {})?.block).toBe(true);
	});

	// The prefilter used to require a literal `commit` in the raw text, so a verb split by
	// quoting returned early and a real commit on a protected branch went through. It now looks
	// for the command word alone.
	test("a verb split by quoting still reaches the branch check", () => {
		for (const command of ["git com'mit' -m x", 'git "commit" -m x', "git co''mmit -m x"]) {
			const { run, calls } = fakeGit({ "/work": "main" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/work", {})?.block, command).toBe(true);
			expect(calls.map(c => c.cwd), command).toEqual(["/work"]);
		}
	});

	test("a genuine commit on main is still refused", () => {
		const { run } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		expect(decideCommit("git commit -m x", "/work", {})?.block).toBe(true);
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

	// The gate reads the directory it is GIVEN. A `cd` does not move it, in either direction:
	// it neither clears a commit on a protected branch nor redirects one away from it.
	test("a cd never moves the repository that is read", () => {
		for (const command of [
			"cd /sibling && git commit -m x",
			"cd /sibling; git commit -m x",
			"cd /sibling | git commit -m x",
			"cd - && git commit -m x",
			"pushd /sibling && git commit -m x",
		]) {
			const { run, calls } = fakeGit({ "/session": "main", "/sibling": "feat/x" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/session", {})?.block, command).toBe(true);
			expect(calls.map(c => c.cwd), command).toEqual(["/session"]);
		}
	});

	// So the caller states the repository instead, by the two routes the message names.
	test("cwd and an absolute -C are the routes that work", () => {
		const first = fakeGit({ "/session": "main", "/sibling": "feat/x" });
		setGitRunForTests(first.run);
		expect(decideCommit("git commit -m x", "/sibling", {})).toBeUndefined();
		expect(first.calls.map(c => c.cwd)).toEqual(["/sibling"]);

		const second = fakeGit({ "/session": "main", "/sibling": "feat/x" });
		setGitRunForTests(second.run);
		expect(decideCommit("git -C /sibling commit -m x", "/session", {})).toBeUndefined();
		expect(second.calls.map(c => c.cwd)).toEqual(["/sibling"]);

		// And an absolute `-C` onto a protected branch still blocks.
		const third = fakeGit({ "/session": "feat/x", "/trunk": "main" });
		setGitRunForTests(third.run);
		expect(decideCommit("git -C /trunk commit -m x", "/session", {})?.block).toBe(true);
		expect(third.calls.map(c => c.cwd)).toEqual(["/trunk"]);
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

	test("the override comes from the environment, never from the command text", () => {
		const { run, calls } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("git commit -m x", "/work", { DELIVERY_ALLOW_MAIN_COMMIT: "1" }),
		).toBeUndefined();
		expect(calls).toEqual([]);

		expect(
			decideCommit("git commit -m x", "/work", { DELIVERY_ALLOW_MAIN_COMMIT: "0" })?.block,
		).toBe(true);
	});

	// Every one of these switched the gate off through text alone. A commit message explaining
	// this gate contains exactly that prose, and a comment or here-document body is data the
	// shell never executes, so no scan of the command can authorise soundly.
	test("no command text grants the override", () => {
		for (const command of [
			"DELIVERY_ALLOW_MAIN_COMMIT=1 git commit -m x",
			"git commit -m 'DELIVERY_ALLOW_MAIN_COMMIT=1'",
			'git commit -m "set DELIVERY_ALLOW_MAIN_COMMIT=1 to override"',
			'"DELIVERY_ALLOW_MAIN_COMMIT=1" git commit -m x',
			"git commit -m x # ; DELIVERY_ALLOW_MAIN_COMMIT=1 git commit",
			"git commit -F - <<'EOF'\nfix: mention DELIVERY_ALLOW_MAIN_COMMIT=1 here\nEOF",
			"export DELIVERY_ALLOW_MAIN_COMMIT=1 && git commit -m x",
		]) {
			const { run } = fakeGit({ "/work": "main" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/work", {})?.block, command).toBe(true);
		}
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
	test("names the branch, the fix, the target-repo route, and the override", () => {
		const reason = denyReason("main");
		expect(reason).toContain("main");
		expect(reason).toContain("git switch -c");
		// The route that actually works when the commit targets another repository.
		expect(reason).toContain("cwd");
		expect(reason).toContain("git -C");
		expect(reason).toContain("DELIVERY_ALLOW_MAIN_COMMIT=1");
		// It must not advertise a command-text form, which no longer exists.
		expect(reason).toContain("ENVIRONMENT");
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

	// Without this the override is reachable only by relaunching the session with the flag,
	// which clears every commit rather than the one the user authorised. Structured tool input
	// is safe to trust where command text is not: a message body cannot forge a field.
	test("the bash call's own env grants the override for that call", () => {
		const { run, calls } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		const [handler] = register();

		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c2",
				input: {
					command: "git commit -m x",
					cwd: "/main-repo",
					env: { DELIVERY_ALLOW_MAIN_COMMIT: "1" },
				},
			}),
		).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("an unrelated or falsy call env leaves the block in place", () => {
		const { run } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		const [handler] = register();

		for (const env of [{ SOMETHING_ELSE: "1" }, { DELIVERY_ALLOW_MAIN_COMMIT: "0" }, null]) {
			expect(
				handler?.({
					toolName: "bash",
					toolCallId: "c3",
					input: { command: "git commit -m x", cwd: "/main-repo", env },
				}),
			).toEqual(expect.objectContaining({ block: true }));
		}
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
