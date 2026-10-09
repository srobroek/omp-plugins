import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import deliveryLandTool, { beadIdsFromBranch, type LandParams, landPullRequest, resolveLandingTarget } from "./delivery-land-tool.ts";
import { type AsyncCliRunner, type CliResult, runCliAsync } from "./forge-adapter.ts";
import { RECEIPT_SCHEMA, readReceipt, repoKey, writeReceipt } from "./landing-receipt.ts";

type Call = { argv: string[]; cwd: string | undefined; timeoutMs: number; env: Readonly<Record<string, string>> | undefined };

const MERGE_OID = "feedfacecafebabe0123456789abcdef01234567";
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";
const BASE_OID = "1111111111111111111111111111111111111111";
const REMOTE_URL = "https://github.com/srobroek/omp-plugins.git";
const BRANCH = "omp/agent/omp-plugins-9ej3.5";
const NOW = 1_764_000_000_000;
const TITLE = "fix(delivery): land the reviewed head";

/** The reviewed head a merging call must name; only an already-MERGED proof may omit it. */
const REVIEWED = { expectHeadSha: HEAD_OID } as const;

const completed = (stdout: string, exitCode = 0, stderr = ""): CliResult => ({ ok: true, exitCode, stdout, stderr });

/** A GitHub pull-request payload in `gh pr view --json` spelling. */
const githubPr = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({
		number: 470,
		url: "https://github.com/srobroek/omp-plugins/pull/470",
		title: TITLE,
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
		title: TITLE,
		state: "merged",
		target_branch: "main",
		source_branch: BRANCH,
		sha: HEAD_OID,
		merge_commit_sha: MERGE_OID,
		merged_at: "2026-09-21T20:00:00Z",
		...overrides,
	});

/** Every fixture directory this file creates, so a test can prove none outlives its test. */
const created: string[] = [];
/** The ones the running test created, removed once it ends. */
const pending: string[] = [];

function temporaryDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	created.push(path);
	pending.push(path);
	return path;
}

