import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	bootstrapAllowed,
	changesRepositoryTopology,
	createsWorktree,
	decideWorktreeCall,
	editTargets,
	type GateTopology,
	globBase,
	insideAny,
	projectWorktrees,
	resetTopologyCache,
	resolveCanonicalRoot,
	tokenize,
} from "./worktree-gate.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Project {
	canonical: string;
	worktree: string;
	foreign: string;
	topology: GateTopology;
}

/**
 * A real on-disk project: containment is decided by realpath, so temporary
 * directories are the only way to exercise it. No git is involved — the topology
 * is injected, which is what the seam exists for.
 */
function project(): Project {
	const parent = mkdtempSync(join(tmpdir(), "worktrunk-gate-"));
	roots.push(parent);
	const canonical = join(parent, "canonical");
	const worktree = join(parent, "worktrees", "omp-agent-bead-1");
	const foreign = join(parent, "other-repo-worktree");
	for (const dir of [join(canonical, "src"), join(worktree, "src"), join(foreign, "src")]) {
		mkdirSync(dir, { recursive: true });
	}
	const worktrees = [worktree];
	return {
		canonical,
		worktree,
		foreign,
		topology: { canonical, worktrees, refresh: () => worktrees },
	};
}

describe("insideAny", () => {
	test("a symlink to the canonical checkout does not count as inside the worktree", () => {
		const { canonical, worktree } = project();
		symlinkSync(join(canonical, "src"), join(worktree, "link"));
		expect(insideAny(join(worktree, "src", "a.ts"), [worktree])).toBe(true);
		// The link's target is canonical, so the physical write lands there.
		expect(insideAny(join(worktree, "link", "a.ts"), [worktree])).toBe(false);
	});

	test("a root itself is inside, and a sibling sharing a name prefix is not", () => {
		const { worktree } = project();
		expect(insideAny(worktree, [worktree])).toBe(true);
		expect(insideAny(`${worktree}-2/src/a.ts`, [worktree])).toBe(false);
	});
});

describe("write", () => {
	test("a relative path resolving into canonical is refused, naming the canonical root", () => {
		const { canonical, topology } = project();
		const decision = decideWorktreeCall("write", { path: "src/probe.ts", content: "" }, canonical, topology);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain(canonical);
		expect(decision?.reason).toContain("wt switch -y --create --no-cd");
	});

	test("a path under a project worktree is allowed", () => {
		const { canonical, worktree, topology } = project();
		expect(
			decideWorktreeCall("write", { path: join(worktree, "src", "probe.ts"), content: "" }, canonical, topology),
		).toBeUndefined();
	});

	test("a worktree of a different repository is refused", () => {
		const { canonical, foreign, topology } = project();
		const decision = decideWorktreeCall("write", { path: join(foreign, "src", "probe.ts"), content: "" }, canonical, topology);
		expect(decision?.block).toBe(true);
	});

	test("a symlink inside a worktree pointing at canonical is refused", () => {
		const { canonical, worktree, topology } = project();
		symlinkSync(join(canonical, "src"), join(worktree, "link"));
		const decision = decideWorktreeCall("write", { path: join(worktree, "link", "probe.ts"), content: "" }, canonical, topology);
		expect(decision?.block).toBe(true);
	});

	test("an internal-URL target is not a working-tree path", () => {
		const { canonical, topology } = project();
		expect(decideWorktreeCall("write", { path: "local://plan.md", content: "x" }, canonical, topology)).toBeUndefined();
	});

	test("a missing path string refuses rather than passing unclassified", () => {
		const { canonical, topology } = project();
		expect(decideWorktreeCall("write", { content: "x" }, canonical, topology)?.block).toBe(true);
	});
});

describe("xd:// devices", () => {
	test("a device write whose own path argument is under canonical is refused", () => {
		const { canonical, topology } = project();
		const decision = decideWorktreeCall(
			"write",
			{ path: "xd://scaffold", content: JSON.stringify({ path: join(canonical, "src", "probe.ts") }) },
			canonical,
			topology,
		);
		expect(decision?.block).toBe(true);
	});

	test("the same device write into a worktree is allowed", () => {
		const { canonical, worktree, topology } = project();
		expect(
			decideWorktreeCall(
				"write",
				{ path: "xd://scaffold", content: JSON.stringify({ path: join(worktree, "src", "probe.ts") }) },
				canonical,
				topology,
			),
		).toBeUndefined();
	});
});

