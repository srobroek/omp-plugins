import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beadIdsFromBranch, type LandParams, landPullRequest, repoPathFromRemote } from "./delivery-land-tool.ts";
import type { CliResult, CliRunner } from "./forge-adapter.ts";
import { RECEIPT_SCHEMA, readReceipt, repoKey, writeReceipt } from "./landing-receipt.ts";

type Call = { argv: string[]; cwd: string | undefined; timeoutMs: number; env: Readonly<Record<string, string>> | undefined };

const MERGE_OID = "feedfacecafebabe0123456789abcdef01234567";
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";
const REMOTE_URL = "https://github.com/srobroek/omp-plugins.git";
const BRANCH = "omp/agent/omp-plugins-9ej3.5";
const NOW = 1_764_000_000_000;

const completed = (stdout: string, exitCode = 0, stderr = ""): CliResult => ({ ok: true, exitCode, stdout, stderr });

/** A GitHub pull-request payload in `gh pr view --json` spelling. */
const githubPr = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({
		number: 470,
		url: "https://github.com/srobroek/omp-plugins/pull/470",
		state: "OPEN",
		baseRefName: "omp/integration/omp-plugins-9ej3",
		headRefName: BRANCH,
		headRefOid: HEAD_OID,
		mergeCommit: null,
		mergedAt: null,
		...overrides,
	});

const mergedGithubPr = (overrides: Record<string, unknown> = {}): string =>
	githubPr({ state: "MERGED", mergeCommit: { oid: MERGE_OID }, mergedAt: "2026-09-21T20:00:00Z", ...overrides });

/** A GitLab merge request in `glab mr view --output json` spelling. */
const gitlabMr = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({
		iid: 12,
		web_url: "https://gitlab.com/group/project/-/merge_requests/12",
		state: "merged",
		target_branch: "main",
		source_branch: BRANCH,
		sha: HEAD_OID,
		merge_commit_sha: MERGE_OID,
		merged_at: "2026-09-21T20:00:00Z",
		...overrides,
	});

/**
 * A repository whose git reads answer from a real temporary directory.
 *
 * `repoKey` hashes the realpath of the git common directory, so the fixture
 * creates one: the receipt then carries a key that a reader could reproduce, and
 * `canonicalRoot` is the parent this landing was keyed from.
 */
function repository(): { canonical: string; receipts: string } {
	const canonical = mkdtempSync(join(tmpdir(), "delivery-land-repo-"));
	mkdirSync(join(canonical, ".git"));
	return { canonical, receipts: mkdtempSync(join(tmpdir(), "delivery-land-receipts-")) };
}

type Answers = {
	prView?: CliResult[];
	merge?: CliResult;
	autoDelete?: CliResult;
	enable?: CliResult;
	lsRemote?: CliResult;
	remoteUrl?: string;
};

/**
 * One runner for every child process the tool may start, recording each argv.
 *
 * Recording all of them in one place is what makes "no merge argv was issued" and
 * "no bd argv was issued" observations rather than assertions about intent. An
 * unexpected command fails loudly instead of returning a plausible default.
 */
function runner(answers: Answers, canonical: string): { run: CliRunner; calls: Call[] } {
	const views = [...(answers.prView ?? [])];
	const calls: Call[] = [];
	const run: CliRunner = (argv, options) => {
		calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
		const command = argv.join(" ");
		if (command.startsWith("git rev-parse --git-common-dir")) return completed(`${join(canonical, ".git")}\n`);
		if (command.startsWith("git remote get-url")) return completed(`${answers.remoteUrl ?? REMOTE_URL}\n`);
		if (argv[1] === "pr" && argv[2] === "view") return views.shift() ?? completed(mergedGithubPr());
		if (argv[1] === "mr" && argv[2] === "view") return views.shift() ?? completed(gitlabMr());
		if (argv[1] === "api" && argv.includes("-X")) return answers.enable ?? completed("{}\n");
		if (argv[1] === "api") return answers.autoDelete ?? completed("false\n");
		if (argv[1] === "pr" && argv[2] === "merge") return answers.merge ?? completed("");
		if (argv[1] === "mr" && argv[2] === "merge") return answers.merge ?? completed("");
		if (argv.includes("ls-remote")) return answers.lsRemote ?? { ok: true, exitCode: 2, stdout: "", stderr: "" };
		throw new Error(`the tool issued an unexpected command: ${command}`);
	};
	return { run, calls };
}
function land(answers: Answers, params: Partial<LandParams> = {}, env: NodeJS.ProcessEnv = {}) {
	const { canonical, receipts } = repository();
	mkdirSync(join(canonical, ".beads"));
	const { run, calls } = runner(answers, canonical);
	const outcome = landPullRequest({ pr: 470, ...params }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env });
	return { outcome, calls, receipts, canonical, files: () => readdirSync(receipts) };
}

