import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import deliveryCleanupTool, {
	branchDeleteArgs,
	type CleanupResult,
	cleanupDelivery,
	type DeliveryCleanupParams,
} from "./delivery-cleanup-tool.ts";
import { landPullRequest } from "./delivery-land-tool.ts";
import { type CliResult, type CliRunner, runCli } from "./forge-adapter.ts";
import {
	buildReceipt,
	type LandingReceipt,
	listReceipts,
	readReceipt,
	receiptDirectory,
	repoKey,
	validateReceipt,
	writeReceipt,
} from "./landing-receipt.ts";

const ROOTS: string[] = [];
afterAll(() => {
	for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

type Fixture = {
	root: string;
	main: string;
	linked: string;
	bare: string;
	branch: string;
	head: string;
	merge: string;
	env: NodeJS.ProcessEnv;
	receipt: LandingReceipt;
	receiptPath: string;
};

type RunnerOptions = {
	pr?: Partial<{
		nameWithOwner: string;
		state: string;
		baseRefName: string;
		headRefName: string;
		headRefOid: string;
		mergeCommitOid: string | null;
		mergedAt: string | null;
		url: string;
	}>;
	beadStatus?: string;
	beadMergeSha?: string;
	remote?: "absent" | "present" | "unknown";
	pathlessAfterRemove?: boolean;
	registeredTargetAfterRemove?: boolean;
	before?: (argv: string[], calls: string[][]) => void;
	after?: (argv: string[], result: CliResult, calls: string[][]) => void;
};

function scratch(name: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), `delivery-cleanup-${name}-`)));
	ROOTS.push(root);
	return root;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();
}

function gitExit(cwd: string, args: string[]): number | null {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	});
	return result.exitCode;
}

/**
 * A real repository whose ledger state on disk is the state its receipt claims.
 *
 * `ledger` decides both halves at once — an active `.beads` directory at the
 * canonical root with `beads.ledgerActive: true`, or a retired one with `false` —
 * because cleanup now recomputes the classification at that root and refuses a
 * receipt that disagrees with it. A fixture whose receipt claimed a ledger the
 * directory did not have would be testing the refusal, not the path it names.
 */
