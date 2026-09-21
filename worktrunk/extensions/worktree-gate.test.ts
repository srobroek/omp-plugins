import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

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
	stillLinkedWorktree,
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

describe("device classification", () => {
	/**
	 * The gate judges the filesystem paths a call names. A device call that names
	 * none — a ledger write, `xd://retain`, a probe — mutates no working tree the
	 * gate can attribute, and judging it against the session cwd would refuse
	 * every such call an agent makes before it has a worktree, because the cwd it
	 * starts in is the canonical checkout.
	 */
	test("a device is judged by the paths it names, not by whether the gate knows it", () => {
		const { canonical, topology } = project();
		expect(decideWorktreeCall("orc_arbitrary", {}, canonical, topology)).toBeUndefined();
		expect(decideWorktreeCall("orc_arbitrary", { path: join(canonical, "src", "a.ts") }, canonical, topology)?.block).toBe(true);
	});

	/**
	 * The refusal this fix exists for: `write { path: "xd://retain" }` recursed into
	 * the `retain` device, that device names no path, and the gate judged it against
	 * the session cwd — so storing a memory from the directory an agent starts in
	 * was refused as a canonical mutation.
	 */
	test("an OMP native URL names no filesystem path, whatever its scheme", () => {
		const { canonical, topology } = project();
		const memory = JSON.stringify({ items: [{ content: "a fact" }] });
		expect(decideWorktreeCall("write", { path: "xd://retain", content: memory }, canonical, topology)).toBeUndefined();
		// Scheme-agnostic: a device, an internal URL and a scheme nobody has shipped
		// yet are all judged the same way, so a new one cannot become a canonical path.
		for (const url of ["xd://recall", "memory://01a0", "local://plan.md", "artifact://253", "future+scheme://whatever"]) {
			expect(decideWorktreeCall("some_tool", { path: url }, canonical, topology)).toBeUndefined();
		}
	});

	/**
	 * `targets` carries bead ids on the ledger tools, and a bead id is shaped exactly
	 * like a relative path — `omp-plugins-v9p5` and `scan-out` are both bare
	 * segments. The key therefore decides, and `targets` means ledger identifiers:
	 * a tool that does name a filesystem target names it under a key that means one.
	 */
	test("a ledger identifier is not a path, and a path key still is", () => {
		const { canonical, topology } = project();
		const finish = { bead: "review", state: "done", reason: "ok", verdict: "approve", targets: ["task-id"] };
		expect(decideWorktreeCall("orc_finish", finish, canonical, topology)).toBeUndefined();
		expect(decideWorktreeCall("some_tool", { targets: [join(canonical, "src", "probe.ts")] }, canonical, topology)).toBeUndefined();
		expect(decideWorktreeCall("some_tool", { path: join(canonical, "src", "probe.ts") }, canonical, topology)?.block).toBe(true);
	});

    test("known ledger-only and read-only controls are explicit", () => {
        const { canonical, topology } = project();
        const controls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
            ["orc_claim", { bead: "proj-1" }],
            ["orc_decide", { bead: "x", action: "retry", reason: "test" }],
            ["orc_finish", { bead: "review", state: "done", reason: "ok", verdict: "approve", targets: ["task-id"] }],
            ["orc_release", { bead: "x", holder: "actor", reason: "test" }],
            ["orc_status", { epic: "run" }],
            ["orc_bot_review_probe", { pr: "357", repo: "srobroek/omp-plugins" }],
            ["orc_review_round_policy", { rounds_completed: 0, actionable_issues: [] }],
            ["orc_conflict_probe", { mode: "ci", pr: "357" }],
        ];
        for (const [tool, input] of controls) {
            expect(decideWorktreeCall(tool, input, canonical, topology)).toBeUndefined();
        }
    });
    test("all ledger tools are exempt from working-tree containment", () => {
        const { canonical, topology } = project();
        const ledgerTools = [
            "orc_bind",
            "orc_claim",
            "orc_status",
            "orc_decide",
            "orc_finish",
            "orc_release",
            "orc_conflict_probe",
            "orc_bot_review_probe",
            "orc_bot_review_request",
            "orc_review_round_policy",
        ] as const;
        for (const tool of ledgerTools) {
            expect(decideWorktreeCall(tool, { cwd: canonical }, canonical, topology)).toBeUndefined();
        }
    });

    test("cwd-bearing ledger probes are exempt while worktree paths remain allowed", () => {
        const { canonical, worktree, topology } = project();
        const controls: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> = [
            ["orc_bot_review_probe", { pr: "357", repo: "srobroek/omp-plugins", cwd: canonical }, { pr: "357", repo: "srobroek/omp-plugins", cwd: worktree }],
            ["orc_conflict_probe", { mode: "ci", pr: "357", cwd: canonical }, { mode: "ci", pr: "357", cwd: worktree }],
        ];
        for (const [tool, canonicalInput, worktreeInput] of controls) {
            expect(decideWorktreeCall(tool, canonicalInput, canonical, topology)).toBeUndefined();
            expect(decideWorktreeCall(tool, worktreeInput, worktree, topology)).toBeUndefined();
        }
    });

});

