import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import hygieneOrientation, { parsePorcelainPaths, parseWorktrees, scanHygiene } from "./hygiene-orientation";
import { receiptDirectory, repoKey } from "./landing-receipt";

const temp = () => mkdtempSync(join(tmpdir(), "delivery-hygiene-"));
const git = (cwd: string, ...args: string[]) =>
	Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 5000,
	});

function repo(): string {
	const cwd = temp();
	git(cwd, "init", "-q");
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "base");
	return cwd;
}

function commit(cwd: string, name: string): void {
	writeFileSync(join(cwd, name), `${name}\n`);
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", name);
}

/** Point the receipt root at `agent` for one test, then put the environment back. */
function withAgentDir<T>(agent: string, body: () => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		return body();
	} finally {
		process.env.PI_CODING_AGENT_DIR = previous;
	}
}

process.env.PI_CODING_AGENT_DIR = temp();

describe("delivery hygiene orientation", () => {
	test("the manifest keeps the advisory extension and registers orientation after it", () => {
		const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { omp: { extensions: string[] } };
		const extensions = manifest.omp.extensions;
		const advisory = extensions.indexOf("./extensions/unpushed-work-advisory.ts");
		const orientation = extensions.indexOf("./extensions/hygiene-orientation.ts");
		expect(advisory).toBeGreaterThanOrEqual(0);
		expect(orientation).toBeGreaterThan(advisory);
	});

	test("dirty state is actionable but missing publication evidence is ambiguous", () => {
		const cwd = repo();
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		const result = scanHygiene(cwd);
		expect(result.status).toBe("ambiguous");
		expect(result.findings.some(f => f.kind === "dirty" && f.status === "actionable")).toBe(true);
		expect(result.findings.some(f => f.kind === "beads" || f.kind === "forge" || f.kind === "publication")).toBe(true);
	});

	test("a readable branch with no upstream is ambiguous rather than clean", () => {
		const result = scanHygiene(repo());
		const publication = result.findings.find(f => f.kind === "publication");
		expect(publication?.status).toBe("ambiguous");
		expect(publication?.description).toContain("no upstream");
		expect(result.worktrees.find(w => w.current)?.tracking).toBe("no-upstream");
	});

	test("a diverged branch reports both its ahead and its behind count", () => {
		const origin = repo();
		const clone = join(temp(), "clone");
		git(temp(), "clone", "-q", origin, clone);
		commit(clone, "local.txt");
		commit(origin, "one.txt");
		commit(origin, "two.txt");
		git(clone, "fetch", "-q", "origin");
		const result = scanHygiene(clone);
		const current = result.worktrees.find(w => w.current);
		expect(current?.tracking).toBe("tracked");
		expect(current?.ahead).toBe(1);
		expect(current?.behind).toBe(2);
		expect(result.findings.some(f => f.kind === "unpushed" && f.status === "actionable")).toBe(true);
		const behind = result.findings.find(f => f.kind === "upstream");
		expect(behind?.status).toBe("actionable");
		expect(behind?.description).toContain("2 commit(s) behind");
	});

	test("every linked worktree is inventoried, not only same-branch siblings", () => {
		const cwd = repo();
		const linked = join(temp(), "linked");
		git(cwd, "worktree", "add", "-q", "-b", "other", linked);
		const result = scanHygiene(cwd);
		expect(result.worktrees.length).toBe(2);
		const sibling = result.worktrees.find(w => !w.current);
		expect(sibling?.branch).toBe("other");
		expect(sibling?.tracking).toBe("no-upstream");
		const inventory = result.findings.find(f => f.kind === "linked-worktrees");
		expect(inventory?.paths?.map(path => realpathSync(path))).toEqual([realpathSync(linked)]);
	});

	test("porcelain worktree records carry branch, detached and bare state", () => {
		expect(parseWorktrees("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n\nworktree /c\nbare\n")).toEqual([
			{ path: "/a", branch: "main", detached: false, bare: false },
			{ path: "/b", branch: null, detached: true, bare: false },
			{ path: "/c", branch: null, detached: false, bare: true },
		]);
	});

	test("missing git is conservatively ambiguous", () => {
		const result = scanHygiene(temp());
		expect(result.status).toBe("ambiguous");
		expect(result.findings.some(f => f.kind === "git" || f.kind === "scope")).toBe(true);
	});

	test("porcelain rename and copy records consume both paths", () => {
		expect(parsePorcelainPaths("R  new.txt\0old.txt\0C  copy.txt\0source.txt\0")).toEqual(["new.txt", "old.txt", "copy.txt", "source.txt"]);
	});

	test("read-only scan does not change the git index", () => {
		const cwd = repo();
		const index = join(cwd, ".git", "index");
		const before = statSync(index).mtimeMs;
		scanHygiene(cwd);
		expect(statSync(index).mtimeMs).toBe(before);
	});

	test("both tools are read-approved and use the context cwd only", () => {
		const registered: Record<string, { approval?: string; description?: string; execute?: (...args: unknown[]) => unknown }> = {};
		const pi = {
			zod: { object: (v: unknown) => v },
			registerTool(def: { name: string; approval?: string; description?: string; execute?: (...args: unknown[]) => unknown }) {
				registered[def.name] = def;
			},
		};
		hygieneOrientation(pi as never);
		expect(Object.keys(registered)).toEqual(["delivery_orient", "delivery_hygiene_report"]);
		expect(registered.delivery_orient?.approval).toBe("read");
		expect(registered.delivery_hygiene_report?.approval).toBe("read");
		expect(registered.delivery_orient?.description).toContain("does not enforce runtime role");
	});

	test("scan leaves inspected files unchanged", () => {
		const cwd = repo();
		const before = readFileSync(join(cwd, "tracked.txt"), "utf8");
		scanHygiene(cwd);
		expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe(before);
	});

	test("a symlink standing in for <agentRoot>/receipts is refused, not traversed", () => {
		const cwd = repo();
		const agent = temp();
		const elsewhere = temp();
		const key = repoKey(cwd);
		if (!key) throw new Error("missing repo key");
		mkdirSync(join(elsewhere, key), { recursive: true });
		const planted = join(agent, "receipts");
		symlinkSync(elsewhere, planted);
		const result = withAgentDir(agent, () => scanHygiene(cwd));
		const receipts = result.findings.find(f => f.kind === "receipts");
		expect(receipts?.status).toBe("ambiguous");
		expect(receipts?.description).toContain("is a symlink");
		expect(receipts?.paths).toEqual([planted]);
	});

	test("hostile receipt entries are ambiguous", () => {
		const cwd = repo();
		const agent = temp();
		const key = repoKey(cwd);
		if (!key) throw new Error("missing repo key");
		const dir = receiptDirectory({ PI_CODING_AGENT_DIR: agent }, key);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "oversize.json"), "x".repeat(1024 * 1024 + 1));
		symlinkSync(join(cwd, "tracked.txt"), join(dir, "linked.json"));
		const fifo = join(dir, "pipe.json");
		Bun.spawnSync(["mkfifo", fifo]);
		const result = withAgentDir(agent, () => scanHygiene(cwd));
		expect(result.status).toBe("ambiguous");
		const receipts = result.findings.find(f => f.kind === "receipts");
		expect(receipts?.paths).toEqual(expect.arrayContaining([join(dir, "oversize.json"), join(dir, "linked.json"), fifo]));
	});

	test("receipt directory falls back to platform home when HOME is unset", () => {
		expect(receiptDirectory({ HOME: "", PI_CODING_AGENT_DIR: "" })).toContain(".omp/receipts");
	});
});