function fixture(name: string, branch = `feat/${name}`, ledger: "active" | "retired" = "active"): Fixture {
	const root = scratch(name);
	const bare = join(root, "remote.git");
	mkdirSync(bare);
	git(bare, ["init", "--bare", "-q"]);
	const main = join(root, "main");
	mkdirSync(main);
	git(main, ["init", "-q", "-b", "main"]);
	git(main, ["config", "user.email", "delivery@example.test"]);
	git(main, ["config", "user.name", "Delivery Test"]);
	writeFileSync(join(main, "base.txt"), "base\n");
	git(main, ["add", "base.txt"]);
	git(main, ["commit", "-q", "-m", "base"]);
	git(main, ["remote", "add", "origin", bare]);
	git(main, ["push", "-q", "-u", "origin", "main"]);
	mkdirSync(join(main, ".beads"));
	if (ledger === "retired") writeFileSync(join(main, ".beads", "RETIRED"), "retired\n");

	const linked = join(root, "linked worktree");
	git(main, ["worktree", "add", "-q", "-b", branch, linked]);
	writeFileSync(join(linked, "feature.txt"), "feature\n");
	git(linked, ["add", "feature.txt"]);
	git(linked, ["commit", "-q", "-m", "feature"]);
	git(linked, ["push", "-q", "-u", "origin", branch]);
	const head = git(linked, ["rev-parse", "HEAD"]);
	git(main, ["merge", "-q", "--no-ff", branch, "-m", "merge feature"]);
	const merge = git(main, ["rev-parse", "HEAD"]);
	git(main, ["push", "-q", "origin", "main"]);
	git(bare, ["update-ref", "-d", `refs/heads/${branch}`]);

	const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") };
	const key = repoKey(main);
	if (key === null) throw new Error("fixture repo has no key");
	const receipt = buildReceipt({
		now: NOW,
		emitter: { plugin: "@srobroek/delivery", version: "0.11.5", tool: "delivery_land" },
		repo: {
			key,
			canonicalRoot: realpathSync(main),
			remote: "origin",
			forge: "github",
			nameWithOwner: "owner/repo",
		},
		pr: {
			number: 17,
			url: "https://github.com/owner/repo/pull/17",
			state: "MERGED",
			baseRefName: "main",
			headRefName: branch,
			headRefOid: head,
			mergeCommitOid: merge,
			mergedAt: "2027-01-15T08:00:00.000Z",
		},
		branch: {
			name: branch,
			deletedRemote: true,
			remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z",
			autoDeleteSetting: "on",
		},
		worktree: { path: linked, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
		beads: { ids: ["delivery-17"], ledgerActive: ledger === "active" },
		proof: {
			method: "gh pr view",
			observedAt: "2027-01-15T08:00:00.000Z",
			evidence: { state: "MERGED" },
		},
		outcome: "landed",
	});
	receipt.forwardProof = { kept: true };
	const receiptPath = writeReceipt(receipt, receiptDirectory(env, key));
	return { root, main, linked, bare, branch, head, merge, env, receipt, receiptPath };
}

function success(stdout = "", exitCode = 0): CliResult {
	return { ok: true, exitCode, stdout, stderr: "" };
}

function githubPayload(f: Fixture, over: RunnerOptions["pr"] = {}): string {
	const state = over.state ?? "MERGED";
	const mergeCommitOid = over.mergeCommitOid === undefined ? f.receipt.pr.mergeCommitOid : over.mergeCommitOid;
	return JSON.stringify({
		number: f.receipt.pr.number,
		url: over.url ?? f.receipt.pr.url,
		state,
		baseRefName: over.baseRefName ?? f.receipt.pr.baseRefName,
		headRefName: over.headRefName ?? f.receipt.pr.headRefName,
		headRefOid: over.headRefOid ?? f.receipt.pr.headRefOid,
		mergeCommit: mergeCommitOid === null ? null : { oid: mergeCommitOid },
		mergedAt: over.mergedAt === undefined ? f.receipt.pr.mergedAt : over.mergedAt,
	});
}

function runner(f: Fixture, options: RunnerOptions = {}): { run: CliRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: CliRunner = (argv, commandOptions) => {
		calls.push([...argv]);
		options.before?.(argv, calls);
		let result: CliResult;
		if (argv[0] === "gh") {
			result = success(githubPayload(f, options.pr));
		} else if (argv[0] === "bd") {
			result = success(JSON.stringify({
				schema_version: 1,
				data: [{
					id: "delivery-17",
					status: options.beadStatus ?? "closed",
					metadata: { merge_sha: options.beadMergeSha ?? f.merge },
				}],
			}));
		} else if (argv[0] === "git" && argv.includes("ls-remote")) {
			const remote = options.remote ?? "absent";
			if (remote === "absent") result = success("", 2);
			else if (remote === "present") result = success(`${f.head}\trefs/heads/${f.branch}\n`);
			else result = { ok: false, exitCode: null, stdout: "", stderr: "", error: "timeout" };
		} else {
			result = runCli(argv, commandOptions);
		}
		if (
			options.pathlessAfterRemove && argv[0] === "git" && argv[1] === "worktree" && argv[2] === "list" &&
			calls.some(call => call[0] === "git" && call[1] === "worktree" && call[2] === "remove")
		) {
			result = success(`${result.stdout.trimEnd()}\n\nworktree \nHEAD ${f.head}\nbranch refs/heads/${f.branch}\n\n`);
		}
		if (
			options.registeredTargetAfterRemove && argv[0] === "git" && argv[1] === "worktree" && argv[2] === "list" &&
			calls.some(call => call[0] === "git" && call[1] === "worktree" && call[2] === "remove")
		) {
			result = success(`${result.stdout.trimEnd()}\n\nworktree ${f.linked}\nHEAD ${f.head}\nbranch refs/heads/${f.branch}\n\n`);
		}
		options.after?.(argv, result, calls);
		return result;
	};
	return { run, calls };
}

function invoke(f: Fixture, params: DeliveryCleanupParams = { receipt: f.receiptPath }, options: RunnerOptions = {}): {
	result: CleanupResult;
	calls: string[][];
} {
	const scripted = runner(f, options);
	const result = cleanupDelivery(params, f.main, { run: scripted.run, now: () => NOW + 10, env: f.env });
	return { result, calls: scripted.calls };
}

function refusal(result: CleanupResult): string {
	if (result.ok) throw new Error(`expected refusal, got ${result.receipt.receiptId}`);
	return result.reason;
}

function commandCalls(calls: string[][], verb: string): string[][] {
	return calls.filter(argv => argv[0] === verb);
}

function mutationCalls(calls: string[][]): string[][] {
	return calls.filter(argv =>
		(argv[0] === "git" && (argv[1] === "worktree" && argv[2] === "remove" || argv[1] === "branch" && argv[2] === "-d")) ||
		argv[0] === "bd" && !["show", "list"].includes(argv[1] ?? ""),
	);
}

describe("delivery_cleanup irreversible boundary", () => {
	test("removes one listed worktree then its local branch and records four independent absence verdicts", () => {
		const f = fixture("happy");
		const listedPath = realpathSync(f.linked);
		const { result, calls } = invoke(f, {
			receipt: f.receiptPath,
			pr: 17,
			branch: f.branch,
			worktree: f.linked,
			remote: "origin",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(existsSync(f.linked)).toBe(false);
		expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(1);
		const destructive = mutationCalls(calls);
		expect(destructive).toEqual([
			["git", "worktree", "remove", listedPath],
			["git", "branch", "-d", "--", f.branch],
		]);
		expect(calls.flat()).not.toContain("--force");
		expect(calls.flat()).not.toContain("-D");
		expect(commandCalls(calls, "bd").every(argv => argv[1] === "show")).toBe(true);

		const validation = validateReceipt(result.receipt);
		expect(validation.ok).toBe(true);
		expect(result.receipt.outcome).toBe("cleaned");
		expect(result.receipt.supersedes).toBe(f.receipt.receiptId);
		expect(result.receipt.forwardProof).toEqual({ kept: true });
		expect(result.receipt.worktree).toEqual({
			path: f.linked,
			removed: true,
			localRefDeleted: true,
			absenceVerifiedAt: new Date(NOW + 10).toISOString(),
		});
		expect(result.receipt.branch.deletedRemote).toBe(true);
		expect(result.receipt.proof.evidence).toEqual({
			worktreeRegistration: "absent",
			worktreePath: "absent",
			localRef: "absent",
			remoteBranch: "absent",
		});
		expect(readReceipt(result.path)).toEqual({ ok: true, receipt: result.receipt });
		expect(listReceipts(receiptDirectory(f.env, f.receipt.repo.key))).toHaveLength(2);
	});

	test("a retired ledger, agreed by the receipt and the canonical root, cleans up with no bd command", () => {
		const f = fixture("inactive-ledger", "feat/inactive-ledger", "retired");

		const { result, calls } = invoke(f);

		expect(result.ok).toBe(true);
		expect(commandCalls(calls, "bd")).toEqual([]);
		if (!result.ok) return;
		expect(result.receipt.beads.ledgerActive).toBe(false);
		expect(existsSync(f.linked)).toBe(false);
	});

	test("a valid receipt extension named ok cannot collide with cleanup's private resolution tag", () => {
		const f = fixture("receipt-ok-extension");
		rmSync(f.receiptPath);
		f.receipt.ok = false;
		const path = writeReceipt(f.receipt, receiptDirectory(f.env, f.receipt.repo.key));

		const { result } = invoke(f, { receipt: path });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.receipt.ok).toBe(false);
		expect(result.receipt.outcome).toBe("cleaned");
		expect(existsSync(f.linked)).toBe(false);
	});

	test("a second call selects the cleaned continuation, refuses the absent worktree, and mutates nothing", () => {
		const f = fixture("second");
		const first = invoke(f);
		expect(first.result.ok).toBe(true);
		const second = invoke(f, {});
		expect(refusal(second.result)).toContain("worktree.path: observed");
		expect(refusal(second.result)).toContain("absent after prior cleanup");
		expect(mutationCalls(second.calls)).toEqual([]);
	});

	test("an unknown remote observation never becomes verified absence, while local cleanup stays truthful", () => {
		const f = fixture("remote-unknown");
		const { result } = invoke(f, { receipt: f.receiptPath }, { remote: "unknown" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.remoteBranchAbsence).toBe("unknown");
		expect(result.receipt.branch.deletedRemote).toBe(false);
		expect(result.receipt.branch.remoteAbsenceVerifiedAt).toBeNull();
		expect(result.receipt.worktree.removed).toBe(true);
		expect(result.receipt.worktree.localRefDeleted).toBe(true);
	});

	test("an explicit receipt outside the canonical repository receipt directory is refused before observation", () => {
		const f = fixture("outside-receipt");
		const outside = join(scratch("explicit-tmp"), basename(f.receiptPath));
		copyFileSync(f.receiptPath, outside);
		const { result, calls } = invoke(f, { receipt: outside });
		expect(refusal(result)).toContain(`receipt.path: observed "${outside}", expected a direct entry under`);
		expect(calls).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	});

	test("explicit and implicit receipt selection refuse a symlinked receipt parent", () => {
		const f = fixture("receipt-parent-symlink");
		const directory = receiptDirectory(f.env, f.receipt.repo.key);
		const realDirectory = `${directory}-real`;
		renameSync(directory, realDirectory);
		symlinkSync(realDirectory, directory, "dir");

		const explicit = invoke(f, { receipt: f.receiptPath });
		expect(refusal(explicit.result)).toContain(`receipt.directory: observed "${directory} (unsafe)"`);
		expect(explicit.calls).toEqual([]);
		const implicit = invoke(f, { pr: f.receipt.pr.number });
		expect(refusal(implicit.result)).toContain(`receipt.directory: observed "${directory} (unsafe)"`);
		expect(implicit.calls).toEqual([]);
	});

	test("receipt, argument, and each merged-PR mismatch precede every local-state observation", () => {
		const f = fixture("proof-order");
		const missing = invoke(f, { pr: 999 });
		expect(refusal(missing.result)).toContain("receipt: observed null, expected the newest validated receipt for pr 999");
		expect(missing.calls).toEqual([]);

		appendFileSync(join(f.linked, "feature.txt"), "dirty\n");
		const argument = invoke(f, { receipt: f.receiptPath, branch: "wrong" });
		expect(refusal(argument.result)).toContain(`branch: observed "wrong", expected receipt value "${f.branch}"`);
		expect(argument.calls).toEqual([]);

		const mismatches: Array<{ pr: NonNullable<RunnerOptions["pr"]>; field: string }> = [
			{ pr: { state: "OPEN" }, field: "pr.state" },
			{ pr: { url: "https://github.com/owner/repo/pull/99" }, field: "pr.url" },
			{ pr: { baseRefName: "other-base" }, field: "pr.baseRefName" },
			{ pr: { headRefName: "other-head" }, field: "pr.headRefName" },
			{ pr: { headRefOid: "a".repeat(40) }, field: "pr.headRefOid" },
			{ pr: { mergeCommitOid: "b".repeat(40) }, field: "pr.mergeCommitOid" },
			{ pr: { mergedAt: "2027-01-15T08:00:01.000Z" }, field: "pr.mergedAt" },
		];
		for (const mismatch of mismatches) {
			const observed = invoke(f, { receipt: f.receiptPath }, { pr: mismatch.pr });
			expect(refusal(observed.result)).toContain(`${mismatch.field}: observed`);
			expect(observed.calls.some(argv => argv[0] === "git" && argv[1] === "status")).toBe(false);
		}
	});

	test("dirty, unpushed, and unreconciled refusals occur in that exact order", () => {
		const f = fixture("refusal-order");
		writeFileSync(join(f.linked, "dirty.txt"), "dirty\n");
		const dirty = invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" });
		expect(refusal(dirty.result)).toContain("worktree.status");
		expect(refusal(dirty.result)).toContain("dirty.txt");
		expect(commandCalls(dirty.calls, "bd")).toEqual([]);

		rmSync(join(f.linked, "dirty.txt"));
		writeFileSync(join(f.linked, "ahead.txt"), "ahead\n");
		git(f.linked, ["add", "ahead.txt"]);
		git(f.linked, ["commit", "-q", "-m", "ahead"]);
		const unpushed = invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" });
		expect(refusal(unpushed.result)).toContain("branch.unpushed: observed 1, expected 0 commits");
		expect(commandCalls(unpushed.calls, "bd")).toEqual([]);

		git(f.linked, ["push", "-q", "origin", f.branch]);
		const ledger = invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" });
		expect(refusal(ledger.result)).toContain('beads.delivery-17.status: observed "open", expected "closed" after bd_reconcile');
		expect(mutationCalls(ledger.calls)).toEqual([]);
	});

	test("a branch with no upstream refuses before the ledger read", () => {
		const f = fixture("no-upstream");
		git(f.linked, ["config", "--unset", `branch.${f.branch}.remote`]);
		git(f.linked, ["config", "--unset", `branch.${f.branch}.merge`]);
		const { result, calls } = invoke(f);
		expect(refusal(result)).toContain("branch.upstream: observed");
		expect(refusal(result)).toContain("expected a configured upstream branch");
		expect(commandCalls(calls, "bd")).toEqual([]);
		expect(mutationCalls(calls)).toEqual([]);
	});

	test("reconciliation requires every bead merge_sha to equal the receipt exactly", () => {
		const f = fixture("ledger-sha");
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, { beadMergeSha: "b".repeat(40) });
		expect(refusal(result)).toContain("beads.delivery-17.metadata.merge_sha");
		expect(refusal(result)).toContain(f.merge);
		expect(commandCalls(calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]]);
		expect(mutationCalls(calls)).toEqual([]);
	});

	test("refuses the repository's main worktree", () => {
		const mainTarget = fixture("main-target");
		const mainReceipt = buildReceipt({
			...mainTarget.receipt,
			now: NOW + 1,
			pr: { ...mainTarget.receipt.pr, headRefName: "main", headRefOid: mainTarget.merge },
			branch: { ...mainTarget.receipt.branch, name: "main" },
			worktree: { path: mainTarget.main, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
			continues: mainTarget.receipt,
		});
		const mainPath = writeReceipt(mainReceipt, receiptDirectory(mainTarget.env, mainReceipt.repo.key));
		const mainRun = runner(mainTarget, { pr: { headRefName: "main", headRefOid: mainTarget.merge } });
		// Asked from the linked worktree: a call standing in its own target is refused
		// earlier, by the invocation check, and would not reach the main-worktree rule.
		const mainResult = cleanupDelivery({ receipt: mainPath }, mainTarget.linked, {
			run: mainRun.run,
			now: () => NOW + 20,
			env: mainTarget.env,
		});
		expect(refusal(mainResult)).toContain("a linked worktree other than main");
		expect(mutationCalls(mainRun.calls)).toEqual([]);
	});

	test("refuses a worktree from a foreign repository", () => {
		const current = fixture("current-repo");
		const foreign = fixture("foreign-repo");
		const foreignReceipt = buildReceipt({
			...current.receipt,
			now: NOW + 2,
			worktree: { path: foreign.linked, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
			continues: current.receipt,
		});
		const foreignPath = writeReceipt(foreignReceipt, receiptDirectory(current.env, foreignReceipt.repo.key));
		const foreignRun = runner(current);
		const foreignResult = cleanupDelivery({ receipt: foreignPath }, current.main, {
			run: foreignRun.run,
			now: () => NOW + 20,
			env: current.env,
		});
		expect(refusal(foreignResult)).toContain("a worktree in the current repository");
		expect(mutationCalls(foreignRun.calls)).toEqual([]);
	});

	test("refuses an unlisted path inside the same linked worktree", () => {
		const unlisted = fixture("unlisted");
		const nested = join(unlisted.linked, "nested");
		mkdirSync(nested);
		const unlistedReceipt = buildReceipt({
			...unlisted.receipt,
			now: NOW + 3,
			worktree: { path: nested, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
			continues: unlisted.receipt,
		});
		const unlistedPath = writeReceipt(unlistedReceipt, receiptDirectory(unlisted.env, unlistedReceipt.repo.key));
		const unlistedRun = runner(unlisted);
		const unlistedResult = cleanupDelivery({ receipt: unlistedPath }, unlisted.main, {
			run: unlistedRun.run,
			now: () => NOW + 20,
			env: unlisted.env,
		});
		expect(refusal(unlistedResult)).toContain("an exact live record in git worktree list --porcelain");
		expect(mutationCalls(unlistedRun.calls)).toEqual([]);
	});

	test("a symlink alias cannot turn an untrusted receipt path into a listed target", () => {
		const f = fixture("symlink");
		const alias = join(f.root, "linked-alias");
		symlinkSync(f.linked, alias, "dir");
		const receipt = buildReceipt({
			...f.receipt,
			now: NOW + 1,
			worktree: { path: alias, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
			continues: f.receipt,
		});
		const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key));
		const { run, calls } = runner(f);
		const result = cleanupDelivery({ receipt: path }, f.main, { run, now: () => NOW + 10, env: f.env });
		expect(refusal(result)).toContain(`${alias} (unsafe)`);
		expect(mutationCalls(calls)).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	});

	test("a dirtying race at the irreversible boundary is observed before removal", () => {
		const f = fixture("dirty-race");
		let statuses = 0;
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, {
			before: argv => {
				if (argv[0] === "git" && argv[1] === "status") {
					statuses += 1;
					if (statuses === 2) writeFileSync(join(f.linked, "raced.txt"), "raced\n");
				}
			},
		});
		expect(refusal(result)).toContain("raced.txt");
		expect(mutationCalls(calls)).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	});

	test("a ref that moves after worktree removal is not force-deleted and emits no receipt", () => {
		const f = fixture("ref-race");
		const beforeReceipts = readFileSync(f.receiptPath, "utf8");
		const raced = git(f.main, ["commit-tree", `${f.merge}^{tree}`, "-p", f.merge, "-m", "raced ref"]);
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, {
			after: (argv, commandResult) => {
				if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
					git(f.main, ["update-ref", `refs/heads/${f.branch}`, raced]);
				}
			},
		});
		expect(refusal(result)).toContain("branch.localRef: observed");
		expect(git(f.main, ["rev-parse", `refs/heads/${f.branch}`])).toBe(raced);
		expect(calls.some(argv => argv[0] === "git" && argv[1] === "branch")).toBe(false);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipts);
	});

	test("re-registration after removal is detected independently and stops branch deletion", () => {
		const f = fixture("registration-race");
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, {
			after: (argv, commandResult) => {
				if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
					git(f.main, ["worktree", "add", "-q", f.linked, f.branch]);
				}
			},
		});
		expect(refusal(result)).toContain('worktree.registrationAbsence: observed "present", expected "absent"');
		expect(existsSync(f.linked)).toBe(true);
		expect(calls.some(argv => argv[0] === "git" && argv[1] === "branch")).toBe(false);
	});

	test("a stored registration path remains present proof after its filesystem target vanishes", () => {
		const f = fixture("stored-registration");
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, { registeredTargetAfterRemove: true });
		expect(refusal(result)).toContain('worktree.registrationAbsence: observed "present", expected "absent"');
		expect(existsSync(f.linked)).toBe(false);
		expect(calls.some(argv => argv[0] === "git" && argv[1] === "branch")).toBe(false);
	});

	test("a pathless porcelain record makes post-remove registration proof unknown", () => {
		const f = fixture("pathless-record");
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, { pathlessAfterRemove: true });
		expect(refusal(result)).toContain('worktree.registrationAbsence: observed "unknown", expected "absent"');
		expect(calls.some(argv => argv[0] === "git" && argv[1] === "branch")).toBe(false);
	});


	test("filesystem-path recreation after removal is independent of registration absence", () => {
		const f = fixture("path-race");
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, {
			after: (argv, commandResult) => {
				if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
					mkdirSync(f.linked);
				}
			},
		});
		expect(refusal(result)).toContain('worktree.pathAbsence: observed "present", expected "absent"');
		expect(calls.some(argv => argv[0] === "git" && argv[1] === "branch")).toBe(false);
	});

	test("local-ref recreation after branch -d is independently reported and emits no receipt", () => {
		const f = fixture("local-ref-race");
		const { result } = invoke(f, { receipt: f.receiptPath }, {
			after: (argv, commandResult) => {
				if (argv[0] === "git" && argv[1] === "branch" && argv[2] === "-d" && commandResult.exitCode === 0) {
					git(f.main, ["update-ref", `refs/heads/${f.branch}`, f.head]);
				}
			},
		});
		expect(refusal(result)).toContain('worktree.localRefAbsence: observed "present", expected "absent"');
		expect(git(f.main, ["rev-parse", `refs/heads/${f.branch}`])).toBe(f.head);
	});

	test("hostile shell punctuation remains one argv element and cannot create a side effect", () => {
		const marker = join(tmpdir(), "delivery-cleanup-must-not-exist");
		rmSync(marker, { force: true });
		const branch = `feat/cleanup;touch-${marker.replaceAll("/", "-")}`;
		const f = fixture("argv", branch);
		const { result, calls } = invoke(f);
		expect(result.ok).toBe(true);
		expect(calls).toContainEqual(["git", "branch", "-d", "--", branch]);
		expect(existsSync(marker)).toBe(false);
	});

	test("a leading-dash branch remains an operand after the branch-delete option terminator", () => {
		expect(branchDeleteArgs("-malicious-option")).toEqual(["branch", "-d", "--", "-malicious-option"]);
	});
});

