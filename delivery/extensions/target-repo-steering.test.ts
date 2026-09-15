import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GitRun, steeringDirective, targetRepoAuthorizes } from "./target-repo-steering.ts";

let scratch: string | undefined;
const SHA = "a".repeat(40);
const ALT_SHA = "b".repeat(40);
type TreeFile = { path: string; text: string; mode?: string; type?: string };

function setupRepo(): string {
	scratch = mkdtempSync(join(tmpdir(), "target-steering-"));
	return scratch;
}

function fakeGit(
	root: string,
	files: TreeFile[] = [],
	options: { remoteRef?: string | null; remoteSha?: string; localSha?: string } = {},
): GitRun {
	const remoteRef = options.remoteRef ?? "refs/heads/main";
	const remoteSha = options.remoteSha ?? SHA;
	const localSha = options.localSha ?? remoteSha;
	return (argv, cwd) => {
		if (cwd !== root) return { exitCode: 128, stdout: "" };
		if (argv[1] === "rev-parse" && argv.includes("--show-toplevel")) return { exitCode: 0, stdout: `${root}\n` };
		if (argv[1] === "ls-remote") {
			return remoteRef === null
				? { exitCode: 128, stdout: "" }
				: { exitCode: 0, stdout: `ref: ${remoteRef}\tHEAD\n${remoteSha}\tHEAD\n` };
		}
		if (argv[1] === "rev-parse" && argv.includes("--verify")) {
			const requested = argv.at(-1)?.replace(/\^\{commit\}$/, "");
			return requested === localSha ? { exitCode: 0, stdout: `${localSha}\n` } : { exitCode: 1, stdout: "" };
		}
		if (argv[1] === "ls-tree") {
			const stdout = files.map((file) => `${file.mode ?? "100644"} ${file.type ?? "blob"} ${SHA}\t${file.path}\0`).join("");
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
	test("accepts an exact directive from a valid remote default fixture", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\n` }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(true);
	});

	test("uses remote HEAD and SHA rather than retargeted local origin metadata", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\n` }];
		const run = fakeGit(root, files, { remoteRef: "refs/heads/main", remoteSha: SHA, localSha: SHA });
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", run)).toBe(true);
		const forged = fakeGit(root, files, { remoteRef: "refs/heads/main", remoteSha: SHA, localSha: ALT_SHA });
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", forged)).toBe(false);
	});

	test.each([
		["offline", (_base: GitRun) => (_argv: string[], _cwd: string) => ({ exitCode: 128, stdout: "" })],
		["ambiguous", (_base: GitRun) => (argv: string[], cwd: string) => argv[1] === "ls-remote" ? { exitCode: 0, stdout: `ref: refs/heads/main\tHEAD\n${SHA}\tHEAD\n${ALT_SHA}\tHEAD\n` } : _base(argv, cwd)],
		["malformed", (_base: GitRun) => (argv: string[], cwd: string) => argv[1] === "ls-remote" ? { exitCode: 0, stdout: "not remote output\n" } : _base(argv, cwd)],
	])("fails closed on %s remote response", (_name, makeRun) => {
		const root = setupRepo();
		const base = fakeGit(root, [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }]);
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", makeRun(base))).toBe(false);
	});

	test("fails closed when the remote SHA is unavailable locally", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files, { remoteSha: SHA, localSha: ALT_SHA }))).toBe(false);
	});

	test("fails closed on malformed tree output", () => {
		const root = setupRepo();
		const base = fakeGit(root, [{ path: "AGENTS.md", text: steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT") }]);
		const run: GitRun = (argv, cwd) => argv[1] === "ls-tree" ? { exitCode: 0, stdout: `100644 blob bad\tAGENTS.md` } : base(argv, cwd);
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", run)).toBe(false);
	});

	test("skips a symlink candidate without reading it when regular AGENTS authorizes", () => {
		const root = setupRepo();
		const files = [
			{ path: "AGENTS.md", text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\n` },
			{ path: "CLAUDE.md", text: "MUST NOT authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n", mode: "120000" },
		];
		const shown: string[] = [];
		const base = fakeGit(root, files);
		const run: GitRun = (argv, cwd) => {
			if (argv[1] === "show") shown.push(argv.at(-1) ?? "");
			return base(argv, cwd);
		};
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", run)).toBe(true);
		expect(shown).toEqual([`${SHA}:AGENTS.md`]);
	});

	test("symlink-only steering is unauthorized and cannot veto", () => {
		const root = setupRepo();
		const files = [{ path: "CLAUDE.md", text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\n`, mode: "120000" }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(false);
	});

	test("an exact veto in a regular source wins", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: `${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\nMUST NOT authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n` }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(false);
	});

	test("ignores directives inside fenced content", () => {
		const root = setupRepo();
		const files = [{ path: "AGENTS.md", text: "```md\nMUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n```\n" }];
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root, files))).toBe(false);
	});
});
