import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worktreeGate, {
	bootstrapAllowed,
	changesRepositoryTopology,
	createsWorktree,
	decideWorktreeCall,
	editTargets,
	type GateTopology,
	globBase,
	insideAny,
	projectWorktrees,
	type RepositoryTopology,
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
 *
 * The injected resolver answers per directory, the way the real one does: this
 * project owns its canonical checkout and its worktree, and everything else —
 * `foreign`, a scratch temp directory — is inside no repository at all.
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
	const owner: RepositoryTopology = { canonical, worktrees, refresh: () => worktrees };
	const nowhere: RepositoryTopology = { canonical: null, uncertainty: null, worktrees: [], refresh: () => [] };
	return {
		canonical,
		worktree,
		foreign,
		topology: { session: owner, forTarget: dir => (insideAny(dir, [canonical, worktree]) ? owner : nowhere) },
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

	test("a target under no repository of its own is scratch space, not a mutation to guard", () => {
		const { canonical, foreign, topology } = project();
		expect(
			decideWorktreeCall("write", { path: join(foreign, "src", "probe.ts"), content: "" }, canonical, topology),
		).toBeUndefined();
	});

	test("a target outside every repository is allowed", () => {
		const { canonical, topology } = project();
		const scratch = mkdtempSync(join(tmpdir(), "worktrunk-outside-"));
		roots.push(scratch);
		expect(decideWorktreeCall("write", { path: join(scratch, "probe.ts"), content: "" }, canonical, topology)).toBeUndefined();
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

	test("a read-only resume_session device may expose canonical paths", () => {
		const { canonical, topology } = project();
		expect(
			decideWorktreeCall(
				"write",
				{ path: "xd://resume_session", content: JSON.stringify({ mode: "list", path: canonical }) },
				canonical,
				topology,
			),
		).toBeUndefined();
	});

	test("an unknown xd device exposing a canonical path remains refused", () => {
		const { canonical, topology } = project();
		const decision = decideWorktreeCall(
			"write",
			{ path: "xd://unknown_device", content: JSON.stringify({ path: canonical }) },
			canonical,
			topology,
		);
		expect(decision?.block).toBe(true);
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

describe("canonical authorization", () => {
	test("a trusted structured env allows a canonical bash mutation", () => {
		const { canonical, topology } = project();
		expect(
			decideWorktreeCall(
				"bash",
				{ cwd: canonical, command: "touch authorized", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } },
				canonical,
				topology,
				root => root === canonical,
			),
		).toBeUndefined();
	});

	test.each([undefined, ""])("authorization requires a nonempty structured cwd: %s", cwd => {
		const { canonical, topology } = project();
		let authorizationCalls = 0;
		const input = { command: "touch denied", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" }, ...(cwd === undefined ? {} : { cwd }) };
		const decision = decideWorktreeCall("bash", input, canonical, topology, () => {
			authorizationCalls++;
			return true;
		});
		expect(decision?.block).toBe(true);
		expect(authorizationCalls).toBe(0);
	});

	test("a canonical subdirectory is not an exact canonical cwd", () => {
		const { canonical, topology } = project();
		let authorizationCalls = 0;
		const decision = decideWorktreeCall(
			"bash",
			{ cwd: join(canonical, "src"), command: "touch denied", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } },
			canonical,
			topology,
			() => {
				authorizationCalls++;
				return true;
			},
		);
		expect(decision?.block).toBe(true);
		expect(authorizationCalls).toBe(0);
	});

	test("a symlink-equivalent canonical root is accepted", () => {
		const { canonical, topology } = project();
		const parent = join(canonical, "..", "canonical-link");
		symlinkSync(canonical, parent);
		expect(
			decideWorktreeCall(
				"bash",
				{ cwd: parent, command: "touch authorized", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } },
				canonical,
				topology,
				root => root === canonical,
			),
		).toBeUndefined();
	});

	test.each([undefined, "0", "true"])("missing or wrong structured env value remains blocked: %s", value => {
		const { canonical, topology } = project();
		const env = value === undefined ? {} : { DELIVERY_ALLOW_PRIMARY_CHECKOUT: value };
		const decision = decideWorktreeCall("bash", { cwd: canonical, command: "touch denied", env }, canonical, topology, () => true);
		expect(decision?.block).toBe(true);
	});

	test("a worktree-only or absent directive remains blocked", () => {
		const { canonical, topology } = project();
		const decision = decideWorktreeCall(
			"bash",
			{ cwd: canonical, command: "touch denied", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } },
			canonical,
			topology,
			() => false,
		);
		expect(decision?.block).toBe(true);
	});

	test("canonical authorization does not parse wrappers or shell composition", () => {
		const { canonical, topology } = project();
		for (const command of ["env -- git commit -m x", "touch one; touch two", "DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 touch x"]) {
			const decision = decideWorktreeCall(
				"bash",
				{ cwd: canonical, command, env: command.startsWith("DELIVERY") ? {} : { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } },
				canonical,
				topology,
				() => true,
			);
			if (command.startsWith("DELIVERY")) expect(decision?.block).toBe(true);
			else expect(decision).toBeUndefined();
		}
	});

	test("linked-worktree wrappers remain allowed without granting canonical authorization", () => {
		const { canonical, worktree, topology } = project();
		let authorizationCalls = 0;
		expect(
			decideWorktreeCall(
				"bash",
				{ cwd: worktree, command: `env -- git -C ${canonical} commit -m x`, env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } },
				canonical,
				topology,
				() => {
					authorizationCalls++;
					return true;
				},
			),
		).toBeUndefined();
		expect(authorizationCalls).toBe(0);
	});

	test("canonical read-only git -C remains a bootstrap allowance", () => {
		const { canonical, worktree, topology } = project();
		expect(
			decideWorktreeCall("bash", { cwd: canonical, command: `git -C ${worktree} status --short` }, canonical, topology),
		).toBeUndefined();
	});

	test("an authorized commit reaches the downstream direct-main gate", () => {
		const { canonical, topology } = project();
		expect(
			decideWorktreeCall(
				"bash",
				{ cwd: canonical, command: "git commit -m authorized", env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" } },
				canonical,
				topology,
				() => true,
			),
		).toBeUndefined();
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

	test("judges each invocation and permits safe shell composition", () => {
		const wt = "wt switch -y --create --no-cd --base main --format json omp/agent/probe-1";
		expect(bootstrapAllowed(`${wt} 2>&1 | tail -5`)).toBe(true);
		expect(bootstrapAllowed(`printf ready; ${wt}`)).toBe(true);
		expect(bootstrapAllowed(`WT_TRACE=1 ${wt}`)).toBe(true);
		expect(bootstrapAllowed(`echo '${wt}'`)).toBe(false);
		expect(bootstrapAllowed(`cat <<'EOF'\n${wt}\nEOF`)).toBe(false);
		expect(bootstrapAllowed(`${wt} ; touch x`)).toBe(false);
	});

	test("a redirection to a file disqualifies the command, while discards and descriptors do not", () => {
		const list = "wt list --format json";
		expect(bootstrapAllowed(`${list} 2>&1 | tail -5`)).toBe(true);
		expect(bootstrapAllowed(`${list} > /dev/null`)).toBe(true);
		expect(bootstrapAllowed(`${list} > /Users/sjors/personal/dev/omp-orchestrate/f`)).toBe(false);
		expect(bootstrapAllowed(`${list} >> notes.txt`)).toBe(false);
		expect(bootstrapAllowed(`printf x > f ; ${list}`)).toBe(false);
	});

	test("resolves env prefixes and stdin-only pipeline filters", () => {
		expect(bootstrapAllowed("env -u BEADS_DIR bd --readonly --sandbox stats 2>&1 | head -40")).toBe(true);
		expect(bootstrapAllowed("bd --readonly --sandbox show omp-plugins-p98r 2>&1 | cut -c1-140")).toBe(true);
		expect(bootstrapAllowed("bd --readonly --sandbox list --status open")).toBe(true);
		expect(bootstrapAllowed("git commit -m x")).toBe(false);
		expect(bootstrapAllowed("bash -c \"bd list\"")).toBe(false);
		expect(bootstrapAllowed("bd list $(echo nope)")).toBe(false);
		expect(bootstrapAllowed("bd list | xargs touch")).toBe(false);
		expect(bootstrapAllowed("bd list > checkout.txt")).toBe(false);
		expect(bootstrapAllowed("not-a-bootstrap-binary")).toBe(false);
	});

	test("a companion that can write in place is not a companion", () => {
		expect(bootstrapAllowed("wt list | sed -i s/a/b/ f")).toBe(false);
		expect(bootstrapAllowed("wt list | sed -i s/a/b/")).toBe(false);
		expect(bootstrapAllowed("wt list | grep -f patterns")).toBe(false);
		expect(bootstrapAllowed("wt list | grep switch")).toBe(true);
	});

	test("an unbalanced quote is not judged, so it refuses", () => {
		expect(bootstrapAllowed('wt list --format "json')).toBe(false);
	});

	test("admits GitHub read verbs but not mutation", () => {
		for (const command of [
			"gh pr view 1",
			"gh pr checks 1",
			"gh pr list",
			"gh pr diff 1",
			"gh issue view 1",
			"gh issue list",
			"gh run view 1",
			"gh run list",
			"gh repo view",
			"gh api --method GET repos/srobroek/omp-plugins",
		]) expect(bootstrapAllowed(command)).toBe(true);
		expect(bootstrapAllowed("gh pr merge 1")).toBe(false);
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
		const nowhere: RepositoryTopology = { canonical: null, uncertainty: null, worktrees: [], refresh: () => [] };
		const inert: GateTopology = { session: nowhere, forTarget: () => nowhere };
		expect(decideWorktreeCall("write", { path: "/anywhere/x.ts", content: "" }, "/anywhere", inert)).toBeUndefined();
	});

	test("an undetermined session topology refuses mutation and still allows reading", () => {
		const undetermined: RepositoryTopology = {
			canonical: null,
			uncertainty: "`git` did not run (spawn git ENOENT)",
			worktrees: [],
			refresh: () => [],
		};
		const unknown: GateTopology = { session: undetermined, forTarget: () => undetermined };
		const decision = decideWorktreeCall("write", { path: "/anywhere/x.ts", content: "" }, "/anywhere", unknown);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("ENOENT");
		expect(decision?.reason).toContain("Uncertainty refuses");
		expect(decideWorktreeCall("read", { path: "/anywhere/x.ts" }, "/anywhere", unknown)).toBeUndefined();
	});

	test("a worktree list that does not answer refuses rather than reporting no worktrees", () => {
		const { canonical } = project();
		let listFailure: string | null = null;
		const owner: RepositoryTopology = {
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
		const broken: GateTopology = { session: owner, forTarget: () => owner };
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
		// Asked from the main worktree and from a linked one, the same canonical root
		// and the same repository identity come back.
		expect(resolveCanonicalRoot(canonical)).toEqual({
			state: "repository",
			canonical: expect.stringContaining("canonical"),
			commonDir: expect.stringContaining(".git"),
		});
		expect(resolveCanonicalRoot(worktree)).toEqual(resolveCanonicalRoot(canonical));
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

	test("a second repository is judged against its own topology, not this project's", () => {
		const mine = repository();
		const other = repository();
		// Its linked worktree is where a worker dispatched there works.
		expect(decideWorktreeCall("bash", { command: "bun test", cwd: other.worktree }, mine.canonical)).toBeUndefined();
		expect(
			decideWorktreeCall("write", { path: join(other.worktree, "probe.ts"), content: "" }, mine.canonical),
		).toBeUndefined();
		// Its canonical checkout is as protected as this project's, and the refusal
		// names that repository rather than the session's.
		const otherCanonical = decideWorktreeCall("bash", { command: "bun test", cwd: other.canonical }, mine.canonical);
		expect(otherCanonical?.block).toBe(true);
		expect(otherCanonical?.reason).toContain(other.canonical);
		const otherWrite = decideWorktreeCall("write", { path: join(other.canonical, "probe.ts"), content: "" }, mine.canonical);
		expect(otherWrite?.block).toBe(true);
		expect(otherWrite?.reason).toContain(other.canonical);
		expect(otherWrite?.reason).not.toContain(mine.canonical);
		// Bootstrapping there is the same exception it is here.
		expect(decideWorktreeCall("bash", { command: "bd list --json", cwd: other.canonical }, mine.canonical)).toBeUndefined();
		const refusal = decideWorktreeCall("bash", { command: "bun test", cwd: mine.canonical }, mine.canonical);
		expect(refusal?.block).toBe(true);
		// The refusal names the directory the call would have run in, so a reader
		// is not sent to inspect the wrong tree.
		expect(refusal?.reason).toContain(mine.canonical);
		// Two real repositories plus their lookups, with a wrapped `git` on PATH.
	}, 60000);

	test("a scratch directory outside every repository stays writable", () => {
		const mine = repository();
		const scratch = mkdtempSync(join(tmpdir(), "worktrunk-scratch-"));
		roots.push(scratch);
		expect(
			decideWorktreeCall("write", { path: join(scratch, "probe.ts"), content: "" }, mine.canonical),
		).toBeUndefined();
		expect(decideWorktreeCall("bash", { command: "bun test", cwd: scratch }, mine.canonical)).toBeUndefined();
	}, 60000);

	test("unreadable repository metadata refuses and does not poison a later permission", () => {
		const { canonical, worktree } = repository();
		const metadata = join(canonical, ".git");
		chmodSync(metadata, 0o000);
		try {
			const resolution = resolveCanonicalRoot(canonical);
			expect(resolution.state).toBe("unknown");
			const blocked = decideWorktreeCall("write", { path: "src/probe.ts", content: "" }, canonical);
			expect(blocked?.block).toBe(true);
			expect(blocked?.reason).toContain("Uncertainty refuses");
		} finally {
			chmodSync(metadata, 0o755);
		}
		expect(
			decideWorktreeCall("write", { path: join(worktree, "src", "probe.ts"), content: "" }, canonical),
		).toBeUndefined();
		expect(decideWorktreeCall("write", { path: "src/probe.ts", content: "" }, canonical)?.block).toBe(true);
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

describe("topology changes", () => {
	afterEach(() => {
		resetTopologyCache();
	});

	test("a worktree removed after a cached allow no longer trusts a recreated ordinary directory", () => {
		const { canonical } = repository();
		// Inside the canonical checkout, so the recreated directory is a canonical
		// mutation rather than scratch space outside every repository.
		const worktree = join(canonical, "nested-wt");
		execFileSync("git", ["-C", canonical, "worktree", "add", "-q", "-b", "omp/agent/nested", worktree], {
			stdio: "ignore",
		});
		const target = join(worktree, "src", "probe.ts");
		mkdirSync(join(worktree, "src"), { recursive: true });
		// The allow caches the membership; git is not consulted again on a hit.
		expect(decideWorktreeCall("write", { path: target, content: "" }, canonical)).toBeUndefined();

		// Another agent removes it — a removal is not a command this gate can see.
		execFileSync("git", ["-C", canonical, "worktree", "remove", "--force", worktree], { stdio: "ignore" });
		mkdirSync(join(worktree, "src"), { recursive: true });

		const decision = decideWorktreeCall("write", { path: target, content: "" }, canonical);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain(canonical);
	}, 60000);

	test("a repository created by the call being judged does not leave the gate inert", () => {
		const plain = mkdtempSync(join(tmpdir(), "worktrunk-init-"));
		roots.push(plain);
		const gate = handler();

		// Judged before it runs: no repository yet, so nothing to guard.
		expect(gate({ toolName: "bash", input: { command: "git init -b main" } }, { cwd: plain })).toBeUndefined();
		execFileSync("git", ["-C", plain, "init", "-q", "-b", "main"], { stdio: "ignore" });

		const decision = gate({ toolName: "write", input: { path: join(plain, "probe.ts"), content: "" } }, { cwd: plain });
		expect(decision?.block).toBe(true);
	}, 60000);
	test("a registered worktree path replaced by a different repository is refused", () => {
		const { canonical, worktree } = repository();
		const target = join(worktree, "probe.ts");
		expect(decideWorktreeCall("write", { path: target, content: "" }, canonical)).toBeUndefined();
		resetTopologyCache();

		// Deleted without unregistering, so the old repository still lists the path,
		// and a new repository now owns what is there.
		rmSync(worktree, { recursive: true, force: true });
		mkdirSync(worktree, { recursive: true });
		execFileSync("git", ["-C", worktree, "init", "-q", "-b", "main"], { stdio: "ignore" });

		expect(decideWorktreeCall("write", { path: target, content: "" }, canonical)?.block).toBe(true);
	}, 60000);

	test("a repository whose working tree git cannot name is guarded through its git directory", () => {
		const parent = mkdtempSync(join(tmpdir(), "worktrunk-sgd-"));
		roots.push(parent);
		const main = join(parent, "main");
		const meta = join(parent, "meta");
		execFileSync("git", ["init", "-q", "-b", "main", `--separate-git-dir=${meta}`, main], { stdio: "ignore" });
		execFileSync("git", ["-C", main, "config", "user.email", "probe@example.invalid"], { stdio: "ignore" });
		execFileSync("git", ["-C", main, "config", "user.name", "probe"], { stdio: "ignore" });
		execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "root"], { stdio: "ignore" });
		const linked = join(parent, "wt");
		execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "omp/agent/sgd", linked], { stdio: "ignore" });

		// Verified against git 2.55.0: with `--separate-git-dir` git sets no
		// `core.worktree` and the registration names the git directory, so the main
		// working tree cannot be named from here at all. The git directory becomes the
		// identity root — work in the linked worktree stays allowed, while the real
		// main checkout is still refused because a target there resolves from its own
		// directory, and the git directory itself is refused like any non-worktree.
		expect(resolveCanonicalRoot(linked)).toEqual({
			state: "repository",
			canonical: realpathSync(meta),
			commonDir: realpathSync(meta),
		});
		expect(decideWorktreeCall("write", { path: join(linked, "probe.ts"), content: "" }, linked)).toBeUndefined();
		expect(decideWorktreeCall("write", { path: join(main, "probe.ts"), content: "" }, linked)?.block).toBe(true);
		expect(decideWorktreeCall("write", { path: join(meta, "probe"), content: "" }, linked)?.block).toBe(true);
	}, 60000);

	test("a worktree path handed from one repository to another resolves its new owner", () => {
		const first = repository();
		const second = repository();
		const shared = first.worktree;
		expect(decideWorktreeCall("write", { path: join(shared, "probe.ts"), content: "" }, first.canonical)).toBeUndefined();

		// The path changes hands: removed from the first repository, added to the
		// second. A cached owner that outlives the move blocks legitimate work.
		execFileSync("git", ["-C", first.canonical, "worktree", "remove", "--force", shared], { stdio: "ignore" });
		execFileSync("git", ["-C", second.canonical, "worktree", "add", "-q", "-b", "omp/agent/moved", shared], {
			stdio: "ignore",
		});

		expect(decideWorktreeCall("write", { path: join(shared, "probe.ts"), content: "" }, second.canonical)).toBeUndefined();
	}, 60000);

	test("a directory that becomes a repository under another agent stops being scratch space", () => {
		const plain = mkdtempSync(join(tmpdir(), "worktrunk-late-init-"));
		roots.push(plain);
		const target = join(plain, "probe.ts");
		// Scratch space today: outside every repository, nothing to guard.
		expect(decideWorktreeCall("write", { path: target, content: "" }, plain)).toBeUndefined();

		// Another agent initialises a repository here; this session never sees that
		// command, so only revalidation can notice.
		execFileSync("git", ["-C", plain, "init", "-q", "-b", "main"], { stdio: "ignore" });

		expect(decideWorktreeCall("write", { path: target, content: "" }, plain)?.block).toBe(true);
	}, 60000);


	test("a submodule belongs to its own repository, whose checkout is refused like any canonical", () => {
		const { superproject, submodule } = withSubmodule();
		// The submodule's own main worktree is the checked-out directory, so a write
		// there is a canonical mutation. Deriving the owner from the common git
		// directory instead names `<super>/.git/modules`, where `git worktree list`
		// reports the superproject — and every one of these writes passes.
		expect(resolveCanonicalRoot(submodule)).toEqual({
			state: "repository",
			canonical: expect.stringContaining("/sub"),
			commonDir: expect.stringContaining("modules"),
		});
		expect(projectWorktrees(submodule)).toEqual([]);
		expect(decideWorktreeCall("write", { path: join(submodule, "probe.ts"), content: "" }, superproject)?.block).toBe(true);
		expect(decideWorktreeCall("write", { path: join(superproject, "probe.ts"), content: "" }, superproject)?.block).toBe(
			true,
		);
		// The submodule's git directory is repository internals, not a worktree.
		expect(
			decideWorktreeCall(
				"write",
				{ path: join(superproject, ".git", "modules", "sub", "probe"), content: "" },
				superproject,
			)?.block,
		).toBe(true);
	}, 60000);

	test("a linked worktree of a submodule is writable, and the submodule's own checkout is not", () => {
		const { submodule } = withSubmodule();
		const linked = join(mkdtempSync(join(tmpdir(), "worktrunk-sublinked-")), "wt");
		roots.push(linked);
		execFileSync("git", ["-C", submodule, "worktree", "add", "-q", "-b", "omp/agent/sub", linked], { stdio: "ignore" });
		expect(decideWorktreeCall("write", { path: join(linked, "probe.ts"), content: "" }, submodule)).toBeUndefined();
		expect(decideWorktreeCall("write", { path: join(submodule, "probe.ts"), content: "" }, submodule)?.block).toBe(true);
	}, 60000);
});

/**
 * A superproject with a checked-out submodule. The submodule's git directory
 * lives at `<super>/.git/modules/sub`, which is what makes `dirname` of the
 * common git directory the wrong owner.
 */
function withSubmodule(): { superproject: string; submodule: string } {
	const inner = repository();
	const superproject = repository().canonical;
	execFileSync(
		"git",
		["-C", superproject, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", inner.canonical, "sub"],
		{ stdio: "ignore" },
	);
	execFileSync("git", ["-C", superproject, "commit", "-q", "-m", "add submodule"], { stdio: "ignore" });
	return { superproject, submodule: join(superproject, "sub") };
}

/**
 * The registered `tool_call` listener. The cache interplay around a
 * topology-changing command lives in the handler, not in `decideWorktreeCall`, so
 * it can only be exercised here.
 */
function handler(): (event: { toolName: string; input: unknown }, ctx: { cwd: string }) => { block?: boolean } | undefined {
	let listener: unknown;
	worktreeGate({
		on: (_name: string, fn: unknown) => {
			listener = fn;
		},
	} as unknown as Parameters<typeof worktreeGate>[0]);
	if (typeof listener !== "function") throw new Error("the gate registered no tool_call listener");
	return listener as (event: { toolName: string; input: unknown }, ctx: { cwd: string }) => { block?: boolean } | undefined;
}

describe("pathless mutating tools", () => {
	test("a mutating tool that names no target is judged by the cwd it defaults to", () => {
		const { canonical, worktree, topology } = project();
		// `typescript_quality({mode:"fix"})` defaults its path to the session cwd and
		// writes fixes there; from canonical that is a canonical mutation.
		const decision = decideWorktreeCall("typescript_quality", { mode: "fix" }, canonical, topology);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain(canonical);
		expect(decideWorktreeCall("typescript_quality", { mode: "fix" }, worktree, topology)).toBeUndefined();
	});

	test("a pathless ledger call is allowed from canonical, and a ledger path argument is not", () => {
		const { canonical, topology } = project();
		// Claim-before-worktree: the bead must be claimable before a worktree exists,
		// exactly as the bootstrap allowlist permits `bd` from canonical.
		expect(decideWorktreeCall("orc_claim", { bead: "proj-1" }, canonical, topology)).toBeUndefined();
		expect(
			decideWorktreeCall("orc_status", { output_root: join(canonical, "out") }, canonical, topology)?.block,
		).toBe(true);
	});

	test("a pathless read-approved scan of the canonical checkout is inspection, not mutation", () => {
		const { canonical, topology } = project();
		// Every `approval: "read"` registration these plugins ship: they default an
		// optional path to the session cwd and only read it.
		const readApproved = [
			"dep_scan",
			"version_gap_scan",
			"resume_session",
			"chezmoi_status",
			"find_tools_scan",
			"agentic_lint",
			"headed_read",
			"sniff_read_report_artifact",
			"sniff_read_analyzer_artifact",
		];
		for (const tool of readApproved) {
			expect(decideWorktreeCall(tool, {}, canonical, topology)).toBeUndefined();
		}
	});

	test("a mode-dependent tool is judged by the mode it was called in", () => {
		const { canonical, topology } = project();
		// `bd_formula_check` reads unless `deep`, and `journeys_index` reads for
		// `lint` and an unconfirmed `prune`; each mirrors that tool's own approval.
		expect(decideWorktreeCall("bd_formula_check", { formula: "x" }, canonical, topology)).toBeUndefined();
		expect(decideWorktreeCall("bd_formula_check", { formula: "x", deep: true }, canonical, topology)?.block).toBe(true);
		expect(
			decideWorktreeCall("journeys_index", { command: "lint", journeysDir: join(canonical, "journeys") }, canonical, topology),
		).toBeUndefined();
		expect(
			decideWorktreeCall("journeys_index", { command: "prune", journeysDir: join(canonical, "journeys") }, canonical, topology),
		).toBeUndefined();
		expect(
			decideWorktreeCall(
				"journeys_index",
				{ command: "prune", yes: true, journeysDir: join(canonical, "journeys") },
				canonical,
				topology,
			)?.block,
		).toBe(true);
		expect(
			decideWorktreeCall("journeys_index", { command: "index", journeysDir: join(canonical, "journeys") }, canonical, topology)
				?.block,
		).toBe(true);
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