/**
 * One runner for a real `delivery_land` call against a fixture repository: the forge
 * reads are scripted, every Git read is answered by the fixture's own repository.
 *
 * Scripted `git remote get-url` is the one exception. The fixture's `origin` is a
 * local bare path, which `detectForge` correctly refuses as no forge; the URL is what
 * the landing classifies, and the remote NAME is what the receipt records.
 */
function landRunner(f: Fixture): { run: CliRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: CliRunner = (argv, options) => {
		calls.push([...argv]);
		if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return success(githubPayload(f));
		if (argv[0] === "gh" && argv[1] === "api") return success("false\n");
		if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "get-url") return success("https://github.com/owner/repo.git\n");
		if (argv[0] === "git" && argv.includes("ls-remote")) return success("", 2);
		return runCli(argv, options);
	};
	return { run, calls };
}

/**
 * The classification seam is the security boundary this whole tool stands on, so it
 * is exercised against real repositories: a real `.beads` at a real canonical root, a
 * real nested retired marker, and a real linked worktree that really disappears or
 * really survives.
 */
describe("the ledger is classified at the canonical root, never at a caller's directory", () => {
	/**
	 * The escalation the final integration review proved, end to end and now closed:
	 * land from a directory shadowed by a nested retired `.beads`, then clean from the
	 * repository whose canonical ledger is active. Before the fix the receipt recorded
	 * `ledgerActive: false` from the shadowed directory and cleanup returned success
	 * from the ledger gate without issuing a single `bd` call, deleting the worktree and
	 * the branch while the bead stayed open.
	 */
	test("a landing from a shadowed directory records the canonical verdict, and cleanup then requires reconciliation", () => {
		const f = fixture("bypass", "omp/agent/delivery-17");
		const shadowed = join(f.main, "nested");
		mkdirSync(join(shadowed, ".beads"), { recursive: true });
		writeFileSync(join(shadowed, ".beads", "RETIRED"), "retired\n");

		const landing = landRunner(f);
		const landed = landPullRequest(
			{ pr: f.receipt.pr.number, worktree: f.linked },
			{ run: landing.run, cwd: shadowed, now: () => NOW + 5, env: f.env },
		);
		expect(landed.ok).toBe(true);
		if (!landed.ok) throw new Error(landed.reason);
		expect(landed.receipt.beads).toEqual({ ids: ["delivery-17"], ledgerActive: true });
		expect(landed.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(f.main), active: true } });
		expect(landed.receipt.repo.remote).toBe("origin");
		expect(landed.next).toEqual(["bd_reconcile", "delivery_cleanup"]);

		const cleaning = runner(f);
		const cleaned = cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
			run: cleaning.run,
			now: () => NOW + 10,
			env: f.env,
		});
		expect(cleaned.ok).toBe(true);
		// The gate ran: the bypass was a cleanup that reached success with no bd call.
		expect(commandCalls(cleaning.calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]]);
		expect(existsSync(f.linked)).toBe(false);
		expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(1);
	});

	test("an unreconciled bead still refuses that same landing, so the gate is the ledger's and not the receipt's", () => {
		const f = fixture("bypass-open-bead", "omp/agent/delivery-17");
		const shadowed = join(f.main, "nested");
		mkdirSync(join(shadowed, ".beads"), { recursive: true });
		writeFileSync(join(shadowed, ".beads", "RETIRED"), "retired\n");

		const landed = landPullRequest(
			{ pr: f.receipt.pr.number, worktree: f.linked },
			{ run: landRunner(f).run, cwd: shadowed, now: () => NOW + 5, env: f.env },
		);
		expect(landed.ok).toBe(true);
		if (!landed.ok) throw new Error(landed.reason);

		const cleaning = runner(f, { beadStatus: "open" });
		const refused = cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
			run: cleaning.run,
			now: () => NOW + 10,
			env: f.env,
		});
		expect(refusal(refused)).toContain('beads.delivery-17.status: observed "open", expected "closed" after bd_reconcile');
		expect(mutationCalls(cleaning.calls)).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
		expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0);
	});

	/**
	 * The same receipt an unfixed producer would have written, and the same receipt an
	 * attacker would forge: `ledgerActive: false` over a repository whose canonical
	 * ledger is active. The stored boolean alone never opens the success path.
	 */
	test("a stale or tampered false claim is refused against the recomputed verdict, and nothing is removed", () => {
		const f = fixture("stale-false-claim");
		const stale = buildReceipt({
			...f.receipt,
			now: NOW + 1,
			beads: { ids: f.receipt.beads.ids, ledgerActive: false },
		});
		const stalePath = writeReceipt(stale, receiptDirectory(f.env, stale.repo.key));

		const { run, calls } = runner(f);
		const result = cleanupDelivery({ receipt: stalePath }, f.main, { run, now: () => NOW + 10, env: f.env });

		const reason = refusal(result);
		expect(reason).toContain("beads.ledgerActive: observed false stored in the receipt, expected true");
		expect(reason).toContain(`recomputed at canonical root "${realpathSync(f.main)}"`);
		expect(reason).toContain("bd_reconcile");
		expect(mutationCalls(calls)).toEqual([]);
		expect(commandCalls(calls, "bd")).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
		expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0);
	});

	test("a true claim over a retired canonical root is refused just as loudly", () => {
		const f = fixture("stale-true-claim", "feat/stale-true-claim", "retired");
		const claimed = buildReceipt({
			...f.receipt,
			now: NOW + 1,
			beads: { ids: f.receipt.beads.ids, ledgerActive: true },
		});
		const claimedPath = writeReceipt(claimed, receiptDirectory(f.env, claimed.repo.key));

		const { run, calls } = runner(f);
		const result = cleanupDelivery({ receipt: claimedPath }, f.main, { run, now: () => NOW + 10, env: f.env });

		const reason = refusal(result);
		expect(reason).toContain("beads.ledgerActive: observed true stored in the receipt, expected false");
		expect(reason).toContain(`recomputed at canonical root "${realpathSync(f.main)}"`);
		expect(mutationCalls(calls)).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	});

	/**
	 * An active ledger with nothing to reconcile is refused by the receipt's own
	 * validator, so a tampered file carrying that pair never reaches the ledger gate.
	 */
	test("a tampered receipt claiming an active ledger with no bead ids is refused when it is read", () => {
		const f = fixture("tampered-empty-ids");
		const directory = receiptDirectory(f.env, f.receipt.repo.key);
		const tampered = { ...f.receipt, beads: { ids: [], ledgerActive: true } };
		rmSync(f.receiptPath);
		writeFileSync(join(directory, `${f.receipt.receiptId}.json`), JSON.stringify(tampered));

		const { run, calls } = runner(f);
		const result = cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env });

		expect(refusal(result)).toContain("beads.ids: observed array of 0, expected at least one bead id when beads.ledgerActive is true");
		expect(calls).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	});
});