const merged = (argv: string[]): boolean => argv[2] === "merge";

describe("delivery_land", () => {
	test("a clean land emits one receipt whose fields are the forge reads", () => {
		const { outcome, receipts, files } = land({
			prView: [completed(githubPr()), completed(mergedGithubPr())],
			lsRemote: { ok: true, exitCode: 2, stdout: "", stderr: "" },
		}, { worktree: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5" });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(files()).toHaveLength(1);
		expect(outcome.receiptPath).toBe(join(receipts, `${NOW}-${MERGE_OID.slice(0, 12)}.json`));

		const receipt = outcome.receipt;
		expect(receipt.schema).toBe(RECEIPT_SCHEMA);
		expect(receipt.pr).toEqual({
			number: 470,
			url: "https://github.com/srobroek/omp-plugins/pull/470",
			state: "MERGED",
			baseRefName: "omp/integration/omp-plugins-9ej3",
			headRefName: BRANCH,
			headRefOid: HEAD_OID,
			mergeCommitOid: MERGE_OID,
			mergedAt: "2026-09-21T20:00:00Z",
		});
		expect(receipt.repo.forge).toBe("github");
		expect(receipt.repo.nameWithOwner).toBe("srobroek/omp-plugins");
		expect(receipt.repo.remote).toBe("origin");
		expect(receipt.proof.evidence).toMatchObject({ remote: "origin", remoteUrl: REMOTE_URL });
		expect(receipt.proof.method).toBe("gh pr view");
		expect(receipt.branch).toEqual({
			name: BRANCH,
			deletedRemote: true,
			remoteAbsenceVerifiedAt: new Date(NOW).toISOString(),
			autoDeleteSetting: "off",
		});
		expect(receipt.beads.ids).toEqual(["omp-plugins-9ej3.5"]);
		expect(receipt.worktree.path).toBe("/tmp/worktrees/omp-agent-omp-plugins-9ej3.5");
		expect(receipt.outcome).toBe("landed");
		expect(receipt.supersedes).toBeNull();
		expect(outcome.next).toEqual(["bd_reconcile", "delivery_cleanup"]);
		expect(outcome.text.indexOf("bd_reconcile")).toBeLessThan(outcome.text.indexOf("delivery_cleanup"));

		// The file on disk is the object returned, and a reader accepts it.
		const reread = readReceipt(outcome.receiptPath);
		expect(reread.ok).toBe(true);
		if (!reread.ok) throw new Error(reread.reason);
		expect(reread.receipt).toEqual(receipt);
	});

	test("a regular-file RETIRED marker makes the landing receipt ledger-inactive", () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		writeFileSync(join(canonical, ".beads", "RETIRED"), "retired\n");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest(
			{ pr: 470, worktree: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5" },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.5"], ledgerActive: false });
		expect(outcome.next).toEqual(["delivery_cleanup"]);
		expect(outcome.text).not.toContain("bd_reconcile");
	});


	/**
	 * The inverse of what this file used to pin, and the security fix itself: the
	 * canonical root's verdict is the repository's verdict. A nested `.beads` under the
	 * directory the tool was called in does not get a vote, in either direction.
	 */
	test("a nested active ledger does not override a retired canonical root", () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		writeFileSync(join(canonical, ".beads", "RETIRED"), "retired\n");
		const nested = join(canonical, "nested");
		mkdirSync(join(nested, ".beads"), { recursive: true });
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(false);
		expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(canonical), active: false } });
		expect(outcome.next).toEqual(["delivery_cleanup"]);
		expect(outcome.text).not.toContain("bd_reconcile");
	});

	test("a nested retired ledger does not deactivate an active canonical root", () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const nested = join(canonical, "nested");
		mkdirSync(join(nested, ".beads"), { recursive: true });
		writeFileSync(join(nested, ".beads", "RETIRED"), "retired\n");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
		expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(canonical), active: true } });
		expect(outcome.next).toEqual(["bd_reconcile", "delivery_cleanup"]);
		expect(outcome.text).toContain("bd_reconcile");
	});

	test("a symlinked RETIRED marker does not deactivate the ledger", () => {
		const { canonical, receipts } = repository();
		const beads = join(canonical, ".beads");
		mkdirSync(beads);
		const target = join(canonical, "retired-target");
		writeFileSync(target, "retired\n");
		symlinkSync(target, join(beads, "RETIRED"));
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
		expect(outcome.next).toEqual(["bd_reconcile", "delivery_cleanup"]);
	});

	test("a dangling .beads path keeps the ledger active", () => {
		const { canonical, receipts } = repository();
		symlinkSync(join(canonical, "missing-beads"), join(canonical, ".beads"));
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
	});

	test("a non-directory .beads path keeps the ledger active", () => {
		const { canonical, receipts } = repository();
		writeFileSync(join(canonical, ".beads"), "not a directory\n");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
	});

	test("the result text routes the caller to bd_reconcile and then delivery_cleanup", () => {
		const { outcome } = land({ prView: [completed(mergedGithubPr())] });
		expect(outcome.ok).toBe(true);
		const reconcile = outcome.text.indexOf("bd_reconcile");
		const cleanup = outcome.text.indexOf("delivery_cleanup");
		expect(reconcile).toBeGreaterThan(-1);
		expect(cleanup).toBeGreaterThan(reconcile);
	});

	test("an already MERGED pull request is proved, not merged again", () => {
		const { outcome, calls, files } = land({ prView: [completed(mergedGithubPr())] });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.outcome).toBe("landed");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(calls.filter(call => call.argv[1] === "pr" && call.argv[2] === "view")).toHaveLength(1);
		expect(outcome.receipt.proof.evidence).toMatchObject({ merge: null, reread: null });
		expect(outcome.receipt.notes).toContain("already MERGED");
		expect(files()).toHaveLength(1);
	});

	test("a GitLab merge request is read in its own dialect", () => {
		const { canonical, receipts } = repository();
		const { run } = runner({ remoteUrl: "git@gitlab.com:group/project.git", prView: [completed(gitlabMr())] }, canonical);
		const outcome = landPullRequest({ pr: "12" }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.repo.forge).toBe("gitlab");
		expect(outcome.receipt.pr.number).toBe(12);
		expect(outcome.receipt.pr.state).toBe("merged");
		expect(outcome.receipt.pr.mergeCommitOid).toBe(MERGE_OID);
	});

	test("an expectHeadSha mismatch refuses, names both shas, and merges nothing", () => {
		const { outcome, calls, files } = land({ prView: [completed(githubPr())] }, { expectHeadSha: "ffffffffffffffffffffffffffffffffffffffff" });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain(HEAD_OID);
		expect(outcome.reason).toContain("ffffffffffffffffffffffffffffffffffffffff");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(files()).toHaveLength(0);
	});

	test("a re-read that is not MERGED refuses, names the observed state and oid, and writes nothing", () => {
		const { outcome, calls, files } = land({
			prView: [completed(githubPr()), completed(githubPr({ state: "OPEN" }))],
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('pr.state "OPEN"');
		expect(outcome.reason).toContain("pr.mergeCommitOid null");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(1);
		expect(files()).toHaveLength(0);
	});

	test("a MERGED re-read with no merge commit oid is not proof", () => {
		const { outcome, files } = land({ prView: [completed(githubPr()), completed(githubPr({ state: "MERGED" }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.mergeCommitOid null");
		expect(files()).toHaveLength(0);
	});

	test("a failed merge refuses with the observed exit status and writes nothing", () => {
		const { outcome, files } = land({
			prView: [completed(githubPr())],
			merge: completed("", 1, "Pull request is not mergeable"),
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("observed exit 1");
		expect(outcome.reason).toContain("Pull request is not mergeable");
		expect(files()).toHaveLength(0);
	});

	test("an unknown remote-absence verdict leaves deletedRemote false and the timestamp null", () => {
		const { outcome } = land({
			prView: [completed(mergedGithubPr())],
			lsRemote: { ok: false, exitCode: null, stdout: "", stderr: "", error: "git was terminated by SIGTERM (timeout 10000ms)" },
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.branch.deletedRemote).toBe(false);
		expect(outcome.receipt.branch.remoteAbsenceVerifiedAt).toBeNull();
		expect(outcome.receipt.notes).toContain("unknown");
	});

	test("a remote branch still present is not recorded as deleted", () => {
		const { outcome } = land({
			prView: [completed(mergedGithubPr())],
			lsRemote: completed(`${HEAD_OID}\trefs/heads/${BRANCH}\n`),
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.branch.deletedRemote).toBe(false);
		expect(outcome.receipt.branch.remoteAbsenceVerifiedAt).toBeNull();
		expect(outcome.receipt.proof.evidence).toMatchObject({ remoteBranch: { verdict: "present" } });
	});

	test("setupAutoDelete absent or false issues no repository-setting write", () => {
		for (const setupAutoDelete of [undefined, false] as const) {
			const { outcome, calls } = land({ prView: [completed(mergedGithubPr())] }, { setupAutoDelete });
			expect(outcome.ok).toBe(true);
			expect(calls.filter(call => call.argv.includes("-X") || call.argv.includes("PATCH") || call.argv.includes("PUT"))).toHaveLength(0);
			if (!outcome.ok) throw new Error(outcome.reason);
			expect(outcome.receipt.notes).toContain("no repository setting was written");
		}
	});

	test("setupAutoDelete true writes the setting once and records the outcome in the notes", () => {
		const { outcome, calls } = land({ prView: [completed(mergedGithubPr())], autoDelete: completed("false\n") }, { setupAutoDelete: true });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		const writes = calls.filter(call => call.argv.includes("-X"));
		expect(writes).toHaveLength(1);
		expect(writes[0]?.argv).toEqual(["gh", "api", "-X", "PATCH", "repos/srobroek/omp-plugins", "-F", "delete_branch_on_merge=true"]);
		expect(outcome.receipt.notes).toContain("the forge accepted");
		// Acceptance is not a re-read, so the recorded setting stays the observed one.
		expect(outcome.receipt.branch.autoDeleteSetting).toBe("off");
	});

	test("a refused setting write is recorded and does not fail the landing", () => {
		const { outcome } = land(
			{ prView: [completed(mergedGithubPr())], enable: completed("", 1, "HTTP 403") },
			{ setupAutoDelete: true },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.notes).toContain("refused");
		expect(outcome.receipt.branch.autoDeleteSetting).toBe("off");
	});

	test("an unreadable auto-delete setting stays unknown", () => {
		const { outcome } = land({ prView: [completed(mergedGithubPr())], autoDelete: completed("", 1, "HTTP 404") });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.branch.autoDeleteSetting).toBe("unknown");
	});

	test("a receipt the validator refuses names the validator's field and writes no file", () => {
		const { outcome, files } = land({ prView: [completed(mergedGithubPr({ url: "" }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.url");
		expect(outcome.reason).toContain("no file was written");
		expect(files()).toHaveLength(0);
	});

	test("no path issues a bd argv", () => {
		const cases: Array<[Answers, Partial<LandParams>]> = [
			[{ prView: [completed(githubPr()), completed(mergedGithubPr())] }, {}],
			[{ prView: [completed(mergedGithubPr())] }, { setupAutoDelete: true }],
			[{ prView: [completed(githubPr())] }, { expectHeadSha: "deadbeef" }],
			[{ prView: [completed(githubPr()), completed(githubPr())] }, {}],
		];
		for (const [answers, params] of cases) {
			const { calls } = land(answers, params);
			expect(calls.filter(call => call.argv[0] === "bd")).toHaveLength(0);
		}
	});

	test("a pull request number that is not a positive integer never reaches a command", () => {
		for (const pr of ["--repo", "0", "-1", "", "12x"]) {
			const { outcome, calls } = land({}, { pr });
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("expected a positive integer");
			expect(calls).toHaveLength(0);
		}
	});

	test("a remote whose URL names no adapter refuses without reading the pull request", () => {
		const { outcome, calls } = land({ remoteUrl: "https://bitbucket.org/team/repo.git", prView: [completed(mergedGithubPr())] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('repo.forge: observed "unknown"');
		expect(calls.filter(call => call.argv[0] === "gh")).toHaveLength(0);
	});

	test("a pull-request payload missing a required field refuses by field name", () => {
		const { outcome, files } = land({ prView: [completed(JSON.stringify({ number: 470, state: "MERGED" }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.url: observed absent");
		expect(files()).toHaveLength(0);
	});

	test("a polluted Object.prototype cannot supply a merge state the forge never sent", () => {
		// The defect this pins: a plain `payload.state` read consults the prototype
		// chain, so one polluting dependency anywhere in the session would let an open
		// pull request read as MERGED and emit a receipt claiming it landed.
		for (const [key, value] of [["state", "MERGED"], ["mergeCommit", { oid: MERGE_OID }]] as const) {
			Object.defineProperty(Object.prototype, key, { value, configurable: true, enumerable: false, writable: true });
		}
		try {
			expect("state" in {}).toBe(true);
			const { outcome, calls, files } = land({
				prView: [completed(JSON.stringify({ number: 470, url: "https://x/1", baseRefName: "main", headRefName: BRANCH, headRefOid: HEAD_OID }))],
			});
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("pr.state: observed absent");
			expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
			expect(files()).toHaveLength(0);
		} finally {
			Reflect.deleteProperty(Object.prototype, "state");
			Reflect.deleteProperty(Object.prototype, "mergeCommit");
		}
		expect("state" in {}).toBe(false);
	});

	test("the merge argv binds the repository and the first observed head", () => {
		const { outcome, calls } = land({ prView: [completed(githubPr()), completed(mergedGithubPr())] });

		expect(outcome.ok).toBe(true);
		const merges = calls.filter(call => merged(call.argv));
		expect(merges).toHaveLength(1);
		expect(merges[0]?.argv).toEqual([
			"gh",
			"pr",
			"merge",
			"470",
			"--squash",
			"--delete-branch",
			"--repo",
			"srobroek/omp-plugins",
			"--match-head-commit",
			HEAD_OID,
		]);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.proof.evidence).toMatchObject({ boundRepo: "srobroek/omp-plugins", merge: { boundHead: HEAD_OID } });
	});

	test("a GitLab merge binds the repository and the head in glab's spelling", () => {
		const { canonical, receipts } = repository();
		const { run, calls } = runner(
			{ remoteUrl: "git@gitlab.com:group/project.git", prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())] },
			canonical,
		);
		const outcome = landPullRequest({ pr: 12 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		expect(calls.filter(call => merged(call.argv))[0]?.argv).toEqual([
			"glab",
			"mr",
			"merge",
			"12",
			"--squash",
			"--remove-source-branch",
			"--repo",
			"group/project",
			"--sha",
			HEAD_OID,
		]);
	});

	test("a head that moved between the merge and the re-read refuses and writes nothing", () => {
		const moved = "9999999999999999999999999999999999999999";
		const { outcome, files } = land({
			prView: [completed(githubPr()), completed(mergedGithubPr({ headRefOid: moved }))],
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain(moved);
		expect(outcome.reason).toContain(HEAD_OID);
		expect(outcome.reason).toContain("the head moved");
		expect(files()).toHaveLength(0);
	});

	test("a pull request re-targeted between the reads refuses and writes nothing", () => {
		const { outcome, files } = land({
			prView: [completed(githubPr()), completed(mergedGithubPr({ baseRefName: "main" }))],
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("re-targeted");
		expect(outcome.reason).toContain("omp/integration/omp-plugins-9ej3");
		expect(files()).toHaveLength(0);
	});

	test("a payload for another pull request refuses before merging", () => {
		const { outcome, calls, files } = land({ prView: [completed(githubPr({ number: 999 }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("observed pr.number 999, expected 470");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(files()).toHaveLength(0);
	});

	test("a re-read for another pull request refuses and writes nothing", () => {
		const { outcome, files } = land({ prView: [completed(githubPr()), completed(mergedGithubPr({ number: 999 }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("observed pr.number 999, expected 470");
		expect(files()).toHaveLength(0);
	});

	test("a head that is not a whole object id cannot bind a merge, so none is issued", () => {
		const { outcome, calls, files } = land({ prView: [completed(githubPr({ headRefOid: "0123456" }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.headRefOid: observed \"0123456\"");
		expect(outcome.reason).toContain("no merge was issued");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(files()).toHaveLength(0);
	});

	test("ambient repository and host variables reach no forge command, on either forge", () => {
		// Every spelling either CLI reads. `gh`: GH_REPO, GH_HOST. `glab`: GITLAB_HOST,
		// the older GL_HOST, GITLAB_URI, and GITLAB_API_HOST, which redirects API traffic
		// by itself. A GitLab variable is stripped from a GitHub command too: whoever
		// exported it was not necessarily talking about this landing.
		const redirectors = {
			GH_REPO: "attacker/elsewhere",
			GH_HOST: "evil.example",
			GITLAB_HOST: "evil.example",
			GL_HOST: "evil.example",
			GITLAB_URI: "https://evil.example",
			GITLAB_API_HOST: "api.evil.example",
		};
		const ambient = { ...redirectors, GH_TOKEN: "keep-gh", GITLAB_TOKEN: "keep-gitlab", GL_TOKEN: "keep-gl", PATH: "/usr/bin" };

		const github = land({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, { setupAutoDelete: true }, ambient);
		expect(github.outcome.ok).toBe(true);

		const { canonical, receipts } = repository();
		const { run, calls: gitlabCalls } = runner(
			{
				remoteUrl: "git@gitlab.com:group/project.git",
				prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())],
			},
			canonical,
		);
		const gitlab = landPullRequest(
			{ pr: 12, setupAutoDelete: true },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: ambient },
		);
		expect(gitlab.ok).toBe(true);

		for (const [cli, calls] of [
			["gh", github.calls],
			["glab", gitlabCalls],
		] as const) {
			const forgeCalls = calls.filter(call => call.argv[0] === cli);
			// view, merge, re-read, settings read, settings write.
			expect(forgeCalls.length).toBeGreaterThan(3);
			for (const call of forgeCalls) {
				for (const key of Object.keys(redirectors)) {
					expect(call.env?.[key]).toBeUndefined();
				}
				// Credentials are kept: an unauthenticated command is a different failure.
				expect(call.env?.GH_TOKEN).toBe("keep-gh");
				expect(call.env?.GITLAB_TOKEN).toBe("keep-gitlab");
				expect(call.env?.GL_TOKEN).toBe("keep-gl");
			}
		}

		// The adapter hardens Git's own environment for the absence observation, and that
		// choice is left intact rather than replaced by this tool's.
		const lsRemote = github.calls.find(call => call.argv.includes("ls-remote"));
		expect(lsRemote?.env?.GIT_ALLOW_PROTOCOL).toBe("file:https:ssh");
		expect(lsRemote?.env?.GIT_TERMINAL_PROMPT).toBe("0");
	});

	test("an unreadable repository refuses before any forge call", () => {
		const { canonical } = repository();
		const calls: Call[] = [];
		const run: CliRunner = (argv, options) => {
			calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
			return { ok: false, exitCode: null, stdout: "", stderr: "", error: "spawn git ENOENT" };
		};
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, env: {} });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("git rev-parse --git-common-dir");
		expect(calls).toHaveLength(1);
	});

	test("the receipt directory defaults under the agent directory, never into the checkout", () => {
		const { canonical } = repository();
		const agentDir = mkdtempSync(join(tmpdir(), "delivery-land-agent-"));
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receiptPath.startsWith(join(agentDir, "receipts", outcome.receipt.repo.key))).toBe(true);
		expect(existsSync(join(canonical, "receipts"))).toBe(false);
		expect(JSON.parse(readFileSync(outcome.receiptPath, "utf8")).receiptId).toBe(outcome.receipt.receiptId);
	});

	test("a repo override that the merge argv could not honour refuses before reading", () => {
		const { outcome, calls } = land({ prView: [completed(mergedGithubPr())] }, { repo: "someone-else/fork" });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('"someone-else/fork"');
		expect(outcome.reason).toContain('"srobroek/omp-plugins"');
		expect(calls.filter(call => call.argv[0] === "gh")).toHaveLength(0);
	});

	test("a repo override that agrees with the remote is accepted", () => {
		const { outcome } = land({ prView: [completed(mergedGithubPr())] }, { repo: "srobroek/omp-plugins" });
		expect(outcome.ok).toBe(true);
	});

	test("a credential in the remote URL is not copied into the receipt", () => {
		const { outcome } = land({ remoteUrl: "https://sjors:ghp_secrettoken@github.com/srobroek/omp-plugins.git", prView: [completed(mergedGithubPr())] });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.repo.remote).toBe("origin");
		expect(outcome.receipt.proof.evidence).toMatchObject({ remoteUrl: "https://github.com/srobroek/omp-plugins.git" });
		expect(outcome.receipt.repo.nameWithOwner).toBe("srobroek/omp-plugins");
		expect(JSON.stringify(outcome.receipt)).not.toContain("ghp_secrettoken");
	});

	/**
	 * The exact object a real land emits, key by key against decision omp-plugins-9ej3.1
	 * section 2 as amended by omp-plugins-9ej3.45. Two packages read this shape, so the
	 * assertion is the whole object and the whole top-level key set: a field added,
	 * renamed or dropped here is a contract change and must fail a test, not a consumer.
	 */
	test("a real land emits exactly the amended v1 receipt object", () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const { run } = runner({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest(
			{ pr: 470, worktree: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5" },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		const receipt = outcome.receipt;
		const key = repoKey(canonical, () => join(canonical, ".git"));
		if (key === null) throw new Error("the fixture repository has no key");

		expect(Object.keys(receipt).sort()).toEqual([
			"beads",
			"branch",
			"emittedAt",
			"emitter",
			"notes",
			"outcome",
			"pr",
			"proof",
			"receiptId",
			"repo",
			"schema",
			"supersedes",
			"version",
			"worktree",
		]);
		expect(receipt.schema).toBe("omp.receipt.landing");
		expect(receipt.version).toBe(1);
		expect(receipt.receiptId).toBe(`${NOW}-${MERGE_OID.slice(0, 12)}`);
		expect(receipt.emittedAt).toBe(new Date(NOW).toISOString());
		expect(receipt.emitter).toEqual({ plugin: "@srobroek/delivery", version: "0.11.5", tool: "delivery_land" });
		expect(receipt.repo).toEqual({
			key,
			canonicalRoot: canonical,
			remote: "origin",
			forge: "github",
			nameWithOwner: "srobroek/omp-plugins",
		});
		expect(receipt.pr).toEqual({
			number: 470,
			url: "https://github.com/srobroek/omp-plugins/pull/470",
			state: "MERGED",
			baseRefName: "omp/integration/omp-plugins-9ej3",
			headRefName: BRANCH,
			headRefOid: HEAD_OID,
			mergeCommitOid: MERGE_OID,
			mergedAt: "2026-09-21T20:00:00Z",
		});
		expect(receipt.branch).toEqual({
			name: BRANCH,
			deletedRemote: true,
			remoteAbsenceVerifiedAt: new Date(NOW).toISOString(),
			autoDeleteSetting: "off",
		});
		expect(receipt.worktree).toEqual({
			path: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5",
			removed: false,
			localRefDeleted: false,
			absenceVerifiedAt: null,
		});
		expect(receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.5"], ledgerActive: true });
		expect(receipt.proof.method).toBe("gh pr view");
		expect(receipt.proof.observedAt).toBe(new Date(NOW).toISOString());
		expect(receipt.outcome).toBe("landed");
		expect(receipt.supersedes).toBeNull();
		expect(typeof receipt.notes).toBe("string");

		// A forward key a later version added must survive the transport untouched.
		const forward = { ...receipt, mergeQueueEntry: { id: "q-1" } };
		const written = writeReceipt(forward, mkdtempSync(join(tmpdir(), "delivery-land-forward-")));
		expect(readReceipt(written)).toEqual({ ok: true, receipt: forward });
	});

	/**
	 * Not a path-shape test: the receipt directory is chosen from the environment, and a
	 * whitespace-only agent directory is no directory at all. Producer and consumer must
	 * trim it identically or they look for receipts in two different trees.
	 */
	test("a whitespace-only PI_CODING_AGENT_DIR puts the receipt under $HOME/.omp", () => {
		const { canonical } = repository();
		const home = mkdtempSync(join(tmpdir(), "delivery-land-home-"));
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest(
			{ pr: 470 },
			{ run, cwd: canonical, now: () => NOW, env: { PI_CODING_AGENT_DIR: "   ", HOME: home } },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receiptPath).toBe(join(home, ".omp", "receipts", outcome.receipt.repo.key, `${outcome.receipt.receiptId}.json`));
	});

	test("the remote-absence probe is asked in the directory this call was made from", () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const nested = join(canonical, "nested");
		mkdirSync(nested);
		const { run, calls } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		expect(calls.filter(call => call.argv.includes("ls-remote")).map(call => call.cwd)).toEqual([nested]);
	});

	/**
	 * An active ledger and no bead to reconcile is the pair the escalation exploited from
	 * the other side: cleanup would ask `bd` about an empty list and pass. A non-agent
	 * branch on a repository that tracks its work must name its bead or refuse.
	 */
	test("an active ledger with no derivable bead identity refuses before merging and writes nothing", () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const { run, calls } = runner({ prView: [completed(githubPr({ headRefName: "feature/no-bead" }))] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('beads.ids: observed no bead identity for branch "feature/no-bead"');
		expect(outcome.reason).toContain("an explicit beadId");
		expect(outcome.reason).toContain(realpathSync(canonical));
		expect(outcome.reason).toContain("no merge was issued and no receipt was written");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(readdirSync(receipts)).toEqual([]);
	});

	test("beadId names the bead a non-agent branch cannot", () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const { run } = runner({ prView: [completed(mergedGithubPr({ headRefName: "feature/no-bead" }))] }, canonical);
		const outcome = landPullRequest(
			{ pr: 470, beadId: "omp-plugins-9ej3.38" },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.38"], ledgerActive: true });
		expect(outcome.next).toEqual(["bd_reconcile", "delivery_cleanup"]);
	});

	test("a ledger-free repository needs no bead identity at all", () => {
		const { canonical, receipts } = repository();
		const { run } = runner({ prView: [completed(mergedGithubPr({ headRefName: "feature/no-bead" }))] }, canonical);
		const outcome = landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads).toEqual({ ids: [], ledgerActive: false });
		expect(outcome.next).toEqual(["delivery_cleanup"]);
	});

	test("a beadId that is not a bead id, or that contradicts the branch, refuses and merges nothing", () => {
		for (const beadId of ["-malicious", "bead id", "../escape", "a;b"]) {
			const { outcome, calls, files } = land({ prView: [completed(githubPr())] }, { beadId });
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("beadId: observed");
			expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
			expect(files()).toHaveLength(0);
		}

		const contradicted = land({ prView: [completed(githubPr())] }, { beadId: "omp-plugins-9ej3.99" });
		expect(contradicted.outcome.ok).toBe(false);
		if (contradicted.outcome.ok) throw new Error("expected a refusal");
		expect(contradicted.outcome.reason).toContain('expected "omp-plugins-9ej3.5" from branch');
		expect(contradicted.files()).toHaveLength(0);
	});
});

describe("branch and remote reading", () => {
	test("bead ids come from the agent branch convention and nowhere else", () => {
		expect(beadIdsFromBranch("omp/agent/omp-plugins-9ej3.5")).toEqual(["omp-plugins-9ej3.5"]);
		for (const branch of ["main", "omp/integration/omp-plugins-9ej3", "omp/agent/", "feature/omp/agent/x"]) {
			expect(beadIdsFromBranch(branch)).toEqual([]);
		}
	});

	test("the owner and name come from the remote path in each spelling git accepts", () => {
		expect(repoPathFromRemote("https://github.com/srobroek/omp-plugins.git")).toBe("srobroek/omp-plugins");
		expect(repoPathFromRemote("git@github.com:srobroek/omp-plugins.git")).toBe("srobroek/omp-plugins");
		expect(repoPathFromRemote("ssh://git@gitlab.com/group/sub/project")).toBe("group/sub/project");
		expect(repoPathFromRemote("https://github.com/")).toBeNull();
		expect(repoPathFromRemote("")).toBeNull();
	});
});
