/**
 * The general session-start worktree sweep. Every case drives `sweepStaleWorktrees` through an
 * injected command runner and an injected ledger reader, because what matters is *which* commands
 * it decides to run: it must never force, never name an open bead's tree to `wt`, never run a real
 * prune, and never speak when nothing happened.
 *
 * The ledger read is a second seam on purpose. It is what decides whether a directory is deleted,
 * so it must not share the command runner's inherited environment — see `sweepBdEnvironment`.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import staleWorktreeSweep, {
	type CommandResult,
	type CommandRunner,
	GRACE_WINDOW_MS,
	graceState,
	type LedgerBead,
	type LedgerReader,
	sweepBdEnvironment,
	sweepNotice,
	sweepStaleWorktrees,
	type TopologyReader,
	WORKTREE_LIST_ARGV,
} from "./stale-worktree-sweep.ts";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

const NOW = Date.parse("2026-09-22T12:00:00Z");
const CLOSED_LONG_AGO = new Date(NOW - 25 * 3_600_000).toISOString();
const CLOSED_RECENTLY = new Date(NOW - 3 * 3_600_000).toISOString();

interface Entry {
	path: string;
	branch: string;
}

/**
 * One canonical root plus its linked worktrees, in the format the flags ask for: `-z` gives
 * NUL-terminated attributes and NUL-closed records, and without it git writes lines. A mock that
 * answered NUL whatever it was asked would hide a read that dropped the flag.
 */
function listing(entries: readonly Entry[], nul: boolean): string {
	const records = entries.map(entry => [`worktree ${entry.path}`, "HEAD abc", `branch refs/heads/${entry.branch}`]);
	if (nul) return records.map(attributes => `${attributes.map(attribute => `${attribute}\0`).join("")}\0`).join("");
	return records.map(attributes => `${attributes.join("\n")}\n`).join("\n");
}

interface Row {
	status: string;
	closedAt?: string;
}

interface Options {
	/** Raw stdout for `wt step prune --dry-run --format json`; defaults to nothing due. */
	prune?: string;
	/** What the first (batched) ledger read answers. An absent bead answers nothing at all. */
	ledger?: Record<string, Row>;
	/** What the confirmation read answers, when it differs from the batched one. */
	confirm?: Record<string, Row>;
	/** Branches whose removal reports success but whose branch ref survives. */
	survives?: readonly string[];
	/** Branches whose removal is refused because the worktree is locked. */
	locked?: readonly string[];
	/** Path a branch has moved to by the time the sweep re-lists, keyed by branch. */
	moved?: Record<string, string>;
}

interface Harness {
	run: CommandRunner;
	readLedger: LedgerReader;
	argv: string[][];
	reads: string[][];
}

function harness(entries: readonly Entry[], options: Options = {}): Harness {
	const argv: string[][] = [];
	const reads: string[][] = [];
	const removed = new Set<string>();
	let listings = 0;
	const run: CommandRunner = async command => {
		argv.push([...command]);
		const [tool, ...rest] = command;
		const joined = rest.join(" ");
		// `wt remove` and the listing are the only git this sweep runs: the canonical root comes
		// from the gate's own topology reader, not from a probe of its own.
		if (tool === "git" && joined.includes("branch --list")) {
			const branch = command[command.length - 1] ?? "";
			return ok((options.survives ?? []).includes(branch) ? `  ${branch}\n` : "");
		}
		if (tool === "git" && joined.includes("worktree list")) {
			listings += 1;
			const live = entries
				.filter(entry => !removed.has(entry.branch) || (options.survives ?? []).includes(entry.branch))
				// A branch only moves for the re-list: the first listing is the one the sweep judged.
				.map(entry => ({ ...entry, path: (listings > 1 ? options.moved?.[entry.branch] : undefined) ?? entry.path }));
			return ok(listing(live, rest.includes("-z")));
		}
		if (tool === "wt" && rest.includes("prune")) return ok(options.prune ?? "[]");
		if (tool === "wt" && rest.includes("remove")) {
			const branch = command[command.length - 1] ?? "";
			if ((options.locked ?? []).includes(branch)) {
				return { code: 1, stdout: "", stderr: `✗ Cannot remove ${branch}, worktree is locked\n  Unlock it first: git worktree unlock <path>` };
			}
			removed.add(branch);
			return ok();
		}
		return { code: 1, stdout: "", stderr: `unexpected ${command.join(" ")}` };
	};
	const readLedger: LedgerReader = async beads => {
		reads.push([...beads]);
		const source = reads.length === 1 ? (options.ledger ?? {}) : { ...(options.ledger ?? {}), ...(options.confirm ?? {}) };
		const answered = new Map<string, LedgerBead>();
		for (const bead of beads) {
			const row = source[bead];
			if (row !== undefined) answered.set(bead, { status: row.status, closedAt: row.closedAt });
		}
		return answered;
	};
	return { run, readLedger, argv, reads };
}

