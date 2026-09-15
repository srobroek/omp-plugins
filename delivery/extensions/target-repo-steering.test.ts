import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GitRun, steeringDirective, targetRepoAuthorizes } from "./target-repo-steering.ts";

let scratch: string | undefined;

type TreeFile = { path: string; text: string; mode?: string; type?: string };

function setupRepo(): string {
	scratch = mkdtempSync(join(tmpdir(), "target-steering-"));
	return scratch;
}

function fakeGit(root: string, files: TreeFile[] = [], options: { head?: string | null; headCommit?: string } = {}): GitRun {
	const head = options.head === undefined ? "refs/remotes/origin/main" : options.head;
	const verifiedRef = head ?? "refs/remotes/origin/master";
	const headCommit = options.headCommit ?? "deadbeef";
	return (argv, cwd) => {
		if (cwd !== root) return { exitCode: 128, stdout: "" };
		if (argv[1] === "rev-parse" && argv.includes("--show-toplevel")) return { exitCode: 0, stdout: `${root}\n` };
		if (argv[1] === "symbolic-ref") return { exitCode: head ? 0 : 1, stdout: head ? `${head}\n` : "" };
		if (argv[1] === "rev-parse" && argv.includes("--verify")) {
			const ref = argv.at(-1);
			return { exitCode: ref === verifiedRef ? 0 : 1, stdout: ref === verifiedRef ? `${headCommit}\n` : "" };
		}
		if (argv[1] === "ls-tree") {
			const stdout = files.map((file) => `${file.mode ?? "100644"} ${file.type ?? "blob"} deadbeef\t${file.path}\0`).join("");
			return { exitCode: 0, stdout };
		}
		if (argv[1] === "show") {
			const path = argv.at(-1)?.split(":").at(-1);
			const file = files.find((candidate) => candidate.path === path);
			return file ? { exitCode: 0, stdout: file.text } : { exitCode: 1, stdout: "" };
		}
		return { exitCode: 1, stdout: "" };
	};
}

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

describe("targetRepoAuthorizes", () => {
	test.each([
		["leading space", " MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
		["four-space code block", "    MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
		["trailing space", "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository. "],
	])("does not authorize %s", (_description, content) => {
		const root = setupRepo();
		writeFileSync(join(root, "AGENTS.md"), content);
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root))).toBe(false);
	});

	test("does not authorize a worktree-only directive", () => {
		const root = setupRepo();
		writeFileSync(join(root, "AGENTS.md"), steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT"));
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root))).toBe(false);
	});

	test("does not authorize a directive present only on the feature commit", () => {
		const root = setupRepo();
		const featureFiles = [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }];
		const base = fakeGit(root);
		const run: GitRun = (argv, cwd) => {
			if (argv[1] === "ls-tree" && argv.includes("refs/heads/feature")) {
				return { exitCode: 0, stdout: featureFiles.map((file) => `100644 blob deadbeef\t${file.path}\0`).join("") };
			}
			if (argv[1] === "show" && argv.at(-1)?.startsWith("refs/heads/feature:")) {
				return { exitCode: 0, stdout: featureFiles[0]?.text ?? "" };
			}
			return base(argv, cwd);
		};
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", run)).toBe(false);
	});

	test("authorizes the exact directive from the trusted remote default branch", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\n` }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(true);
	});

	test("accepts an exact directive from a direct .omp/rules file", () => {
		const root = setupRepo();
		const files = [{ path: ".omp/rules/allow.md", text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\n` }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(true);
	});

	test("fails closed on an invalid remote HEAD ref", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }];
		expect(
			targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files, { head: "not-a-ref" })),
		).toBe(false);
	});

	test("fails closed when the trusted ref cannot be verified", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }];
		const base = fakeGit(root, files);
		const run: GitRun = (argv, cwd) =>
			argv[1] === "rev-parse" && argv.includes("--verify") ? { exitCode: 1, stdout: "" } : base(argv, cwd);
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", run)).toBe(false);
	});

	test("fails closed on malformed trusted tree output", () => {
		const root = setupRepo();
		const base = fakeGit(root, [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }]);
		const run: GitRun = (argv, cwd) =>
			argv[1] === "ls-tree" ? { exitCode: 0, stdout: "100644 blob deadbeef\\tAGENTS.md" } : base(argv, cwd);
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", run)).toBe(false);
	});

	test("falls back from an absent remote HEAD to origin/master", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files, { head: null }))).toBe(true);
	});

	test("denies an unreadable trusted source", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }];
		const base = fakeGit(root, files);
		const run: GitRun = (argv, cwd) => (argv[1] === "show" ? { exitCode: 1, stdout: "" } : base(argv, cwd));
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", run)).toBe(false);
	});

	test("rejects symlink steering entries from the trusted tree", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT"), mode: "120000" }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(false);
	});

	test.each([
		["backtick fence with info", "```markdown\nMUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n```"],
		["indented tilde fence", "   ~~~ ts\r\nMUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\r\n   ~~~\r\n"],
		["unclosed backtick fence", "```\nMUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
		["unclosed tilde fence", "~~~yaml\nMUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
	])("ignores directives inside %s", (_description, content) => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: content }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(false);
	});

	test("authorizes an exact standalone directive outside a closed fence", () => {
		const root = setupRepo();
		const text = `~~~markdown\n${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\n~~~\n${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\r\n`;
		const files = [{ path: "AGENTS.md", text }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(true);
	});

	test("a veto outside fences wins over an affirmative", () => {
		const root = setupRepo();
		const files = [{
			path: "AGENTS.md",
			text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\nMUST NOT authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n`,
		}];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(false);
	});
});