afterEach(() => {
	for (const path of pending.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A repository whose git reads answer from a real temporary directory.
 *
 * `repoKey` hashes the realpath of the git common directory, so the fixture
 * creates one: the receipt then carries a key that a reader could reproduce, and
 * `canonicalRoot` is the parent this landing was keyed from.
 */
function repository(): { canonical: string; receipts: string } {
	const canonical = temporaryDirectory("delivery-land-repo-");
	mkdirSync(join(canonical, ".git"));
	return { canonical, receipts: temporaryDirectory("delivery-land-receipts-") };
}

type Answers = {
	prView?: CliResult[];
	merge?: CliResult;
	autoDelete?: CliResult;
	policy?: CliResult;
	enable?: CliResult;
	lsRemote?: CliResult;
	parents?: string;
	remoteUrl?: string;
	/** What `git rev-parse --verify HEAD^{commit}` answers inside a supplied worktree. */
	worktreeHead?: CliResult;
};

/**
 * One runner for every child process the tool may start, recording each argv.
 *
 * Recording all of them in one place is what makes "no merge argv was issued" and
 * "no bd argv was issued" observations rather than assertions about intent. An
 * unexpected command fails loudly instead of returning a plausible default.
 */
function runner(answers: Answers, canonical: string): { run: AsyncCliRunner; calls: Call[] } {
	const views = [...(answers.prView ?? [])];
	const calls: Call[] = [];
	const run: AsyncCliRunner = (argv, options) => {
		calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
		const command = argv.join(" ");
		if (command.startsWith("git rev-parse --path-format=absolute --git-common-dir --show-toplevel")) {
			return completed(`${join(canonical, ".git")}\n${canonical}\n`);
		}
		if (argv[0] === "git" && argv[1] === "show" && argv[2] === "-s") return completed(`${answers.parents ?? BASE_OID}\n`);
		if (command === "git rev-parse --verify HEAD^{commit}") return answers.worktreeHead ?? completed(`${HEAD_OID}\n`);
		if (command.startsWith("git remote get-url")) return completed(`${answers.remoteUrl ?? REMOTE_URL}\n`);
		if (argv[1] === "pr" && argv[2] === "view") return views.shift() ?? completed(mergedGithubPr());
		if (argv[1] === "mr" && argv[2] === "view") return views.shift() ?? completed(gitlabMr());
		if (argv[1] === "api" && argv.includes(".allow_merge_commit")) return answers.policy ?? completed("true\n");
		if (argv[1] === "api" && argv.includes("-X")) return answers.enable ?? completed("{}\n");
		if (argv[1] === "api") return answers.autoDelete ?? completed("false\n");
		if (argv[1] === "pr" && argv[2] === "merge") return answers.merge ?? completed("");
		if (argv[1] === "mr" && argv[2] === "merge") return answers.merge ?? completed("");
		if (argv.includes("ls-remote")) return answers.lsRemote ?? { ok: true, exitCode: 2, stdout: "", stderr: "" };
		throw new Error(`the tool issued an unexpected command: ${command}`);
	};
	return { run, calls };
}
async function land(answers: Answers, params: Partial<LandParams> = {}, env: NodeJS.ProcessEnv = {}) {
	const { canonical, receipts } = repository();
	mkdirSync(join(canonical, ".beads"));
	const { run, calls } = runner(answers, canonical);
	const outcome = await landPullRequest({ pr: 470, ...params }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env });
	return { outcome, calls, receipts, canonical, files: () => readdirSync(receipts) };
}
function nativeNext(beadId: string, pr: number, mergeSha: string, receiptPath: string): string[] {
	return [
		`bd update ${beadId} --set-metadata pr=${pr} --set-metadata merge_sha=${mergeSha}`,
		`bd close ${beadId} --reason "PR #${pr} merged as ${mergeSha}; receipt ${receiptPath}"`,
		"delivery_cleanup",
	];
}

/** Whether a call reads or writes the deletion-on-merge repository setting. */
const settingsCall = (argv: string[]): boolean =>
	argv.some(part => part.includes("delete_branch_on_merge") || part.includes("remove_source_branch_after_merge"));

/** Run Git in a fixture repository with no user or system configuration and no hooks. */
function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(
		["git", "-c", "user.name=Delivery Test", "-c", "user.email=delivery@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
		{ cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" } },
	);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function commitFile(repo: string, file: string, content: string, message: string): void {
	writeFileSync(join(repo, file), content);
	git(repo, ["add", file]);
	git(repo, ["commit", "-q", "-m", message]);
}

/** Resolve once `file` exists, on the directory's change events rather than a polling clock. */
function appeared(file: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const settle = (): void => {
		if (!existsSync(file)) return;
		watcher.close();
		resolve();
	};
	const watcher = watch(dirname(file), settle);
	settle();
	return promise;
}

/** Eight numbered lines: room for a base edit near, but not touching, a reviewed hunk. */
const NUMBERED = ["1", "2", "3", "4", "5", "6", "7", "8"];
const numbered = (line: number, text: string): string => `${NUMBERED.map((value, index) => (index === line - 1 ? text : value)).join("\n")}\n`;

/**
 * A real repository holding a reviewed two-commit branch and its rebase-and-merge
 * landing. The base moved after review, so the landed commits are rewritten copies
 * with new SHAs and a different committer, as GitHub's rebase-and-merge always makes
 * them. `altered` changes the last landed patch, which no equivalence may accept.
 * `context-moved` has the base edit line 4 of a file whose line 6 the reviewed branch
 * edits: the rebase replays cleanly, but the landed hunk's context lines differ.
 */
function rebasedRepository(variant: "clean" | "altered" | "context-moved" = "clean"): { canonical: string; receipts: string; head: string; landed: string } {
	const moved = variant === "context-moved";
	const canonical = realpathSync(temporaryDirectory("delivery-land-rebase-"));
	git(canonical, ["init", "-q", "-b", "main"]);
	commitFile(canonical, "base.txt", moved ? numbered(0, "") : "base\n", "base");
	git(canonical, ["checkout", "-q", "-b", BRANCH]);
	commitFile(canonical, "one.txt", "one\n", "one");
	commitFile(canonical, "base.txt", moved ? numbered(6, "6, reviewed") : "base\ntwo\n", "two");
	const head = git(canonical, ["rev-parse", "HEAD"]);
	git(canonical, ["checkout", "-q", "main"]);
	if (moved) commitFile(canonical, "base.txt", numbered(4, "4, moved on the base"), "base moved");
	else commitFile(canonical, "other.txt", "other\n", "other");
	git(canonical, ["checkout", "-q", "-b", "landed", head]);
	git(canonical, ["-c", "user.name=Forge Rebase", "rebase", "-q", "main"]);
	if (variant === "altered") {
		writeFileSync(join(canonical, "base.txt"), "base\ntwo, altered\n");
		git(canonical, ["commit", "-q", "-a", "--amend", "--no-edit"]);
	}
	const landed = git(canonical, ["rev-parse", "HEAD"]);
	git(canonical, ["checkout", "-q", "main"]);
	return { canonical, receipts: temporaryDirectory("delivery-land-receipts-"), head, landed };
}

/** A commit's `git patch-id --stable` over Git's default three-line-context diff. */
function contextPatchId(repo: string, commit: string): string {
	const diff = Bun.spawnSync(["git", "diff-tree", "-p", "--no-color", commit], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	const id = Bun.spawnSync(["git", "patch-id", "--stable"], { cwd: repo, stdin: diff.stdout, stdout: "pipe", stderr: "pipe" });
	return id.stdout.toString().split(" ")[0] ?? "";
}

/**
 * Land a rebase against {@link rebasedRepository}: the forge reads are scripted and
 * every other Git read is answered by the real repository through the real runner —
 * the patch-id proof feeds Git on stdin — so it runs against real rewritten commits.
 */
async function landRebase(repo: { canonical: string; receipts: string; head: string; landed: string }) {
	const fixture = runner(
		{
			prView: [
				completed(githubPr({ headRefOid: repo.head })),
				completed(mergedGithubPr({ headRefOid: repo.head, mergeCommit: { oid: repo.landed } })),
			],
		},
		repo.canonical,
	);
	const run: AsyncCliRunner = (argv, options) => {
		if (argv[0] !== "git" || argv[1] === "remote" || argv.includes("ls-remote")) return fixture.run(argv, options);
		fixture.calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
		return runCliAsync(argv, options);
	};
	const outcome = await landPullRequest(
		{ pr: 470, merge_method: "rebase", expectHeadSha: repo.head },
		{ run, cwd: repo.canonical, now: () => NOW, receiptsDirectory: repo.receipts, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
	);
	return { outcome, calls: fixture.calls, files: () => readdirSync(repo.receipts) };
}

const merged = (argv: string[]): boolean => argv[2] === "merge";

describe("delivery_land", () => {
	test("a clean land emits one receipt whose fields are the forge reads", async () => {
		const { outcome, receipts, files, calls } = await land({
			prView: [completed(githubPr()), completed(mergedGithubPr())],
			lsRemote: { ok: true, exitCode: 2, stdout: "", stderr: "" },
		}, { ...REVIEWED, worktree: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5" });

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
		// The worktree is recorded only after its own HEAD was read and matched the PR head.
		expect(calls.filter(call => call.argv.join(" ") === "git rev-parse --verify HEAD^{commit}").map(call => call.cwd)).toEqual([
			"/tmp/worktrees/omp-agent-omp-plugins-9ej3.5",
		]);
		expect(receipt.proof.evidence).toMatchObject({ worktree: { path: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5", head: HEAD_OID } });
		expect(receipt.outcome).toBe("landed");
		expect(receipt.supersedes).toBeNull();
		expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath));
		expect(outcome.text).toContain("children before parents");
		expect(outcome.text.indexOf(`bd update omp-plugins-9ej3.5 --set-metadata pr=470 --set-metadata merge_sha=${MERGE_OID}`)).toBeLessThan(outcome.text.indexOf("delivery_cleanup"));

		// The file on disk is the object returned, and a reader accepts it.
		const reread = readReceipt(outcome.receiptPath);
		expect(reread.ok).toBe(true);
		if (!reread.ok) throw new Error(reread.reason);
		expect(reread.receipt).toEqual(receipt);
	});
	test("records the default squash method and one-parent proof", async () => {
		const { outcome } = await land({ prView: [completed(mergedGithubPr())] });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "squash", mergeShape: { parents: [BASE_OID], rebase: null } });
	});

	test("maps merge method and proves the reviewed head is the second parent", async () => {
		const { outcome, calls } = await land(
			{ prView: [completed(githubPr()), completed(mergedGithubPr())], parents: `${BASE_OID} ${HEAD_OID}`, policy: completed("true\n") },
			{ ...REVIEWED, merge_method: "merge" },
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		const merge = calls.find(call => merged(call.argv))?.argv;
		expect(merge).toContain("--merge");
		// The PR title is a squash subject only; a merge commit keeps the forge's message.
		expect(merge).not.toContain("--subject");
		expect(outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "merge", mergePolicy: true, mergeShape: { parents: [BASE_OID, HEAD_OID] } });
	});

	test("a rebase-and-merge landing with rewritten SHAs is proved by ordered patch-id equivalence", async () => {
		const repo = rebasedRepository();
		// Rewritten SHAs: the reviewed head is not reachable from what landed, which is the
		// precondition the old reviewed-head ancestry proof could never meet.
		expect(repo.landed).not.toBe(repo.head);
		const ancestry = Bun.spawnSync(["git", "merge-base", "--is-ancestor", repo.head, repo.landed], { cwd: repo.canonical });
		expect(ancestry.exitCode).toBe(1);

		const { outcome, calls, files } = await landRebase(repo);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(calls.find(call => merged(call.argv))?.argv).toContain("--rebase");
		expect(calls.filter(call => call.argv[1] === "patch-id").map(call => call.argv)).toEqual([
			["git", "patch-id", "--stable"],
			["git", "patch-id", "--stable"],
		]);
		const base = git(repo.canonical, ["merge-base", repo.head, repo.landed]);
		const landedBase = git(repo.canonical, ["rev-parse", `${repo.landed}~2`]);
		expect(outcome.receipt.proof.evidence).toMatchObject({
			mergeMethod: "rebase",
			mergeShape: {
				parents: [git(repo.canonical, ["rev-parse", `${repo.landed}^`])],
				rebase: { method: "patch-id", commits: 2, reviewed: `${base}..${repo.head}`, landed: `${landedBase}..${repo.landed}` },
			},
		});
		expect(outcome.receipt.pr.mergeCommitOid).toBe(repo.landed);
		expect(files()).toHaveLength(1);
	});

	test("a clean rebase whose landed hunk's context moved on the base is still proved", async () => {
		const repo = rebasedRepository("context-moved");
		// The base edit sits inside the reviewed hunk's default three context lines, so a
		// context-bearing patch id changes even though the reviewed change replayed as is.
		expect(contextPatchId(repo.canonical, repo.landed)).not.toBe(contextPatchId(repo.canonical, repo.head));
		expect(git(repo.canonical, ["show", `${repo.landed}:base.txt`])).toBe(numbered(4, "4, moved on the base").replace("6\n", "6, reviewed\n").trim());

		const { outcome, files } = await landRebase(repo);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "rebase", mergeShape: { rebase: { method: "patch-id", commits: 2 } } });
		expect(files()).toHaveLength(1);
	});

	test("a rebase landing whose patches differ from the reviewed commits refuses and writes nothing", async () => {
		const repo = rebasedRepository("altered");
		const { outcome, files } = await landRebase(repo);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("patch-id");
		expect(outcome.reason).toContain(repo.landed);
		expect(outcome.reason).toContain("no receipt was written");
		expect(files()).toHaveLength(0);
	});

	test("refuses merge method when repository policy disallows merge commits", async () => {
		const { outcome, calls, files } = await land(
			{ prView: [completed(githubPr())], policy: completed("false\n") },
			{ ...REVIEWED, merge_method: "merge" },
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("allow_merge_commit observed false");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(files()).toHaveLength(0);
	});

	test.each(["fast-forward", "MERGE", "", null, 1])("strictly refuses invalid merge_method %p", async merge_method => {
		const { outcome, calls } = await land({}, { merge_method: merge_method as string });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('expected one of "squash", "merge", "rebase"');
		expect(calls).toHaveLength(0);
	});

	test("a regular-file RETIRED marker makes the landing receipt ledger-inactive", async () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		writeFileSync(join(canonical, ".beads", "RETIRED"), "retired\n");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest(
			{ pr: 470, worktree: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5" },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.5"], ledgerActive: false });
		expect(outcome.next).toEqual(["delivery_cleanup"]);
		expect(outcome.text).not.toContain("bd update");
	});


	/**
	 * The inverse of what this file used to pin, and the security fix itself: the
	 * canonical root's verdict is the repository's verdict. A nested `.beads` under the
	 * directory the tool was called in does not get a vote, in either direction.
	 */
	test("a nested active ledger does not override a retired canonical root", async () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		writeFileSync(join(canonical, ".beads", "RETIRED"), "retired\n");
		const nested = join(canonical, "nested");
		mkdirSync(join(nested, ".beads"), { recursive: true });
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(false);
		expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(canonical), active: false } });
		expect(outcome.next).toEqual(["delivery_cleanup"]);
		expect(outcome.text).not.toContain("bd update");
	});

	test("a nested retired ledger does not deactivate an active canonical root", async () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const nested = join(canonical, "nested");
		mkdirSync(join(nested, ".beads"), { recursive: true });
		writeFileSync(join(nested, ".beads", "RETIRED"), "retired\n");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
		expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(canonical), active: true } });
		expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath));
		expect(outcome.text).toContain(`bd close omp-plugins-9ej3.5 --reason "PR #470 merged as ${MERGE_OID}; receipt ${outcome.receiptPath}"`);
	});

	test("a symlinked RETIRED marker does not deactivate the ledger", async () => {
		const { canonical, receipts } = repository();
		const beads = join(canonical, ".beads");
		mkdirSync(beads);
		const target = join(canonical, "retired-target");
		writeFileSync(target, "retired\n");
		symlinkSync(target, join(beads, "RETIRED"));
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
		expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath));
	});

	test("a dangling .beads path keeps the ledger active", async () => {
		const { canonical, receipts } = repository();
		symlinkSync(join(canonical, "missing-beads"), join(canonical, ".beads"));
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
	});

	test("a non-directory .beads path keeps the ledger active", async () => {
		const { canonical, receipts } = repository();
		writeFileSync(join(canonical, ".beads"), "not a directory\n");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads.ledgerActive).toBe(true);
	});

	test("the result text lists native child-before-parent closeout commands before delivery_cleanup", async () => {
		const { outcome } = await land({ prView: [completed(mergedGithubPr())] });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		const update = `bd update omp-plugins-9ej3.5 --set-metadata pr=470 --set-metadata merge_sha=${MERGE_OID}`;
		const close = `bd close omp-plugins-9ej3.5 --reason "PR #470 merged as ${MERGE_OID}; receipt ${outcome.receiptPath}"`;
		expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath));
		expect(outcome.text).toContain("children before parents");
		expect(outcome.text.indexOf(update)).toBeGreaterThan(-1);
		expect(outcome.text.indexOf(update)).toBeLessThan(outcome.text.indexOf(close));
		expect(outcome.text.indexOf(close)).toBeLessThan(outcome.text.indexOf("delivery_cleanup"));
	});

	test("an already MERGED pull request is proved, not merged again", async () => {
		const { outcome, calls, files } = await land({ prView: [completed(mergedGithubPr())] });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.outcome).toBe("landed");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(calls.filter(call => call.argv[1] === "pr" && call.argv[2] === "view")).toHaveLength(1);
		expect(outcome.receipt.proof.evidence).toMatchObject({ merge: null, reread: null });
		expect(outcome.receipt.notes).toContain("already MERGED");
		expect(files()).toHaveLength(1);
	});

	test("a GitLab merge request is read in its own dialect", async () => {
		const { canonical, receipts } = repository();
		const { run } = runner({ remoteUrl: "git@gitlab.com:group/project.git", prView: [completed(gitlabMr())] }, canonical);
		const outcome = await landPullRequest({ pr: "12" }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.repo.forge).toBe("gitlab");
		expect(outcome.receipt.pr.number).toBe(12);
		expect(outcome.receipt.pr.state).toBe("merged");
		expect(outcome.receipt.pr.mergeCommitOid).toBe(MERGE_OID);
	});

	test("an expectHeadSha mismatch refuses, names both shas, and merges nothing", async () => {
		const { outcome, calls, files } = await land({ prView: [completed(githubPr())] }, { expectHeadSha: "ffffffffffffffffffffffffffffffffffffffff" });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain(HEAD_OID);
		expect(outcome.reason).toContain("ffffffffffffffffffffffffffffffffffffffff");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(files()).toHaveLength(0);
	});

	test("a re-read that is not MERGED refuses, names the observed state and oid, and writes nothing", async () => {
		const { outcome, calls, files } = await land({
			prView: [completed(githubPr()), completed(githubPr({ state: "OPEN" }))],
		}, REVIEWED);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('pr.state "OPEN"');
		expect(outcome.reason).toContain("pr.mergeCommitOid null");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(1);
		expect(files()).toHaveLength(0);
	});

	test("a MERGED re-read with no merge commit oid is not proof", async () => {
		const { outcome, files } = await land({ prView: [completed(githubPr()), completed(githubPr({ state: "MERGED" }))] }, REVIEWED);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.mergeCommitOid null");
		expect(files()).toHaveLength(0);
	});

	test("a failed merge refuses with the observed exit status and writes nothing", async () => {
		const { outcome, files } = await land({
			prView: [completed(githubPr())],
			merge: completed("", 1, "Pull request is not mergeable"),
		}, REVIEWED);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("observed exit 1");
		expect(outcome.reason).toContain("Pull request is not mergeable");
		expect(files()).toHaveLength(0);
	});

	test("a failed pull-request read and a failed merge describe the failure in one spelling", async () => {
		const view = ["gh", "pr", "view", "470", "--repo", "github.com/srobroek/omp-plugins", "--json", "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,title"].join(" ");
		const merge = `gh pr merge 470 --squash --subject ${TITLE} --delete-branch --repo github.com/srobroek/omp-plugins --match-head-commit ${HEAD_OID}`;
		const cases: Array<[Answers, string]> = [
			[{ prView: [completed("", 4, "  HTTP 401: Bad credentials \n")] }, `${view}: observed exit 4, expected exit 0; stderr: HTTP 401: Bad credentials`],
			[{ prView: [{ ok: false, exitCode: null, stdout: "", stderr: "", error: "gh produced no exit status within 30000ms" }] }, `${view}: observed gh produced no exit status within 30000ms, expected exit 0`],
			[{ prView: [completed(githubPr())], merge: completed("", 1, "Pull request is not mergeable") }, `${merge}: observed exit 1, expected exit 0; stderr: Pull request is not mergeable; no receipt was written`],
			[{ prView: [completed(githubPr())], merge: { ok: true, exitCode: null, stdout: "", stderr: "" } }, `${merge}: observed no exit status, expected exit 0; no receipt was written`],
		];
		for (const [answers, reason] of cases) {
			const { outcome } = await land(answers, REVIEWED);
			expect(outcome.ok ? null : outcome.reason).toBe(reason);
		}
	});

	test("an unknown remote-absence verdict leaves deletedRemote false and the timestamp null", async () => {
		const { outcome } = await land({
			prView: [completed(mergedGithubPr())],
			lsRemote: { ok: false, exitCode: null, stdout: "", stderr: "", error: "git was terminated by SIGTERM (timeout 10000ms)" },
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.branch.deletedRemote).toBe(false);
		expect(outcome.receipt.branch.remoteAbsenceVerifiedAt).toBeNull();
		expect(outcome.receipt.notes).toContain("unknown");
	});

	test("a remote branch still present is not recorded as deleted", async () => {
		const { outcome } = await land({
			prView: [completed(mergedGithubPr())],
			lsRemote: completed(`${HEAD_OID}\trefs/heads/${BRANCH}\n`),
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.branch.deletedRemote).toBe(false);
		expect(outcome.receipt.branch.remoteAbsenceVerifiedAt).toBeNull();
		expect(outcome.receipt.proof.evidence).toMatchObject({ remoteBranch: { verdict: "present" } });
	});

	test("setupAutoDelete absent or false issues no repository-setting write", async () => {
		for (const setupAutoDelete of [undefined, false] as const) {
			const { outcome, calls } = await land({ prView: [completed(mergedGithubPr())] }, { setupAutoDelete });
			expect(outcome.ok).toBe(true);
			expect(calls.filter(call => call.argv.includes("-X") || call.argv.includes("PATCH") || call.argv.includes("PUT"))).toHaveLength(0);
			if (!outcome.ok) throw new Error(outcome.reason);
			expect(outcome.receipt.notes).toContain("no repository setting was written");
		}
	});

	test("setupAutoDelete true writes the setting once and records the outcome in the notes", async () => {
		const { outcome, calls } = await land({ prView: [completed(mergedGithubPr())], autoDelete: completed("false\n") }, { setupAutoDelete: true });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		const writes = calls.filter(call => call.argv.includes("-X"));
		expect(writes).toHaveLength(1);
		expect(writes[0]?.argv).toEqual(["gh", "api", "-X", "PATCH", "repos/srobroek/omp-plugins", "-F", "delete_branch_on_merge=true"]);
		expect(outcome.receipt.notes).toContain("the forge accepted");
		// Acceptance is not a re-read, so the recorded setting stays the observed one.
		expect(outcome.receipt.branch.autoDeleteSetting).toBe("off");
	});

	test("a refused setting write is recorded and does not fail the landing", async () => {
		const { outcome } = await land(
			{ prView: [completed(mergedGithubPr())], enable: completed("", 1, "HTTP 403") },
			{ setupAutoDelete: true },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.notes).toContain("refused");
		expect(outcome.receipt.branch.autoDeleteSetting).toBe("off");
	});

	test("an unreadable auto-delete setting stays unknown", async () => {
		const { outcome } = await land({ prView: [completed(mergedGithubPr())], autoDelete: completed("", 1, "HTTP 404") });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.branch.autoDeleteSetting).toBe("unknown");
	});

	test("a receipt the validator refuses names the validator's field and writes no file", async () => {
		const { outcome, files } = await land({ prView: [completed(mergedGithubPr({ url: "" }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.url");
		expect(outcome.reason).toContain("no file was written");
		expect(files()).toHaveLength(0);
	});

	test("no path issues a bd argv", async () => {
		const cases: Array<[Answers, Partial<LandParams>]> = [
			[{ prView: [completed(githubPr()), completed(mergedGithubPr())] }, REVIEWED],
			[{ prView: [completed(mergedGithubPr())] }, { setupAutoDelete: true }],
			[{ prView: [completed(githubPr())] }, { expectHeadSha: "deadbeef" }],
			[{ prView: [completed(githubPr())] }, {}],
			[{ prView: [completed(githubPr()), completed(githubPr())] }, REVIEWED],
		];
		for (const [answers, params] of cases) {
			const { calls } = await land(answers, params);
			expect(calls.filter(call => call.argv[0] === "bd")).toHaveLength(0);
		}
	});

	test("a pull request number that is not a positive integer never reaches a command", async () => {
		for (const pr of ["--repo", "0", "-1", "", "12x"]) {
			const { outcome, calls } = await land({}, { pr });
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("expected a positive integer");
			expect(calls).toHaveLength(0);
		}
	});

	test("a remote whose URL names no adapter refuses without reading the pull request", async () => {
		const { outcome, calls } = await land({ remoteUrl: "https://bitbucket.org/team/repo.git", prView: [completed(mergedGithubPr())] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('repo.forge: observed "unknown"');
		expect(calls.filter(call => call.argv[0] === "gh")).toHaveLength(0);
	});

	test("a pull-request payload missing a required field refuses by field name", async () => {
		const { outcome, files } = await land({ prView: [completed(JSON.stringify({ number: 470, state: "MERGED" }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.url: observed absent");
		expect(files()).toHaveLength(0);
	});

	test("a polluted Object.prototype cannot supply a merge state the forge never sent", async () => {
		// The defect this pins: a plain `payload.state` read consults the prototype
		// chain, so one polluting dependency anywhere in the session would let an open
		// pull request read as MERGED and emit a receipt claiming it landed.
		for (const [key, value] of [["state", "MERGED"], ["mergeCommit", { oid: MERGE_OID }]] as const) {
			Object.defineProperty(Object.prototype, key, { value, configurable: true, enumerable: false, writable: true });
		}
		try {
			expect("state" in {}).toBe(true);
			const { outcome, calls, files } = await land({
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

	test("the merge argv binds the repository, the first observed head, and the title as squash subject", async () => {
		const { outcome, calls } = await land({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, REVIEWED);

		expect(outcome.ok).toBe(true);
		const merges = calls.filter(call => merged(call.argv));
		expect(merges).toHaveLength(1);
		expect(merges[0]?.argv).toEqual([
			"gh",
			"pr",
			"merge",
			"470",
			"--squash",
			"--subject",
			TITLE,
			"--delete-branch",
			"--repo",
			"github.com/srobroek/omp-plugins",
			"--match-head-commit",
			HEAD_OID,
		]);
		expect(calls.filter(call => call.argv[1] === "pr" && call.argv[2] === "view").map(call => call.argv)).toEqual([
			["gh", "pr", "view", "470", "--repo", "github.com/srobroek/omp-plugins", "--json", "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,title"],
			["gh", "pr", "view", "470", "--repo", "github.com/srobroek/omp-plugins", "--json", "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,title"],
		]);
		if (!outcome.ok) throw new Error(outcome.reason);
		// The receipt records the unqualified identity: the host belongs to the command
		// that was issued, not to the repository the landing is about.
		expect(outcome.receipt.proof.evidence).toMatchObject({ boundRepo: "srobroek/omp-plugins", merge: { boundHead: HEAD_OID } });
	});

	test("a canonical GitHub repo prefix and a pinned GH_HOST defeat a configured host alias", async () => {
		const { outcome, calls } = await land(
			{ prView: [completed(githubPr()), completed(mergedGithubPr())] },
			{ ...REVIEWED, setupAutoDelete: true },
			{ GH_HOST: "evil.example", GH_REPO: "attacker/elsewhere", GH_TOKEN: "keep-gh", PATH: "/usr/bin" },
		);

		expect(outcome.ok).toBe(true);
		const ghCalls = calls.filter(call => call.argv[0] === "gh");
		expect(ghCalls.length).toBeGreaterThan(3);
		for (const call of ghCalls) {
			// Replaced by the verified host, not merely stripped: an absent GH_HOST still
			// lets `gh` fall back to a host from its own configuration.
			expect(call.env?.GH_HOST).toBe("github.com");
			expect(call.env?.GH_REPO).toBeUndefined();
			expect(call.env?.GH_TOKEN).toBe("keep-gh");
			const repoIndex = call.argv.indexOf("--repo");
			if (repoIndex >= 0) expect(call.argv[repoIndex + 1]).toBe("github.com/srobroek/omp-plugins");
		}
		// The settings reads address the repository in the request path, where the host
		// is the adapter's to add, so they carry the unqualified path.
		for (const call of ghCalls.filter(call => call.argv[1] === "api")) {
			expect(call.argv.some(part => part.includes("repos/srobroek/omp-plugins"))).toBe(true);
		}
	});

	test("an alternate SSH transport host still addresses the canonical API host", async () => {
		const { canonical, receipts } = repository();
		const { run, calls } = runner(
			{
				remoteUrl: "ssh://git@ssh.github.com:443/srobroek/omp-plugins.git",
				prView: [completed(githubPr()), completed(mergedGithubPr())],
			},
			canonical,
		);
		const outcome = await landPullRequest({ pr: 470, ...REVIEWED }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		for (const call of calls.filter(call => call.argv[0] === "gh" && call.argv.includes("--repo"))) {
			expect(call.argv[call.argv.indexOf("--repo") + 1]).toBe("github.com/srobroek/omp-plugins");
			expect(call.env?.GH_HOST).toBe("github.com");
		}
	});

	test("a GitLab merge binds the repository and the head in glab's spelling", async () => {
		const { canonical, receipts } = repository();
		const { run, calls } = runner(
			{ remoteUrl: "ssh://git@altssh.gitlab.com:443/group/sub/project.git", prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())] },
			canonical,
		);
		const outcome = await landPullRequest({ pr: 12, ...REVIEWED }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		expect(calls.filter(call => merged(call.argv))[0]?.argv).toEqual([
			"glab",
			"mr",
			"merge",
			"12",
			"--squash",
			"--squash-message",
			TITLE,
			"--remove-source-branch",
			"--repo",
			"gitlab.com/group/sub/project",
			"--sha",
			HEAD_OID,
		]);
		expect(calls.filter(call => call.argv[1] === "mr" && call.argv[2] === "view").map(call => call.argv)).toEqual([
			["glab", "mr", "view", "12", "--repo", "gitlab.com/group/sub/project", "--output", "json"],
			["glab", "mr", "view", "12", "--repo", "gitlab.com/group/sub/project", "--output", "json"],
		]);
	});

	test("a canonical GitLab repo prefix defeats a configured dotless host alias", async () => {
		const { canonical, receipts } = repository();
		const fixture = runner(
			{
				remoteUrl: "git@gitlab.com:corp/group/project.git",
				prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())],
			},
			canonical,
		);
		const run: AsyncCliRunner = (argv, options) => {
			const repoIndex = argv.indexOf("--repo");
			if (argv[0] === "glab" && repoIndex >= 0 && argv[repoIndex + 1] === "corp/group/project") {
				// Model glab treating the first path segment as a configured host alias.
				fixture.calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
				return completed(gitlabMr({ iid: 999 }));
			}
			return fixture.run(argv, options);
		};
		const outcome = await landPullRequest(
			{ pr: 12, ...REVIEWED },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.repo.nameWithOwner).toBe("corp/group/project");
		expect(
			fixture.calls
				.filter(call => call.argv[0] === "glab" && call.argv.includes("--repo"))
				.map(call => call.argv[call.argv.indexOf("--repo") + 1]),
		).toEqual([
			"gitlab.com/corp/group/project",
			"gitlab.com/corp/group/project",
			"gitlab.com/corp/group/project",
		]);
	});

	test("a structurally malformed identity refuses before an unreadable remote", async () => {
		for (const repo of ["https://github.com/owner/repo", "owner", "owner//repo", "owner/../repo"]) {
			const { canonical } = repository();
			const calls: Call[] = [];
			const run: AsyncCliRunner = (argv, options) => {
				calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
				return { ok: false, exitCode: null, stdout: "", stderr: "", error: "the remote is unreadable" };
			};
			const outcome = await landPullRequest({ pr: 470, repo }, { run, cwd: canonical, now: () => NOW, env: {} });

			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("repo: observed");
			expect(calls).toHaveLength(0);
		}
	});

	test("a host-qualified GitHub remote path cannot become --repo when params.repo is absent", async () => {
		const { outcome, calls } = await land({ remoteUrl: "https://github.com/github.com/owner/repo.git" });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("repo: observed");
		expect(calls.filter(call => call.argv[0] === "gh")).toHaveLength(0);
	});

	/**
	 * `URL` deletes embedded tabs and newlines before parsing, so each of these would
	 * classify as an ordinary GitHub remote once the output was trimmed — and this
	 * identity binds the merge argv, so agreeing with the wrong parser here merges
	 * somewhere nobody named. The output is therefore read as exactly one record.
	 *
	 * The refusal quotes none of it. Output no parser accepted cannot be redacted, since
	 * a redactor can only find a secret in a spelling it understands, so the cases with
	 * userinfo and a token query must leave neither the token nor its URL in the reason
	 * or in any receipt — and there is no receipt, because nothing was written.
	 */
	test("git remote get-url output that is not exactly one record merges nothing", async () => {
		for (const remoteUrl of [
			"https://git\thub.com/srobroek/omp-plugins.git",
			"https://github.com/srobroek/omp-plugins.git\n@evil.example/x",
			"https://github.com/srobroek/omp-plugins.git\nhttps://evil.example/o/r.git",
			" https://github.com/srobroek/omp-plugins.git",
			"https://github.com/srobroek/omp-plugins.git ",
			"",
			"https://srobroek:ghp_secrettoken@git\thub.com/srobroek/omp-plugins.git",
			"https://github.com/srobroek/omp-plugins.git?token=ghp_secrettoken\nhttps://evil.example/x",
			" ssh://git:ghp_secrettoken@github.com/srobroek/omp-plugins.git",
		]) {
			const { outcome, calls, files } = await land({ remoteUrl, prView: [completed(githubPr())] });

			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("git remote get-url origin: observed malformed Git remote output");
			expect(outcome.reason).toContain("exactly one URL record");
			expect(outcome.reason).not.toContain("ghp_secrettoken");
			expect(outcome.reason).not.toContain("github.com/srobroek");
			expect(outcome.reason).not.toContain("evil.example");
			// Before any forge command, so nothing was read, merged, or written.
			expect(calls.filter(call => call.argv[0] === "gh")).toHaveLength(0);
			expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
			expect(files()).toHaveLength(0);
		}
	});

	test("ambient Git selectors cannot redirect repository identity or landing proof", async () => {
		const { canonical, receipts } = repository();
		const attacker = repository();
		const ambient = {
			GIT_DIR: join(attacker.canonical, ".git"),
			GIT_WORK_TREE: attacker.canonical,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "remote.origin.url",
			GIT_CONFIG_VALUE_0: "https://github.com/attacker/elsewhere.git",
			PATH: "/usr/bin",
		};
		const fixture = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const run: AsyncCliRunner = (argv, options) => {
			const effectiveEnv = options.env ?? ambient;
			const redirected = argv[0] === "git" && Object.keys(effectiveEnv).some(key => key === "GIT_DIR" || key === "GIT_WORK_TREE" || key.startsWith("GIT_CONFIG_"));
			if (!redirected) return fixture.run(argv, options);
			fixture.calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
			if (argv.includes("--show-toplevel")) return completed(`${join(attacker.canonical, ".git")}\n${attacker.canonical}\n`);
			if (argv.includes("get-url")) return completed("https://github.com/attacker/elsewhere.git\n");
			return completed(`${HEAD_OID}\trefs/heads/${BRANCH}\n`);
		};
		const outcome = await landPullRequest(
			{ pr: 470 },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: ambient },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.repo.canonicalRoot).toBe(realpathSync(canonical));
		expect(outcome.receipt.repo.nameWithOwner).toBe("srobroek/omp-plugins");
		expect(outcome.receipt.branch.deletedRemote).toBe(true);
	});

	test("a head that moved between the merge and the re-read refuses and writes nothing", async () => {
		const moved = "9999999999999999999999999999999999999999";
		const { outcome, files } = await land({
			prView: [completed(githubPr()), completed(mergedGithubPr({ headRefOid: moved }))],
		}, REVIEWED);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain(moved);
		expect(outcome.reason).toContain(HEAD_OID);
		expect(outcome.reason).toContain("the head moved");
		expect(files()).toHaveLength(0);
	});

	test("a pull request re-targeted between the reads refuses and writes nothing", async () => {
		const { outcome, files } = await land({
			prView: [completed(githubPr()), completed(mergedGithubPr({ baseRefName: "main" }))],
		}, REVIEWED);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("re-targeted");
		expect(outcome.reason).toContain("omp/integration/omp-plugins-9ej3");
		expect(files()).toHaveLength(0);
	});

	test("a payload for another pull request refuses before merging", async () => {
		const { outcome, calls, files } = await land({ prView: [completed(githubPr({ number: 999 }))] });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("observed pr.number 999, expected 470");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(files()).toHaveLength(0);
	});

	test("a re-read for another pull request refuses and writes nothing", async () => {
		const { outcome, files } = await land({ prView: [completed(githubPr()), completed(mergedGithubPr({ number: 999 }))] }, REVIEWED);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("observed pr.number 999, expected 470");
		expect(files()).toHaveLength(0);
	});

	test("a head that is not a whole object id cannot bind a merge, so none is issued", async () => {
		const { outcome, calls, files } = await land({ prView: [completed(githubPr({ headRefOid: "0123456" }))] }, { expectHeadSha: "0123456" });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("pr.headRefOid: observed \"0123456\"");
		expect(outcome.reason).toContain("no merge was issued");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(files()).toHaveLength(0);
	});

	test("ambient repository and host variables reach no forge command, on either forge", async () => {
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

		const github = await land({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, { ...REVIEWED, setupAutoDelete: true }, ambient);
		expect(github.outcome.ok).toBe(true);

		const { canonical, receipts } = repository();
		const { run, calls: gitlabCalls } = runner(
			{
				remoteUrl: "git@gitlab.com:group/project.git",
				prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())],
			},
			canonical,
		);
		const gitlab = await landPullRequest(
			{ pr: 12, ...REVIEWED, setupAutoDelete: true },
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
				const glabCall = cli === "glab";
				const pinnedGitLabApi = glabCall && call.argv[1] === "api";
				// Each CLI's own host variable is not stripped but overwritten with the host
				// `forgeTarget` verified: absent, a CLI still reads a default host from its
				// own configuration. Every other redirector, including the other forge's,
				// is gone.
				const pinned = glabCall ? ["GITLAB_HOST", "GITLAB_API_HOST"] : ["GH_HOST"];
				const canonicalHost = glabCall ? "gitlab.com" : "github.com";
				for (const key of Object.keys(redirectors)) {
					if (pinned.includes(key)) {
						expect(call.env?.[key]).toBe(canonicalHost);
					} else {
						expect(call.env?.[key]).toBeUndefined();
					}
				}
				if (pinnedGitLabApi) {
					const hostname = call.argv.indexOf("--hostname");
					expect(hostname).toBeGreaterThan(0);
					expect(call.argv[hostname + 1]).toBe("gitlab.com");
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

	test("an unreadable repository refuses before any forge call", async () => {
		const { canonical } = repository();
		const calls: Call[] = [];
		const run: AsyncCliRunner = (argv, options) => {
			calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
			return { ok: false, exitCode: null, stdout: "", stderr: "", error: "spawn git ENOENT" };
		};
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, env: {} });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("git rev-parse --path-format=absolute --git-common-dir --show-toplevel");
		expect(calls).toHaveLength(1);
	});

	test("the receipt directory defaults under the agent directory, never into the checkout", async () => {
		const { canonical } = repository();
		const agentDir = temporaryDirectory("delivery-land-agent-");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receiptPath.startsWith(join(agentDir, "receipts", outcome.receipt.repo.key))).toBe(true);
		expect(existsSync(join(canonical, "receipts"))).toBe(false);
		expect(JSON.parse(readFileSync(outcome.receiptPath, "utf8")).receiptId).toBe(outcome.receipt.receiptId);
	});

	test("a repo override that the merge argv could not honour refuses before reading", async () => {
		const { outcome, calls } = await land({ prView: [completed(mergedGithubPr())] }, { repo: "someone-else/fork" });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('"someone-else/fork"');
		expect(outcome.reason).toContain('"srobroek/omp-plugins"');
		expect(calls.filter(call => call.argv[0] === "gh")).toHaveLength(0);
	});

	test("a repo override that agrees with the remote is accepted", async () => {
		const { outcome } = await land({ prView: [completed(mergedGithubPr())] }, { repo: "srobroek/omp-plugins" });
		expect(outcome.ok).toBe(true);
	});

	test("a credential in the remote URL is not copied into the receipt", async () => {
		const { outcome } = await land({ remoteUrl: "https://sjors:ghp_secrettoken@github.com/srobroek/omp-plugins.git", prView: [completed(mergedGithubPr())] });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.repo.remote).toBe("origin");
		expect(outcome.receipt.proof.evidence).toMatchObject({ remoteUrl: "https://github.com/srobroek/omp-plugins.git" });
		expect(outcome.receipt.repo.nameWithOwner).toBe("srobroek/omp-plugins");
		expect(JSON.stringify(outcome.receipt)).not.toContain("ghp_secrettoken");
	});

	test("a configured upstream remote name is recorded and reused, never hardcoded to origin", async () => {
		const { outcome, calls } = await land(
			{ prView: [completed(mergedGithubPr())] },
			{ remote: "upstream" },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.repo.remote).toBe("upstream");
		expect(outcome.receipt.proof.evidence).toMatchObject({ remote: "upstream" });
		expect(calls.find(call => call.argv[1] === "remote")?.argv).toEqual(["git", "remote", "get-url", "upstream"]);
		const absence = calls.find(call => call.argv.includes("ls-remote"));
		expect(absence?.argv).toContain("upstream");
		expect(absence?.argv).not.toContain("origin");
	});

	/**
	 * The exact object a real land emits, key by key against decision omp-plugins-9ej3.1
	 * section 2 as amended by omp-plugins-9ej3.45. Two packages read this shape, so the
	 * assertion is the whole object and the whole top-level key set: a field added,
	 * renamed or dropped here is a contract change and must fail a test, not a consumer.
	 */
	test("a real land emits exactly the amended v1 receipt object", async () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const { run } = runner({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest(
			{ pr: 470, ...REVIEWED, worktree: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5" },
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
		expect(receipt.emitter).toEqual({ plugin: "@srobroek/delivery", version: pkg.version, tool: "delivery_land" });
		expect(receipt.repo).toEqual({
			key,
			canonicalRoot: realpathSync(canonical),
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
		const written = writeReceipt(forward, temporaryDirectory("delivery-land-forward-"));
		expect(readReceipt(written)).toEqual({ ok: true, receipt: forward });
	});

	/**
	 * Not a path-shape test: the receipt directory is chosen from the environment, and a
	 * whitespace-only agent directory is no directory at all. Producer and consumer must
	 * trim it identically or they look for receipts in two different trees.
	 */
	test("a whitespace-only PI_CODING_AGENT_DIR puts the receipt under $HOME/.omp", async () => {
		const { canonical } = repository();
		const home = temporaryDirectory("delivery-land-home-");
		const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest(
			{ pr: 470 },
			{ run, cwd: canonical, now: () => NOW, env: { PI_CODING_AGENT_DIR: "   ", HOME: home } },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receiptPath).toBe(join(home, ".omp", "receipts", outcome.receipt.repo.key, `${outcome.receipt.receiptId}.json`));
	});

	test("the remote-absence probe is asked in the directory this call was made from", async () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const nested = join(canonical, "nested");
		mkdirSync(nested);
		const { run, calls } = runner({ prView: [completed(mergedGithubPr())] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		expect(calls.filter(call => call.argv.includes("ls-remote")).map(call => call.cwd)).toEqual([nested]);
	});

	/**
	 * An active ledger and no bead to reconcile is the pair the escalation exploited from
	 * the other side: cleanup would ask `bd` about an empty list and pass. A non-agent
	 * branch on a repository that tracks its work must name its bead or refuse.
	 */
	test("an active ledger with no derivable bead identity refuses before merging and writes nothing", async () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const { run, calls } = runner({ prView: [completed(githubPr({ headRefName: "feature/no-bead" }))] }, canonical);
		const outcome = await landPullRequest({ pr: 470, ...REVIEWED }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain('beads.ids: observed no bead identity for branch "feature/no-bead"');
		expect(outcome.reason).toContain("an explicit beadId");
		expect(outcome.reason).toContain(realpathSync(canonical));
		expect(outcome.reason).toContain("no merge was issued and no receipt was written");
		expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(readdirSync(receipts)).toEqual([]);
	});

	test("beadId names the bead a non-agent branch cannot", async () => {
		const { canonical, receipts } = repository();
		mkdirSync(join(canonical, ".beads"));
		const { run } = runner({ prView: [completed(mergedGithubPr({ headRefName: "feature/no-bead" }))] }, canonical);
		const outcome = await landPullRequest(
			{ pr: 470, beadId: "omp-plugins-9ej3.38" },
			{ run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.38"], ledgerActive: true });
		expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.38", 470, MERGE_OID, outcome.receiptPath));
	});

	test("a ledger-free repository needs no bead identity at all", async () => {
		const { canonical, receipts } = repository();
		const { run } = runner({ prView: [completed(mergedGithubPr({ headRefName: "feature/no-bead" }))] }, canonical);
		const outcome = await landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.receipt.beads).toEqual({ ids: [], ledgerActive: false });
		expect(outcome.next).toEqual(["delivery_cleanup"]);
	});

	test("a beadId that is not a bead id, or that contradicts the branch, refuses and merges nothing", async () => {
		for (const beadId of ["-malicious", "bead id", "../escape", "a;b"]) {
			const { outcome, calls, files } = await land({ prView: [completed(githubPr())] }, { ...REVIEWED, beadId });
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("beadId: observed");
			expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
			expect(files()).toHaveLength(0);
		}

		const contradicted = await land({ prView: [completed(githubPr())] }, { ...REVIEWED, beadId: "omp-plugins-9ej3.99" });
		expect(contradicted.outcome.ok).toBe(false);
		if (contradicted.outcome.ok) throw new Error("expected a refusal");
		expect(contradicted.outcome.reason).toContain('expected "omp-plugins-9ej3.5" from branch');
		expect(contradicted.files()).toHaveLength(0);
	});

	/**
	 * The per-user store `~/.beads` sits above every repository under $HOME. It is not
	 * this repository's ledger, so it must neither mark the landing ledger-backed nor
	 * demand a bead for a branch that names none.
	 */
	test("a ledger-free repository below an ancestor .beads lands without a beadId", async () => {
		const outer = realpathSync(temporaryDirectory("delivery-land-home-"));
		mkdirSync(join(outer, ".beads"));
		const canonical = join(outer, "repo");
		mkdirSync(join(canonical, ".git"), { recursive: true });
		const receipts = temporaryDirectory("delivery-land-receipts-");
		const { run, calls } = runner(
			{ prView: [completed(githubPr({ headRefName: "feature/no-bead" })), completed(mergedGithubPr({ headRefName: "feature/no-bead" }))] },
			canonical,
		);
		const outcome = await landPullRequest({ pr: 470, ...REVIEWED }, { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(calls.filter(call => merged(call.argv))).toHaveLength(1);
		expect(outcome.receipt.beads).toEqual({ ids: [], ledgerActive: false });
		expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: canonical, active: false } });
		expect(outcome.next).toEqual(["delivery_cleanup"]);
	});

	/**
	 * The recorded worktree is what `delivery_cleanup` later removes, so it must be the
	 * checkout holding the landed head. A path at another head — the release-please
	 * landing that recorded an unrelated feature worktree — would hand cleanup a target
	 * nobody landed. The check also covers an already-MERGED proof, which records the
	 * worktree just the same.
	 */
	test("a worktree that does not hold the pull request head refuses before any forge mutation", async () => {
		const elsewhere = "9".repeat(40);
		const cases: Array<[string, Answers, Partial<LandParams>]> = [
			["another head", { prView: [completed(githubPr())], worktreeHead: completed(`${elsewhere}\n`) }, REVIEWED],
			["not a checkout", { prView: [completed(githubPr())], worktreeHead: completed("", 128, "fatal: not a git repository") }, REVIEWED],
			["already merged, another head", { prView: [completed(mergedGithubPr())], worktreeHead: completed(`${elsewhere}\n`) }, {}],
		];
		for (const [label, answers, params] of cases) {
			const { outcome, calls, files } = await land(answers, { ...params, worktree: "/tmp/worktrees/elsewhere", setupAutoDelete: true });
			if (outcome.ok) throw new Error(`${label}: expected a refusal`);
			expect(outcome.reason).toContain("worktree");
			expect(outcome.reason).toContain("/tmp/worktrees/elsewhere");
			expect(outcome.reason).toContain(HEAD_OID);
			if (label.includes("another head")) expect(outcome.reason).toContain(elsewhere);
			expect(calls.filter(call => call.argv.join(" ") === "git rev-parse --verify HEAD^{commit}").map(call => call.cwd)).toEqual(["/tmp/worktrees/elsewhere"]);
			expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
			expect(calls.filter(call => settingsCall(call.argv))).toHaveLength(0);
			expect(files()).toHaveLength(0);
		}
	});

	test("a new merge requires expectHeadSha, while an already-MERGED proof does not", async () => {
		for (const expectHeadSha of [undefined, "", "   "]) {
			const { outcome, calls, files } = await land({ prView: [completed(githubPr())] }, { expectHeadSha });
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("expectHeadSha");
			expect(outcome.reason).toContain(HEAD_OID);
			expect(outcome.reason).toContain("no merge was issued");
			expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
			expect(files()).toHaveLength(0);
		}

		const proved = await land({ prView: [completed(mergedGithubPr())] });
		expect(proved.outcome.ok).toBe(true);
		expect(proved.calls.filter(call => merged(call.argv))).toHaveLength(0);
		expect(proved.files()).toHaveLength(1);
	});

	/**
	 * Every refusal the call can reach, each with `setupAutoDelete: true`. The setting
	 * changes every future contributor's merges, so a landing that does not complete
	 * must leave it untouched — not merely unwritten, but not even read.
	 */
	test("a refused landing reads and writes no deletion-on-merge setting", async () => {
		const cases: Array<[string, Answers, Partial<LandParams>]> = [
			["merge-commit policy", { prView: [completed(githubPr())], policy: completed("false\n") }, { ...REVIEWED, merge_method: "merge" }],
			["no expectHeadSha", { prView: [completed(githubPr())] }, {}],
			["expectHeadSha mismatch", { prView: [completed(githubPr())] }, { expectHeadSha: "f".repeat(40) }],
			["worktree at another head", { prView: [completed(githubPr())], worktreeHead: completed(`${"9".repeat(40)}\n`) }, { ...REVIEWED, worktree: "/tmp/worktrees/elsewhere" }],
			["abbreviated head", { prView: [completed(githubPr({ headRefOid: "0123456" }))] }, { expectHeadSha: "0123456" }],
			["no title to squash with", { prView: [completed(githubPr({ title: "" }))] }, REVIEWED],
			["no bead identity", { prView: [completed(githubPr({ headRefName: "feature/no-bead" }))] }, REVIEWED],
			["forge refused the merge", { prView: [completed(githubPr())], merge: completed("", 1, "Pull request is not mergeable") }, REVIEWED],
			["re-read not merged", { prView: [completed(githubPr()), completed(githubPr())] }, REVIEWED],
			["landed shape mismatch", { prView: [completed(githubPr()), completed(mergedGithubPr())], parents: `${BASE_OID} ${HEAD_OID}` }, REVIEWED],
		];
		for (const [label, answers, params] of cases) {
			const { outcome, calls, files } = await land(answers, { ...params, setupAutoDelete: true });
			if (outcome.ok) throw new Error(`${label}: expected a refusal`);
			expect({ label, settings: calls.filter(call => settingsCall(call.argv)).map(call => call.argv) }).toEqual({ label, settings: [] });
			expect(files()).toHaveLength(0);
		}
	});

	test("a squash merge with no pull request title refuses before merging", async () => {
		for (const title of ["", "   ", null]) {
			const { outcome, calls, files } = await land({ prView: [completed(githubPr({ title }))] }, REVIEWED);
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.reason).toContain("pr.title");
			expect(outcome.reason).toContain("no merge was issued");
			expect(calls.filter(call => merged(call.argv))).toHaveLength(0);
			expect(files()).toHaveLength(0);
		}
	});

	test("a title spelled like an option stays the --subject operand", async () => {
		const { outcome, calls } = await land({ prView: [completed(githubPr({ title: "--admin" })), completed(mergedGithubPr())] }, REVIEWED);

		expect(outcome.ok).toBe(true);
		const merge = calls.find(call => merged(call.argv))?.argv ?? [];
		expect(merge[merge.indexOf("--subject") + 1]).toBe("--admin");
		expect(merge.filter(part => part === "--admin")).toHaveLength(1);
	});

	/**
	 * The hung `gh` is a real process: a script on PATH that records its pid and sleeps.
	 * The interrupt must kill it and return, instead of holding the session for the
	 * forge timeout, and nothing may be merged or written after it.
	 */
	test("an interrupt kills a hung forge call and lands nothing", async () => {
		const canonical = realpathSync(temporaryDirectory("delivery-land-abort-"));
		git(canonical, ["init", "-q", "-b", "main"]);
		git(canonical, ["remote", "add", "origin", REMOTE_URL]);
		const bin = temporaryDirectory("delivery-land-bin-");
		const pidFile = join(bin, "gh.pid");
		// Written aside and renamed, so the pid file exists only once it is whole.
		writeFileSync(join(bin, "gh"), `#!/bin/sh\necho $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'\nexec sleep 30\n`);
		chmodSync(join(bin, "gh"), 0o755);
		const receipts = temporaryDirectory("delivery-land-receipts-");
		const controller = new AbortController();
		const started = Date.now();
		const pending = landPullRequest(
			{ pr: 470, ...REVIEWED },
			{
				cwd: canonical,
				now: () => NOW,
				receiptsDirectory: receipts,
				env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
				signal: controller.signal,
			},
		);
		await appeared(pidFile);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(() => process.kill(pid, 0)).not.toThrow();
		controller.abort();
		const outcome = await pending;

		expect(Date.now() - started).toBeLessThan(4_000);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toContain("gh pr view 470");
		expect(outcome.reason).toContain("abort");
		expect(() => process.kill(pid, 0)).toThrow();
		expect(readdirSync(receipts)).toEqual([]);
	});
});

describe("branch reading", () => {
	test("bead ids come from the agent branch convention and nowhere else", () => {
		expect(beadIdsFromBranch("omp/agent/omp-plugins-9ej3.5")).toEqual(["omp-plugins-9ej3.5"]);
		for (const branch of ["main", "omp/integration/omp-plugins-9ej3", "omp/agent/", "feature/omp/agent/x"]) {
			expect(beadIdsFromBranch(branch)).toEqual([]);
		}
	});
});

describe("landing target resolution", () => {
	/** A Git read answering the repository observation and one remote URL, recording each argv. */
	function gitAnswering(remoteUrl: string): { git: (argv: readonly string[]) => Promise<string | null>; reads: string[][]; cwd: string } {
		const { canonical } = repository();
		const reads: string[][] = [];
		const git = async (argv: readonly string[]): Promise<string | null> => {
			reads.push([...argv]);
			if (argv[0] === "rev-parse") return `${join(canonical, ".git")}\n${canonical}\n`;
			if (argv.join(" ") === "remote get-url origin") return `${remoteUrl}\n`;
			return null;
		};
		return { git, reads, cwd: canonical };
	}

	test("refuses an explicit identity before reading any repository state", async () => {
		const { git, reads, cwd } = gitAnswering(REMOTE_URL);
		const resolved = await resolveLandingTarget({ repo: "https://github.com/x/y" }, git, cwd, {});
		expect(resolved).toEqual({
			reason: 'repo: observed "https://github.com/x/y", expected an unqualified "<owner>/<name>" or bounded GitLab "<group>/.../<project>" path',
		});
		expect(reads).toEqual([]);
	});

	test("refuses a repo override that disagrees with the remote, naming both", async () => {
		const { git, cwd } = gitAnswering(REMOTE_URL);
		const resolved = await resolveLandingTarget({ repo: "someone/else" }, git, cwd, {});
		expect("reason" in resolved && resolved.reason).toBe(
			'repo: observed "someone/else", expected "srobroek/omp-plugins" from remote origin; the branch absence is verified against origin, so both must name one repository',
		);
	});

	test("binds every forge command to the canonical host the remote names", async () => {
		const { git, reads, cwd } = gitAnswering("ssh://git@altssh.gitlab.com:443/group/sub/project.git");
		const resolved = await resolveLandingTarget({}, git, cwd, { PATH: "/bin" });
		if ("reason" in resolved) throw new Error(resolved.reason);
		expect(resolved).toMatchObject({ remote: "origin", forge: "gitlab", nameWithOwner: "group/sub/project", cliRepo: "gitlab.com/group/sub/project" });
		expect({ ...resolved.forgeCommandEnv }).toEqual({ PATH: "/bin", GITLAB_HOST: "gitlab.com", GITLAB_API_HOST: "gitlab.com" });
		expect(resolved.repository.canonicalRoot).toBe(realpathSync(cwd));
		expect(reads.map((argv) => argv[0])).toEqual(["rev-parse", "remote"]);
	});
});

describe("delivery_land registration", () => {
	/**
	 * The host's interrupt reaches the tool as `execute`'s signal; a signal the tool
	 * dropped would leave every forge call above it uninterruptible. An already-aborted
	 * signal must therefore stop the call before it starts a single command.
	 */
	test("execute forwards the tool call's abort signal into the landing", async () => {
		type Registered = {
			name: string;
			execute: (...args: unknown[]) => Promise<{ details: { ok: boolean; reason?: string } }>;
		};
		let tool: Registered | undefined;
		const chain: Record<string, unknown> = {};
		for (const method of ["optional", "describe"]) chain[method] = () => chain;
		const pi = {
			zod: {
				object: (shape: unknown) => shape,
				union: () => chain,
				number: () => chain,
				string: () => chain,
				boolean: () => chain,
				enum: () => chain,
			},
			registerTool: (value: Registered) => {
				tool = value;
			},
		} as unknown as ExtensionAPI;
		deliveryLandTool(pi);
		if (tool === undefined) throw new Error("delivery_land was not registered");
		expect(tool.name).toBe("delivery_land");

		const controller = new AbortController();
		controller.abort();
		const cwd = temporaryDirectory("delivery-land-execute-");
		const result = await tool.execute("call-1", { pr: 470 }, controller.signal, undefined, { cwd });

		expect(result.details.ok).toBe(false);
		expect(result.details.reason).toContain("abort");
	});
});

// Last in the file: bun runs a file's tests in order, so every fixture above exists by now.
describe("fixture hygiene", () => {
	test("no fixture directory outlives the test that created it", () => {
		expect(created.length).toBeGreaterThan(0);
		expect(created.filter((path) => existsSync(path))).toEqual([]);
	});
});