describe("unenumerated tools", () => {
	test("a nested absolute canonical path in an unknown tool is refused", () => {
		const { canonical, topology } = project();
		const decision = decideWorktreeCall(
			"mcp__filesystem_write_file",
			{ args: { file: join(canonical, "src", "probe.ts") } },
			canonical,
			topology,
		);
		expect(decision?.block).toBe(true);
	});

	test("a read-only builtin naming a canonical path is allowed", () => {
		const { canonical, topology } = project();
		expect(decideWorktreeCall("read", { path: join(canonical, "src") }, canonical, topology)).toBeUndefined();
		expect(
			decideWorktreeCall("task", { task: `review ${join(canonical, "src")}` }, canonical, topology),
		).toBeUndefined();
	});
});

describe("bash", () => {
	test("an omitted cwd with an ordinary command is refused", () => {
		const { canonical, topology } = project();
		const decision = decideWorktreeCall("bash", { command: "touch scratch-probe" }, canonical, topology);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain(canonical);
	});

	test("an omitted cwd with the allowlisted worktree bootstrap is allowed", () => {
		const { canonical, topology } = project();
		expect(
			decideWorktreeCall(
				"bash",
				{ command: "wt switch -y --create --no-cd --base main --format json omp/agent/probe-1" },
				canonical,
				topology,
			),
		).toBeUndefined();
	});

	test("the same bootstrap with a chained command appended is refused", () => {
		const { canonical, topology } = project();
		const decision = decideWorktreeCall(
			"bash",
			{ command: "wt switch -y --create --no-cd --base main --format json omp/agent/probe-1 ; touch x" },
			canonical,
			topology,
		);
		expect(decision?.block).toBe(true);
	});

	test("a cwd inside a worktree runs anything", () => {
		const { canonical, worktree, topology } = project();
		expect(
			decideWorktreeCall("bash", { command: "touch scratch-probe", cwd: worktree }, canonical, topology),
		).toBeUndefined();
	});

	test("a command with no command string refuses", () => {
		const { canonical, topology } = project();
		expect(decideWorktreeCall("bash", {}, canonical, topology)?.block).toBe(true);
	});
});

describe("bootstrapAllowed", () => {
	test("accepts the create and pull-request switch forms", () => {
		expect(bootstrapAllowed("wt switch -y --create --no-cd --base main --format json omp/agent/x.1")).toBe(true);
		expect(bootstrapAllowed("wt -C /repo switch --yes -c --no-cd --base origin/main --format json omp/epic/e1")).toBe(true);
		expect(bootstrapAllowed("wt switch -y --no-cd --format json pr:1763")).toBe(true);
	});

	test("rejects a switch that would hang, escape the prefix, or create without a base", () => {
		expect(bootstrapAllowed("wt switch -y --no-cd --format json")).toBe(false);
		expect(bootstrapAllowed("wt switch -y --create --no-cd --base main --format json feature/x")).toBe(false);
		expect(bootstrapAllowed("wt switch -y --create --no-cd --format json omp/agent/x")).toBe(false);
		expect(bootstrapAllowed("wt switch --create --no-cd --base main --format json omp/agent/x")).toBe(false);
		expect(bootstrapAllowed("wt switch -y --create --no-cd --base main --format json omp/agent/x --clobber")).toBe(false);
	});

	test("accepts the listed read-only wt, git, and every bd command", () => {
		expect(bootstrapAllowed("wt list")).toBe(true);
		expect(bootstrapAllowed("wt list --format json")).toBe(true);
		expect(bootstrapAllowed("wt config show")).toBe(true);
		expect(bootstrapAllowed("wt step prune --dry-run")).toBe(true);
		expect(bootstrapAllowed("git worktree list --porcelain")).toBe(true);
		expect(bootstrapAllowed("git -C /repo status --porcelain=v1 -b")).toBe(true);
		expect(bootstrapAllowed("git fetch origin")).toBe(true);
		expect(bootstrapAllowed("git branch --list omp/*")).toBe(true);
		expect(bootstrapAllowed("bd update x --claim --json")).toBe(true);
	});

	test("rejects mutating git, unlisted wt, and every other program", () => {
		expect(bootstrapAllowed("wt step prune")).toBe(false);
		expect(bootstrapAllowed("wt remove -y omp/agent/x")).toBe(false);
		expect(bootstrapAllowed("wt merge")).toBe(false);
		expect(bootstrapAllowed("git worktree remove x")).toBe(false);
		expect(bootstrapAllowed("git branch -D omp/agent/x")).toBe(false);
		expect(bootstrapAllowed("git commit -m x")).toBe(false);
		expect(bootstrapAllowed("bun test")).toBe(false);
	});

	test("a shell metacharacter disqualifies an otherwise allowlisted command", () => {
		for (const suffix of [" ; touch x", " && touch x", " | tee x", " > x", " < x", " `touch x`", " $(touch x)", "\ntouch x"]) {
			expect(bootstrapAllowed(`git status${suffix}`)).toBe(false);
		}
	});
});