describe("delivery_cleanup never removes the worktree it was called from", () => {
	test("a call from inside its own target refuses, naming the invocation and the resolved target", () => {
		const f = fixture("invocation-target");
		const { run, calls } = runner(f);
		const result = cleanupDelivery({ receipt: f.receiptPath }, f.linked, { run, now: () => NOW + 10, env: f.env });

		const reason = refusal(result);
		expect(reason).toContain(`worktree.invocationCwd: observed "${f.linked}"`);
		expect(reason).toContain(realpathSync(f.linked));
		expect(calls).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
		expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0);
	});

	test("a subdirectory of the target is inside the target", () => {
		const f = fixture("invocation-nested");
		const nested = join(f.linked, "deep", "deeper");
		mkdirSync(nested, { recursive: true });
		const { run, calls } = runner(f);
		const result = cleanupDelivery({ receipt: f.receiptPath }, nested, { run, now: () => NOW + 10, env: f.env });

		expect(refusal(result)).toContain("expected a directory outside the worktree this call would remove");
		expect(calls).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	});

	test("a symlinked alias of the target is still the target", () => {
		const f = fixture("invocation-alias");
		const alias = join(f.root, "alias");
		symlinkSync(f.linked, alias, "dir");
		const { run, calls } = runner(f);
		const result = cleanupDelivery({ receipt: f.receiptPath }, alias, { run, now: () => NOW + 10, env: f.env });

		expect(refusal(result)).toContain("worktree.invocationCwd");
		expect(calls).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	});

	test("the remote-absence probe is asked from a surviving worktree of this repository", () => {
		const f = fixture("probe-cwd");
		const scripted = runner(f);
		const directories: (string | undefined)[] = [];
		const run: CliRunner = (argv, options) => {
			if (argv.includes("ls-remote")) directories.push(options.cwd);
			return scripted.run(argv, options);
		};
		const result = cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env });

		expect(result.ok).toBe(true);
		expect(directories).toHaveLength(1);
		const asked = directories[0];
		if (asked === undefined) throw new Error("the probe was issued with no working directory");
		expect(realpathSync(asked)).toBe(realpathSync(f.main));
		expect(repoKey(asked)).toBe(f.receipt.repo.key);
	});
});