describe("xd wire validation", () => {
	/**
	 * A payload the gate cannot parse names no filesystem path, and the device
	 * rejects it on arrival. Refusing it here would report a wire error as a
	 * containment breach.
	 */
	test("a payload that names no path is left to the device", () => {
		const { canonical, topology } = project();
		for (const content of [undefined, 42, "{bad"]) {
			const input = content === undefined ? { path: "xd://unknown_device" } : { path: "xd://unknown_device", content };
			expect(decideWorktreeCall("write", input, canonical, topology)).toBeUndefined();
		}
	});

	test("a device payload is judged by the paths it carries, whatever the device is", () => {
		const { canonical, worktree, topology } = project();
		for (const path of ["xd://orc_bot_review_request", "xd://unknown_device"]) {
			expect(decideWorktreeCall("write", { path, content: "{}" }, canonical, topology)).toBeUndefined();
			const nested = JSON.stringify({ path: join(canonical, "src", "a.ts") });
			expect(decideWorktreeCall("write", { path, content: nested }, canonical, topology)?.block).toBe(true);
			const inWorktree = JSON.stringify({ path: join(worktree, "src", "a.ts") });
			expect(decideWorktreeCall("write", { path, content: inWorktree }, canonical, topology)).toBeUndefined();
		}
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

	test("canonical bootstrap refuses sort and output-file forms but permits allowlisted stdin filters", () => {
		const { canonical, topology } = project();
		for (const command of [
			"wt list | sort -o README.md",
			"wt list | sort -oREADME.md",
			"wt list | sort -noREADME.md",
			"wt list | sort --output README.md",
			"wt list | sort --output=README.md",
			"wt list | sort --out=README.md",
			"wt list | sort --o=README.md",
			"wt list | sort -$'\\x6fREADME.md'",
			"wt list | sort --$'\\x6futput=README.md'",
			"wt list | uniq input.txt output.txt",
		]) {
			expect(decideWorktreeCall("bash", { command }, canonical, topology)?.block).toBe(true);
		}
		for (const command of ["wt list | uniq -c"]) {
			expect(decideWorktreeCall("bash", { command }, canonical, topology)).toBeUndefined();
		}
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

test("an explicit wt -C worktree target allows a non-bootstrap mutation", () => {
  const { canonical, worktree, topology } = project();
  const decision = decideWorktreeCall(
    "bash",
    { command: `wt -C ${worktree} -y step copy-ignored` },
    canonical,
    topology,
  );
  expect(decision).toBeUndefined();
});

test("git work-tree and git-dir options select the effective target", () => {
  const { canonical, worktree, topology } = project();
  for (const command of [
    `git --work-tree ${worktree} status`,
    `git --git-dir ${worktree}/.git status`,
  ]) {
    expect(decideWorktreeCall("bash", { command }, canonical, topology)).toBeUndefined();
  }
});

test("a chain of explicit worktree targets is judged per command", () => {
  const { canonical, worktree, topology } = project();
  const command = `wt -C ${worktree} -y step copy-ignored && wt -C ${worktree} -y step copy-ignored`;
  expect(decideWorktreeCall("bash", { command }, canonical, topology)).toBeUndefined();
});

test("a wt global directory option before switch is recognized", () => {
  const { worktree } = project();
  expect(
    bootstrapAllowed(`wt --directory ${worktree} -y switch --create --no-cd --base main --format json omp/agent/probe-1`),
  ).toBe(true);
});

test("dynamic, substituted, and unparseable explicit targets refuse", () => {
  const { canonical, worktree, topology } = project();
  for (const command of [
    `wt -C "$DIR" -y step copy-ignored`,
    `wt -C $(printf ${worktree}) -y step copy-ignored`,
    `wt -C "${worktree} -y step copy-ignored`,
  ]) {
    expect(decideWorktreeCall("bash", { command }, canonical, topology)?.block).toBe(true);
  }
});

test("a read-only absolute path outside the project is not judged canonical", () => {
  const { canonical, foreign, topology } = project();
  const file = join(foreign, "mise");
  writeFileSync(file, "#!/bin/sh\nprintf\n");
  expect(decideWorktreeCall("bash", { command: `wc -c ${file}` }, canonical, topology)).toBeUndefined();
});

test("an eval cell that only reads an external file is not judged canonical", () => {
  const { canonical, foreign, topology } = project();
  const file = join(foreign, "mise");
  writeFileSync(file, "#!/bin/sh\nprintf\n");
  const code = `from pathlib import Path\ndata = Path(${JSON.stringify(file)}).read_bytes()\nprint([(i, byte) for i, byte in enumerate(data)])`;
  expect(decideWorktreeCall("eval", { language: "py", code }, canonical, topology)).toBeUndefined();
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

	test("allows read-only quoted and heredoc data without executing it", () => {
		const wt = "wt switch -y --create --no-cd --base main --format json omp/agent/probe-1";
		expect(bootstrapAllowed(`echo '${wt}'`)).toBe(true);
		expect(bootstrapAllowed(`cat <<'EOF'\n${wt}\nEOF`)).toBe(true);
		expect(bootstrapAllowed("rm -f scratch")).toBe(false);
		expect(bootstrapAllowed("touch scratch")).toBe(false);
	});

	test.each([
		"wt switch -y --create --no-cd --base $(printf main) --format json omp/agent/x.1",
		"wt switch -y --create --no-cd --base `printf main` --format json omp/agent/x.1",
		"wt switch -y --create --no-cd --base '`printf main`' --format json omp/agent/x.1",
		"wt switch -y --create --no-cd --base $(printf $(printf main)) --format json omp/agent/x.1",
	])("rejects literal command substitution before tokenization: %s", command => {
		expect(bootstrapAllowed(command)).toBe(false);
	});

	test("rejects quoted command substitution but accepts an ordinary quoted argument", () => {
		expect(bootstrapAllowed("wt switch -y --create --no-cd --base '$(printf main)' --format json omp/agent/x.1")).toBe(false);
		expect(bootstrapAllowed("wt switch -y --create --no-cd --base '`printf main`' --format json omp/agent/x.1")).toBe(false);
		expect(bootstrapAllowed("wt switch -y --create --no-cd --base 'main branch' --format json omp/agent/x.1")).toBe(true);
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
		expect(bootstrapAllowed("bd --readonly --sandbox show omp-plugins-p98r 2>&1 | cut -c1-140 named.txt")).toBe(false);
		expect(bootstrapAllowed("bd --readonly --sandbox show omp-plugins-p98r 2>&1 | cut -c1-140 /tmp/output.txt")).toBe(false);
		expect(bootstrapAllowed("bd --readonly --sandbox list --status open")).toBe(true);
		expect(bootstrapAllowed("git commit -m x")).toBe(false);
		expect(bootstrapAllowed("bash -c \"bd list\"")).toBe(false);
		expect(bootstrapAllowed("bd list $(echo nope)")).toBe(false);
		expect(bootstrapAllowed("bd list `echo nope`")).toBe(false);
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
	}, 60000);

	test("ownership queries ignore inherited Git environment controls while retaining PATH", () => {
		const { canonical, worktree } = repository();
		const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
		const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
		Object.assign(process.env, {
			GIT_DIR: join(canonical, "missing-git-dir"),
			GIT_WORK_TREE: join(canonical, "missing-work-tree"),
			GIT_OBJECT_DIRECTORY: join(canonical, "missing-objects"),
			GIT_CONFIG_GLOBAL: join(canonical, "missing-config"),
			GIT_CONFIG_SYSTEM: join(canonical, "missing-system-config"),
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.worktree",
			GIT_CONFIG_VALUE_0: join(canonical, "wrong-work-tree"),
		});
		try {
			expect(resolveCanonicalRoot(worktree).state).toBe("repository");
			expect(projectWorktrees(canonical)).toHaveLength(1);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("a file target inside a linked worktree is allowed when cwd is that file", () => {
		const { worktree } = repository();
		const file = join(worktree, "src", "existing.ts");
		mkdirSync(join(worktree, "src"), { recursive: true });
		writeFileSync(file, "export const probe = true;\n");
		expect(decideWorktreeCall("write", { path: file, content: "" }, file)).toBeUndefined();
	}, 60000);

	test("a not-yet-existing target inside a linked worktree is allowed", () => {
		const { worktree } = repository();
		const file = join(worktree, "src", "new", "probe.ts");
		expect(decideWorktreeCall("write", { path: file, content: "" }, file)).toBeUndefined();
	}, 60000);

	test("a file target inside this project's canonical checkout remains refused", () => {
		const { canonical } = repository();
		const file = join(canonical, "src", "existing.ts");
		writeFileSync(file, "export const probe = true;\n");
		const refusal = decideWorktreeCall("write", { path: file, content: "" }, file);
		expect(refusal?.block).toBe(true);
		expect(refusal?.reason).toContain(canonical);
		// The classified refusal, not an uncertainty one: git was asked from the
		// file's directory and named this repository, so the gate decided rather
		// than gave up.
		expect(refusal?.reason).toContain("is not inside a linked worktree of this project");
		expect(refusal?.reason).not.toContain("Uncertainty refuses");
	}, 60000);

	test("a file target in a foreign repository is judged against that repository", () => {
		const mine = repository();
		const foreign = repository();
		mkdirSync(join(foreign.worktree, "src"), { recursive: true });
		const inWorktree = join(foreign.worktree, "src", "existing.ts");
		writeFileSync(inWorktree, "export const probe = true;\n");
		// Ownership comes from the file's own repository, so its linked worktree is
		// where a worker dispatched there writes.
		expect(decideWorktreeCall("write", { path: inWorktree, content: "" }, mine.canonical)).toBeUndefined();
		// And that repository's canonical checkout is as protected as this one's:
		// resolving a file target through its directory must not lose the owner.
		const inCanonical = join(foreign.canonical, "src", "existing.ts");
		writeFileSync(inCanonical, "export const probe = true;\n");
		const refusal = decideWorktreeCall("write", { path: inCanonical, content: "" }, mine.canonical);
		expect(refusal?.block).toBe(true);
		expect(refusal?.reason).toContain(foreign.canonical);
		expect(refusal?.reason).not.toContain(mine.canonical);
		// Two real repositories plus their lookups.
	}, 60000);

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
	}, 60000);

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
	}, 60000);
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

	test("a registered worktree path replaced through a git directory under the old common directory is refused", () => {
		// `--separate-git-dir` lets an unrelated repository put its git directory
		// anywhere, including inside this repository's common git directory, while
		// leaving a `.git` FILE of exactly the linked-worktree shape at a registered
		// worktree's path. Both placements below are rejected: an arbitrary
		// descendant, and one wearing the `worktrees/<id>` shape of a registration.
		for (const inside of [["replacement"], ["worktrees", "impostor"]]) {
			const { canonical, worktree } = repository();
			const commonDir = execFileSync("git", ["-C", canonical, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
				encoding: "utf8",
			}).trim();
			const admin = join(commonDir, ...inside);
			const target = join(worktree, "probe.ts");
			// The real registration is trusted, and the allow caches the membership.
			expect(stillLinkedWorktree(worktree, commonDir)).toBe(true);
			expect(decideWorktreeCall("write", { path: target, content: "" }, canonical)).toBeUndefined();

			// Replaced without unregistering: git still lists the path, its `.git`
			// still names a directory under the old common directory, but writes there
			// now land in a different repository's canonical checkout.
			rmSync(worktree, { recursive: true, force: true });
			mkdirSync(worktree, { recursive: true });
			execFileSync("git", ["-C", worktree, "init", "-q", "-b", "main", `--separate-git-dir=${admin}`], {
				stdio: "ignore",
			});

			expect(stillLinkedWorktree(worktree, commonDir)).toBe(false);
			expect(projectWorktrees(canonical, commonDir)).toEqual([]);
			const decision = decideWorktreeCall("write", { path: target, content: "" }, canonical);
			expect(decision?.block).toBe(true);
			expect(decision?.reason).toContain(realpathSync(worktree));
			resetTopologyCache();
		}
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


	test("a cached linked-worktree directory replaced by a submodule is re-resolved to the submodule owner", () => {
		const outer = repository();
		const inner = repository();
		const submodule = join(outer.worktree, "sub");
		mkdirSync(submodule);

		// Cache this ordinary directory as part of the superproject's linked worktree.
		expect(decideWorktreeCall("write", { path: join(submodule, "probe.ts"), content: "" }, outer.canonical)).toBeUndefined();

		// Replace the cached directory with a real submodule checkout.
		rmSync(submodule, { recursive: true, force: true });
		execFileSync(
			"git",
			["-C", outer.worktree, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", inner.canonical, "sub"],
			{ stdio: "ignore" },
		);
		execFileSync("git", ["-C", outer.worktree, "commit", "-q", "-m", "add submodule"], { stdio: "ignore" });

		const resolution = resolveCanonicalRoot(submodule);
		expect(resolution.state).toBe("repository");
		if (resolution.state !== "repository") return;
		const commonParts = relative(outer.canonical, resolution.commonDir).split(sep);
		expect(commonParts).toContain("worktrees");
		expect(commonParts).toContain("modules");
		expect(decideWorktreeCall("write", { path: join(submodule, "probe.ts"), content: "" }, outer.canonical)?.block).toBe(true);
	}, 60000);

	test("a cached linked-worktree directory replaced by a main-worktree submodule is refused", () => {
		const inner = repository();
		const outer = repository();
		execFileSync(
			"git",
			["-C", outer.canonical, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", inner.canonical, "sub"],
			{ stdio: "ignore" },
		);
		execFileSync("git", ["-C", outer.canonical, "commit", "-q", "-m", "add submodule"], { stdio: "ignore" });

		execFileSync("git", ["-C", outer.worktree, "merge", "-q", "main"], { stdio: "ignore" });

		const submodule = join(outer.worktree, "sub");
		rmSync(submodule, { recursive: true, force: true });
		mkdirSync(submodule);
		// Cache the superproject owner while this is still an ordinary directory.
		expect(decideWorktreeCall("write", { path: join(submodule, "probe.ts"), content: "" }, outer.canonical)).toBeUndefined();

		rmSync(submodule, { recursive: true, force: true });
		execFileSync(
			"git",
			["-C", outer.worktree, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet", "sub"],
			{ stdio: "ignore" },
		);
		const linkedAdmin = execFileSync("git", ["-C", submodule, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
		const canonicalAdmin = join(outer.canonical, ".git", "modules", "sub");
		mkdirSync(join(outer.canonical, ".git", "modules"), { recursive: true });
		rmSync(canonicalAdmin, { recursive: true, force: true });
		cpSync(linkedAdmin, canonicalAdmin, { recursive: true });
		execFileSync("git", ["config", "--file", join(canonicalAdmin, "config"), "core.worktree", submodule], { stdio: "ignore" });
		writeFileSync(join(submodule, ".git"), `gitdir: ${canonicalAdmin}\n`);
		const resolution = resolveCanonicalRoot(submodule);
		expect(resolution.state).toBe("repository");
		if (resolution.state !== "repository") return;
		expect(relative(outer.canonical, resolution.commonDir).split(sep)).toContain("modules");
		expect(relative(outer.canonical, resolution.commonDir).split(sep)).not.toContain("worktrees");
		expect(decideWorktreeCall("write", { path: join(submodule, "probe.ts"), content: "" }, outer.canonical)?.block).toBe(true);
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

describe("pathless tools", () => {
	/**
	 * A tool that names no path may still write through its session cwd, and this
	 * gate does not stop it: an argument scan cannot tell `typescript_quality`
	 * defaulting its path to the cwd from `retain` writing to a database, and
	 * guessing refused every pathless device call from the directory an agent
	 * starts in. The enumerated mutators — `bash`, `eval`, `write`, `edit`,
	 * `ast_edit` — carry an explicit cwd or target and stay judged by it.
	 */
	test("a pathless call is allowed, whatever the tool does with its cwd", () => {
		const { canonical, worktree, topology } = project();
		expect(decideWorktreeCall("typescript_quality", { mode: "fix" }, canonical, topology)).toBeUndefined();
		expect(decideWorktreeCall("typescript_quality", { mode: "fix" }, worktree, topology)).toBeUndefined();
		expect(decideWorktreeCall("eval", { code: "1" }, canonical, topology)?.block).toBe(true);
	});

    test("pathless ledger and status calls are allowed from canonical", () => {
        const { canonical, topology } = project();
        // Claim-before-worktree: the bead must be claimable before a worktree exists,
        // exactly as the bootstrap allowlist permits `bd` from canonical.
        expect(decideWorktreeCall("orc_claim", { bead: "proj-1" }, canonical, topology)).toBeUndefined();
        expect(decideWorktreeCall("orc_status", { epic: "run" }, canonical, topology)).toBeUndefined();
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
		// `journeys_index` reads for `lint` and an unconfirmed `prune`, so its
		// canonical `journeysDir` is inspection in those modes and a mutation in the
		// others. `bd_formula_check` names no path in either mode, so the gate has
		// nothing to judge and the tool's own approval decides.
		expect(decideWorktreeCall("bd_formula_check", { formula: "x" }, canonical, topology)).toBeUndefined();
		expect(decideWorktreeCall("bd_formula_check", { formula: "x", deep: true }, canonical, topology)).toBeUndefined();
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
