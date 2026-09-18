import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	PRIMARY_CHECKOUT_DIRECTIVE,
	setTrustedPrimaryPolicyGitForTests,
	trustedPrimaryPolicy,
} from "./trusted-primary-policy.ts";

const roots: string[] = [];
afterEach(() => {
	setTrustedPrimaryPolicyGitForTests(null);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function repository(content = PRIMARY_CHECKOUT_DIRECTIVE): string {
	const parent = mkdtempSync(join(tmpdir(), "worktrunk-policy-"));
	roots.push(parent);
	const canonical = join(parent, "canonical");
	mkdirSync(canonical, { recursive: true });
	git(canonical, "init", "-q", "-b", "main");
	git(canonical, "config", "user.email", "probe@example.invalid");
	git(canonical, "config", "user.name", "probe");
	writeFileSync(join(canonical, "AGENTS.md"), `${content}\n`);
	git(canonical, "add", "AGENTS.md");
	git(canonical, "commit", "-q", "-m", "policy");
	return canonical;
}

describe("trustedPrimaryPolicy", () => {
	test("accepts the exact directive from a committed regular blob", () => {
		const canonical = repository();
		expect(trustedPrimaryPolicy(canonical)).toBe(true);
	});

	test("rejects an absent directive", () => {
		const canonical = repository("MUST authorize something else.");
		expect(trustedPrimaryPolicy(canonical)).toBe(false);
	});

	test("rejects a directive that exists only in an uncommitted linked worktree", () => {
		const canonical = repository("No authorization here.");
		const worktree = join(canonical, "..", "linked");
		git(canonical, "worktree", "add", "-q", "-b", "omp/agent/policy", worktree);
		writeFileSync(join(worktree, "AGENTS.md"), `${PRIMARY_CHECKOUT_DIRECTIVE}\n`);
		expect(trustedPrimaryPolicy(canonical)).toBe(false);
	});

	test("ignores a replace ref and reads the pinned HEAD commit", () => {
		const canonical = repository("No authorization here.");
		const original = git(canonical, "rev-parse", "HEAD").trim();
		writeFileSync(join(canonical, "AGENTS.md"), `${PRIMARY_CHECKOUT_DIRECTIVE}\n`);
		git(canonical, "add", "AGENTS.md");
		git(canonical, "commit", "-q", "-m", "replacement");
		const replacement = git(canonical, "rev-parse", "HEAD").trim();
		git(canonical, "reset", "-q", "--hard", original);
		git(canonical, "replace", original, replacement);
		expect(trustedPrimaryPolicy(canonical)).toBe(false);
	});

	test("rejects a symlink policy entry instead of reading its target", () => {
		const parent = mkdtempSync(join(tmpdir(), "worktrunk-policy-link-"));
		roots.push(parent);
		const canonical = join(parent, "canonical");
		const target = join(parent, "outside.md");
		mkdirSync(canonical, { recursive: true });
		git(canonical, "init", "-q", "-b", "main");
		git(canonical, "config", "user.email", "probe@example.invalid");
		git(canonical, "config", "user.name", "probe");
		writeFileSync(target, `${PRIMARY_CHECKOUT_DIRECTIVE}\n`);
		symlinkSync(target, join(canonical, "AGENTS.md"));
		git(canonical, "add", "AGENTS.md");
		git(canonical, "commit", "-q", "-m", "symlink");
		expect(trustedPrimaryPolicy(canonical)).toBe(false);
	});

	test("rejects an unborn HEAD", () => {
		const parent = mkdtempSync(join(tmpdir(), "worktrunk-policy-unborn-"));
		roots.push(parent);
		const canonical = join(parent, "canonical");
		mkdirSync(canonical, { recursive: true });
		git(canonical, "init", "-q", "-b", "main");
		expect(trustedPrimaryPolicy(canonical)).toBe(false);
	});

	test("ignores ambient Git routing variables", () => {
		const canonical = repository();
		const prior = process.env.GIT_DIR;
		process.env.GIT_DIR = join(canonical, "missing.git");
		try {
			expect(trustedPrimaryPolicy(canonical)).toBe(true);
		} finally {
			if (prior === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = prior;
		}
	});

	test("fails closed on an excess number of policy files", () => {
		const head = "a".repeat(40);
		setTrustedPrimaryPolicyGitForTests((_cwd, args) => {
			if (args[0] === "rev-parse") return `${head}\n`;
			if (args[0] === "ls-tree") {
				return Array.from({ length: 257 }, (_, index) => {
					const oid = index.toString(16).padStart(40, "0");
					return `100644 blob ${oid}\t.omp/rules/r${index}.md\u0000`;
				}).join("");
			}
			return "";
		});
		expect(trustedPrimaryPolicy("/fixture")).toBe(false);
	});

	test("fails closed on cumulative blob output over the bound", () => {
		const head = "a".repeat(40);
		const first = "b".repeat(40);
		setTrustedPrimaryPolicyGitForTests((_cwd, args) => {
			if (args[0] === "rev-parse") return `${head}\n`;
			if (args[0] === "ls-tree") return `100644 blob ${first}\tAGENTS.md\u0000100644 blob ${"c".repeat(40)}\tCLAUDE.md\u0000`;
			return "x".repeat(600_000);
		});
		expect(trustedPrimaryPolicy("/fixture")).toBe(false);
	});

	test("fails closed when the policy lookup runner times out", () => {
		setTrustedPrimaryPolicyGitForTests(() => null);
		expect(trustedPrimaryPolicy("/fixture")).toBe(false);
	});
});