const REPO = "/repo";
const ENTRIES: readonly Entry[] = [
	{ path: REPO, branch: "main" },
	{ path: "/wt/agent-a", branch: "omp/agent/a" },
	{ path: "/wt/agent-b", branch: "omp/agent/b" },
	{ path: "/wt/human", branch: "feature/unrelated" },
];

function removals(argv: readonly string[][]): string[][] {
	return argv.filter(command => command[0] === "wt" && command.includes("remove"));
}

describe("what the sweep collects", () => {
	test("a bead closed past the grace window is collected, with no force flag anywhere", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO }, b: { status: "in_progress" } },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result).toEqual({ swept: ["omp/agent/a"], retained: [] });
		expect(removals(argv)).toEqual([["wt", "-C", REPO, "remove", "-y", "--foreground", "omp/agent/a"]]);
		for (const command of argv) {
			expect(command).not.toContain("-f");
			expect(command).not.toContain("--force");
			expect(command).not.toContain("-D");
		}
		// The unrelated worktree is not an agent tree and is never mentioned to anything.
		expect(argv.some(command => command.includes("feature/unrelated"))).toBe(false);
		// `-z` is load-bearing: the mock answers lines without it, which would parse as nothing.
		expect(argv.filter(command => command.join(" ").includes("worktree list")).every(command => command.includes("-z"))).toBe(true);
		expect(WORKTREE_LIST_ARGV).toContain("-z");
	});

	test("an open bead's tree is never named to `wt` at all", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "open" }, b: { status: "in_progress" } },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result).toEqual({ swept: [], retained: [] });
		expect(removals(argv)).toEqual([]);
		expect(argv.filter(command => command[0] === "wt").every(command => !command.some(token => token.startsWith("omp/agent/")))).toBe(true);
		expect(sweepNotice(result)).toBeUndefined();
	});

	test("a bead the ledger could not answer for keeps its tree, silently", async () => {
		const { run, readLedger, argv } = harness(ENTRIES);
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result).toEqual({ swept: [], retained: [] });
		expect(removals(argv)).toEqual([]);
	});
});

describe("the grace window", () => {
	test("a bead closed inside the window is retained, and the message names the lock", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_RECENTLY } },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained).toHaveLength(1);
		expect(result.retained[0]).toContain("omp/agent/a");
		expect(result.retained[0]).toContain("closed 3h ago");
		expect(result.retained[0]).toContain("git worktree lock /wt/agent-a");
		expect(removals(argv)).toEqual([]);
	});

	test("a closed bead with no closed_at is retained, not collected", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, { ledger: { a: { status: "closed" } } });
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained).toHaveLength(1);
		expect(result.retained[0]).toContain("no closed_at");
		expect(result.retained[0]).toContain("git worktree lock /wt/agent-a");
		expect(removals(argv)).toEqual([]);
	});

	test("a closed bead whose closed_at is garbage is retained, not collected", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: "last tuesday-ish" } },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained).toHaveLength(1);
		expect(result.retained[0]).toContain("not a date");
		expect(result.retained[0]).toContain("git worktree lock /wt/agent-a");
		expect(removals(argv)).toEqual([]);
	});

	test("the window boundary is the elapsed edge, and an unreadable stamp is never elapsed", () => {
		expect(graceState(new Date(NOW - GRACE_WINDOW_MS).toISOString(), NOW).kind).toBe("elapsed");
		expect(graceState(new Date(NOW - GRACE_WINDOW_MS + 1_000).toISOString(), NOW).kind).toBe("inside");
		expect(graceState(undefined, NOW).kind).toBe("unknown");
		expect(graceState("", NOW).kind).toBe("unknown");
		expect(graceState("2026-13-45T99:00:00Z", NOW).kind).toBe("unknown");
	});
});