describe("delivery_cleanup registration", () => {
	test("registers once as an exec tool and keeps its manifest entry once in the decided order", () => {
		let descriptor: { name?: string; approval?: string } | undefined;
		const chain: Record<string, unknown> = {};
		for (const method of ["min", "int", "positive", "optional", "describe"]) {
			chain[method] = () => chain;
		}
		const pi = {
			zod: {
				string: () => chain,
				number: () => chain,
				object: (shape: unknown) => shape,
			},
			registerTool: (value: { name?: string; approval?: string }) => {
				descriptor = value;
			},
		} as unknown as ExtensionAPI;
		deliveryCleanupTool(pi);
		expect(descriptor).toMatchObject({ name: "delivery_cleanup", approval: "exec" });

		const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
			omp: { extensions: string[] };
		};
		const decidedOrder = [
			"./extensions/unpushed-work-advisory.ts",
			"./extensions/delivery-land-tool.ts",
			"./extensions/delivery-cleanup-tool.ts",
			"./extensions/hygiene-orientation.ts",
		];
		const registered = manifest.omp.extensions.filter(entry => decidedOrder.includes(entry));
		expect(registered).toEqual(decidedOrder.filter(entry => manifest.omp.extensions.includes(entry)));
		expect(manifest.omp.extensions.filter(entry => entry === "./extensions/delivery-cleanup-tool.ts")).toHaveLength(1);
	});
});
