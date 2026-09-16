import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import mainBranchGate, {
	currentBranch,
	decideCommit,
	denyReason,
	extractCommand,
	findCommitInvocations,
	findGitInvocations,
	type GitOperation,
	type GitRun,
	PRIMARY_INDEX_OPERATIONS,
	setGitRunForTests,
	tokenize,
	UNDECIDED_REASON,
} from "./main-branch-gate.ts";

type TrustedSource = { path: string; text: string; mode?: string; type?: string };
const trustedSources: Record<string, TrustedSource[]> = {};

function steeredRepo(envName: string, body = `MUST authorize ${envName}=1 for this repository.`): string {
	const root = mkdtempSync(join("/tmp", "delivery-steering-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "CLAUDE.md"), `${body}\n`);
	trustedSources[root] = [{ path: "CLAUDE.md", text: `${body}\n` }];
	return root;
}

type Call = { argv: string[]; cwd: string };

/** A fake git seam over a fixed cwd -> branch table and trusted remote-default tree. */
function fakeGit(
	table: Record<string, string>,
	calls: Call[] = [],
): { run: GitRun; calls: Call[] } {
	const roots = Object.keys(table).sort((a, b) => b.length - a.length);
	const run: GitRun = (argv, cwd) => {
		calls.push({ argv, cwd });
		const root = roots.find((candidate) => cwd === candidate || cwd.startsWith(`${candidate}/`));
		if (root === undefined) return { exitCode: 128, stdout: "" };
        if (argv[1] === "rev-parse" && argv.includes("--show-toplevel")) return { exitCode: 0, stdout: `${root}\n` };
        if (argv[1] === "rev-parse" && argv.includes("--git-common-dir")) return { exitCode: 0, stdout: `${root}/.git\n` };
        if (argv[1] === "config" && argv[2] === "--get-all" && argv[3] === "remote.origin.url") return { exitCode: 0, stdout: `https://example.test/${root.replaceAll("/", "_")}.git\n` };
        if (argv[1] === "symbolic-ref") return { exitCode: 0, stdout: "refs/remotes/origin/main\n" };
        if (argv[1] === "ls-remote") return { exitCode: 0, stdout: `ref: refs/heads/main\tHEAD\n${"a".repeat(40)}\tHEAD\n` };
        if (argv[1] === "rev-parse" && argv.includes("--verify")) return { exitCode: 0, stdout: `${"a".repeat(40)}\n` };
        if (argv[1] === "ls-tree") {
            const entries = trustedSources[root] ?? [];
            return { exitCode: 0, stdout: entries.map((entry) => `${entry.mode ?? "100644"} ${entry.type ?? "blob"} ${"a".repeat(40)}\t${entry.path}\0`).join("") };
        }
		if (argv[1] === "show") {
			const path = argv.at(-1)?.split(":").at(-1);
			const entry = (trustedSources[root] ?? []).find((candidate) => candidate.path === path);
			return entry ? { exitCode: 0, stdout: entry.text } : { exitCode: 1, stdout: "" };
		}
		return { exitCode: 0, stdout: `${table[root]}\n` };
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
		expect(tokenize("git commit -m 'fix main bug'").map((t) => t.text)).toEqual(
			["git", "commit", "-m", "fix main bug"],
		);
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

	test("path-qualified git commands are scanned", () => {
		expect(findCommitInvocations("/usr/bin/git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations("/opt/homebrew/bin/dgit commit -m x")).toEqual(
			[{ repoDir: null, dryRun: false }],
		);
	});

	test("direct git commit helpers are scanned", () => {
		expect(
			findCommitInvocations(
				"/Library/Developer/CommandLineTools/usr/libexec/git-core/git-commit -m x",
			),
		).toEqual([{ repoDir: null, dryRun: false }]);
		expect(
			findCommitInvocations("/usr/libexec/git-core/git-commit --dry-run"),
		).toEqual([{ repoDir: null, dryRun: true }]);
	});

	test("-C names the target repository, and repeats fold", () => {
		expect(findCommitInvocations("git -C /repo commit -m x")).toEqual([
			{ repoDir: "/repo", dryRun: false },
		]);
		expect(findCommitInvocations("git -C /repo -C sub commit -m x")).toEqual([
			{ repoDir: "/repo/sub", dryRun: false },
		]);
		expect(findCommitInvocations("git -C/protected commit -m x")).toEqual([
			{ repoDir: "/protected", dryRun: false },
		]);
		expect(
			findCommitInvocations("git -C omp-plugins -C delivery -C .. commit -m x"),
		).toEqual([{ repoDir: "omp-plugins/delivery/..", dryRun: false }]);
		expect(
			findCommitInvocations("git -C rel -C /absolute -C child commit -m x"),
		).toEqual([{ repoDir: "/absolute/child", dryRun: false }]);
		expect(findCommitInvocations("git -C rel -C.. commit -m x")).toEqual([
			{ repoDir: "rel/..", dryRun: false },
		]);
		expect(findCommitInvocations("git -C commit -m x")).toEqual([]);
	});

	test("pre-verb value options do not swallow the verb", () => {
		expect(findCommitInvocations("git -c user.name=x commit -m y")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// This previously asserted `repoDir: null` and nothing else, which WAS the silent permit:
		// the commit lands in `/r` while the gate reads the call's own cwd. Neither flag names a
		// directory this gate can check, so the invocation is marked instead.
		expect(
			findCommitInvocations("git --git-dir /r/.git --work-tree /r commit -m y"),
		).toEqual([{ repoDir: null, dryRun: false, retargeted: true }]);
		// The `=` form is the one that escaped entirely: it never reached the value-flag branch.
		expect(findCommitInvocations("git --git-dir=/r/.git commit -m y")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		// `-c` and `--namespace` do not move the working tree, so they stay unmarked.
		expect(findCommitInvocations("git --namespace ns commit -m y")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	test("inline Git aliases fail closed", () => {
		for (const command of [
			"git -c alias.ci=commit ci -m x",
			"git -c=alias.ci=commit ci -m x",
			"git -c alias.ci=commit ci --dry-run",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
	});

	test("config-env Git aliases fail closed", () => {
		for (const command of [
			"git --config-env=alias.ci=ALIAS ci -m x",
			"git --config-env alias.ci=ALIAS ci -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		for (const command of [
			"git -c ALIAS.ci=commit ci -m x",
			"git --config-env=ALIAS.ci=ALIAS ci -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
	});

	test("inline Git config includes fail closed", () => {
		for (const command of [
			"git -c include.path=/tmp/aliases ci -m x",
			"git -c includeIf.gitdir:/repo.path=/tmp/aliases ci -m x",
			"git --config-env=include.path=CFG ci -m x",
			"git -c include.path=/tmp/aliases ci -m x",
			"git --config-env include.path=CFG ci -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
	});

	test("structured Git config aliases fail closed", () => {
		const env = {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "alias.ci",
			GIT_CONFIG_VALUE_0: "commit",
		};
		expect(decideCommit("git ci -m x", "/protected", env)?.block).toBe(true);
	});

	test("legacy structured Git config parameters fail closed", () => {
		const env = { GIT_CONFIG_PARAMETERS: "'alias.ci'='commit'" };
		expect(decideCommit("git ci -m x", "/protected", env)?.block).toBe(true);
	});

	test("fails closed before iterating an oversized Git config count", () => {
		const decision = decideCommit("git status", "/feature", { GIT_CONFIG_COUNT: "2147483647" });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("structured Git configuration");
	});

	test("command-prefix Git config aliases fail closed", () => {
		for (const command of [
			"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit git ci -m x",
			"env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit git ci -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
	});

	test("exported Git config aliases fail closed", () => {
		const command =
			"export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit; git ci -m x";
		expect(findCommitInvocations(command)).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
	});

	test("command-prefix Git config policy is Git-scoped and fail closed", () => {
		expect(findCommitInvocations("GIT_CONFIG_COUNT=1 git status")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(findCommitInvocations("GIT_CONFIG_COUNT=1 printf hello")).toEqual(
			[],
		);
	});

	test("structured Git config uncertainty overrides dry-run", () => {
		const env = {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "alias.ci",
			GIT_CONFIG_VALUE_0: "commit",
		};
		expect(decideCommit("git commit --dry-run", "/feature", env)?.block).toBe(
			true,
		);
	});

	test("structured Git config does not block unrelated commands", () => {
		const env = {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "alias.ci",
			GIT_CONFIG_VALUE_0: "commit",
		};
		expect(decideCommit("printf hello", "/protected", env)).toBeUndefined();
		expect(decideCommit('echo "$HOME"', "/protected", env)).toBeUndefined();
	});

	test("malformed config-env operands do not invent an alias", () => {
		for (const command of [
			"git --config-env=alias.ci status",
			"git --config-env alias.ci status",
		]) {
			expect(findCommitInvocations(command), command).toEqual([]);
		}
	});

	test("config-env aliases block on a protected branch", () => {
		const { run, calls } = fakeGit({ "/protected": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("git --config-env=alias.ci=ALIAS ci -m x", "/protected", {
				ALIAS: "commit",
			})?.block,
		).toBe(true);
		expect(calls).toEqual([]);
	});
	test("dry-run is a commit option, not a message or path", () => {
		expect(findCommitInvocations("git commit --dry-run")).toEqual([
			{ repoDir: null, dryRun: true },
		]);
		for (const command of [
			"git commit -m --dry-run",
			"git commit --message --dry-run",
			"git commit -- --dry-run",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
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
		expect(
			findCommitInvocations("git commit -m a; git -C /r commit -m b"),
		).toEqual([
			{ repoDir: null, dryRun: false },
			{ repoDir: "/r", dryRun: false },
		]);
	});

	// ACCEPTED FALSE BLOCK, not an oversight. A function definition body is scanned, so
	// `f() { git commit ...; }` is refused on a protected branch although defining a function
	// commits nothing. Allowing it would require proving `f` is never called, and the two shapes
	// below are INDISTINGUISHABLE to this walker: the second really does commit. Deciding
	// between them needs the kind of shell inference that produced silent permits three times in
	// this file, so the visible refusal stands.
	test("a function definition is scanned, deliberately", () => {
		const definition = "f() { git commit --allow-empty -m x; }";
		expect(findCommitInvocations(definition)).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations(`${definition}; f`)).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	// SILENT PERMIT, found by review. Bash keeps an escaped quote inside the argument, but the
	// tokenizer closed the string on it, read the real closing quote as an opener, and swallowed
	// the separator and the commit after it. Nothing was reported and the commit landed.
	test("an escaped quote does not swallow the commit after it", () => {
		expect(findCommitInvocations('echo "x\\"y"; git commit -m x')).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations('echo "x\\\\"; git commit -m x')).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations('echo "\\$HOME"; git commit -m x')).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// A backslash inside SINGLE quotes is literal in bash, so nothing is escaped there.
		expect(findCommitInvocations("echo 'x\\'; git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// And a genuinely quoted commit stays inert.
		expect(findCommitInvocations('echo "git commit -m x"')).toEqual([]);
	});

	// A here-document body is DATA. Scanning it refused `cat <<EOF` with a commit in the body,
	// and an apostrophe in a body used to poison quote tracking through the delimiter and hide a
	// real commit after it, which was a silent permit.
	test("a here-document body is not scanned as commands", () => {
		expect(findCommitInvocations("cat <<EOF\ngit commit -m x\nEOF")).toEqual(
			[],
		);
		expect(findCommitInvocations("cat <<'EOF'\ngit commit -m x\nEOF")).toEqual(
			[],
		);
		// `<<-` strips leading TABS from the closing delimiter, and only tabs.
		expect(findCommitInvocations("cat <<-EOF\ngit commit -m x\n\tEOF")).toEqual(
			[],
		);
		// A spaced delimiter does not close a plain heredoc, so the body continues.
		expect(
			findCommitInvocations("cat <<EOF\n  EOF\ngit commit -m x\nEOF"),
		).toEqual([]);
		// Commands after the body, and on the operator's own line, still run.
		expect(
			findCommitInvocations("cat <<EOF\ndata\nEOF\ngit commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false }]);
		expect(
			findCommitInvocations("cat <<EOF && git commit -m x\ndata\nEOF"),
		).toEqual([{ repoDir: null, dryRun: false }]);
		// The permit this closes: the apostrophe no longer reaches the tokenizer at all.
		expect(
			findCommitInvocations("cat <<EOF\nit is o'clock\nEOF\ngit commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false }]);
		// `<<<` is a here-STRING whose operand is an ordinary word, so it is left alone.
		expect(findCommitInvocations("cat <<< hello; git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	// SILENT PERMIT, found by review. A shell prefix assignment never reaches the call's
	// environment, so `GIT_DIR=... git commit` retargeted the commit invisibly.
	test("a retargeting prefix assignment marks the invocation", () => {
		expect(findCommitInvocations("GIT_DIR=/r/.git git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(findCommitInvocations("GIT_WORK_TREE=/r git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(
			findCommitInvocations("env GIT_DIR=/r/.git git commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false, retargeted: true }]);
		// An unrelated assignment changes nothing.
		expect(findCommitInvocations("GIT_AUTHOR_NAME=x git commit -m y")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// The prefix applies to ITS command only, so it must not leak past a separator.
		expect(
			findCommitInvocations("GIT_DIR=/r/.git echo hi; git commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false }]);
	});

	// SILENT PERMITS the FIRST here-document implementation introduced, all four found by review.
	// Skipping text is the dangerous direction: anything wrongly skipped may hold a real commit,
	// so every uncertainty now falls back to NOT skipping.
	test("only a real here-document skips a body", () => {
		// `<<<` is a here-STRING. Reached at its second `<`, the old test saw `<<` followed by a
		// non-`<` and skipped a body that does not exist.
		expect(findCommitInvocations("cat <<< EOF\ngit commit -m x\nEOF")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// A `<<` inside a comment is text, not a redirection.
		expect(findCommitInvocations(": # <<EOF\ngit commit -m x\nEOF")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// An arithmetic shift shares the spelling, so the delimiter must look like a shell name.
		expect(findCommitInvocations("((1 << 1))\ngit commit -m x\n1")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// `<<\EOF` quotes the delimiter, so the backslash is not part of the name. Keeping it made
		// the terminator unmatchable and the body ran to the end of the string.
		expect(
			findCommitInvocations("cat <<\\EOF\npayload\nEOF\ngit commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false }]);
	});

	// Bodies are QUEUED per line and consumed in operator order. Recursing on the rest of the
	// operator line consumed the first body and then re-read the second as commands.
	test("every here-document queued on one line gets its own body", () => {
		expect(
			findCommitInvocations(
				"cat <<A <<B\nx\nA\ngit commit -m x\nB\ngit commit -m y",
			),
		).toEqual([{ repoDir: null, dryRun: false }]);
		expect(
			findCommitInvocations("cat <<A <<B\nx\nA\ny\nB\ngit commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false }]);
	});

	// A backslash before a newline is a LINE CONTINUATION: bash removes both and joins the words.
	// Appending the newline split the verb into a token nothing matched.
	test("a line continuation joins the word it splits", () => {
		expect(findCommitInvocations("git com\\\nmit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations('git "com\\\nmit" -m x')).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	// A CRLF body left `\r` on every line, so the terminator never matched and the body ran to
	// the end of the string, swallowing the commit after it.
	test("a CRLF here-document terminates", () => {
		expect(
			findCommitInvocations("cat <<EOF\r\nx\r\nEOF\r\ngit commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false }]);
	});

	// An unquoted `#` at the start of a word begins a comment, so a commented commit does not
	// run. Mid-word it is literal.
	test("a comment is not a command", () => {
		expect(findCommitInvocations("# git commit -m x")).toEqual([]);
		expect(findCommitInvocations("echo hi # git commit -m x")).toEqual([]);
		expect(findCommitInvocations("echo hi # nothing\ngit commit -m x")).toEqual(
			[{ repoDir: null, dryRun: false }],
		);
		// Mid-word and quoted forms are ordinary text.
		expect(findCommitInvocations("git commit -m a#b")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations('git commit -m "# x"')).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	// A selector AFTER the verb is an operand, not an option, so a message carrying one is an
	// ordinary commit rather than a retarget.
	test("a selector after the verb is message text", () => {
		expect(findCommitInvocations("git commit -m --git-dir=/tmp/other")).toEqual(
			[{ repoDir: null, dryRun: false }],
		);
		expect(
			findCommitInvocations("git --git-dir=/tmp/other commit -m x"),
		).toEqual([{ repoDir: null, dryRun: false, retargeted: true }]);
	});

	test("execution wrappers preserve the Git command", () => {
		for (const command of [
			"nice git commit -m x",
			"nice -n 5 git commit -m x",
			"nohup git commit -m x",
			"exec git commit -m x",
			"exec -a feature git commit -m x",
			"exec --argv0 feature git commit -m x",
			"exec -afeature git commit -m x",
			"exec --argv0=feature git commit -m x",
			"/bin/bash -c 'git commit -m x'",
			"/bin/sh -c 'git commit -m x'",
		]) {
			const { run } = fakeGit({ "/protected": "main" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/protected", {})?.block, command).toBe(
				true,
			);
		}
	});

	test("shell script execution always fails closed", () => {
		for (const command of [
			"/bin/bash -c 'echo hi'",
			"/bin/bash -lc 'git commit -m x'",
			"/bin/bash -c 'git commit --dry-run'",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
	});

	test("unknown wrappers cannot hide Git commit forms", () => {
		for (const command of [
			"xcrun git commit -m x",
			"xcrun git -c alias.ci=commit ci -m x",
			"xcrun /usr/libexec/git-core/git-commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		expect(findCommitInvocations("xcrun git status")).toEqual([]);
	});

	test("unknown wrappers cannot hide opaque Git argv", () => {
		expect(findCommitInvocations("xcrun $" + "{RUNNER} commit -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(findCommitInvocations("xcrun git $" + "{VERB} -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
	});

	test("argv-forwarding wrappers cannot hide Git commit forms", () => {
		expect(findCommitInvocations("xargs git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(findCommitInvocations("xargs git status")).toEqual([]);
		expect(findCommitInvocations("xargs $" + "{RUNNER} commit -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(
			findCommitInvocations("printf x | xargs sh -c 'git commit -m x'"),
		).toEqual([{ repoDir: null, dryRun: false, retargeted: true }]);
		const { run, calls } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit("printf x | xargs sh -c 'git commit -m x'", "/feature", {}),
		).toEqual(expect.objectContaining({ block: true }));
		expect(calls).toEqual([]);
	});

	test("time options do not hide the timed command", () => {
		for (const command of [
			"time git commit -m x",
			"time -p git commit -m x",
			"time -- git commit -m x",
			"time -p -- git commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
		expect(findCommitInvocations("time -p git commit --dry-run")).toEqual([
			{ repoDir: null, dryRun: true },
		]);
		expect(findCommitInvocations("time -p git status")).toEqual([]);
	});

	test("unknown time options fail closed", () => {
		expect(findCommitInvocations("time -o /tmp/out git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
	});

	test("ordinary commands mentioning Git are not wrappers", () => {
		for (const command of [
			"echo git commit",
			"printf git commit",
			"cat git commit",
		]) {
			expect(findCommitInvocations(command), command).toEqual([]);
		}
	});

	test("unknown wrapped helper dry-runs fail closed", () => {
		expect(findCommitInvocations("xcrun git-commit --dry-run")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
	});

	// SILENT PERMIT at the decision level. A retargeted commit lands in another repository, so
	// probing the call's own cwd cleared it. Nothing is read now, on any branch, because none of
	// these names a working directory this gate can check.
	test("a retargeted commit is refused without reading anything", () => {
		for (const [command, env] of [
			["git --git-dir=/protected/.git commit --allow-empty -m x", {}],
			["git --work-tree=/protected commit --allow-empty -m x", {}],
			["GIT_DIR=/protected/.git git commit --allow-empty -m x", {}],
			["git commit --allow-empty -m x", { GIT_DIR: "/protected/.git" }],
			["git commit --allow-empty -m x", { GIT_WORK_TREE: "/protected" }],
			["git commit --allow-empty -m x", { GIT_COMMON_DIR: "/protected/.git" }],
			["export GIT_DIR=/protected/.git && git commit --allow-empty -m x", {}],
			["export GIT_WORK_TREE=/protected; git commit --allow-empty -m x", {}],
			[
				"export GIT_COMMON_DIR=/protected/.git\ngit commit --allow-empty -m x",
				{},
			],
			[
				"GIT_DIR=/protected/.git; export GIT_DIR; git commit --allow-empty -m x",
				{},
			],
			[
				"GIT_WORK_TREE=/protected; export GIT_WORK_TREE; git commit --allow-empty -m x",
				{},
			],
			[
				"GIT_COMMON_DIR=/protected/.git; export GIT_COMMON_DIR; git commit --allow-empty -m x",
				{},
			],
			[
				"export OTHER=value GIT_DIR=/protected/.git && git commit --allow-empty -m x",
				{},
			],
			["env -i GIT_DIR=/protected/.git git commit --allow-empty -m x", {}],
			["env -- GIT_WORK_TREE=/protected git commit --allow-empty -m x", {}],
			[
				"env -u HOME GIT_COMMON_DIR=/protected/.git git commit --allow-empty -m x",
				{},
			],
			["env -S 'GIT_DIR=/protected/.git git commit -m x'", {}],
			["env --split-string='GIT_WORK_TREE=/protected git commit -m x'", {}],
			["env -S 'git commit -m x'", {}],
			['env -S"git commit -m x"', {}],
			["env -C /protected git commit -m x", {}],
			["env --chdir=/protected git commit -m x", {}],
			["sudo -C /protected git commit -m x", {}],
			["sudo --chdir=/protected git commit -m x", {}],
			["env -C/protected git commit -m x", {}],
			["env --ch=/protected git commit -m x", {}],
			["env --chd /protected git commit -m x", {}],
			["env --split='git commit -m x'", {}],
			["env -vS 'git commit -m x'", {}],
			["env -ivC/protected git commit -m x", {}],
			["env -S 'g\"i\"t commit -m x'", {}],
			["env --split-string='g\"i\"t commit -m x'", {}],
			["env -S '-C /protected g\"i\"t commit -m x'", {}],
			["env -S '$" + "{RUNNER} commit -m x'", { RUNNER: "git" }],
			["env -ivS '$" + "{RUNNER} commit -m x'", { RUNNER: "git" }],
			["env --split-string '$" + "{RUNNER} commit -m x'", { RUNNER: "git" }],
			["env -C/protected $" + "{RUNNER} commit -m x", { RUNNER: "git" }],
			["sudo -D /protected $" + "{RUNNER} commit -m x", { RUNNER: "git" }],
			["env -C /protected $" + "{RUNNER} commit -m x", { RUNNER: "git" }],
			["env --ch=/protected $" + "{RUNNER} commit -m x", { RUNNER: "git" }],
			["sudo --chdir=/protected $" + "{RUNNER} commit -m x", { RUNNER: "git" }],
		] as Array<[string, Record<string, string>]>) {
			const { run, calls } = fakeGit({
				"/feature": "feature",
				"/protected": "main",
			});
			setGitRunForTests(run);
			// `/feature` is safe, which is exactly why reading it was wrong.
			const decision = decideCommit(command, "/feature", env);
			expect(decision?.block, command).toBe(true);
			expect(decision?.reason, command).toContain("not readable here");
			expect(calls, command).toEqual([]);
		}
	});

	test("wrapper directory uncertainty overrides dry-run inference", () => {
		for (const command of [
			"env -C /protected git commit --dry-run",
			"sudo -D /protected git commit --dry-run",
		]) {
			const { run, calls } = fakeGit({ "/feature": "feature" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/feature", {})?.block, command).toBe(true);
			expect(calls, command).toEqual([]);
		}
	});

	test("wrapper retarget message names its actual uncertainty", () => {
		const decision = decideCommit(
			"env -C /protected git commit -m x",
			"/feature",
			{},
		);
		expect(decision?.reason).toContain("command-level target selector");
		expect(decision?.reason).not.toContain("--git-dir/--work-tree");
	});

	test("a non-Git command never claims a repository it does not name", () => {
		const { run, calls } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("printf x | xargs echo", "/main-repo", {}),
		).toBeUndefined();
		expect(
			decideCommit("find . -print0 | xargs -0 ls", "/main-repo", {}),
		).toBeUndefined();
		expect(decideCommit("xargs --help", "/main-repo", {})).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("xargs fails closed only for a payload that can reach Git", () => {
		for (const command of [
			"printf x | xargs sh -c 'git commit -m x'",
			"printf x | xargs env git commit -m x",
			"printf x | xargs $" + "{RUNNER} commit -m x",
			"printf x | xargs -I{} sh -c 'git commit -m x'",
			"printf x | xargs -0 git commit -m x",
			"printf x | xargs --unknown-option git commit -m x",
			"printf x | xargs >/dev/null sh -c 'git commit -m x'",
			"printf x | xargs > /dev/null sh -c 'git commit -m x'",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		for (const command of [
			"xargs echo",
			"xargs --help",
			"xargs -r",
			"find . -print0 | xargs -0 ls",
			"xargs echo sh",
			"xargs echo git",
			"xargs echo git commit",
			"xargs -n1 echo '$HOME'",
		]) {
			expect(findCommitInvocations(command), command).toEqual([]);
		}
	});

	test("a redirection never names the xargs payload", () => {
		for (const command of [
			"printf x | xargs >/dev/null git commit -m x",
			"printf x | xargs > /dev/null git commit -m x",
			"printf x | xargs 2>&1 git commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		expect(findCommitInvocations("printf x | xargs >/dev/null echo")).toEqual(
			[],
		);
	});

	test("an xargs option with an optional value keeps its payload", () => {
		for (const command of [
			"printf '{}\\n' | xargs --replace git commit --dry-run",
			"printf '{}\\n' | xargs --replace git commit -m x",
			"printf '{}\\n' | xargs -i git commit -m x",
			"printf '{}\\n' | xargs --eof git commit -m x",
			"printf '{}\\n' | xargs --replace={} git commit -m x",
			"printf '{}\\n' | xargs --eof=EOF git commit -m x",
			"printf '{}\\n' | xargs -I{} git commit -m x",
			"printf '{}\\n' | xargs -E EOF git commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		expect(findCommitInvocations("xargs --replace echo")).toEqual([]);
		expect(findCommitInvocations("xargs -i echo")).toEqual([]);
	});

	test("an expansion in a pre-verb option value fails closed", () => {
		for (const command of [
			'git -C "$DIR" commit -m x',
			"git -C $DIR commit -m x",
			"git -C$DIR commit -m x",
			'git --git-dir "$DIR" commit -m x',
			'git --work-tree "$DIR" commit -m x',
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		// A `-c` value can name the alias that renames the verb, so any verb is refused.
		for (const command of ['git -c "$CFG" ci -m x', 'git -c "$CFG" status']) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		// A `-C` value only decides WHERE, so an ordinary read stays allowed.
		expect(findCommitInvocations('git -C "$DIR" status')).toEqual([]);
	});

	test("a dynamic descriptor redirection stays grammar", () => {
		expect(tokenize("{fd}>out git commit -m x").map((t) => t.text)).toEqual([
			"{fd}>out",
			"git",
			"commit",
			"-m",
			"x",
		]);
		for (const command of [
			"{fd}>out git commit -m x",
			"{fd}>>out git commit -m x",
			"git {fd}>out commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
	});

	test("clustered xargs flags keep their payload readable", () => {
		for (const command of [
			"find . | xargs -0t ls",
			"find . | xargs -0p echo",
			"find . | xargs -t echo",
		]) {
			expect(findCommitInvocations(command), command).toEqual([]);
		}
		for (const command of [
			"find . | xargs -0t git commit -m x",
			"find . | xargs -0n1 git commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
	});

	test("a quoted redirection target does not make the operator argv", () => {
		for (const command of [
			"git >'out' commit -m x",
			"git 2>'out' commit -m x",
			"git >>'out' commit -m x",
			"git <'in' commit -m x",
			"git <>'file' commit -m x",
			"git >&'2' commit -m x",
			'git >"out" commit -m x',
			"git <<<'foo' commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
		expect(findCommitInvocations("git <<<'foo' commit --dry-run")).toEqual([
			{ repoDir: null, dryRun: true },
		]);
		// A quoted OPERATOR is an operand, so it names a directory rather than redirecting.
		expect(findCommitInvocations("git -C '>out' status")).toEqual([]);
		for (const command of [
			"git <<< hello commit -m x",
			"git <<< 'hello' commit -m x",
			"git > out commit -m x",
			"git 2> out commit -m x",
			"git >& 2 commit -m x",
			"git < in commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
	});

	test("a redirected commit is decided without probing another branch", () => {
		for (const command of [
			"git >/dev/null commit -m x",
			">/dev/null git commit -m x",
			"git \\\n commit -m x",
			"git >&2 commit -m x",
		]) {
			const { run, calls } = fakeGit({ "/main-repo": "main" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/main-repo", {})?.block, command).toBe(
				true,
			);
			expect(
				calls.map((call) => call.cwd),
				command,
			).toEqual(["/main-repo"]);
		}
		for (const command of [
			"printf x | xargs >/dev/null git commit -m x",
			"printf x | xargs > /dev/null sh -c 'git commit -m x'",
		]) {
			const { run, calls } = fakeGit({ "/main-repo": "main" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/main-repo", {})?.block, command).toBe(
				true,
			);
			expect(calls, command).toEqual([]);
		}
		const { run, calls } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit("git >/dev/null commit -m x", "/feature", {}),
		).toBeUndefined();
		expect(calls.map((call) => call.cwd)).toEqual(["/feature"]);
	});

	test("redirections do not hide the command or its verb", () => {
		for (const command of [
			"git >/dev/null commit -m x",
			"git>/dev/null commit -m x",
			">/dev/null git commit -m x",
			"env >/dev/null git commit -m x",
			"sudo 2>/dev/null git commit -m x",
			"git > out commit -m x",
			"git >>log commit -m x",
			"git <input commit -m x",
			"git 3<>file commit -m x",
			"git commit -m x >/dev/null",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
		expect(findCommitInvocations("git -C sub >/dev/null commit -m x")).toEqual([
			{ repoDir: "sub", dryRun: false },
		]);
		expect(findCommitInvocations("git commit --dry-run >/dev/null")).toEqual([
			{ repoDir: null, dryRun: true },
		]);
	});

	test("a redirection operator never reads as a separator", () => {
		expect(tokenize("git >&2 commit -m x").map((t) => t.text)).toEqual([
			"git",
			">&2",
			"commit",
			"-m",
			"x",
		]);
		for (const command of [
			"git >&2 commit -m x",
			"git 2>&1 commit -m x",
			"git >| out commit -m x",
			"git &>log commit -m x",
			"git&>log commit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
	});

	test("redirections stay grammar for ordinary commands", () => {
		expect(findCommitInvocations("git status >/dev/null")).toEqual([]);
		expect(findCommitInvocations("echo a>b")).toEqual([]);
		expect(findCommitInvocations('git commit -m "a>b"')).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// Bash rejects a redirection with no target, so refusing the later real commit is safe.
		expect(findCommitInvocations("git > && git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		expect(findCommitInvocations("git >")).toEqual([]);
	});

	test("a line continuation between words joins nothing", () => {
		expect(tokenize("git \\\n commit -m x").map((t) => t.text)).toEqual([
			"git",
			"commit",
			"-m",
			"x",
		]);
		for (const command of [
			"git \\\n commit -m x",
			"env \\\n git commit -m x",
			"git com\\\nmit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
	});

	test("an expansion that could be the verb fails closed", () => {
		for (const command of [
			"git $EMPTY commit --allow-empty -m x",
			"git com$" + "{EMPTY}mit --allow-empty -m x",
			'git "$VERB" -m x',
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false, retargeted: true },
			]);
		}
		const { run, calls } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("git `printf commit` -m x", "/main-repo", {})?.block,
		).toBe(true);
		expect(calls).toEqual([]);
	});

	test("an expansion outside the verb slot stays ordinary", () => {
		expect(findCommitInvocations("git status $ARGS")).toEqual([]);
		expect(findCommitInvocations("git -C $DIR status")).toEqual([]);
		expect(findCommitInvocations('git -C "$DIR" status')).toEqual([]);
		expect(findCommitInvocations('git commit -m "$MSG"')).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	test("attached env unset preserves an explicit git target", () => {
		const { run, calls } = fakeGit({
			"/feature": "feature",
			"/protected": "main",
		});
		setGitRunForTests(run);
		expect(
			decideCommit(
				"env -uGIT_DIR git -C /protected commit -m x",
				"/feature",
				{},
			)?.block,
		).toBe(true);
		expect(calls.map((call) => call.cwd)).toEqual(["/protected"]);
	});

	test("sudo options preserve the wrapped git command", () => {
		for (const command of [
			"sudo -u alice git commit -m x",
			"sudo --user alice git commit -m x",
			"sudo -r staff git commit -m x",
			"sudo --role staff git commit -m x",
			"sudo -a password git commit -m x",
			"sudo --authentication-type=password git commit -m x",
			"sudo -E git commit -m x",
			"sudo -nHE git commit -m x",
		]) {
			const { run, calls } = fakeGit({ "/protected": "main" });

			setGitRunForTests(run);
			expect(decideCommit(command, "/protected", {})?.block, command).toBe(
				true,
			);
			expect(
				calls.map((call) => call.cwd),
				command,
			).toEqual(["/protected"]);
		}
	});

	test("repeated relative -C selectors resolve from the bash call cwd", () => {
		const { run, calls } = fakeGit({ "/workspace/omp-plugins": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit(
				"git -C omp-plugins -C delivery -C .. commit -m x",
				"/workspace",
				{},
			)?.block,
		).toBe(true);
		expect(calls.map((call) => call.cwd)).toEqual(["/workspace/omp-plugins"]);
	});

	test("unknown sudo options fail closed", () => {
		const { run, calls } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit("sudo --unknown value git commit -m x", "/feature", {})
				?.block,
		).toBe(true);
		expect(calls).toEqual([]);
	});

	test("command options preserve the wrapped git command", () => {
		const { run, calls } = fakeGit({ "/protected": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("command -p git commit -m x", "/protected", {})?.block,
		).toBe(true);
		expect(calls.map((call) => call.cwd)).toEqual(["/protected"]);
	});

	test("unrelated exports do not invent a retarget", () => {
		const { run, calls } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit(
				"export OTHER=value; git commit --allow-empty -m x",
				"/feature",
				{},
			),
		).toBeUndefined();
		expect(calls.map((call) => call.cwd)).toEqual(["/feature"]);
	});

	test("every env split payload fails closed", () => {
		const { run, calls } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(decideCommit("env -S 'printf hello'", "/feature", {})?.block).toBe(
			true,
		);
		expect(calls).toEqual([]);
	});

	test("env option terminator makes the next dash-word the command", () => {
		const { run, calls } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit("env -- -C /protected git commit -m x", "/feature", {}),
		).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("a possibly skipped target export fails closed", () => {
		const { run, calls } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit(
				"false && export GIT_DIR=/protected/.git; git commit --allow-empty -m x",
				"/feature",
				{},
			),
		).toEqual(expect.objectContaining({ block: true }));
		expect(calls).toEqual([]);
	});

	test("an empty target variable is not a retarget", () => {
		const { run } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit("git commit --allow-empty -m x", "/feature", {
				GIT_DIR: "",
			}),
		).toBeUndefined();
	});

	test("a retargeted dry run still writes nothing, so it passes", () => {
		const { run } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(
			decideCommit(
				"git --git-dir=/protected/.git commit --dry-run -m x",
				"/feature",
				{},
			),
		).toBeUndefined();
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
		expect(findCommitInvocations("cd /repo && git -C sub commit -m x")).toEqual(
			[{ repoDir: "sub", dryRun: false }],
		);
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
		for (const command of [
			"git com'mit' -m x",
			'git "commit" -m x',
			"git co''mmit -m x",
		]) {
			expect(findCommitInvocations(command), command).toEqual([
				{ repoDir: null, dryRun: false },
			]);
		}
	});

	// A substitution appends ONE candidate when `PREFILTER` also matches the raw text,
	// without reading inside it. Deciding which substitutions are inert cannot be done here: a
	// stray apostrophe in a here-document body or a comment is literal text yet poisons quote
	// tracking, and a backtick nests through backslashes. Every shape below satisfies both halves,
	// so each yields a candidate whatever the quoting does to it.
	test("a substitution yields a candidate however it is quoted or escaped", () => {
		for (const command of [
			'printf "%s" "$(git commit -m x)"',
			"printf '%s' \"$(\ngit commit -m x\n)\"",
			"printf '%s' \"$(printf ')'; git commit -m x)\"",
			'echo "`git commit -m x`"',
			"echo `git commit -m x`",
			"echo $(git commit -m x)",
			// The escape shapes that defeated a quote-aware detector.
			"printf '%s\\' \"$(git commit -m x)\"",
			"echo `echo \\`git commit -m x\\``",
			"cat <<EOF\n'$(git commit -m x)\nEOF",
			// A reserved word must not consume the command slot inside the substitution.
			'echo "$(if :; then git commit -m x; fi)"',
		]) {
			expect(
				findCommitInvocations(command).length,
				command,
			).toBeGreaterThanOrEqual(1);
		}
	});

	// BOTH halves are required, and dropping either only avoids THIS candidate. Comments here got
	// this wrong four times: twice claiming one half alone, once implying that avoiding the
	// candidate meant passing the gate, and once calling the second half a COMMAND WORD when
	// `PREFILTER` is a raw-text match that prose, comments and paths satisfy.
	test("the candidate needs a substitution and a raw git/dgit word match, both", () => {
		// Substitution, no word match: nothing appended.
		expect(findCommitInvocations('echo "$(date)"')).toEqual([]);
		// Word match, no substitution: nothing appended, and nothing found by the scan either.
		expect(findCommitInvocations("git status")).toEqual([]);
		expect(findCommitInvocations("dgit push origin b")).toEqual([]);
		// Both halves: one candidate, from a command that commits nothing.
        // A push beside an unrelated substitution is not a commit candidate.
        expect(findCommitInvocations('dgit push origin b && echo "$(date)"')).toEqual([]);
        // The match is RAW TEXT, not command position. None of these run git at all, and each
        // still yields no candidate because no nested git operation is present.
        for (const command of [
            "echo 'the git tool is handy'; echo \"$(date)\"",
            "echo 'we push with dgit'; echo \"$(date)\"",
            'echo hi # git is nice\necho "$(date)"',
            'cat /opt/git-notes.txt; echo "$(date)"',
        ]) {
            expect(findCommitInvocations(command), command).toEqual([]);
        }
		// Near misses that must NOT match: `\b` needs a boundary on BOTH sides, and a word
		// character on either side removes one. `legit` and `digit` embed the letters without a
		// preceding boundary, and `gitx` lacks a following one.
		for (const command of [
			'echo "$(date)"; legit --help',
			'echo "$(date)"; digit --help',
			'echo "$(date)"; gitx --help',
		]) {
			expect(findCommitInvocations(command), command).toEqual([]);
		}
		// But a hyphen IS a boundary, which is easy to misread as a near miss.
        expect(findCommitInvocations('cat my-git.log; echo "$(date)"')).toEqual([]);
		// Avoiding the candidate is NOT passing the gate. This has no substitution, so no
		// candidate is appended, yet the scan finds the commit on its own.
		expect(findCommitInvocations("git commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
		// And `dgit` commits are real commits to the scan, substitution or not.
		expect(findCommitInvocations("dgit commit -m x")).toEqual([
			{ repoDir: null, dryRun: false },
		]);
	});

	// Appending may never WEAKEN what the quote-aware scan saw plainly. Each of these was a
	// silent permit in the version that replaced that scan with a quote-stripped one instead of
	// adding to it. The lossy pass is gone, and these hold the property that replaced it.
	test("appending never removes a commit the scan found", () => {
		// `--dry-run` here is message data that the quote-stripping pass promotes to an option.
		const promoted = findCommitInvocations(
			'git commit -m "document --dry-run $(date)"',
		);
		expect(promoted.some((c) => !c.dryRun)).toBe(true);
		// An empty `-C` operand disappears when quotes go, letting the flag swallow the verb.
		expect(
			findCommitInvocations('git -C "" commit -m "$(date)"').length,
		).toBeGreaterThanOrEqual(1);
		// A verb split across adjacent quoted fragments.
		expect(
			findCommitInvocations("git com'mit' -m x; echo \"$(date)\"").length,
		).toBeGreaterThanOrEqual(1);
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

	// The deliberate cost. A backtick anywhere in a command that `PREFILTER` also matches appends
	// a candidate, and prose quoting this gate's own message does both. It
	// only matters on a protected branch, where the remedy is removing the backticks and `$(`:
	// splitting into separate calls does NOT help, because each is scanned the same way and the
	// prose travels with it. The alternative is clearing a commit hidden in a substitution that
	// nobody read.
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
		expect(calls).toEqual([
			{ argv: ["git", "branch", "--show-current"], cwd: "/work" },
		]);
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
			expect.objectContaining({
				block: true,
				reason: expect.stringContaining("main"),
			}),
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
	// nothing short of a shell parser tells prose from one. The remedy is dropping the backticks;
	// resending the same text as a separate call does NOT help, because it is scanned identically.
	// The alternative is clearing a commit hidden in a substitution, which nobody would see.
	test("the same prose with a backtick is refused, deliberately", () => {
		const { run } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		const quoted = [
			"bd comment omp-x --message '",
			"has `main` checked out.",
			"git commit -m x",
			"'",
		].join("\n");
		expect(decideCommit(quoted, "/work", {})?.block).toBe(true);
	});

	// The prefilter used to require a literal `commit` in the raw text, so a verb split by
	// quoting returned early and a real commit on a protected branch went through. `PREFILTER`
	// now omits the verb entirely.
	test("a verb split by quoting still reaches the branch check", () => {
		for (const command of [
			"git com'mit' -m x",
			'git "commit" -m x',
			"git co''mmit -m x",
		]) {
			const { run, calls } = fakeGit({ "/work": "main" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/work", {})?.block, command).toBe(true);
			expect(
				calls.map((c) => c.cwd),
				command,
			).toEqual(["/work"]);
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
		expect(decideCommit("git -C sub commit -m x", "/work", {})?.block).toBe(
			true,
		);
		expect(calls.map((c) => c.cwd)).toEqual(["/work/sub"]);
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
			const { run, calls } = fakeGit({
				"/session": "main",
				"/sibling": "feat/x",
			});
			setGitRunForTests(run);
			expect(decideCommit(command, "/session", {})?.block, command).toBe(true);
			expect(
				calls.map((c) => c.cwd),
				command,
			).toEqual([]);
		}
	});

	// So the caller states the repository instead, by the two routes the message names.
	test("cwd and an absolute -C are the routes that work", () => {
		const first = fakeGit({ "/session": "main", "/sibling": "feat/x" });
		setGitRunForTests(first.run);
		expect(decideCommit("git commit -m x", "/sibling", {})).toBeUndefined();
		expect(first.calls.map((c) => c.cwd)).toEqual(["/sibling"]);

		const second = fakeGit({ "/session": "main", "/sibling": "feat/x" });
		setGitRunForTests(second.run);
		expect(
			decideCommit("git -C /sibling commit -m x", "/session", {}),
		).toBeUndefined();
		expect(second.calls.map((c) => c.cwd)).toEqual(["/sibling"]);

		// And an absolute `-C` onto a protected branch still blocks.
		const third = fakeGit({ "/session": "feat/x", "/trunk": "main" });
		setGitRunForTests(third.run);
		expect(
			decideCommit("git -C /trunk commit -m x", "/session", {})?.block,
		).toBe(true);
		expect(third.calls.map((c) => c.cwd)).toEqual(["/trunk"]);
	});

	test("blocks the second of two commits when only that repo is on main", () => {
		const { run } = fakeGit({ "/work": "feat/x", "/main-repo": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit(
				"git commit -m a && git -C /main-repo commit -m b",
				"/work",
				{},
			)?.block,
		).toBe(true);
	});

	test("--dry-run commits nothing, so it is never blocked and never spawns", () => {
		const { run, calls } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		expect(decideCommit("git commit --dry-run", "/work", {})).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("fails open when git cannot name a branch", () => {
		setGitRunForTests(() => ({
			exitCode: 128,
			stdout: "fatal: not a git repository",
		}));
		expect(decideCommit("git commit -m x", "/tmp/scratch", {})).toBeUndefined();

		setGitRunForTests(() => ({ exitCode: 0, stdout: "" }));
		expect(decideCommit("git commit -m x", "/detached", {})).toBeUndefined();

		setGitRunForTests(() => {
			throw new Error("no git binary");
		});
		expect(decideCommit("git commit -m x", "/work", {})).toBeUndefined();
	});

	test("the override requires environment plus target-repository steering", () => {
		const { run, calls } = fakeGit({ "/work": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("git commit -m x", "/work", {
				DELIVERY_ALLOW_MAIN_COMMIT: "1",
			})?.block,
		).toBe(true);
		expect(calls.length).toBeGreaterThan(0);

		expect(
			decideCommit("git commit -m x", "/work", {
				DELIVERY_ALLOW_MAIN_COMMIT: "0",
			})?.block,
		).toBe(true);
	});

	// Command text supplies neither authorization factor. A commit message explaining this gate
	// contains exactly that prose, and a comment or here-document body is data the shell never
	// executes, so no scan of the command can authorize soundly.
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
		for (const command of [
			"git status",
			"bun test",
			"echo commit",
			"git log --oneline",
		]) {
			expect(decideCommit(command, "/work", {})).toBeUndefined();
		}
		expect(calls).toEqual([]);
	});
});

describe("denyReason", () => {
	test("names the branch, the directory read, the fix, and the override", () => {
		const reason = denyReason("main", "/some/repo");
		expect(reason).toContain("main");
		// The directory whose branch was actually read. Claiming it was the bash call's cwd was
		// false whenever `-C` selected another repository.
		expect(reason).toContain("/some/repo");
		expect(reason).toContain("feature branch")
		// The route that actually works when the commit targets another repository.
		expect(reason).toContain("cwd");
		expect(reason).toContain("git -C");
		expect(reason).toContain("DELIVERY_ALLOW_MAIN_COMMIT=1");
		// It must not advertise a command-text form, which no longer exists.
		expect(reason).toContain("ENVIRONMENT");
	});

	test("a -C target is named, not the call's cwd", () => {
		const { run } = fakeGit({ "/work": "feature", "/protected": "main" });
		setGitRunForTests(run);
		const decision = decideCommit("git -C /protected commit -m x", "/work", {});
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("/protected");
		expect(decision?.reason).not.toContain("bash call's own working");
	});
});

describe("a commit inside a substitution", () => {
test("opaque nested commits fail closed without probing the outer cwd", () => {
	const { run, calls } = fakeGit({ "/protected": "main" });
	setGitRunForTests(run);
	expect(decideCommit('echo "$(git commit -m x)"', "/protected", {})?.block).toBe(true);
	expect(calls).toEqual([]);
});

test("harmless substitutions are not broadly blocked", () => {
	const { run } = fakeGit({ "/feature": "feature" });
	setGitRunForTests(run);
	expect(decideCommit('echo "$(date)"; git status', "/feature", {})).toBeUndefined();
	expect(decideCommit('git log --format="$(cat f)"', "/feature", {})).toBeUndefined();
});

	// The FULL cost, asserted so nobody understates it again. The predicate is any substitution
	// plus a `PREFILTER` match, neither needing anything to do with the other, so on a protected
	// branch ordinary read-only work is refused whenever a substitution rides along.
test("harmless substitutions are not broadly blocked", () => {
	const { run } = fakeGit({ "/feature": "feature" });
	setGitRunForTests(run);
	expect(decideCommit('echo "$(date)"; git status', "/feature", {})).toBeUndefined();
	expect(decideCommit('git log --format="$(cat f)"', "/feature", {})).toBeUndefined();
});

	// Dropping either half avoids the CANDIDATE. These clear the gate as well, but only because
	// none of them is a commit: `git commit -m x` drops the substitution half and still blocks.
	test("dropping either half avoids the candidate", () => {
		for (const command of [
			'echo "$(date)"',
			"git status",
			"git log --format=%h",
		]) {
			const { run } = fakeGit({ "/protected": "main" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/protected", {}), command).toBeUndefined();
		}
		// The distinction that matters: no substitution, still blocked, on the ordinary scan.
		const { run } = fakeGit({ "/protected": "main" });
		setGitRunForTests(run);
		expect(decideCommit("git commit -m x", "/protected", {})?.block).toBe(true);
	});

	// None of that reaches a feature branch, which is where work belongs.
	test("the same commands are untouched on a feature branch", () => {
		for (const command of [
			'echo "$(date)"; git status',
			'git log --format="$(cat f)"',
		]) {
			const { run } = fakeGit({ "/feature": "feature" });
			setGitRunForTests(run);
			expect(decideCommit(command, "/feature", {}), command).toBeUndefined();
		}
	});

	// A blocked `git status` is baffling without this: the message must name the substitution.
	// It must also give the RIGHT remedy, which differs by where the substitution sits.
    test("the reason explains nested substitutions and the rewrite remedy", () => {
        const { run } = fakeGit({ "/protected": "main" });
        setGitRunForTests(run);
        const reason = decideCommit('echo "$(git commit -m x)"', "/protected", {})?.reason ?? "";
        expect(reason).toContain("command-level target selector");
        expect(reason).toContain("rewrite");
    });

	// Both remedies are asserted to actually clear the block, not merely described.
	test("each remedy works on the case it is offered for", () => {
		// Unrelated substitution: sending the git command by itself passes.
		const first = fakeGit({ "/protected": "main" });
		setGitRunForTests(first.run);
		expect(decideCommit("git status", "/protected", {})).toBeUndefined();

		// Substitution inside the git command: splitting is NOT enough, which is why the
		// message does not offer it here.
        expect(
            decideCommit('echo "$(git commit -m x)"', "/protected", {})?.block,
        ).toBe(true);

		// Replacing the substitution with the value read earlier is what clears it.
		const third = fakeGit({ "/protected": "main" });
		setGitRunForTests(third.run);
		expect(
			decideCommit('git log --format="%h %s"', "/protected", {}),
		).toBeUndefined();
	});

	// The boundary that keeps this a main-branch gate. Blocking every substitution regardless
	// of branch was tried, and it refuses `echo "$(git status)"` on a feature branch: not this
	// gate's job, and the kind of control people switch off.
	test("is allowed on a feature branch", () => {
		const { run } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
        expect(
            decideCommit('echo "$(git commit -m x)"', "/feature", {}),
        ).toMatchObject({ block: true });
		expect(
			decideCommit('echo "$(git status)"', "/feature", {}),
		).toBeUndefined();
		expect(
			decideCommit('git log --format="$(cat f)"', "/feature", {}),
		).toBeUndefined();
	});

	test("an outer --dry-run does not cover the nested commit", () => {
		// The outer command writes nothing, but the substitution runs a real commit. Appending
		// the candidate only when the scan found nothing left this permitted on main.
        const command = 'git commit --dry-run -m "$(git commit -m x)"';
        expect(findCommitInvocations(command)).toEqual([
            { repoDir: null, dryRun: true },
            { repoDir: null, dryRun: false, retargeted: true },
        ]);
        expect(decideCommit(command, "/protected", {})?.block).toBe(true);
	});

	test("a verb split by quoting inside the substitution still counts", () => {
		// There is no literal `commit` in this text, which is why the condition is a `PREFILTER`
		// match on the raw string rather than the verb.
		const { run } = fakeGit({ "/protected": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit("echo \"$(git com'mit' -m x)\"", "/protected", {})?.block,
		).toBe(true);
	});

    test("a -C inside an opaque substitution fails closed", () => {
        const { run } = fakeGit({ "/feature": "feature", "/protected": "main" });
        setGitRunForTests(run);
        expect(decideCommit('echo "$(git -C /protected commit -m x)"', "/feature", {})).toMatchObject({ block: true });
    });

	test("the override requires repository steering", () => {
		const { run } = fakeGit({ "/protected": "main" });
		setGitRunForTests(run);
		expect(
			decideCommit('echo "$(git commit -m x)"', "/protected", {
				DELIVERY_ALLOW_MAIN_COMMIT: "1",
			})?.block,
		).toBe(true);
	});
});
describe("integration", () => {
	type Handler = (event: unknown, context?: { cwd?: string }) => unknown;
	function register(): Handler[] {
		const handlers: Record<string, Handler[]> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: Handler) => {
				const eventHandlers = handlers[event] ?? [];
				eventHandlers.push(handler);
				handlers[event] = eventHandlers;
			},
		};
		mainBranchGate(fakePi as never);
		return handlers.tool_call as Handler[];
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
		expect(calls.map((c) => c.cwd)).toEqual(["/main-repo"]);
	});

	// The Bash call's environment is one required factor, not authorization by itself; exact
	// target-repository steering is also required, while command text cannot forge either factor.
	test("omitted input cwd uses the session context cwd", () => {
		const { run } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		const [handler] = register();
		expect(handler?.({ toolName: "bash", input: { command: "git commit -m x" } }, { cwd: "/main-repo" })).toEqual(expect.objectContaining({ block: true }));
	});

	test("relative input cwd resolves from the session context cwd", () => {
		const { run } = fakeGit({ "/main-repo/nested": "main" });
		setGitRunForTests(run);
		const [handler] = register();
		expect(handler?.({ toolName: "bash", input: { command: "git commit -m x", cwd: "nested" } }, { cwd: "/main-repo" })).toEqual(expect.objectContaining({ block: true }));
	});

	test("an unrelated session cwd remains unblocked", () => {
		const { run } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		const [handler] = register();
		expect(handler?.({ toolName: "bash", input: { command: "git commit -m x" } }, { cwd: "/feature" })).toBeUndefined();
	});
	test("the Bash call's env alone does not grant the override", () => {
		const { run } = fakeGit({ "/main-repo": "main" });
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
		).toEqual(expect.objectContaining({ block: true }));
	});

	test("the bash call env cannot inject a Git alias", () => {
		const { run, calls } = fakeGit({ "/main-repo": "feature" });
		setGitRunForTests(run);
		const [handler] = register();
		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c-config",
				input: {
					command: "git ci -m x",
					cwd: "/main-repo",
					env: { GIT_CONFIG_PARAMETERS: "'alias.ci'='commit'" },
				},
			}),
		).toEqual(expect.objectContaining({ block: true }));
		expect(calls).toEqual([]);
	});

	test("the bash call env cannot hide the Git command name", () => {
		const [handler] = register();
		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c-runner",
				input: {
					command: "$" + "{RUNNER} commit -m x",
					cwd: "/main-repo",
					env: { RUNNER: "/usr/bin/git" },
				},
			}),
		).toEqual(expect.objectContaining({ block: true }));
	});

	test("the bash call env cannot hide both Git and commit", () => {
		const [handler] = register();
		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c-runner-verb",
				input: {
					command: "$" + "{RUNNER} $" + "{VERB} -m x",
					cwd: "/main-repo",
					env: { RUNNER: "/usr/bin/git", VERB: "commit" },
				},
			}),
		).toEqual(expect.objectContaining({ block: true }));
	});

	test("the bash call env cannot expand Git and commit from one word", () => {
		const [handler] = register();
		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c-runner-multiword",
				input: {
					command: "$RUNNER -m x",
					cwd: "/main-repo",
					env: { RUNNER: "git commit" },
				},
			}),
		).toEqual(expect.objectContaining({ block: true }));
	});

	test("the bash call env cannot expand a complete Git commit command", () => {
		const [handler] = register();
		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c-runner-complete",
				input: {
					command: "$RUNNER",
					cwd: "/main-repo",
					env: { RUNNER: "git commit --allow-empty -m x" },
				},
			}),
		).toEqual(expect.objectContaining({ block: true }));
	});

	test("unquoted variable commands fail closed", () => {
		expect(findCommitInvocations("$" + "{RUNNER} status")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(findCommitInvocations("env $" + "{RUNNER} commit -m x")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(findCommitInvocations("$" + "{RUNNER} commit --dry-run")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(
			findCommitInvocations("$" + "{RUNNER} -c alias.ci=commit ci -m x"),
		).toEqual([{ repoDir: null, dryRun: false, retargeted: true }]);
		expect(
			findCommitInvocations(
				"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci $" + "{RUNNER} ci -m x",
			),
		).toEqual([{ repoDir: null, dryRun: false, retargeted: true }]);
		expect(findCommitInvocations("$RUNNER")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
	});

	test("unquoted opaque commands fail closed before ordinary argv", () => {
		expect(findCommitInvocations("$RUNNER ordinary")).toEqual([
			{ repoDir: null, dryRun: false, retargeted: true },
		]);
		expect(findCommitInvocations("'$RUNNER' ordinary")).toEqual([]);
	});

	test("structured config cannot hide a variable alias command", () => {
		const [handler] = register();
		expect(
			handler?.({
				toolName: "bash",
				toolCallId: "c-variable-alias",
				input: {
					command: "$" + "{RUNNER} ci -m x",
					cwd: "/main-repo",
					env: {
						RUNNER: "/usr/bin/git",
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: "alias.ci",
						GIT_CONFIG_VALUE_0: "commit",
					},
				},
			}),
		).toEqual(expect.objectContaining({ block: true }));
	});

	test("an unrelated or falsy call env leaves the block in place", () => {
		const { run } = fakeGit({ "/main-repo": "main" });
		setGitRunForTests(run);
		const [handler] = register();

		for (const env of [
			{ SOMETHING_ELSE: "1" },
			{ DELIVERY_ALLOW_MAIN_COMMIT: "0" },
			null,
		]) {
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
		expect(
			handler?.({ toolName: "bash", toolCallId: "c3", input: {} }),
		).toBeUndefined();
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
describe("nested substitution integration", () => {
    test("registered main handler rejects a nested commit chain", () => {
        const { run } = fakeGit({ "/main-repo": "main" });
        setGitRunForTests(run);
        const [handler] = register();
        expect(handler?.({
            toolName: "bash",
            toolCallId: "nested-main",
            input: { command: 'echo "$(git commit -m x)"', cwd: "/main-repo" },
        })).toMatchObject({ block: true });
    });
});
});
test("absolute Git after a cwd transition resolves the transitioned main repository", () => {
	const { run, calls } = fakeGit({ "/main-repo": "main", "/feature": "feature" });
	setGitRunForTests(run);
	const command = "cd /main-repo && /usr/bin/git commit -m x";
	expect(decideCommit(command, "/feature")?.block, command).toBe(true);
	expect(calls.map((call) => call.cwd)).toEqual(["/main-repo"]);
});

test("mixed cwd transitions never reuse the first transition", () => {
	const { run } = fakeGit({ "/main-repo": "main", "/feature": "feature" });
	setGitRunForTests(run);
	for (const command of [
		"cd /feature && /usr/bin/git status; cd /main-repo && git commit -m x",
		"cd /feature && /usr/bin/git status && cd /main-repo && git commit -m x",
		"cd /feature && /usr/bin/git status || cd /main-repo && git commit -m x",
		"cd /feature && /usr/bin/git status\ncd /main-repo && git commit -m x",
		"cd /feature && (/usr/bin/git status; cd /main-repo && git commit -m x)",
		"cd /feature && /usr/bin/git status; cd /main-repo && /bin/git commit -m x",
	]) {
		expect(decideCommit(command, "/feature")?.block, command).toBe(true);
	}
});

describe("repository steering", () => {
    test("accepts an exact root directive from a nested cwd", () => {
        const root = steeredRepo("DELIVERY_ALLOW_MAIN_COMMIT", "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.");
        try {
            const { run } = fakeGit({ [root]: "main" });
            setGitRunForTests(run);
            expect(decideCommit("git commit -m x", join(root, "src"), { DELIVERY_ALLOW_MAIN_COMMIT: "1" })).toBeUndefined();
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

	test("accepts a direct rule and rejects incidental text, symlinks, and vetoes", () => {
		const ruleRoot = steeredRepo("DELIVERY_ALLOW_MAIN_COMMIT", "not this line");
		const vetoRoot = steeredRepo("DELIVERY_ALLOW_MAIN_COMMIT");
		const symlinkRoot = steeredRepo("DELIVERY_ALLOW_MAIN_COMMIT");
		try {
			rmSync(join(ruleRoot, "CLAUDE.md"));
			mkdirSync(join(ruleRoot, ".omp", "rules"), { recursive: true });
			writeFileSync(
				join(ruleRoot, ".omp", "rules", "allow.md"),
				"MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n",
			);
			trustedSources[ruleRoot] = [{ path: ".omp/rules/allow.md", text: "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n" }];
			mkdirSync(join(vetoRoot, ".omp", "rules"), { recursive: true });
			writeFileSync(
				join(vetoRoot, ".omp", "rules", "deny.md"),
				"MUST NOT authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n",
			);
			trustedSources[vetoRoot] = [
				{ path: "CLAUDE.md", text: "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n" },
				{ path: ".omp/rules/deny.md", text: "MUST NOT authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n" },
			];
			const real = join(symlinkRoot, "real.md");
			rmSync(join(symlinkRoot, "CLAUDE.md"));
			writeFileSync(real, "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n");
			symlinkSync(real, join(symlinkRoot, "CLAUDE.md"));
			trustedSources[symlinkRoot] = [{ path: "CLAUDE.md", text: "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n", mode: "120000" }];
			const { run } = fakeGit({ [ruleRoot]: "main", [vetoRoot]: "main", [symlinkRoot]: "main" });
			setGitRunForTests(run);
			const env = { DELIVERY_ALLOW_MAIN_COMMIT: "1" };
			expect(decideCommit("git commit -m x", ruleRoot, env)).toBeUndefined();
			expect(decideCommit("git commit -m x", vetoRoot, env)?.block).toBe(true);
			expect(decideCommit("git commit -m x", symlinkRoot, env)?.block).toBe(true);
		} finally {
			for (const root of [ruleRoot, vetoRoot, symlinkRoot]) rmSync(root, { recursive: true, force: true });
		}
	});

	test("scopes authorization to each -C target and does not let one invocation grant another", () => {
		const allowed = steeredRepo("DELIVERY_ALLOW_MAIN_COMMIT");
		const denied = steeredRepo("DELIVERY_ALLOW_MAIN_COMMIT", "unrelated text");
		try {
			const { run } = fakeGit({ [allowed]: "main", [denied]: "main" });
			setGitRunForTests(run);
			const env = { DELIVERY_ALLOW_MAIN_COMMIT: "1" };
            expect(decideCommit(`git -C ${allowed} commit -m x`, denied, env)).toBeUndefined();
			expect(decideCommit(`git -C ${denied} commit -m x`, allowed, env)?.block).toBe(true);
			expect(
				decideCommit(`git -C ${allowed} commit -m a && git -C ${denied} commit -m b`, allowed, env)?.block,
			).toBe(true);
		} finally {
			rmSync(allowed, { recursive: true, force: true });
			rmSync(denied, { recursive: true, force: true });
		}
	});

	test("explains that unreadable commands must be rewritten before authorization", () => {
		const { run } = fakeGit({ "/protected": "main" });
		setGitRunForTests(run);
		const reason = decideCommit("exec $RUNNER git commit -m x", "/protected", {
			DELIVERY_ALLOW_MAIN_COMMIT: "1",
		})?.reason;
		expect(reason).toContain("First rewrite the command into a readable form");
		expect(reason).toContain("Do not try to clear this refusal with environment variables");
		expect(reason).toContain("Only after the rewritten operation is readable");
		expect(reason).toContain("target repository must contain");
	});

});

describe("readable index operations", () => {
	test.each<[string, GitOperation, string[]]>([
		["git add -- src/a.ts", "stage", ["src/a.ts"]],
		["git add -- src/a.ts src/b.ts", "stage", ["src/a.ts", "src/b.ts"]],
		['git add -- "src/my file.ts"', "stage", ["src/my file.ts"]],
		["dgit add -- src/a.ts", "stage", ["src/a.ts"]],
		["git restore --staged -- src/a.ts", "unstage", ["src/a.ts"]],
		["git restore --staged -- src/a.ts src/b.ts", "unstage", ["src/a.ts", "src/b.ts"]],
	])("reads %s as an index operation over its literal files", (command, operation, paths) => {
		expect(findGitInvocations(command)).toEqual([{ operation, repoDir: null, paths }]);
	});

	test("keeps the repository target of a readable index operation", () => {
		expect(findGitInvocations("git -C /repo add -- src/a.ts")).toEqual([{ operation: "stage", repoDir: "/repo", paths: ["src/a.ts"] }]);
	});

	test.each([
		"git add .",
		"git add src/a.ts",
		"git add -- .",
		"git add -- ..",
		"git add -- ./src/a.ts",
		"git add -- src/",
		"git add -- src//a.ts",
		"git add -- ../other/a.ts",
		"git add -- /etc/passwd",
		"git add -A -- src/a.ts",
		"git add --all -- src/a.ts",
		"git add -u -- src/a.ts",
		"git add -p -- src/a.ts",
		"git add --",
		"git add -- -src/a.ts",
		"git add -- $FILE",
		'git add -- "$(ls)"',
		"git add -- 'src/*.ts'",
		"git add -- src/?.ts",
		"git add -- 'src/[ab].ts'",
		"git add -- src/{a,b}.ts",
		"git add -- ~/src/a.ts",
		"git add -- ':(glob)src/**'",
		"git add -- ':!src/a.ts'",
		"git restore -- src/a.ts",
		"git restore --staged src/a.ts",
		"git restore --staged --worktree -- src/a.ts",
		"git restore --staged --",
		"git restore --source=HEAD~1 --staged -- src/a.ts",
		"git stash push -- src/a.ts",
		"git stash push -m sync -- src/a.ts",
		"git stash",
		"git stash pop",
		"git rebase origin/main",
		"git rebase --onto main feature~3 feature",
		"git reset --hard",
		"git -C $d add -- src/a.ts",
		"git --git-dir=/elsewhere/.git add -- src/a.ts",
		"git --work-tree=/elsewhere add -- src/a.ts",
		"GIT_DIR=/elsewhere/.git git add -- src/a.ts",
		"GIT_WORK_TREE=/elsewhere git add -- src/a.ts",
		"GIT_INDEX_FILE=/tmp/other-index git add -- src/a.ts",
		"GIT_OBJECT_DIRECTORY=/tmp/objects git add -- src/a.ts",
		"GIT_DIR=/elsewhere/.git git restore --staged -- src/a.ts",
		"env GIT_DIR=/elsewhere git add -- src/a.ts",
		"eval git add -- src/a.ts",
		"bash -c 'git add -- src/a.ts'",
		"xargs git add -- src/a.ts",
		"/usr/libexec/git-core/git-add -- src/a.ts",
	])("keeps %s opaque", (command) => {
		expect(findGitInvocations(command)).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	test.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"])(
		"a %s in the call environment makes an index operation opaque",
		(name) => {
			expect(findGitInvocations("git add -- src/a.ts", { [name]: "/elsewhere" })).toEqual([
				{ operation: "opaque", repoDir: null, retargeted: true },
			]);
		},
	);

	test.each([
		"git -C ~/repo add -- src/a.ts",
		"git -C ~ add -- src/a.ts",
		"git -C~/repo add -- src/a.ts",
		"git -C ~/repo restore --staged -- src/a.ts",
		"git -C ~/repo status",
		"git -C ~/repo commit -m x",
		"git -C /tmp/re*o add -- src/a.ts",
		"git -C '/tmp/re*o' add -- src/a.ts",
		"git -C /tmp/re?o add -- src/a.ts",
		"git -C '/tmp/[ab]' add -- src/a.ts",
		"git -C /tmp/{a,b} add -- src/a.ts",
		"git -C '' add -- src/a.ts",
		"git -C $HOME/repo add -- src/a.ts",
		"git -C `pwd` add -- src/a.ts",
	])("a -C value the shell or Git would resolve elsewhere is opaque: %s", (command) => {
		expect(findGitInvocations(command)).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	test("a -C value this gate can resolve identically still names its repository", () => {
		expect(findGitInvocations("git -C sub add -- src/a.ts")).toEqual([{ operation: "stage", repoDir: "sub", paths: ["src/a.ts"] }]);
		expect(findGitInvocations("git -C .. add -- src/a.ts")).toEqual([{ operation: "stage", repoDir: "..", paths: ["src/a.ts"] }]);
		// The tokenizer resolves the escape, so the gate holds the same word the shell passes.
		expect(findGitInvocations("git -C /tmp/re\\ po add -- src/a.ts")).toEqual([{ operation: "stage", repoDir: "/tmp/re po", paths: ["src/a.ts"] }]);
	});

	test.each(["stash", "rebase", "reset", "checkout"])("the %s verb never becomes a readable index operation in the `-- <files>` shape", (verb) => {
		for (const command of [`git ${verb} -- src/a.ts`, `git ${verb} -- src/a.ts src/b.ts`, `git ${verb} --staged -- src/a.ts`]) {
			const invocations = findGitInvocations(command);
			expect(invocations.length, command).toBe(1);
			const invocation = invocations[0] as { operation: GitOperation; paths?: string[] };
			expect(PRIMARY_INDEX_OPERATIONS[invocation.operation], command).toBeUndefined();
			expect(invocation.paths, command).toBeUndefined();
		}
	});

	test("a readable staging chain does not launder the commit it feeds on a protected branch", () => {
		const { run } = fakeGit({ "/main": "main", "/feature": "feature" });
		setGitRunForTests(run);
		expect(decideCommit("git add -- src/a.ts && git commit -m x", "/main", {})?.block).toBe(true);
		expect(decideCommit("git restore --staged -- src/a.ts && git commit -m x", "/main", {})?.block).toBe(true);
		expect(decideCommit("git add -- src/a.ts && git commit -m x", "/feature", {})).toBeUndefined();
		expect(decideCommit("git add -- src/a.ts", "/main", {})).toBeUndefined();
	});
});

describe("shell-level Git selectors", () => {
	test.each([
		"export GIT_DIR=/other/.git; git add -- src/a.ts",
		"export GIT_DIR=/other/.git && git add -- src/a.ts",
		"export GIT_DIR=/other/.git\ngit add -- src/a.ts",
		"export GIT_WORK_TREE=/other | git add -- src/a.ts",
		"export GIT_DIR",
		"declare -x GIT_INDEX_FILE=/tmp/other-index; git add -- src/a.ts",
		"typeset -x GIT_OBJECT_DIRECTORY=/tmp/objects; git add -- src/a.ts",
		"readonly GIT_WORK_TREE=/other; git restore --staged -- src/a.ts",
		"export GIT_CONFIG_GLOBAL=/tmp/evil.config; git add -- src/a.ts",
		"export GIT_ICASE_PATHSPECS=1; git add -- src/a.ts",
		"GIT_DIR=/other/.git; git add -- src/a.ts",
		"GIT_INDEX_FILE=/tmp/other-index\ngit add -- src/a.ts",
		"set -a; GIT_DIR=/other/.git; git add -- src/a.ts",
		"git add -- src/a.ts; export GIT_DIR=/other/.git",
		// Quoting the NAME does not stop the export: bash assigns GIT_DIR either way.
		"export 'GIT_DIR'=/other/.git; git add -- src/a.ts",
	])("an exported or shell-level Git selector makes the whole call opaque: %s", (command) => {
		expect(findGitInvocations(command)).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	test("the commit walker agrees that a shell-level selector retargets every commit in the call", () => {
		for (const command of [
			"GIT_DIR=/other/.git; git commit -m x",
			"set -a; GIT_DIR=/other/.git; git commit -m x",
			"declare -x GIT_WORK_TREE=/other && git commit -m x",
		])
			expect(findCommitInvocations(command), command).toEqual([{ repoDir: null, dryRun: false, retargeted: true }]);
	});

	test.each([
		"export PAGER=cat; git add -- src/a.ts",
		"GIT_PAGER=cat; git add -- src/a.ts",
		"export GITDIR=/other; git add -- src/a.ts",
		"echo export GIT_DIR=/other/.git; git add -- src/a.ts",
	])("an unrelated export or a mention of one leaves the index operation readable: %s", (command) => {
		expect(findGitInvocations(command)).toEqual([{ operation: "stage", repoDir: null, paths: ["src/a.ts"] }]);
	});

	test("a prefix assignment stays bound to its own command", () => {
		// `GIT_DIR=… true` ends with `true`, so the staging that follows is not retargeted, while
		// the same assignment in front of `git add` is (covered above as an opaque prefix form).
		expect(findGitInvocations("GIT_DIR=/other/.git true; git add -- src/a.ts")).toEqual([
			{ operation: "stage", repoDir: null, paths: ["src/a.ts"] },
		]);
	});

	test.each(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_ICASE_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_LITERAL_PATHSPECS"])(
		"a %s in the call environment is as opaque as its argv twin",
		(name) => {
			expect(findGitInvocations("git add -- src/a.ts", { [name]: "1" })).toEqual([
				{ operation: "opaque", repoDir: null, retargeted: true },
			]);
			expect(findGitInvocations("git add -- src/a.ts", { [name]: "" })).toEqual([
				{ operation: "stage", repoDir: null, paths: ["src/a.ts"] },
			]);
		},
	);

	test.each([
		"git --icase-pathspecs add -- src/a.ts",
		"git --glob-pathspecs add -- src/a.ts",
		"git --noglob-pathspecs add -- src/a.ts",
		"git --literal-pathspecs add -- src/a.ts",
	])("a pathspec-magic option in argv is opaque: %s", (command) => {
		expect(findGitInvocations(command)).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	test("a structured GIT_CONFIG_GLOBAL blocks a commit the same way -c does", () => {
		const { run } = fakeGit({ "/feature": "feature" });
		setGitRunForTests(run);
		expect(decideCommit("git commit -m x", "/feature", { GIT_CONFIG_GLOBAL: "/tmp/evil.config" })?.block).toBe(true);
		expect(decideCommit("git commit -m x", "/feature", { GIT_CONFIG_NOSYSTEM: "1" })?.block).toBe(true);
		expect(decideCommit("git commit -m x", "/feature", {})).toBeUndefined();
	});
});

describe("escaped separators", () => {
	test("an escaped separator is an operand of the one real Git command, not a boundary", () => {
		expect(tokenize("git add -- verified.txt \\; bigdir").map((t) => [t.text, t.escaped === true])).toEqual([
			["git", false],
			["add", false],
			["--", false],
			["verified.txt", false],
			[";", true],
			["bigdir", false],
		]);
	});

	test.each([
		["git add -- verified.txt \\; bigdir", ["verified.txt", ";", "bigdir"]],
		["git add -- verified.txt \\&\\& bigdir", ["verified.txt", "&&", "bigdir"]],
		["git add -- verified.txt \\| bigdir", ["verified.txt", "|", "bigdir"]],
		["git add -- verified.txt ';' bigdir", ["verified.txt", ";", "bigdir"]],
		['git add -- verified.txt "&&" bigdir', ["verified.txt", "&&", "bigdir"]],
		["git restore --staged -- verified.txt \\; bigdir", ["verified.txt", ";", "bigdir"]],
	])("%s carries every operand Git receives", (command, paths) => {
		const invocations = findGitInvocations(command);
		expect(invocations.length, command).toBe(1);
		expect(invocations[0], command).toMatchObject({ paths });
	});

	test("an unescaped separator still ends the command", () => {
		expect(findGitInvocations("git add -- verified.txt ; bigdir")).toEqual([
			{ operation: "stage", repoDir: null, paths: ["verified.txt"] },
		]);
	});

	test("an escaped separator does not hide a later command from the commit walker", () => {
		// `echo \; git commit -m x` runs no commit: `;`, `git`, `commit`, `-m` and `x` are all
		// operands of `echo`. Reading the escape as a boundary invented a second command here and
		// dropped the operands of the real one everywhere else.
		expect(findCommitInvocations("echo \\; git commit -m x", false)).toEqual([]);
		expect(findCommitInvocations("echo ; git commit -m x", false)).toEqual([{ repoDir: null, dryRun: false }]);
	});
});


describe("final registered bypass controls", () => {
	type Handler = (event: unknown, context?: { cwd?: string }) => unknown;
	function register(): Handler {
		const handlers: Handler[] = [];
		mainBranchGate({ on: (event: string, handler: Handler) => { if (event === "tool_call") handlers.push(handler); } } as never);
		return handlers[0] as Handler;
	}

	test("absolute git-commit helper is checked on feature and main through the registered chain", () => {
		for (const branch of ["feature", "main"]) {
			const root = branch === "main" ? "/main-helper" : "/feature-helper";
			const { run } = fakeGit({ [root]: branch });
			setGitRunForTests(run);
			const result = register()({ toolName: "bash", input: { cwd: root, command: "/usr/libexec/git-core/git-commit -m x" } });
			if (branch === "main") expect(result, branch).toMatchObject({ block: true });
			else expect(result, branch).toBeUndefined();
		}
	});

	test.each([
		"cd /main && git commit -m x",
		"cd /main ; git checkout feature",
		"pushd /main && git merge feature",
		"{ git commit -m x; }",
		"(git commit -m x)",
		"cd /missing ; git commit -m x",
		"cd /missing && git commit -m x",
	])("registered cwd/grouping chain refuses without cwd simulation: %s", (command) => {
		const { run, calls } = fakeGit({ "/feature": "feature", "/main": "main" });
		setGitRunForTests(run);
		const result = register()({ toolName: "bash", input: { cwd: "/feature", command } });
		expect(result).toMatchObject({ block: true });
		expect(calls).toEqual([]);
	});
});

describe("production Git runner", () => {
	test("uses the remote budget when main authorization reaches ls-remote", () => {
		const root = "/tmp/runner-main";
		const seen: number[] = [];
		const original = Bun.spawnSync;
		Object.defineProperty(Bun, "spawnSync", { value: (_argv: string[], options: { timeout: number }) => {
			seen.push(options.timeout);
			return { exitCode: 0, stdout: { toString: () => "main\n" } };
		} });
		try {
			const result = decideCommit("git commit -m x", root, { DELIVERY_ALLOW_MAIN_COMMIT: "1" });
			expect(result).toMatchObject({ block: true });
			expect(seen).toContain(10_000);
		} finally {
			Object.defineProperty(Bun, "spawnSync", { value: original });
		}
	});
});

describe("relative -C after a supported cwd transition", () => {
	test("resolves from the transitioned cwd, leaving direct and absolute forms alone", () => {
		// `cd /abs-primary && /abs/git -C . commit` commits in /abs-primary. Filling in only the
		// nulls left `-C .` resolving against the CALLER's checkout, so the branch of the wrong
		// repository was read and the commit landed on whatever /abs-primary had checked out.
		expect(findCommitInvocations("cd /abs-primary && /abs/git -C . commit -m x", false)[0]?.repoDir).toBe("/abs-primary/.");
		expect(findCommitInvocations("cd /abs-primary && /abs/git -C sub commit -m x", false)[0]?.repoDir).toBe("/abs-primary/sub");
		expect(findCommitInvocations("cd /abs-primary && /abs/git -Csub commit -m x", false)[0]?.repoDir).toBe("/abs-primary/sub");
		expect(findCommitInvocations("cd /abs-primary && /abs/git -C a -C b commit -m x", false)[0]?.repoDir).toBe("/abs-primary/a/b");
		// An absolute `-C` already names its target, and a relative child folds onto it.
		expect(findCommitInvocations("cd /abs-primary && /abs/git -C /elsewhere commit -m x", false)[0]?.repoDir).toBe("/elsewhere");
		expect(findCommitInvocations("cd /abs-primary && /abs/git -C /elsewhere -C child commit -m x", false)[0]?.repoDir).toBe("/elsewhere/child");
		expect(findCommitInvocations("cd /abs-primary && /abs/git commit -m x", false)[0]?.repoDir).toBe("/abs-primary");
		// With no transition to read, a relative `-C` still resolves against the bash call's cwd.
		expect(findCommitInvocations("git -C sub commit -m x", false)[0]?.repoDir).toBe("sub");
	});

	test("a commit through the transitioned checkout is refused on its protected branch", () => {
		const { run } = fakeGit({ "/feature": "feature", "/main": "main" });
		setGitRunForTests(run);
		for (const command of [
			"cd /main && /usr/bin/git -C . commit -m x",
			"cd /main && /usr/bin/git -C sub commit -m x",
			"cd /main && /usr/bin/git -Csub commit -m x",
		])
			expect(decideCommit(command, "/feature"), command).toMatchObject({ block: true });
		// The caller's own checkout is on a feature branch, which is what the old resolution read.
		expect(decideCommit("cd /feature && /usr/bin/git -C . commit -m x", "/feature")).toBeUndefined();
		expect(decideCommit("cd /feature && /usr/bin/git -C /feature commit -m x", "/main")).toBeUndefined();
	});
});

describe("redirection targets carrying command substitution", () => {
	// Bash expands a redirection target BEFORE it opens the file, so the nested Git call runs even
	// though no argv this walker parses ever contains it. Checked with `includeOpaqueSubstitution`
	// OFF, so these prove the redirection seam itself rather than the prose-level fallback.
	const hidden = [
		'git status > "$(git commit -m x)"',
		'git status > "$(git checkout other)"',
		'git status > "`git commit -m x`"',
		'> "$(git commit -m x)" git status',
		'echo ok > "$(git commit -m x)"',
		'cat < "$(git checkout other)"',
		// Concatenated so no single literal spells `${…}`. The command text is exactly
		// `printf x 3>"$(g${EMPTY}it commit -m x)"`, a substitution naming no readable `git`.
		'printf x 3>"$(g$' + '{EMPTY}it commit -m x)"',
		'RUNNER=git; >"$($RUNNER commit -m x)" printf x',
		"RUNNER=git; >\"`$RUNNER commit -m x`\" printf x",
	];

	test.each(hidden)("the commit walker surfaces it as unreadable: %s", (command) => {
		expect(findCommitInvocations(command, false)).toContainEqual({ repoDir: null, dryRun: false, retargeted: true });
	});

	test.each(hidden)("a protected branch refuses it: %s", (command) => {
		const { run } = fakeGit({ "/main": "main" });
		setGitRunForTests(run);
		expect(decideCommit(command, "/main")?.block, command).toBe(true);
	});

	test.each([
		"git commit -m x > out.txt",
		"git commit -m x 2>&1",
		'git commit -m x > "$HOME/out.txt"',
		"git commit -m x >/dev/null",
		"> out.txt git commit -m x",
	])("a harmless redirection adds no unreadable candidate: %s", (command) => {
		const invocations = findCommitInvocations(command, false);
		expect(invocations.length, command).toBe(1);
		expect(invocations[0], command).toEqual({ repoDir: null, dryRun: false });
	});
});

describe("registered handler on an unexpected failure", () => {
	type Handler = (event: unknown, context?: { cwd?: string }) => unknown;
	function register(): Handler {
		const handlers: Handler[] = [];
		mainBranchGate({ on: (event: string, handler: Handler) => { if (event === "tool_call") handlers.push(handler); } } as never);
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
		const { run } = fakeGit({ "/main": "main" });
		setGitRunForTests(run);
		let reads = 0;
		const stateful = {
			get toolName(): string {
				reads++;
				return reads === 1 ? "bash" : "read";
			},
			input: { cwd: "/main", command: "git commit -m x" },
		};
		expect(register()(stateful)).toMatchObject({ block: true });
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

	test("a bash call whose classification throws is refused, not allowed", () => {
		const exploding = {
			toolName: "bash",
			get input(): never {
				throw new Error("classification exploded");
			},
		};
		expect(register()(exploding)).toEqual({ block: true, reason: UNDECIDED_REASON });
	});
});

describe("a credential handed to the GitHub CLI", () => {
	const auth = `token="$(env -u GH_TOKEN -u GITHUB_TOKEN gh auth token --hostname github.com 2>/dev/null)"`;
	const create = `env -u GH_TOKEN GITHUB_TOKEN="$token" gh pr create --repo o/r --head fix/x --base main --draft --title T --body-file /tmp/body.md`;

	// `github.com` is not the word `git`, and `GITHUB_TOKEN=$token` is environment for a child, not
	// the program `env` runs. Neither reaches Git, so this call names no repository to read.
	test("is not the program a wrapper runs", () => {
		expect(findGitInvocations(auth)).toEqual([]);
		expect(findGitInvocations(create)).toEqual([]);
		expect(findGitInvocations(`${auth}\n${create}`)).toEqual([]);
	});

	test.each([
		`env -u GH_TOKEN GITHUB_TOKEN="$token" git push origin main`,
		`env GITHUB_TOKEN="$token" /usr/bin/git checkout main`,
		`xcrun GITHUB_TOKEN="$token" git commit -m x`,
		`env GITHUB_TOKEN="$(git checkout other)" gh pr create`,
		`env GITHUB_TOKEN="$token" "$runner" pr create`,
		`env GITHUB_TOKEN="$token" gh pr create --title "$(git log -1 --pretty=%s)"`,
		`env GITHUB_TOKEN="$token" bash -c 'git commit -m x'`,
	])("cannot launder the Git call in: %s", (command) => {
		expect(findGitInvocations(command)).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	// The underscore is the whole boundary, so a prefix test that stops at `GIT` would refuse the
	// approved call again, and one that never runs would miss a real retarget.
	test.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_GLOBAL", "GIT_ICASE_PATHSPECS"])(
		"an unreadable %s in the same argv keeps the call opaque",
		(name) => {
			expect(findGitInvocations(`env ${name}="$elsewhere" gh pr create --base main`)).toEqual([
				{ operation: "opaque", repoDir: null, retargeted: true },
			]);
		},
	);

	test.each(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GH_TOKEN", "GH_HOST"])("an unreadable %s retargets nothing", (name) => {
		expect(findGitInvocations(`env -u GH_TOKEN ${name}="$value" gh pr create --base main`)).toEqual([]);
	});

	// A shell or `eval` operand is ONE token holding a whole script that the inner shell parses AGAIN
	// after the outer one expands it, so no word there can be read as environment: with
	// `SCRIPT='; git checkout other'`, `GITHUB_TOKEN=x$SCRIPT` is a lone assignment by every lexical
	// test and a Git command once expanded. Only the word's POSITION separates the two, so the
	// exemption belongs to `env` and `sudo` argv and to nothing else.
	test.each([
		[`bash -c "GITHUB_TOKEN=x$SCRIPT"`, { SCRIPT: "; git checkout other" }],
		[`bash -c "GITHUB_TOKEN=x$SCRIPT"`, {}],
		[`eval "GITHUB_TOKEN=x$SCRIPT"`, { SCRIPT: "; git checkout other" }],
		[`sh -c "GH_TOKEN=x$SCRIPT"`, { SCRIPT: "; git checkout other" }],
		[`bash -lc "GITHUB_TOKEN=$token$SCRIPT"`, { SCRIPT: "; git checkout other" }],
		[`bash -c 'GITHUB_TOKEN=x $RUNNER checkout other'`, { RUNNER: "git" }],
		[`bash -c 'GITHUB_TOKEN=x $RUNNER checkout other'`, {}],
		[`sh -c 'GH_TOKEN=x $R commit -m x'`, { R: "git" }],
		[`zsh -c 'GITHUB_TOKEN=x $R merge other'`, {}],
		[`eval 'GITHUB_TOKEN=x $RUNNER checkout other'`, { RUNNER: "git" }],
		[`bash -c "GITHUB_TOKEN=$token $RUNNER push origin main"`, { RUNNER: "git" }],
		[`bash -c 'A=x;$R'`, { R: "git checkout other" }],
		[`env GITHUB_TOKEN=x $RUNNER checkout other`, { RUNNER: "git" }],
		// The run ends at the program the wrapper executes, so every later word is a command word
		// again even when more assignments precede it.
		[`env GITHUB_TOKEN=x sudo GH_TOKEN=y $RUNNER checkout other`, { RUNNER: "git" }],
	] as Array<[string, NodeJS.ProcessEnv]>)("a script operand keeps a bare expansion unreadable: %s", (command, env) => {
		expect(findGitInvocations(command, env)).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	// The same spelling in an `env` or `sudo` assignment position is one environment value that
	// nothing re-parses, so the separator inside it never runs.
	test("an assignment position passes a value on without re-parsing it", () => {
		expect(findGitInvocations(`env GITHUB_TOKEN=x$SCRIPT gh pr create --base main`, { SCRIPT: "; git checkout other" })).toEqual([]);
		expect(findGitInvocations(`sudo -u ci GITHUB_TOKEN="$token" gh pr create --base main`)).toEqual([]);
	});

	// An option and the word it consumes are not the assignment run: `env -S` hands `env` a string
	// that `env` itself splits and runs, so that word is a script like any other.
	test.each([
		[`env -S "GITHUB_TOKEN=x$SCRIPT"`, { SCRIPT: "; git checkout other" }],
		[`env --split-string "GITHUB_TOKEN=x$SCRIPT"`, { SCRIPT: "; git checkout other" }],
		[`env -u GH_TOKEN -S "GH_TOKEN=x$SCRIPT"`, { SCRIPT: "; git checkout other" }],
		[`env -S "GITHUB_TOKEN=x $RUNNER checkout"`, { RUNNER: "git" }],
		[`sudo -u "$who" GITHUB_TOKEN=x $RUNNER checkout other`, { RUNNER: "git" }],
	] as Array<[string, NodeJS.ProcessEnv]>)("an option value is outside the assignment run: %s", (command, env) => {
		expect(findGitInvocations(command, env)).toEqual([{ operation: "opaque", repoDir: null, retargeted: true }]);
	});

	// `xargs` resolves its utility from argv, so `NAME=value` there is a filename and not an
	// assignment at all: nothing in that position may be read as environment.
	test("an xargs utility is a command word, not an assignment", () => {
		expect(findGitInvocations(`xargs GITHUB_TOKEN="$token" git checkout other`)).toEqual([
			{ operation: "opaque", repoDir: null, retargeted: true },
		]);
		expect(findGitInvocations(`xargs GITHUB_TOKEN="$token" -- git checkout other`)).toEqual([
			{ operation: "opaque", repoDir: null, retargeted: true },
		]);
	});
});