describe("the races carried over from the orchestrate sweep", () => {
	test("the dry-run prune is a precondition, never a removal, and naming anything stands the sweep down", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } },
			prune: '[{"branch":"someone/else"}]',
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained).toEqual([]);
		expect(result.stoodDown).toContain("someone/else");
		expect(removals(argv)).toEqual([]);
		expect(argv.filter(command => command.includes("prune"))).toEqual([["wt", "-C", REPO, "step", "prune", "--dry-run", "--format", "json"]]);
		expect(sweepNotice(result)).toBeUndefined();
	});

	test("the status is re-read immediately before removal, so a reopened bead keeps its tree", async () => {
		const { run, readLedger, argv, reads } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } },
			confirm: { a: { status: "in_progress" } },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result).toEqual({ swept: [], retained: [] });
		expect(removals(argv)).toEqual([]);
		expect(reads).toEqual([["a", "b"], ["a"]]);
	});

	test("a bead reclosed inside the window between the two reads keeps its tree", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } },
			confirm: { a: { status: "closed", closedAt: CLOSED_RECENTLY } },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained[0]).toContain("moved while the sweep was running");
		expect(result.retained[0]).toContain("git worktree lock");
		expect(removals(argv)).toEqual([]);
	});

	test("a branch that has moved to another path is not removed, because `wt remove` addresses by branch", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } },
			moved: { "omp/agent/a": "/wt/successor-a" },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained[0]).toContain("/wt/successor-a");
		expect(result.retained[0]).toContain("git worktree lock");
		expect(removals(argv)).toEqual([]);
	});

	test("the ledger read drops an inherited BEADS_DIR rather than letting another store answer", () => {
		const pinned = sweepBdEnvironment(REPO, { BEADS_DIR: "/another/project/.beads", PATH: "/usr/bin" });
		expect(pinned.BEADS_DIR).toBeUndefined();
		// An explicit environment built from this process's, not a bare one: PATH tells the two apart.
		expect(pinned.PATH).toBe("/usr/bin");
		expect(pinned.BD_DOLT_AUTO_START).toBe("false");
		expect(pinned.BD_NON_INTERACTIVE).toBe("1");

		const canonical = mkdtempSync(join(tmpdir(), "worktrunk-sweep-store-"));
		try {
			mkdirSync(join(canonical, ".beads"));
			// A checkout with a store of its own is pinned at it, so discovery cannot wander.
			expect(sweepBdEnvironment(canonical, { BEADS_DIR: "/another/project/.beads" }).BEADS_DIR).toBe(join(canonical, ".beads"));
		} finally {
			rmSync(canonical, { recursive: true, force: true });
		}
	});
});

describe("a tree that survives its removal", () => {
	test("a locked worktree survives and is reported, naming the lock as the mechanism", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } },
			locked: ["omp/agent/a"],
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained).toHaveLength(1);
		expect(result.retained[0]).toContain("worktree is locked");
		expect(result.retained[0]).toContain("git worktree lock");
		expect(result.retained[0]).toContain(`git -C ${REPO} worktree unlock /wt/agent-a`);
		expect(removals(argv)).toEqual([["wt", "-C", REPO, "remove", "-y", "--foreground", "omp/agent/a"]]);
		for (const command of removals(argv)) {
			expect(command).not.toContain("-f");
			expect(command).not.toContain("-D");
		}
		expect(sweepNotice(result)).toContain("git worktree lock");
	});

	test("a branch that outlives its removal is reported for remediation, not counted as swept", async () => {
		const { run, readLedger } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } },
			survives: ["omp/agent/a"],
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained[0]).toContain("omp/agent/a");
		expect(result.retained[0]).toContain("unmerged");
		expect(result.retained[0]).toContain("git worktree lock");
	});

	test("the worktree this session is running in is never collected", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, {
			ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } },
		});
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW, sessionCwd: "/wt/agent-a/worktrunk" });

		expect(result).toEqual({ swept: [], retained: [] });
		expect(removals(argv)).toEqual([]);
		expect(sweepNotice(result)).toBeUndefined();
	});
});