describe("edit", () => {
	test("a header under canonical is refused and one under a worktree is allowed", () => {
		const { canonical, worktree, topology } = project();
		const target = join(canonical, "src", "a.ts");
		writeFileSync(target, "x\n");
		expect(decideWorktreeCall("edit", { input: `[${target}#1A2B]\nPUT 1.=1:\n+y\n` }, canonical, topology)?.block).toBe(true);
		const allowed = join(worktree, "src", "a.ts");
		writeFileSync(allowed, "x\n");
		expect(decideWorktreeCall("edit", { input: `[${allowed}#1A2B]\nPUT 1.=1:\n+y\n` }, canonical, topology)).toBeUndefined();
	});

	test("a payload whose headers will not parse refuses", () => {
		const { canonical, topology } = project();
		expect(editTargets({ input: "PUT 1.=1:\n+y\n" })).toBeNull();
		expect(decideWorktreeCall("edit", { input: "PUT 1.=1:\n+y\n" }, canonical, topology)?.block).toBe(true);
		expect(decideWorktreeCall("edit", { nonsense: true }, canonical, topology)?.block).toBe(true);
	});

	test("a move destination outside a worktree is refused even when the source is inside", () => {
		const { canonical, worktree, topology } = project();
		const source = join(worktree, "src", "a.ts");
		writeFileSync(source, "x\n");
		const payload = `[${source}#1A2B]\nMV ${join(canonical, "src", "a.ts")}\n`;
		expect(editTargets({ input: payload })).toContain(join(canonical, "src", "a.ts"));
		expect(decideWorktreeCall("edit", { input: payload }, canonical, topology)?.block).toBe(true);
	});

	test("the replace wire shape is checked through its path and rename fields", () => {
		const { canonical, worktree, topology } = project();
		expect(
			decideWorktreeCall(
				"edit",
				{ path: join(canonical, "src", "a.ts"), old_string: "a", new_string: "b" },
				canonical,
				topology,
			)?.block,
		).toBe(true);
		expect(
			decideWorktreeCall(
				"edit",
				{ path: join(worktree, "src", "a.ts"), edits: [{ rename: join(canonical, "src", "b.ts") }] },
				canonical,
				topology,
			)?.block,
		).toBe(true);
	});
});

describe("ast_edit", () => {
	test("a glob whose base is under canonical is refused", () => {
		const { canonical, worktree, topology } = project();
		expect(globBase("src/**/*.ts")).toBe("src");
		expect(
			decideWorktreeCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src/**/*.ts"] }, canonical, topology)
				?.block,
		).toBe(true);
		expect(
			decideWorktreeCall(
				"ast_edit",
				{ ops: [{ pat: "a", out: "b" }], paths: [`${join(worktree, "src")}/**/*.ts`] },
				canonical,
				topology,
			),
		).toBeUndefined();
	});

	test("a missing or non-string paths list refuses", () => {
		const { canonical, topology } = project();
		expect(decideWorktreeCall("ast_edit", { ops: [] }, canonical, topology)?.block).toBe(true);
		expect(decideWorktreeCall("ast_edit", { paths: [7] }, canonical, topology)?.block).toBe(true);
	});
});

describe("eval", () => {
	test("a canonical session cwd is refused and a worktree cwd is allowed", () => {
		const { canonical, worktree, topology } = project();
		expect(decideWorktreeCall("eval", { code: "1" }, canonical, topology)?.block).toBe(true);
		expect(decideWorktreeCall("eval", { code: "1" }, worktree, topology)).toBeUndefined();
	});
});

describe("scope", () => {
	test("the gate is inert when git confirmed the session is in no repository", () => {
		const inert: GateTopology = { canonical: null, uncertainty: null, worktrees: [], refresh: () => [] };
		expect(decideWorktreeCall("write", { path: "/anywhere/x.ts", content: "" }, "/anywhere", inert)).toBeUndefined();
	});

	test("an undetermined topology refuses mutation and still allows reading", () => {
		const unknown: GateTopology = {
			canonical: null,
			uncertainty: "`git` did not run (spawn git ENOENT)",
			worktrees: [],
			refresh: () => [],
		};
		const decision = decideWorktreeCall("write", { path: "/anywhere/x.ts", content: "" }, "/anywhere", unknown);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("ENOENT");
		expect(decision?.reason).toContain("Uncertainty refuses");
		expect(decideWorktreeCall("read", { path: "/anywhere/x.ts" }, "/anywhere", unknown)).toBeUndefined();
	});

	test("a worktree list that does not answer refuses rather than reporting no worktrees", () => {
		const { canonical } = project();
		let listFailure: string | null = null;
		const broken: GateTopology = {
			canonical,
			get uncertainty(): string | null {
				return listFailure;
			},
			worktrees: [],
			refresh: () => {
				listFailure = "`git worktree list` did not answer";
				return [];
			},
		};
		const decision = decideWorktreeCall("write", { path: join(canonical, "src", "x.ts"), content: "" }, canonical, broken);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("`git worktree list` did not answer");
	});
});

