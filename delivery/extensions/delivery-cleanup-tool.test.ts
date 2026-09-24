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
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
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

type FixtureLayout = "normal" | "separate-git-dir" | "separate-dot-git-dir" | "submodule";

type RecordedCall = {
	argv: string[];
	cwd: string | undefined;
	timeoutMs: number;
	env: Readonly<Record<string, string>> | undefined;
};

type RunnerOptions = {
	pr?: Partial<{
		state: string;
		baseRefName: string;
		headRefName: string;
		headRefOid: string;
		mergeCommitOid: string | null;
		mergedAt: string | null;
		url: string;
	}>;
	/**
	 * What each remote name resolves to, for a checkout whose remotes do not all
	 * name the repository the receipt was written for. Absent, every name resolves
	 * to the receipt's own repository; present, a name it omits is no remote at all.
	 */
	remotes?: Record<string, string>;
	/** Let git answer `remote get-url` itself, so a worktree-scoped rewrite is real. */
	realRemoteUrls?: boolean;
	/** Verbatim stdout for `remote get-url`, for output that is not one clean record. */
	remoteStdout?: string;
	beadStatus?: string;
	beadRows?: Record<string, unknown>[];
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
 * Nonstandard layouts plant a retired ledger above an active checkout ledger. That
 * is the live fail-open shape: using the common metadata directory as the checkout
 * root sees the parent verdict, while Git's top level names the active ledger.
 */
function fixture(
	name: string,
	branch = `feat/${name}`,
	ledger: "active" | "retired" = "active",
	layout: FixtureLayout = "normal",
): Fixture {
	const root = scratch(name);
	const bare = join(root, "remote.git");
	mkdirSync(bare);
	git(bare, ["init", "--bare", "-q"]);

	let main: string;
	if (layout === "submodule") {
		const source = join(root, "source");
		const superproject = join(root, "superproject");
		main = join(superproject, "sub");
		mkdirSync(source);
		git(source, ["init", "-q", "-b", "main"]);
		git(source, ["config", "user.email", "delivery@example.test"]);
		git(source, ["config", "user.name", "Delivery Test"]);
		writeFileSync(join(source, "source.txt"), "source\n");
		git(source, ["add", "source.txt"]);
		git(source, ["commit", "-q", "-m", "source"]);
		mkdirSync(superproject);
		git(superproject, ["init", "-q", "-b", "main"]);
		git(superproject, ["config", "user.email", "delivery@example.test"]);
		git(superproject, ["config", "user.name", "Delivery Test"]);
		writeFileSync(join(superproject, "super.txt"), "super\n");
		git(superproject, ["add", "super.txt"]);
		git(superproject, ["commit", "-q", "-m", "super"]);
		git(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"]);
		mkdirSync(join(superproject, ".beads"));
		writeFileSync(join(superproject, ".beads", "RETIRED"), "retired\n");
	} else {
		main = join(root, "main");
		mkdirSync(main);
		if (layout === "separate-git-dir" || layout === "separate-dot-git-dir") {
			const common = layout === "separate-dot-git-dir" ? join(root, "store", ".git") : join(root, "store.git");
			mkdirSync(dirname(common), { recursive: true });
			git(main, ["init", "-q", "-b", "main", `--separate-git-dir=${common}`]);
			mkdirSync(join(dirname(common), ".beads"));
			writeFileSync(join(dirname(common), ".beads", "RETIRED"), "retired\n");
		} else {
			git(main, ["init", "-q", "-b", "main"]);
		}
	}

	git(main, ["config", "user.email", "delivery@example.test"]);
	git(main, ["config", "user.name", "Delivery Test"]);
	writeFileSync(join(main, "base.txt"), "base\n");
	git(main, ["add", "base.txt"]);
	git(main, ["commit", "-q", "-m", "base"]);
	if (layout === "submodule") git(main, ["remote", "set-url", "origin", bare]);
	else git(main, ["remote", "add", "origin", bare]);
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
		emitter: { plugin: "@srobroek/delivery", version: pkg.version, tool: "delivery_land" },
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

function gitlabPayload(f: Fixture, over: RunnerOptions["pr"] = {}): string {
	return JSON.stringify({
		iid: f.receipt.pr.number,
		web_url: over.url ?? f.receipt.pr.url,
		state: over.state ?? f.receipt.pr.state,
		target_branch: over.baseRefName ?? f.receipt.pr.baseRefName,
		source_branch: over.headRefName ?? f.receipt.pr.headRefName,
		sha: over.headRefOid ?? f.receipt.pr.headRefOid,
		merge_commit_sha: over.mergeCommitOid === undefined ? f.receipt.pr.mergeCommitOid : over.mergeCommitOid,
		merged_at: over.mergedAt === undefined ? f.receipt.pr.mergedAt : over.mergedAt,
	});
}

/**
 * The URL a remote name resolves to, which is the one Git read this runner scripts.
 *
 * The fixture's real `origin` is a local bare path, and no forge adapter verifies
 * a path as a host. The remote NAME is what a receipt records; the URL is what
 * classification and every forge query are bound to, so it is scripted here, and
 * `remotes` is how a contributor fork on `origin` is expressed.
 *
 * `realRemoteUrls` hands the read back to git, for the one case whose whole point is
 * that git resolves a URL differently per worktree.
 */
function remoteUrl(f: Fixture, remote: string, options: RunnerOptions): string | null {
	if (options.remotes !== undefined) return options.remotes[remote] ?? null;
	const { forge, nameWithOwner } = f.receipt.repo;
	const host = forge === "gitlab" ? "gitlab.com" : "github.com";
	return `https://${host}/${nameWithOwner}.git`;
}

function runner(f: Fixture, options: RunnerOptions = {}): { run: CliRunner; calls: string[][]; details: RecordedCall[] } {
	const calls: string[][] = [];
	const details: RecordedCall[] = [];
	const run: CliRunner = (argv, commandOptions) => {
		calls.push([...argv]);
		details.push({ argv: [...argv], cwd: commandOptions.cwd, timeoutMs: commandOptions.timeoutMs, env: commandOptions.env });
		options.before?.(argv, calls);
		let result: CliResult;
		if (argv[0] === "gh") {
			result = success(githubPayload(f, options.pr));
		} else if (argv[0] === "glab") {
			result = success(gitlabPayload(f, options.pr));
		} else if (argv[0] === "bd") {
			result = success(JSON.stringify({
				schema_version: 1,
				data: options.beadRows ?? [{
					id: "delivery-17",
					status: options.beadStatus ?? "closed",
					metadata: { merge_sha: options.beadMergeSha ?? f.merge },
				}],
			}));
		} else if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "get-url" && options.realRemoteUrls !== true) {
			if (options.remoteStdout !== undefined) {
				result = success(options.remoteStdout);
			} else {
				const url = remoteUrl(f, argv[3] ?? "", options);
				result = url === null
					? { ok: true, exitCode: 1, stdout: "", stderr: `error: No such remote '${argv[3]}'\n` }
					: success(`${url}\n`);
			}
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
	return { run, calls, details };
}

function invoke(f: Fixture, params: DeliveryCleanupParams = { receipt: f.receiptPath }, options: RunnerOptions = {}): {
	result: CleanupResult;
	calls: string[][];
	details: RecordedCall[];
} {
	const scripted = runner(f, options);
	const result = cleanupDelivery(params, f.main, { run: scripted.run, now: () => NOW + 10, env: f.env });
	return { result, calls: scripted.calls, details: scripted.details };
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
		expect(calls.slice(0, 3)).toEqual([
			["git", "worktree", "list", "--porcelain"],
			["git", "remote", "get-url", "origin"],
			[
				"gh", "pr", "view", "17", "--repo", "github.com/owner/repo", "--json",
				"number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
			],
		]);
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
	}, 60_000);

	test("a retired ledger, agreed by the receipt and the canonical root, cleans up with no bd command", () => {
		const f = fixture("inactive-ledger", "feat/inactive-ledger", "retired");

		const { result, calls } = invoke(f);

		expect(result.ok).toBe(true);
		expect(commandCalls(calls, "bd")).toEqual([]);
		if (!result.ok) return;
		expect(result.receipt.beads.ledgerActive).toBe(false);
		expect(existsSync(f.linked)).toBe(false);
	});

	test("a ledger-free receipt for another repository is denied before local mutation", () => {
		const f = fixture("cross-repo-receipt", "feat/cross-repo-receipt", "retired");
		const receipt = buildReceipt({
			...f.receipt,
			now: NOW + 1,
			continues: f.receipt,
			repo: { ...f.receipt.repo, nameWithOwner: "attacker/elsewhere" },
		});
		const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key));

		const { result, calls } = invoke(f, { receipt: path });

		expect(refusal(result)).toContain('repo.nameWithOwner: observed "owner/repo", expected receipt value "attacker/elsewhere"');
		expect(calls).toEqual([
			["git", "worktree", "list", "--porcelain"],
			["git", "remote", "get-url", "origin"],
		]);
		expect(commandCalls(calls, "bd")).toEqual([]);
		expect(mutationCalls(calls)).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
	}, 60_000);

	test("a receipt remote that cannot name one verified repository fails closed", () => {
		const f = fixture("remote-identity", "feat/remote-identity", "retired");
		// A leading dash is an option to `git remote get-url`; whitespace padding is a
		// receipt that does not say which remote. Neither is trimmed into something
		// usable, and neither reaches a command that names a remote: the one call made
		// first is the target-identity listing the observation is resolved inside.
		//
		// The four line terminators are here because a receipt is a file: a generator
		// that wrote `origin\n` produced a value that must refuse, and U+2028/U+2029 are
		// line terminators to a JavaScript regex while surviving a JSON round trip
		// untouched.
		for (const remote of [
			"--upload-pack=touch",
			" origin",
			"origin\n",
			"origin\r",
			"origin\r\n",
			"origin\u2028",
			"origin\u2029",
			"or igin",
		]) {
			const receipt = buildReceipt({
				...f.receipt,
				now: NOW + 1,
				continues: f.receipt,
				repo: { ...f.receipt.repo, remote },
			});
			const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key));
			const { result, calls } = invoke(f, { receipt: path });
			expect(refusal(result)).toContain(`repo.remote: observed ${JSON.stringify(remote)}, expected a git remote name`);
			expect(calls).toEqual([["git", "worktree", "list", "--porcelain"]]);
			rmSync(path);
		}

		for (const [field, remotes] of [
			["repo.remote", {}],
			["repo.forge", { origin: "https://evil.example/owner/repo.git" }],
			["repo.forge", { origin: "https://gitlab.com/owner/repo.git" }],
			["repo.nameWithOwner", { origin: "https://github.com/" }],
			["repo.nameWithOwner", { origin: "https://github.com/attacker/elsewhere.git" }],
		] as const) {
			const { result, calls } = invoke(f, { receipt: f.receiptPath }, { remotes });
			expect(refusal(result)).toContain(field);
			expect(calls).toEqual([
				["git", "worktree", "list", "--porcelain"],
				["git", "remote", "get-url", "origin"],
			]);
		}
		expect(existsSync(f.linked)).toBe(true);
	}, 60_000);

	/**
	 * `URL` deletes embedded tabs and newlines before parsing, so each of these reads as
	 * an ordinary GitHub remote once the output is trimmed. Trimming would let the
	 * identity comparison pass and authorise a removal whose absence probe could then
	 * only ever answer "unknown" — a worktree deleted on an observation of nothing. The
	 * output is read as exactly one record instead, and refusal precedes the forge read.
	 *
	 * The refusal also says nothing about the bytes. Output no parser accepted cannot be
	 * redacted — a redactor can only find a secret in a spelling it understands — so the
	 * cases below carry userinfo and a token query, and the refusal text must hold
	 * neither those tokens nor the URL that framed them.
	 */
	test("git remote get-url output that is not exactly one record refuses before the forge read", () => {
		const f = fixture("remote-record", "feat/remote-record", "retired");
		for (const remoteStdout of [
			"https://git\thub.com/owner/repo.git\n",
			"https://github.com/owner/repo.git\n@evil.example/x\n",
			"https://github.com/owner/repo.git\nhttps://evil.example/owner/repo.git\n",
			"https://github.com/owner/repo.git\r\n\r\n",
			" https://github.com/owner/repo.git\n",
			"https://github.com/owner/repo.git \n",
			"\n",
			"",
			"https://srobroek:ghp_secrettoken@git\thub.com/owner/repo.git\n",
			"https://github.com/owner/repo.git?token=ghp_secrettoken\nhttps://evil.example/x\n",
			" ssh://git:ghp_secrettoken@github.com/owner/repo.git\n",
		]) {
			const { result, calls } = invoke(f, { receipt: f.receiptPath }, { remoteStdout });
			const reason = refusal(result);
			expect(reason).toContain('repo.remote: observed "malformed Git remote output"');
			expect(reason).toContain("exactly one URL record");
			// Neither the secret nor the spelling that carried it.
			expect(reason).not.toContain("ghp_secrettoken");
			expect(reason).not.toContain("github.com/owner/repo");
			expect(reason).not.toContain("evil.example");
			expect(calls).toEqual([
				["git", "worktree", "list", "--porcelain"],
				["git", "remote", "get-url", "origin"],
			]);
			expect(mutationCalls(calls)).toEqual([]);
		}
		expect(existsSync(f.linked)).toBe(true);
	}, 60_000);

	test("GitLab queries the receipt's project on the canonical host", () => {
		const f = fixture("gitlab-local-repo", "feat/gitlab-local-repo", "retired");
		const receipt = buildReceipt({
			...f.receipt,
			now: NOW + 1,
			continues: f.receipt,
			repo: { ...f.receipt.repo, forge: "gitlab", nameWithOwner: "group/project" },
			pr: {
				...f.receipt.pr,
				url: "https://gitlab.com/group/project/-/merge_requests/17",
				state: "merged",
			},
			proof: { ...f.receipt.proof, method: "glab mr view" },
		});
		const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key));
		f.receipt = receipt;
		f.receiptPath = path;

		const { result, calls, details } = invoke(f);

		expect(result.ok).toBe(true);
		expect(calls.slice(0, 3)).toEqual([
			["git", "worktree", "list", "--porcelain"],
			["git", "remote", "get-url", "origin"],
			["glab", "mr", "view", "17", "--repo", "gitlab.com/group/project", "--output", "json"],
		]);
		const mr = details.find(call => call.argv[0] === "glab");
		expect(mr?.env?.GITLAB_HOST).toBe("gitlab.com");
		expect(mr?.env?.GITLAB_API_HOST).toBe("gitlab.com");
		expect(mr?.cwd).toBeUndefined();
	}, 60_000);

	/**
	 * The finding this pins: a checkout whose `origin` is a contributor fork and
	 * whose `upstream` is the remote the landing was run with. `gh repo view` and
	 * `glab repo view` answer for `origin`, so the observation came out of the fork
	 * and a valid upstream receipt was refused, blocking cleanup after a landing
	 * that had already succeeded — while the receipt named the right remote all
	 * along.
	 */
	for (const forge of ["github", "gitlab"] as const) {
		test(`${forge}: the observation follows the receipt's remote while origin is a fork`, () => {
			const f = fixture(`fork-origin-${forge}`, `feat/fork-origin-${forge}`, "retired");
			git(f.main, ["remote", "add", "upstream", f.bare]);
			const nameWithOwner = forge === "github" ? "owner/repo" : "group/project";
			const host = forge === "github" ? "github.com" : "gitlab.com";
			const receipt = buildReceipt({
				...f.receipt,
				now: NOW + 1,
				continues: f.receipt,
				repo: { ...f.receipt.repo, remote: "upstream", forge, nameWithOwner },
				pr: forge === "github" ? f.receipt.pr : {
					...f.receipt.pr,
					url: `https://gitlab.com/${nameWithOwner}/-/merge_requests/17`,
					state: "merged",
				},
				proof: { ...f.receipt.proof, method: forge === "github" ? "gh pr view" : "glab mr view" },
			});
			f.receiptPath = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key));
			f.receipt = receipt;

			const { result, calls, details } = invoke(f, { receipt: f.receiptPath }, {
				remotes: {
					origin: `https://${host}/contributor/fork.git`,
					upstream: `https://${host}/${nameWithOwner}.git`,
				},
			});

			expect(result.ok).toBe(true);
			expect(calls.slice(0, 3)).toEqual([
				["git", "worktree", "list", "--porcelain"],
				["git", "remote", "get-url", "upstream"],
				forge === "github"
					? [
						"gh", "pr", "view", "17", "--repo", "github.com/owner/repo", "--json",
						"number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
					]
					: ["glab", "mr", "view", "17", "--repo", "gitlab.com/group/project", "--output", "json"],
			]);
			expect(calls.filter(argv => argv[1] === "remote" && argv[2] === "get-url")).toEqual([
				["git", "remote", "get-url", "upstream"],
			]);
			expect(calls.flat().join(" ")).not.toContain("contributor/fork");
			expect(calls.flat()).not.toContain("origin");
			// The absence probe is bound to the resolved URL, not the remote name: after
			// removal a name would be re-resolved by a surviving worktree's configuration.
			// The URL travels in the child's environment, so argv names only the alias.
			const absence = details.find(call => call.argv.includes("ls-remote"));
			expect(absence?.argv.at(-2)).toBe("omp-absence-probe");
			expect(absence?.argv).not.toContain("upstream");
			expect(absence?.env?.GIT_CONFIG_VALUE_0).toBe(`https://${host}/${nameWithOwner}.git`);
			expect(existsSync(f.linked)).toBe(false);
			if (!result.ok) return;
			expect(result.receipt.repo.remote).toBe("upstream");
			expect(result.receipt.proof.method).toBe(forge === "github" ? "gh pr view" : "glab mr view");
		}, 60_000);
	}

	/**
	 * A remote NAME resolves per repository; a remote URL resolves per worktree.
	 *
	 * `extensions.worktreeConfig` scopes `url.<other>.insteadOf` to a single worktree,
	 * and `git remote get-url` expands those rewrites, so the landed worktree and the
	 * directory cleanup must run from print different URLs for the same name. Nothing
	 * here is scripted: git configures the rewrite and git answers both reads, and the
	 * two `expect`s before the call record the premise as an observation rather than an
	 * assumption. Resolved from the invocation worktree this receipt is unusable —
	 * `origin` is the fork there — and the landed worktree it names becomes impossible
	 * to clean.
	 */
	test("the remote URL is resolved in the landed worktree, where a worktree-scoped rewrite applies", () => {
		const f = fixture("worktree-config", "feat/worktree-config", "retired");
		const fork = "https://github.com/contributor/fork.git";
		const upstream = "https://github.com/owner/repo.git";
		git(f.main, ["config", "extensions.worktreeConfig", "true"]);
		git(f.main, ["remote", "set-url", "origin", fork]);
		git(f.linked, ["config", "--worktree", `url.${upstream}.insteadOf`, fork]);
		// The surviving worktree rewrites the other way: any probe that loaded this
		// repository's configuration would be sent from upstream to the fork. It is the
		// worktree cleanup runs from, and the only one left once the target is removed.
		git(f.main, ["config", "--worktree", `url.${fork}.insteadOf`, upstream]);
		expect(git(f.linked, ["remote", "get-url", "origin"])).toBe(upstream);
		expect(git(f.main, ["remote", "get-url", "origin"])).toBe(fork);
		// Captured before the call, because a successful cleanup removes this directory
		// and `realpathSync` then throws on a path that no longer exists.
		const landedPath = realpathSync(f.linked);

		const { result, calls, details } = invoke(f, { receipt: f.receiptPath }, { realRemoteUrls: true });

		expect(result.ok).toBe(true);
		const identityRead = details.find(call => call.argv[1] === "remote" && call.argv[2] === "get-url");
		expect(identityRead?.argv).toEqual(["git", "remote", "get-url", "origin"]);
		// The directory is what makes the answer upstream's rather than the fork's.
		expect(identityRead?.cwd).toBe(landedPath);
		expect(calls.slice(0, 3)).toEqual([
			["git", "worktree", "list", "--porcelain"],
			["git", "remote", "get-url", "origin"],
			[
				"gh", "pr", "view", "17", "--repo", "github.com/owner/repo", "--json",
				"number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
			],
		]);
		expect(calls.flat().join(" ")).not.toContain("contributor/fork");
		// The post-removal absence probe is the second place a remote name would be
		// re-resolved, and by then the worktree that rewrites it is gone. It is bound to
		// the URL the target resolved — but through Git's environment config, because
		// `ps` shows argv to every user on the host and a remote URL may carry a token.
		// The command line therefore names an opaque alias and nothing else.
		const probe = details.find(call => call.argv.includes("ls-remote"));
		expect(probe?.argv.at(-2)).toBe("omp-absence-probe");
		expect(probe?.argv.join(" ")).not.toContain(upstream);
		expect(probe?.argv).not.toContain("origin");
		expect(probe?.env?.GIT_CONFIG_COUNT).toBe("1");
		expect(probe?.env?.GIT_CONFIG_KEY_0).toBe("remote.omp-absence-probe.url");
		expect(probe?.env?.GIT_CONFIG_VALUE_0).toBe(upstream);
		// Config cannot reach that probe: no global file, no system file, and — because a
		// ceiling around the probe directory was measured not to stop a parent checkout's
		// rewrite — a repository of this module's own making, so there is no discovery to
		// redirect. The directory is gone once the call returns.
		expect(probe?.env?.GIT_CONFIG_GLOBAL).toBe(devNull);
		expect(probe?.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
		expect(probe?.env?.GIT_DIR).toBe(join(probe?.cwd ?? "", "probe.git"));
		expect(probe?.env?.GIT_CEILING_DIRECTORIES).toBe(probe?.cwd);
		expect(probe?.cwd).not.toBe(f.main);
		expect(probe?.cwd).not.toBe(landedPath);
		expect(existsSync(probe?.cwd ?? "")).toBe(false);
		expect(existsSync(f.linked)).toBe(false);
	}, 60_000);

	test("cleanup strips every ambient forge and Git selector from the identity and pull-request reads", () => {
		const f = fixture("ambient-redirectors", "feat/ambient-redirectors", "retired");
		Object.assign(f.env, {
			GH_REPO: "attacker/elsewhere",
			GH_HOST: "evil.example",
			GITLAB_HOST: "evil.example",
			GL_HOST: "evil.example",
			GITLAB_URI: "https://evil.example",
			GITLAB_API_HOST: "api.evil.example",
			GIT_DIR: "/elsewhere/.git",
			GIT_WORK_TREE: "/elsewhere",
			GIT_CONFIG_GLOBAL: "/elsewhere/config",
			GH_TOKEN: "keep-gh",
			GITLAB_TOKEN: "keep-gitlab",
			GL_TOKEN: "keep-gl",
		});

		const { result, details } = invoke(f);

		expect(result.ok).toBe(true);
		const forgeCalls = details.filter(call => call.argv[0] === "gh");
		expect(forgeCalls).toHaveLength(1);
		for (const call of forgeCalls) {
			for (const key of ["GH_REPO", "GITLAB_HOST", "GL_HOST", "GITLAB_URI", "GITLAB_API_HOST"]) {
				expect(call.env?.[key]).toBeUndefined();
			}
			// Not merely stripped: replaced by the host `forgeTarget` verified, so the
			// CLI cannot fall back to a configured default host either.
			expect(call.env?.GH_HOST).toBe("github.com");
			expect(call.env?.GH_TOKEN).toBe("keep-gh");
			expect(call.env?.GITLAB_TOKEN).toBe("keep-gitlab");
			expect(call.env?.GL_TOKEN).toBe("keep-gl");
		}
		const identityRead = details.find(call => call.argv[1] === "remote" && call.argv[2] === "get-url");
		expect(identityRead?.argv).toEqual(["git", "remote", "get-url", "origin"]);
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_GLOBAL"]) {
			expect(identityRead?.env?.[key]).toBeUndefined();
		}
	}, 60_000);

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
			// The pull-request read is now preceded by the target's identity, because the
			// remote is resolved inside the target. That is the only thing allowed to
			// precede it, and it is a listing: no dirty check, no unpushed check, no
			// ledger read, and nothing that mutates.
			expect(observed.calls.map(argv => argv.slice(0, 3))).toEqual([
				["git", "worktree", "list"],
				["git", "remote", "get-url"],
				["gh", "pr", "view"],
			]);
			expect(observed.calls.some(argv => argv[0] === "git" && argv[1] === "status")).toBe(false);
			expect(observed.calls.some(argv => argv[0] === "bd")).toBe(false);
			expect(mutationCalls(observed.calls)).toEqual([]);
		}
	});

	test("a schema-valid receipt without a merge commit refuses before any observation or mutation", () => {
		const f = fixture("missing-merge-authorization", "feat/missing-merge-authorization", "retired");
		const receipt = buildReceipt({
			...f.receipt,
			now: NOW + 1,
			pr: { ...f.receipt.pr, mergeCommitOid: null },
		});
		const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key));

		const { result, calls } = invoke(f, { receipt: path }, { pr: { mergeCommitOid: null } });

		expect(refusal(result)).toContain("pr.mergeCommitOid");
		expect(refusal(result)).toContain("a non-empty merge commit oid before cleanup");
		expect(calls).toEqual([]);
		expect(mutationCalls(calls)).toEqual([]);
		expect(existsSync(f.linked)).toBe(true);
		expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0);
		rmSync(f.root, { recursive: true, force: true });
	});

	test("a moved head, a dirty tree, an unpushed commit, and an open bead each refuse at their own gate", () => {
		const f = fixture("refusal-order");
		writeFileSync(join(f.linked, "dirty.txt"), "dirty\n");
		const dirty = invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" });
		expect(refusal(dirty.result)).toContain("worktree.status");
		expect(refusal(dirty.result)).toContain("dirty.txt");
		expect(commandCalls(dirty.calls, "bd")).toEqual([]);

		// A commit moves the worktree off the head the receipt names, and the target's
		// identity is now proved before the pull request is read — because the remote is
		// resolved inside the target — so this refuses at `worktree.HEAD` rather than
		// reaching the unpushed count. The earlier gate is the point: the receipt no
		// longer describes this worktree at all.
		rmSync(join(f.linked, "dirty.txt"));
		writeFileSync(join(f.linked, "ahead.txt"), "ahead\n");
		git(f.linked, ["add", "ahead.txt"]);
		git(f.linked, ["commit", "-q", "-m", "ahead"]);
		const moved = invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" });
		expect(refusal(moved.result)).toContain("worktree.HEAD: observed");
		expect(refusal(moved.result)).toContain(f.head);
		expect(moved.calls.map(argv => argv.slice(0, 3))).toEqual([["git", "worktree", "list"]]);

		// Unpushed with the head the receipt does name: the commit is dropped and the
		// tracking ref is rewound instead, which is what `@{upstream}..HEAD` counts.
		git(f.linked, ["reset", "-q", "--hard", f.head]);
		git(f.linked, ["update-ref", `refs/remotes/origin/${f.branch}`, `${f.head}^`]);
		const unpushed = invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" });
		expect(refusal(unpushed.result)).toContain("branch.unpushed: observed 1, expected 0 commits");
		expect(commandCalls(unpushed.calls, "bd")).toEqual([]);

		git(f.linked, ["update-ref", `refs/remotes/origin/${f.branch}`, f.head]);
		const ledger = invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" });
		expect(refusal(ledger.result)).toContain('beads.delivery-17.status: observed "open", expected "closed" after bd_reconcile');
		expect(mutationCalls(ledger.calls)).toEqual([]);
	}, 60_000);

	test("a branch with no upstream refuses before the ledger read", () => {
		const f = fixture("no-upstream");
		git(f.linked, ["config", "--unset", `branch.${f.branch}.remote`]);
		git(f.linked, ["config", "--unset", `branch.${f.branch}.merge`]);
		const { result, calls } = invoke(f);
		expect(refusal(result)).toContain("branch.upstream: observed");
		expect(refusal(result)).toContain("expected a configured upstream branch");
		expect(commandCalls(calls, "bd")).toEqual([]);
		expect(mutationCalls(calls)).toEqual([]);
	}, 60_000);

	test("reconciliation requires every bead merge_sha to equal the receipt exactly", () => {
		const f = fixture("ledger-sha");
		const { result, calls } = invoke(f, { receipt: f.receiptPath }, { beadMergeSha: "b".repeat(40) });
		expect(refusal(result)).toContain("beads.delivery-17.metadata.merge_sha");
		expect(refusal(result)).toContain(f.merge);
		expect(commandCalls(calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]]);
		expect(mutationCalls(calls)).toEqual([]);
	});
	for (const [order, statuses] of [
		["open then closed", ["open", "closed"]],
		["closed then open", ["closed", "open"]],
	] as const) {
		test(`conflicting duplicate bead statuses refuse in ${order} order without mutation`, () => {
			const f = fixture(`duplicate-status-${statuses.join("-")}`);
			const beadRows = statuses.map(status => ({
				id: "delivery-17",
				status,
				metadata: { merge_sha: f.merge },
			}));

			const { result, calls } = invoke(f, { receipt: f.receiptPath }, { beadRows });

			const reason = refusal(result);
			expect(reason).toContain("beads.delivery-17");
			expect(reason).toContain("duplicate bd show rows for one bead id to be identical");
			expect(reason).toContain(JSON.stringify(beadRows));
			expect(mutationCalls(calls)).toEqual([]);
			expect(existsSync(f.linked)).toBe(true);
			expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0);
			rmSync(f.root, { recursive: true, force: true });
		});
	}

	for (const [order, identities] of [
		["first then second", ["issue-one", "issue-two"]],
		["second then first", ["issue-two", "issue-one"]],
	] as const) {
		test(`conflicting duplicate bead identities refuse in ${order} order without mutation`, () => {
			const f = fixture(`duplicate-identity-${identities.join("-")}`);
			const beadRows = identities.map(identity => ({
				id: "delivery-17",
				identity,
				status: "closed",
				metadata: { merge_sha: f.merge },
			}));

			const { result, calls } = invoke(f, { receipt: f.receiptPath }, { beadRows });

			const reason = refusal(result);
			expect(reason).toContain("beads.delivery-17");
			expect(reason).toContain("duplicate bd show rows for one bead id to be identical");
			expect(reason).toContain(JSON.stringify(beadRows));
			expect(mutationCalls(calls)).toEqual([]);
			expect(existsSync(f.linked)).toBe(true);
			expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0);
			rmSync(f.root, { recursive: true, force: true });
		});
	}

	test("identical duplicate bead rows coalesce without weakening cleanup authorization", () => {
		const f = fixture("duplicate-identical");
		const issue = { id: "delivery-17", status: "closed", metadata: { merge_sha: f.merge } };
		const linked = realpathSync(f.linked);

		const { result, calls } = invoke(f, { receipt: f.receiptPath }, { beadRows: [issue, structuredClone(issue)] });

		expect(result.ok).toBe(true);
		expect(mutationCalls(calls)).toEqual([
			["git", "worktree", "remove", linked],
			["git", "branch", "-d", "--", f.branch],
		]);
		rmSync(f.root, { recursive: true, force: true });
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

	for (const layout of ["separate-git-dir", "separate-dot-git-dir", "submodule"] as const) {
		test(`${layout}: an active checkout ledger requires reconciliation and preserves an open bead's worktree and branch`, () => {
			const f = fixture(`live-${layout}`, "omp/agent/delivery-17", "active", layout);
			const landed = landPullRequest(
				{ pr: f.receipt.pr.number, worktree: f.linked },
				{ run: landRunner(f).run, cwd: f.main, now: () => NOW + 5, env: f.env },
			);

			expect(landed.ok).toBe(true);
			if (!landed.ok) throw new Error(landed.reason);
			expect(landed.receipt.repo.canonicalRoot).toBe(realpathSync(f.main));
			expect(landed.receipt.beads).toEqual({ ids: ["delivery-17"], ledgerActive: true });
			expect(landed.next).toEqual(["bd_reconcile", "delivery_cleanup"]);

			const cleaning = runner(f, { beadStatus: "open" });
			const refused = cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
				run: cleaning.run,
				now: () => NOW + 10,
				env: f.env,
			});
			expect(refusal(refused)).toContain('beads.delivery-17.status: observed "open", expected "closed" after bd_reconcile');
			expect(commandCalls(cleaning.calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]]);
			expect(mutationCalls(cleaning.calls)).toEqual([]);
			expect(existsSync(f.linked)).toBe(true);
			expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0);
		});
	}

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

	/**
	 * The probe used to be asked from a surviving worktree, because a remote NAME only
	 * resolves inside the repository that configures it. It is now given the URL the
	 * landed worktree resolved, so it is asked from nowhere in particular on purpose:
	 * any checkout it ran in could rewrite that URL through `url.<base>.insteadOf` and
	 * send the question to another repository, whose answer would become a false
	 * absence here.
	 */
	test("the remote-absence probe is asked outside every checkout, and its directory does not survive", () => {
		const f = fixture("probe-cwd");
		const scripted = runner(f);
		// Classified inside the hook, while the directory still exists: afterwards it is
		// gone, and "no repository" would be true of any deleted path.
		const probes: { cwd: string | undefined; key: string | null }[] = [];
		const run: CliRunner = (argv, options) => {
			if (argv.includes("ls-remote")) {
				probes.push({ cwd: options.cwd, key: options.cwd === undefined ? null : repoKey(options.cwd) });
			}
			return scripted.run(argv, options);
		};
		const result = cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env });

		expect(result.ok).toBe(true);
		expect(probes).toHaveLength(1);
		const asked = probes[0]?.cwd;
		if (asked === undefined) throw new Error("the probe was issued with no working directory");
		expect(asked).not.toBe(f.main);
		expect(asked.startsWith(f.root)).toBe(false);
		expect(probes[0]?.key).toBeNull();
		expect(existsSync(asked)).toBe(false);
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