describe("what the session is told", () => {
	test("no candidates: nothing is asked of `wt`, and nothing is said", async () => {
		const { run, readLedger, argv } = harness([
			{ path: REPO, branch: "main" },
			{ path: "/wt/human", branch: "feature/unrelated" },
		]);
		const result = await sweepStaleWorktrees(REPO, { run, readLedger, now: NOW });

		expect(result).toEqual({ swept: [], retained: [] });
		expect(argv.some(command => command[0] === "wt")).toBe(false);
		expect(sweepNotice(result)).toBeUndefined();
	});

	test("an unreadable `git worktree list` stands the sweep down and says nothing", async () => {
		const run: CommandRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
		const result = await sweepStaleWorktrees(REPO, { run, readLedger: async () => new Map(), now: NOW });

		expect(result.swept).toEqual([]);
		expect(result.retained).toEqual([]);
		expect(result.stoodDown).toContain("not a git repository");
		expect(sweepNotice(result)).toBeUndefined();
	});

	test("a removal and a retention each produce a notice that names the branch", () => {
		expect(sweepNotice({ swept: ["omp/agent/a"], retained: [] })).toContain("omp/agent/a");
		expect(sweepNotice({ swept: [], retained: ["omp/agent/b: kept"] })).toContain("omp/agent/b");
		expect(sweepNotice({ swept: [], retained: [], stoodDown: "anything at all" })).toBeUndefined();
	});
});

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** The handler the extension registers, plus whatever it sent, from a stub `pi`. */
function session(deps: Parameters<typeof staleWorktreeSweep>[1]): { start: Handler; sent: { content: string }[] } {
	const registered: Record<string, Handler> = {};
	const sent: { content: string }[] = [];
	const pi = {
		logger: { warn: () => undefined },
		on: (event: string, handler: Handler) => {
			registered[event] = handler;
		},
		sendMessage: (message: { content: string }) => sent.push(message),
	};
	staleWorktreeSweep(pi as never, deps);
	const start = registered.session_start;
	if (start === undefined) throw new Error("the extension registered no session_start handler");
	return { start, sent };
}

describe("the session_start handler", () => {
	/** The topology the gate's resolver would report for the mock repository. */
	const inRepository: TopologyReader = () => ({ canonical: REPO, commonDir: `${REPO}/.git`, uncertainty: null, worktrees: ["/wt/agent-a", "/wt/agent-b"], refresh: () => [] });

	test("a session that reclaimed a tree is told once", async () => {
		const { run, readLedger } = harness(ENTRIES, { ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } } });
		const { start, sent } = session({ run, readLedger, now: NOW, readTopology: inRepository });

		await start({ type: "session_start" }, { cwd: REPO });

		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("omp/agent/a");
	});

	test("a session that swept nothing hears nothing", async () => {
		const { run, readLedger } = harness(ENTRIES, { ledger: { a: { status: "in_progress" } } });
		const { start, sent } = session({ run, readLedger, now: NOW, readTopology: inRepository });

		await start({ type: "session_start" }, { cwd: REPO });

		expect(sent).toEqual([]);
	});

	test("a cwd in no repository never asks git anything, and says nothing", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, { ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } } });
		const { start, sent } = session({
			run,
			readLedger,
			now: NOW,
			readTopology: () => ({ canonical: null, uncertainty: null, worktrees: [], refresh: () => [] }),
		});

		await start({ type: "session_start" }, { cwd: "/nowhere" });

		expect(sent).toEqual([]);
		expect(argv).toEqual([]);
	});

	test("a topology git could not answer for is a stand-down, not a sweep", async () => {
		const { run, readLedger, argv } = harness(ENTRIES, { ledger: { a: { status: "closed", closedAt: CLOSED_LONG_AGO } } });
		const { start, sent } = session({
			run,
			readLedger,
			now: NOW,
			// A canonical root *and* an uncertainty: the root alone must not be enough to sweep by.
			readTopology: () => ({ canonical: REPO, uncertainty: "`git rev-parse` was killed by SIGTERM (timeout)", worktrees: [], refresh: () => [] }),
		});

		await start({ type: "session_start" }, { cwd: REPO });

		expect(sent).toEqual([]);
		expect(argv).toEqual([]);
	});
});