/** A real repository with one linked worktree: the git-answer classification needs real git. */
function repository(): { canonical: string; worktree: string } {
	const parent = mkdtempSync(join(tmpdir(), "worktrunk-git-"));
	roots.push(parent);
	const canonical = join(parent, "canonical");
	mkdirSync(join(canonical, "src"), { recursive: true });
	const git = (...args: string[]): void => {
		execFileSync("git", ["-C", canonical, ...args], { stdio: "ignore" });
	};
	git("init", "-q", "-b", "main");
	git("config", "user.email", "probe@example.invalid");
	git("config", "user.name", "probe");
	git("commit", "-q", "--allow-empty", "-m", "root");
	const worktree = join(parent, "wt");
	git("worktree", "add", "-q", "-b", "omp/agent/probe", worktree);
	return { canonical, worktree };
}

describe("git answers", () => {
	afterEach(() => {
		resetTopologyCache();
	});

	test("a repository, a plain directory and an unavailable git are three different answers", () => {
		const { canonical, worktree } = repository();
		expect(resolveCanonicalRoot(canonical)).toEqual({ state: "repository", canonical: expect.stringContaining("canonical") });
		expect(resolveCanonicalRoot(worktree)).toEqual({ state: "repository", canonical: expect.stringContaining("canonical") });
		expect(projectWorktrees(canonical)?.length).toBe(1);

		const plain = mkdtempSync(join(tmpdir(), "worktrunk-plain-"));
		roots.push(plain);
		expect(resolveCanonicalRoot(plain)).toEqual({ state: "no-repository" });

		const path = process.env.PATH;
		process.env.PATH = join(plain, "no-tools");
		try {
			const unknown = resolveCanonicalRoot(canonical);
			expect(unknown.state).toBe("unknown");
			expect(projectWorktrees(canonical)).toBeNull();
		} finally {
			process.env.PATH = path;
		}
	});

	test("a git failure blocks the write and is not cached, so recovery needs no invalidation", () => {
		const { canonical, worktree } = repository();
		const path = process.env.PATH;
		process.env.PATH = join(canonical, "no-tools");
		let duringFailure: { block: boolean } | undefined;
		try {
			duringFailure = decideWorktreeCall("write", { path: "src/probe.ts", content: "" }, canonical) as
				| { block: boolean }
				| undefined;
		} finally {
			process.env.PATH = path;
		}
		expect(duringFailure?.block).toBe(true);
		// No cache was poisoned: the very next call decides against real git again.
		expect(
			decideWorktreeCall("write", { path: join(worktree, "src", "probe.ts"), content: "" }, canonical),
		).toBeUndefined();
		expect(decideWorktreeCall("write", { path: "src/probe.ts", content: "" }, canonical)?.block).toBe(true);
	});
});

describe("security_scan", () => {
	test("its output root and knowledge base are mutations, so canonical targets are refused", () => {
		const { canonical, worktree, topology } = project();
		expect(
			decideWorktreeCall("security_scan", { action: "start", output_root: "scan-out" }, canonical, topology)?.block,
		).toBe(true);
		expect(
			decideWorktreeCall(
				"security_scan",
				{ action: "start", knowledge_base_paths: [join(canonical, "kb")] },
				canonical,
				topology,
			)?.block,
		).toBe(true);
		expect(
			decideWorktreeCall(
				"security_scan",
				{ action: "start", output_root: join(worktree, "scan-out") },
				canonical,
				topology,
			),
		).toBeUndefined();
	});
});

describe("helpers", () => {
	test("tokenize honours quotes and reports an unbalanced one", () => {
		expect(tokenize(`git -C "/a b" status`)).toEqual(["git", "-C", "/a b", "status"]);
		expect(tokenize(`git -C "/a`)).toBeNull();
	});

	test("createsWorktree recognizes the commands that stale the cache", () => {
		expect(createsWorktree("wt switch -y --create --no-cd --base main --format json omp/agent/x")).toBe(true);
		expect(createsWorktree("git worktree add ../x -b y")).toBe(true);
		expect(createsWorktree("wt list --format json")).toBe(false);
	});

	test("changesRepositoryTopology recognizes only what can create or move a repository", () => {
		expect(changesRepositoryTopology("git init -b main")).toBe(true);
		expect(changesRepositoryTopology("git clone https://example.invalid/r.git")).toBe(true);
		expect(changesRepositoryTopology("git status --porcelain")).toBe(false);
		expect(changesRepositoryTopology("wt switch -y --create --no-cd --base main --format json omp/agent/x")).toBe(false);
	});
});
