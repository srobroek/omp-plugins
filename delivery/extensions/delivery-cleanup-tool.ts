import pkg from "../package.json" with { type: "json" };
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	type CliResult,
	type CliRunner,
	FORGE_TIMEOUT_MS,
	forgeEnvironment,
	forgeTarget,
	gitObservationEnvironment,
	normalizeRepoPath,
	REMOTE_NAME,
	redactRemote,
	remoteBranchAbsent,
	repoPathFromRemote,
	runCli,
	singleRemoteRecord,
} from "./forge-adapter.ts";
import {
	buildReceipt,
	canonicalLedger,
	type LandingReceipt,
	listReceipts,
	type ReceiptPr,
	readReceipt,
	receiptDirectory,
	repoKey,
	validateReceipt,
	writeReceipt,
} from "./landing-receipt.ts";

const LOCAL_TIMEOUT_MS = 2_000;
const MAX_CLI_JSON_BYTES = 1024 * 1024;
const MAX_DIRTY_PATHS = 8;
const DELIVERY_VERSION = pkg.version;
const LOCAL_REF_PREFIX = "refs/heads/";

/** The GitHub fields this observation needs, in one `--json` projection. */
const PR_FIELDS = "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt";

export type DeliveryCleanupParams = {
	receipt?: string;
	pr?: number;
	branch?: string;
	worktree?: string;
	remote?: string;
};

export type CleanupSuccess = {
	ok: true;
	receipt: LandingReceipt;
	path: string;
	remoteBranchAbsence: "absent" | "present" | "unknown";
};

export type CleanupFailure = { ok: false; reason: string };
export type CleanupResult = CleanupSuccess | CleanupFailure;

export type CleanupDeps = {
	run?: CliRunner;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
};

type WorktreeRecord = {
	path: string;
	head: string;
	branch: string | null;
	detached: boolean;
	prunable: boolean;
};

type TargetIdentity = { records: WorktreeRecord[]; target: WorktreeRecord; main: WorktreeRecord };

/**
 * One observed pull request, in receipt spelling, plus the CLI and verb that
 * observed it — which is what the continuation receipt records as `proof.method`,
 * so the field names a command this call actually issued.
 *
 * It carries no repository identity: the repository was decided, and cross-checked
 * against the receipt, before this read was issued.
 */
type PullRequestObservation = ReceiptPr & { method: string };
type ReceiptResolution =
	| { tag: "resolved"; receipt: LandingReceipt }
	| { tag: "refused"; failure: CleanupFailure };

type Absence = "absent" | "present" | "unknown";

function show(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "missing";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function refuse(field: string, observed: unknown, expected: string): CleanupFailure {
	return { ok: false, reason: `${field}: observed ${show(observed)}, expected ${expected}` };
}
function isFailure(value: unknown): value is CleanupFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(value, "ok");
	return descriptor !== undefined && "value" in descriptor && descriptor.value === false;
}

function commandLabel(argv: readonly string[]): string {
	return argv.map(value => JSON.stringify(value)).join(" ");
}

function completed(result: CliResult): boolean {
	return result.ok && result.exitCode === 0 && result.error === undefined;
}

function commandFailure(field: string, argv: readonly string[], result: CliResult, expected: string): CleanupFailure {
	const exit = result.exitCode === null ? "no exit status" : `exit ${result.exitCode}`;
	const error = result.error === undefined ? "" : `, error ${result.error}`;
	const stderr = result.stderr.trim() === "" ? "" : `, stderr ${result.stderr.trim().slice(0, 400)}`;
	return refuse(field, `${commandLabel(argv)} (${exit}${error}${stderr})`, expected);
}

function own(holder: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(holder, key);
	if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
	return descriptor.value;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(holder: Record<string, unknown>, key: string): string | null {
	const value = own(holder, key);
	return typeof value === "string" && value !== "" ? value : null;
}

function integer(holder: Record<string, unknown>, key: string): number | null {
	const value = own(holder, key);
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseJsonObject(field: string, result: CliResult): Record<string, unknown> | CleanupFailure {
	if (!completed(result)) return commandFailure(field, [], result, "a successful bounded forge read");
	if (Buffer.byteLength(result.stdout) > MAX_CLI_JSON_BYTES) {
		return refuse(field, `JSON over ${MAX_CLI_JSON_BYTES} bytes`, `at most ${MAX_CLI_JSON_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return refuse(field, "unparseable JSON", "a JSON object from the forge");
	}
	return record(parsed) ?? refuse(field, parsed, "a JSON object from the forge");
}

function normalizedOid(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const oid = value.trim().toLowerCase();
	return oid === "" ? null : oid;
}

/**
 * The repository one receipt's own remote names, pinned to the forge's canonical
 * CLI host.
 *
 * `cliRepo` is what `--repo` receives, and both CLIs take `<host>/<path>` there:
 * `gh` documents `[HOST/]OWNER/REPO` and `glab` the same shape. Qualifying it is
 * what stops a bare path from being resolved against a configured host alias.
 * `nameWithOwner` stays unqualified: that is the spelling the receipt records, and
 * the spelling this identity had to equal to exist at all.
 */
type RemoteIdentity = {
	forge: "github" | "gitlab";
	nameWithOwner: string;
	cliRepo: string;
	/**
	 * Exactly what `git remote get-url` printed in the landed worktree, rewrites
	 * already expanded. Raw, not redacted: this is spent as an argv by the absence
	 * probe, which returns a verdict and never quotes what it was given, so no
	 * diagnostic can carry it. Nothing else may print it — {@link redactRemote} is
	 * what refusal messages use.
	 */
	remoteUrl: string;
	env: Readonly<Record<string, string>>;
};

/**
 * Resolve the repository to observe from `repo.remote` — never from whichever
 * repository a forge CLI infers from the directory it runs in.
 *
 * `gh repo view` and `glab repo view` answer about whichever repository their CLI
 * treats as the local default, which is `origin`. On a checkout whose `origin` is
 * a contributor fork and whose `upstream` is the remote the landing was run with,
 * that is not the repository the receipt proves: the pull request came out of the
 * fork, and the identity comparison then refused a valid receipt, so cleanup
 * stayed blocked after a landing that had already succeeded. The remote *name* is
 * the field the receipt records, so the URL is resolved from that name and every
 * forge command is bound to the identity that URL names. That also moves the
 * identity decision ahead of every forge call, instead of catching a foreign
 * repository only after one was issued against it.
 *
 * `cwd` is the worktree the receipt names, not the directory cleanup was called in,
 * and the caller proves that path is a live listed worktree of this repository
 * before passing it. A remote name resolves per repository, but a remote *URL*
 * resolves per worktree: `extensions.worktreeConfig` scopes `url.<other>.insteadOf`
 * to one worktree, and `git remote get-url` expands those rewrites. So the landed
 * worktree and the directory cleanup runs from can print different URLs for the
 * same name, and only one of them is the URL the landing recorded.
 *
 * The Git read runs with {@link gitObservationEnvironment}: an ambient `GIT_DIR`,
 * `GIT_WORK_TREE`, or `GIT_CONFIG_*` selector decides which repository's remotes
 * are read, which is the same substitution by another route. The forge reads run
 * with {@link forgeEnvironment} and, on GitLab, an explicitly pinned canonical
 * host, and they are given no working directory at all: the repository is named
 * in the request, and nothing about the answer may depend on any directory.
 *
 * Every part of the identity is refused rather than guessed at: a receipt whose
 * remote is not a remote name, names no configured remote, names a host no
 * adapter verifies, names a different forge than the receipt recorded, carries no
 * `<owner>/<name>`, or names a repository other than the one the receipt proves is
 * not an observation. The last of those is the cross-check that makes a receipt
 * non-transferable: it is decided here, before one forge command is issued, so a
 * receipt carried into another checkout asks that checkout's forge nothing.
 */
function resolveRemoteIdentity(
	receipt: LandingReceipt,
	run: CliRunner,
	cwd: string,
	forgeEnv: Readonly<Record<string, string>>,
	env: NodeJS.ProcessEnv,
): RemoteIdentity | CleanupFailure {
	// Tested exactly as recorded, not trimmed first: `" origin"` is not the name of a
	// remote, it is a receipt that does not say which remote, and normalising it here
	// would let this call answer a question the receipt never asked.
	const remote = receipt.repo.remote;
	if (!REMOTE_NAME.test(remote)) return refuse("repo.remote", remote, "a git remote name");
	const argv = ["git", "remote", "get-url", remote];
	const expected = `exactly one URL record for the configured remote ${remote} in ${cwd}`;
	const result = run(argv, { cwd, timeoutMs: LOCAL_TIMEOUT_MS, env: gitObservationEnvironment(env) });
	if (!completed(result)) return commandFailure("repo.remote", argv, result, expected);
	// Not trimmed: a trimmed value is what lets a malformed one through. `URL` deletes
	// embedded tabs and newlines before parsing, so a rewritten or multi-URL remote can
	// read as an ordinary forge URL here while Git contacts something else — and this
	// identity then authorises a removal whose absence probe can only ever say
	// "unknown". One terminal newline is a record terminator; everything else refuses.
	//
	// The refusal names the shape, never the bytes. A remote URL may carry userinfo or a
	// token query, and output that no parser here accepts cannot be redacted either:
	// {@link redactRemote} can only locate a secret in a spelling it understands, so
	// echoing an unparseable value would publish whatever it holds into a refusal
	// message and into any log that quotes one.
	const remoteText = singleRemoteRecord(result.stdout);
	if (remoteText === null) return refuse("repo.remote", "malformed Git remote output", expected);
	// Classified before it is redacted: `forgeTarget` owns that judgement and must
	// see the spelling Git will actually contact.
	const target = forgeTarget(remoteText);
	const remoteUrl = redactRemote(remoteText);
	if (target === null) {
		return refuse("repo.forge", `"unknown" for remote ${remote} at ${show(remoteUrl)}`, '"github" or "gitlab"');
	}
	const forgeFailure = compare("repo.forge", target.forge, receipt.repo.forge);
	if (forgeFailure !== null) return forgeFailure;
	const fromRemote = repoPathFromRemote(remoteText);
	const nameWithOwner = fromRemote === null ? null : normalizeRepoPath(target.forge, fromRemote);
	if (nameWithOwner === null) {
		const shape = target.forge === "github" ? 'exactly "<owner>/<name>"' : 'a bounded "<group>/.../<project>" path';
		return refuse("repo.nameWithOwner", fromRemote, `${shape} from remote ${remote} at ${show(remoteUrl)}`);
	}
	const identityFailure = compare("repo.nameWithOwner", nameWithOwner, receipt.repo.nameWithOwner);
	if (identityFailure !== null) return identityFailure;
	// Both forges are addressed by canonical host and path, and both have that host
	// pinned in the environment as well. The host is not caller data: it is the
	// verified value `forgeTarget` returned for the transport host Git will contact,
	// so `gh` and `glab` are told the same thing twice and can infer neither from a
	// configured alias nor from the directory.
	const cliRepo = `${target.canonicalHost}/${nameWithOwner}`;
	const commandEnv = Object.assign(
		Object.create(null) as Record<string, string>,
		forgeEnv,
		target.forge === "github"
			? { GH_HOST: target.canonicalHost }
			: { GITLAB_HOST: target.canonicalHost, GITLAB_API_HOST: target.canonicalHost },
	);
	// `remoteText`, not the redacted spelling: the absence probe has to contact what
	// Git contacted, and it is the one consumer allowed to hold the raw URL.
	return { forge: target.forge, nameWithOwner, cliRepo, remoteUrl: remoteText, env: commandEnv };
}

function githubObservation(
	receipt: LandingReceipt,
	identity: RemoteIdentity,
	run: CliRunner,
): PullRequestObservation | CleanupFailure {
	const argv = ["gh", "pr", "view", String(receipt.pr.number), "--repo", identity.cliRepo, "--json", PR_FIELDS];
	const method = argv.slice(0, 3).join(" ");
	const result = run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env: identity.env });
	if (!completed(result)) return commandFailure("pr", argv, result, "a successful bounded GitHub pull-request read");
	const root = parseJsonObject("pr", result);
	if (isFailure(root)) return root;
	const mergeCommit = record(own(root, "mergeCommit"));
	return {
		number: integer(root, "number") ?? -1,
		url: text(root, "url") ?? "",
		state: text(root, "state") ?? "",
		baseRefName: text(root, "baseRefName") ?? "",
		headRefName: text(root, "headRefName") ?? "",
		headRefOid: text(root, "headRefOid") ?? "",
		mergeCommitOid: mergeCommit === null ? null : normalizedOid(own(mergeCommit, "oid")),
		mergedAt: text(root, "mergedAt"),
		method,
	};
}

function gitlabObservation(
	receipt: LandingReceipt,
	identity: RemoteIdentity,
	run: CliRunner,
): PullRequestObservation | CleanupFailure {
	const argv = ["glab", "mr", "view", String(receipt.pr.number), "--repo", identity.cliRepo, "--output", "json"];
	const method = argv.slice(0, 3).join(" ");
	const result = run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env: identity.env });
	if (!completed(result)) return commandFailure("pr", argv, result, "a successful bounded GitLab merge-request read");
	const root = parseJsonObject("pr", result);
	if (isFailure(root)) return root;
	const mergeCommit = normalizedOid(own(root, "merge_commit_sha"));
	return {
		number: integer(root, "iid") ?? -1,
		url: text(root, "web_url") ?? "",
		state: text(root, "state") ?? "",
		baseRefName: text(root, "target_branch") ?? "",
		headRefName: text(root, "source_branch") ?? "",
		headRefOid: text(root, "sha") ?? "",
		mergeCommitOid: mergeCommit ?? normalizedOid(own(root, "squash_commit_sha")),
		mergedAt: text(root, "merged_at"),
		method,
	};
}

/** One resolved repository identity and the pull request read through it. */
type Observation = { identity: RemoteIdentity; pr: PullRequestObservation };

export function observePullRequest(
	receipt: LandingReceipt,
	run: CliRunner = runCli,
	cwd: string = receipt.repo.canonicalRoot,
	env: NodeJS.ProcessEnv = process.env,
): Observation | CleanupFailure {
	const identity = resolveRemoteIdentity(receipt, run, cwd, forgeEnvironment(env), env);
	if (isFailure(identity)) return identity;
	const pr = identity.forge === "github"
		? githubObservation(receipt, identity, run)
		: gitlabObservation(receipt, identity, run);
	return isFailure(pr) ? pr : { identity, pr };
}

function compare(field: string, observed: unknown, expected: unknown): CleanupFailure | null {
	return observed === expected ? null : refuse(field, observed, `receipt value ${show(expected)}`);
}

/**
 * Whether the observation is the landing the receipt proves.
 *
 * Only the pull request is compared here. The repository it was read from is not
 * one of the comparisons, because it was never in doubt: the read was bound to the
 * identity {@link resolveRemoteIdentity} had already matched against the receipt.
 */
function verifyObservation(receipt: LandingReceipt, observed: PullRequestObservation): CleanupFailure | null {
	const observedState = observed.state.trim().toUpperCase();
	const receiptState = receipt.pr.state.trim().toUpperCase();
	const comparisons: readonly [string, unknown, unknown][] = [
		["pr.number", observed.number, receipt.pr.number],
		["pr.url", observed.url, receipt.pr.url],
		["pr.state", observedState, "MERGED"],
		["receipt.pr.state", receiptState, "MERGED"],
		["pr.baseRefName", observed.baseRefName, receipt.pr.baseRefName],
		["pr.headRefName", observed.headRefName, receipt.pr.headRefName],
		["pr.headRefOid", observed.headRefOid, receipt.pr.headRefOid],
		["pr.mergeCommitOid", observed.mergeCommitOid, receipt.pr.mergeCommitOid],
		["pr.mergedAt", observed.mergedAt, receipt.pr.mergedAt],
	];
	for (const [field, actual, expected] of comparisons) {
		const failure = compare(field, actual, expected);
		if (failure !== null) return failure;
	}
	if (observed.headRefName !== receipt.branch.name) {
		return refuse("pr.headRefName", observed.headRefName, `receipt branch.name ${show(receipt.branch.name)}`);
	}
	return null;
}
type ReceiptDirectoryState = "safe" | "absent" | "unsafe";

function receiptDirectoryState(directory: string): ReceiptDirectoryState {
	const chain: string[] = [];
	let current = resolve(directory);
	for (;;) {
		chain.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	chain.reverse();
	for (const path of chain) {
		let stat: Stats;
		try {
			stat = lstatSync(path);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe";
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
	}
	return "safe";
}

function canonicalReceiptPath(raw: string, cwd: string, directory: string): string | CleanupFailure {
	const target = resolve(cwd, raw);
	if (dirname(target) !== directory) return refuse("receipt.path", target, `a direct entry under ${show(directory)}`);
	const directoryState = receiptDirectoryState(directory);
	if (directoryState !== "safe") {
		return refuse("receipt.directory", `${directory} (${directoryState})`, "an existing path with only non-symlink directory parents");
	}
	let stat: Stats;
	try {
		stat = lstatSync(target);
	} catch {
		return refuse("receipt.path", target, "an existing canonical non-symlink receipt file");
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		return refuse("receipt.path", target, "a canonical non-symlink regular receipt file");
	}
	return target;
}

function resolveReceipt(params: DeliveryCleanupParams, cwd: string, env: NodeJS.ProcessEnv): ReceiptResolution {
	const key = repoKey(cwd);
	if (key === null) {
		return { tag: "refused", failure: refuse("repo.key", null, "a repository key derived from the current Git common directory") };
	}
	const directory = resolve(receiptDirectory(env, key));
	let receipt: LandingReceipt | null = null;
	if (params.receipt !== undefined) {
		const path = canonicalReceiptPath(params.receipt, cwd, directory);
		if (typeof path !== "string") return { tag: "refused", failure: path };
		const read = readReceipt(path);
		if (!read.ok) return { tag: "refused", failure: { ok: false, reason: read.reason } };
		receipt = read.receipt;
	} else {
		const state = receiptDirectoryState(directory);
		if (state === "unsafe") {
			return {
				tag: "refused",
				failure: refuse("receipt.directory", `${directory} (unsafe)`, "an existing path with only non-symlink directory parents"),
			};
		}
		const matches = state === "safe" ? listReceipts(directory, { pr: params.pr, branch: params.branch }) : [];
		receipt = matches[0] ?? null;
	}
	if (receipt === null) {
		const selector = params.pr !== undefined
			? `pr ${params.pr}`
			: params.branch !== undefined
				? `branch ${show(params.branch)}`
				: `repo.key ${key}`;
		return { tag: "refused", failure: refuse("receipt", null, `the newest validated receipt for ${selector}`) };
	}
	if (receipt.repo.key !== key) {
		return { tag: "refused", failure: refuse("repo.key", receipt.repo.key, `current repository key ${key}`) };
	}
	if (receipt.worktree.path === null) {
		return { tag: "refused", failure: refuse("worktree.path", null, "a linked-worktree path recorded by the receipt") };
	}
	if (receipt.worktree.removed) {
		return {
			tag: "refused",
			failure: refuse(
				"worktree.path",
				`${receipt.worktree.path} (absent after prior cleanup)`,
				"a present linked worktree not already cleaned",
			),
		};
	}
	return { tag: "resolved", receipt };
}

function verifyArguments(params: DeliveryCleanupParams, receipt: LandingReceipt): CleanupFailure | null {
	const requested: readonly [string, unknown, unknown][] = [
		["pr", params.pr, receipt.pr.number],
		["branch", params.branch, receipt.branch.name],
		["worktree", params.worktree, receipt.worktree.path],
		["remote", params.remote, receipt.repo.remote],
	];
	for (const [field, supplied, expected] of requested) {
		if (supplied === undefined) continue;
		const failure = compare(field, supplied, expected);
		if (failure !== null) return failure;
	}
	return null;
}

function runGit(run: CliRunner, cwd: string, args: string[]): CliResult {
	return run(["git", ...args], { cwd, timeoutMs: LOCAL_TIMEOUT_MS });
}

function worktreePathState(path: string): "directory" | "absent" | "unsafe" {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe";
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
	try {
		realpathSync(path);
		return "directory";
	} catch {
		return "unsafe";
	}
}

function dirtyPaths(output: string): string[] {
	return output
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => line.length > 3 ? line.slice(3) : line)
		.slice(0, MAX_DIRTY_PATHS);
}

function verifyCleanTarget(path: string, run: CliRunner): CleanupFailure | null {
	const state = worktreePathState(path);
	if (state !== "directory") return refuse("worktree.path", `${path} (${state})`, "a present non-symlink directory");
	const argv = ["status", "--porcelain"];
	const result = runGit(run, path, argv);
	if (!completed(result)) return commandFailure("worktree.status", ["git", ...argv], result, "exit 0 with empty output");
	if (result.stdout !== "") {
		const all = result.stdout.split(/\r?\n/).filter(Boolean);
		return refuse("worktree.status", { paths: dirtyPaths(result.stdout), total: all.length }, "no dirty paths (empty porcelain output)");
	}
	return null;
}

function verifyPushed(path: string, run: CliRunner): CleanupFailure | null {
	const upstreamArgv = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
	const upstream = runGit(run, path, upstreamArgv);
	if (!completed(upstream) || upstream.stdout.trim() === "") {
		return commandFailure("branch.upstream", ["git", ...upstreamArgv], upstream, "a configured upstream branch");
	}
	const countArgv = ["rev-list", "--count", "@{upstream}..HEAD"];
	const countResult = runGit(run, path, countArgv);
	if (!completed(countResult)) {
		return commandFailure("branch.unpushed", ["git", ...countArgv], countResult, "exit 0 and count 0");
	}
	const raw = countResult.stdout.trim();
	const count = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(count)) return refuse("branch.unpushed", raw, "a non-negative integer count");
	if (count !== 0) return refuse("branch.unpushed", count, "0 commits above the upstream");
	return null;
}

function unwrapEnvelope(value: unknown): unknown {
	const root = record(value);
	if (root === null || own(root, "schema_version") === undefined) return value;
	return own(root, "data");
}

/**
 * The reconciliation gate: classify the ledger at the canonical root, require the
 * receipt to agree, and then require every bead it names to be closed against this
 * merge.
 *
 * The stored boolean is never the gate on its own. A receipt is a file written by an
 * earlier call, possibly from a different directory and possibly tampered with, and
 * `beads.ledgerActive: false` read straight off it used to return success here — so
 * landing from a directory shadowed by a nested retired `.beads` and cleaning from
 * the repository whose canonical ledger is active removed the worktree and deleted
 * the branch with no `bd_reconcile` while the authoritative bead stayed open. The
 * classification is therefore recomputed on every call, at the canonical root
 * {@link canonicalLedger} derives, and a disagreement refuses naming both values.
 *
 * A repository that cannot be classified refuses too: an unclassifiable ledger is
 * not an absent one, and the only irreversible step in this tool is on the other
 * side of this check.
 *
 * An active ledger with no bead ids is not handled here. `validateReceipt` refuses
 * that pair at the trust boundary, so a receipt read by this tool never carries it.
 */
function verifyLedger(receipt: LandingReceipt, cwd: string, run: CliRunner): CleanupFailure | null {
	const classification = canonicalLedger(cwd);
	if (classification === null) {
		return refuse(
			"beads.ledgerActive",
			`no ledger classification from ${cwd}`,
			"a repository whose canonical root can be resolved, so the receipt's ledger claim can be recomputed rather than trusted",
		);
	}
	if (classification.active !== receipt.beads.ledgerActive) {
		return {
			ok: false,
			reason: `beads.ledgerActive: observed ${receipt.beads.ledgerActive} stored in the receipt, expected ${classification.active}, recomputed at canonical root ${show(classification.root)}; ${
				classification.active
					? "this repository's ledger is active, so run bd_reconcile to write it from the receipt and then delivery_cleanup"
					: "the receipt was written against a ledger this repository does not have, so bd_reconcile cannot record it and nothing was removed"
			}`,
		};
	}
	if (!classification.active) return null;
	const argv = ["bd", "show", ...receipt.beads.ids, "--json"];
	const result = run(argv, {
		cwd,
		timeoutMs: LOCAL_TIMEOUT_MS,
		env: { ...process.env, BD_JSON_ENVELOPE: "1", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
	});
	if (!completed(result)) return commandFailure("beads", argv, result, "a successful read-only bd show");
	if (Buffer.byteLength(result.stdout) > MAX_CLI_JSON_BYTES) {
		return refuse("beads", `JSON over ${MAX_CLI_JSON_BYTES} bytes`, `at most ${MAX_CLI_JSON_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = unwrapEnvelope(JSON.parse(result.stdout));
	} catch {
		return refuse("beads", "unparseable JSON", "an issue array from read-only bd show");
	}
	if (!Array.isArray(parsed)) return refuse("beads", parsed, "an issue array from read-only bd show");
	const rows = new Map<string, Record<string, unknown>>();
	for (const item of parsed) {
		const issue = record(item);
		const id = issue === null ? null : text(issue, "id");
		if (issue === null || id === null) return refuse("beads", item, "issues with string ids");
		const prior = rows.get(id);
		if (prior !== undefined && !isDeepStrictEqual(prior, issue)) {
			return refuse(`beads.${id}`, [prior, issue], "duplicate bd show rows for one bead id to be identical");
		}
		if (prior === undefined) rows.set(id, issue);
	}
	for (const id of receipt.beads.ids) {
		const issue = rows.get(id);
		if (issue === undefined) return refuse(`beads.${id}`, null, "a bead returned by bd show; run bd_reconcile");
		const status = text(issue, "status");
		if (status !== "closed") return refuse(`beads.${id}.status`, status, '"closed" after bd_reconcile');
		const metadata = record(own(issue, "metadata"));
		const mergeSha = metadata === null ? undefined : own(metadata, "merge_sha");
		if (typeof mergeSha !== "string" || mergeSha !== receipt.pr.mergeCommitOid) {
			return refuse(
				`beads.${id}.metadata.merge_sha`,
				mergeSha,
				`receipt pr.mergeCommitOid ${show(receipt.pr.mergeCommitOid)} after bd_reconcile`,
			);
		}
	}
	return null;
}

export function parseWorktreeList(output: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let current: WorktreeRecord | null = null;
	for (const line of output.split("\n")) {
		if (line === "") {
			if (current !== null) records.push(current);
			current = null;
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (current !== null) records.push(current);
			current = { path: line.slice(9), head: "", branch: null, detached: false, prunable: false };
			continue;
		}
		if (current === null) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice(5);
		else if (line.startsWith("branch ")) current.branch = line.slice(7);
		else if (line === "detached") current.detached = true;
		else if (line.startsWith("prunable")) current.prunable = true;
	}
	if (current !== null) records.push(current);
	return records;
}

function readWorktrees(cwd: string, run: CliRunner): WorktreeRecord[] | CleanupFailure {
	const argv = ["worktree", "list", "--porcelain"];
	const result = runGit(run, cwd, argv);
	if (!completed(result)) return commandFailure("worktree.list", ["git", ...argv], result, "exit 0 porcelain records");
	const records = parseWorktreeList(result.stdout);
	if (records.length === 0) return refuse("worktree.list", [], "at least the repository's main worktree");
	const malformed = records.find(item => item.path === "" || !isAbsolute(item.path));
	if (malformed !== undefined) return refuse("worktree.list.path", malformed.path, "a non-empty absolute path in every record");
	return records;
}

function isInsidePhysicalRepository(target: string, cwd: string): boolean {
	return repoKey(target) !== null && repoKey(target) === repoKey(cwd);
}

function physicalPath(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * Whether this call was made from inside the worktree it would remove.
 *
 * `git worktree remove` aimed at the caller's own directory leaves the process
 * standing in a deleted path, and every absence check after that point is then
 * answered from somewhere that no longer exists — so the removal is both the
 * destruction and the loss of its own proof. Comparison is by realpath and by
 * containment: a subdirectory of the target is inside the target, and a symlinked
 * alias of either resolves to the same place.
 *
 * A path that does not resolve is not treated as inside: the later listing and
 * directory checks refuse an unresolvable target by name, and guessing here would
 * hide that refusal behind a less specific one.
 */
function invocationInsideTarget(cwd: string, target: string): boolean {
	const invocation = physicalPath(cwd);
	const resolved = physicalPath(target);
	if (invocation === null || resolved === null) return false;
	return invocation === resolved || invocation.startsWith(`${resolved}${sep}`);
}

function recordForTarget(records: WorktreeRecord[], target: string): WorktreeRecord | null {
	const expected = physicalPath(target);
	if (expected === null) return null;
	for (const item of records) {
		if (physicalPath(item.path) === expected) return item;
	}
	return null;
}

function storedRecordForTarget(records: WorktreeRecord[], target: string): WorktreeRecord | null {
	const expected = resolve(target);
	for (const item of records) {
		if (resolve(item.path) === expected) return item;
	}
	return null;
}

function verifyTargetIdentity(
	receipt: LandingReceipt,
	cwd: string,
	run: CliRunner,
): TargetIdentity | CleanupFailure {
	const path = receipt.worktree.path as string;
	const listed = readWorktrees(cwd, run);
	if (!Array.isArray(listed)) return listed;
	const main = listed[0];
	if (main === undefined) return refuse("worktree.list", [], "a main worktree record");
	if (physicalPath(path) === physicalPath(main.path)) return refuse("worktree.path", path, `a linked worktree other than main ${show(main.path)}`);
	if (!isInsidePhysicalRepository(path, cwd)) return refuse("worktree.path", path, "a worktree in the current repository");
	const target = recordForTarget(listed, path);
	if (target === null || target.prunable) return refuse("worktree.path", path, "an exact live record in git worktree list --porcelain");
	if (target.detached) return refuse("worktree.branch", "detached", `branch ${show(receipt.branch.name)}`);
	const expectedRef = `${LOCAL_REF_PREFIX}${receipt.branch.name}`;
	const branchFailure = compare("worktree.branch", target.branch, expectedRef);
	if (branchFailure !== null) return branchFailure;
	const headFailure = compare("worktree.HEAD", target.head, receipt.pr.headRefOid);
	if (headFailure !== null) return headFailure;
	if (worktreePathState(path) !== "directory") {
		return refuse("worktree.path", `${path} (unsafe)`, "the listed non-symlink directory");
	}
	return { records: listed, target, main };
}

function verifyLocalRef(receipt: LandingReceipt, cwd: string, run: CliRunner): CleanupFailure | null {
	const ref = `${LOCAL_REF_PREFIX}${receipt.branch.name}`;
	const argv = ["rev-parse", "--verify", ref];
	const result = runGit(run, cwd, argv);
	if (!completed(result)) return commandFailure("branch.localRef", ["git", ...argv], result, `exit 0 and oid ${receipt.pr.headRefOid}`);
	return compare("branch.localRef", result.stdout.trim(), receipt.pr.headRefOid);
}

function revalidateBoundary(receipt: LandingReceipt, cwd: string, run: CliRunner): TargetIdentity | CleanupFailure {
	const identity = verifyTargetIdentity(receipt, cwd, run);
	if (isFailure(identity)) return identity;
	const ref = verifyLocalRef(receipt, cwd, run);
	if (ref !== null) return ref;
	const clean = verifyCleanTarget(identity.target.path, run);
	if (clean !== null) return clean;
	const pushed = verifyPushed(identity.target.path, run);
	return pushed ?? identity;
}

function registrationAbsence(cwd: string, trustedPath: string, run: CliRunner): Absence {
	const listed = readWorktrees(cwd, run);
	if (!Array.isArray(listed)) return "unknown";
	return storedRecordForTarget(listed, trustedPath) === null ? "absent" : "present";
}

function pathAbsence(path: string): Absence {
	try {
		lstatSync(path);
		return "present";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
	}
}

function localRefAbsence(cwd: string, branch: string, run: CliRunner): Absence {
	const result = runGit(run, cwd, ["show-ref", "--verify", "--quiet", `${LOCAL_REF_PREFIX}${branch}`]);
	if (result.error !== undefined || !result.ok) return "unknown";
	if (result.exitCode === 0) return "present";
	if (result.exitCode === 1 && result.stdout === "" && result.stderr === "") return "absent";
	return "unknown";
}

function safeExecutionCwd(receipt: LandingReceipt, records: WorktreeRecord[], invocationCwd: string): string | null {
	const target = physicalPath(receipt.worktree.path as string);
	const preferred = records.find(item =>
		item.branch === `${LOCAL_REF_PREFIX}${receipt.pr.baseRefName}` && physicalPath(item.path) !== target,
	);
	if (preferred !== undefined && worktreePathState(preferred.path) === "directory") return preferred.path;
	const invocation = records.find(item => physicalPath(item.path) === physicalPath(invocationCwd) && physicalPath(item.path) !== target);
	if (invocation !== undefined && worktreePathState(invocation.path) === "directory") return invocation.path;
	const main = records[0];
	return main !== undefined && physicalPath(main.path) !== target && worktreePathState(main.path) === "directory" ? main.path : null;
}

function nextReceiptEpoch(receipt: LandingReceipt, now: () => number): number {
	const observed = Math.trunc(now());
	const prior = Date.parse(receipt.emittedAt);
	return Math.max(observed, Number.isFinite(prior) ? prior + 1 : observed);
}
export function branchDeleteArgs(branch: string): string[] {
	return ["branch", "-d", "--", branch];
}

export function cleanupDelivery(
	params: DeliveryCleanupParams,
	cwd: string,
	deps: CleanupDeps = {},
): CleanupResult {
	const run = deps.run ?? runCli;
	const now = deps.now ?? Date.now;
	const env = deps.env ?? process.env;
	const resolution = resolveReceipt(params, cwd, env);
	if (resolution.tag === "refused") return resolution.failure;
	const receipt = resolution.receipt;

	const argsFailure = verifyArguments(params, receipt);
	if (argsFailure !== null) return argsFailure;
	if (typeof receipt.pr.mergeCommitOid !== "string" || receipt.pr.mergeCommitOid.trim() === "") {
		return refuse("pr.mergeCommitOid", receipt.pr.mergeCommitOid, "a non-empty merge commit oid before cleanup");
	}
	// Before any observation, and long before the irreversible step: a call from inside
	// its own target can neither remove it safely nor verify the removal afterwards.
	if (invocationInsideTarget(cwd, receipt.worktree.path as string)) {
		return refuse(
			"worktree.invocationCwd",
			cwd,
			`a directory outside the worktree this call would remove (${receipt.worktree.path}, resolved to ${physicalPath(receipt.worktree.path as string)})`,
		);
	}
	// The target's identity is proved before the pull request is read, because the read
	// has to be made from inside the target. With `extensions.worktreeConfig`, a
	// `url.<other>.insteadOf` rewrite is worktree-scoped, and `git remote get-url`
	// expands those rewrites: the same remote name resolves to one repository in the
	// landed worktree and another here. The URL the landing recorded is the one its own
	// worktree resolves, so resolving it anywhere else refuses a valid receipt and
	// leaves that worktree permanently unremovable.
	//
	// This is a read: `git worktree list --porcelain` and one `lstat`. It proves the
	// path is a live, listed, non-symlink linked worktree of this repository on the
	// receipt's branch and head before it is used as a directory to run a command in,
	// and `revalidateBoundary` proves the same identity again immediately before the
	// irreversible step.
	const identity = verifyTargetIdentity(receipt, cwd, run);
	if (isFailure(identity)) return identity;
	const observed = observePullRequest(receipt, run, identity.target.path, env);
	if (isFailure(observed)) return observed;
	const observedFailure = verifyObservation(receipt, observed.pr);
	if (observedFailure !== null) return observedFailure;

	const path = receipt.worktree.path as string;
	const dirty = verifyCleanTarget(path, run);
	if (dirty !== null) return dirty;
	const pushed = verifyPushed(path, run);
	if (pushed !== null) return pushed;
	const ledger = verifyLedger(receipt, cwd, run);
	if (ledger !== null) return ledger;
	const localRef = verifyLocalRef(receipt, cwd, run);
	if (localRef !== null) return localRef;
	const boundary = revalidateBoundary(receipt, cwd, run);
	if (isFailure(boundary)) return boundary;

	const executionCwd = safeExecutionCwd(receipt, boundary.records, cwd);
	if (executionCwd === null) return refuse("worktree.executionCwd", null, "a different listed worktree for the same repository");
	const targetPath = boundary.target.path;
	const removeArgv = ["worktree", "remove", targetPath];
	const removed = runGit(run, executionCwd, removeArgv);
	if (!completed(removed)) {
		return commandFailure("worktree.removed", ["git", ...removeArgv], removed, "exit 0 without --force");
	}

	const registration = registrationAbsence(executionCwd, targetPath, run);
	const pathGone = pathAbsence(targetPath);
	if (registration !== "absent") return refuse("worktree.registrationAbsence", registration, '"absent" after removal');
	if (pathGone !== "absent") return refuse("worktree.pathAbsence", pathGone, '"absent" after removal');

	const refAfterWorktree = verifyLocalRef(receipt, executionCwd, run);
	if (refAfterWorktree !== null) return refAfterWorktree;
	const deleteArgv = branchDeleteArgs(receipt.branch.name);
	const deleted = runGit(run, executionCwd, deleteArgv);
	if (!completed(deleted)) {
		return commandFailure("worktree.localRefDeleted", ["git", ...deleteArgv], deleted, "exit 0 without -D");
	}
	const localAbsence = localRefAbsence(executionCwd, receipt.branch.name, run);
	if (localAbsence !== "absent") return refuse("worktree.localRefAbsence", localAbsence, '"absent" after branch -d');

	// The probe is given the URL the target resolved, not `repo.remote`. A name is
	// re-resolved wherever it is asked, and by now the target is gone, so the question
	// would be answered through a surviving worktree's configuration: one
	// worktree-scoped `insteadOf` there and `git ls-remote` asks a different repository,
	// whose exit 2 would be recorded as verified absence of a branch that still exists.
	// A false absence is the one verdict this tool must never invent, so the probe
	// contacts exactly what Git contacted when the identity was resolved. `cwd` is still
	// a surviving worktree: Git needs a repository for the protocol and helper pins the
	// adapter puts on this read. The verdict comes back as a word, so the URL cannot
	// reach the receipt or a refusal.
	const remoteAbsence = remoteBranchAbsent(observed.identity.remoteUrl, receipt.branch.name, executionCwd, run);
	const issuedAt = nextReceiptEpoch(receipt, now);
	const verifiedAt = new Date(issuedAt).toISOString();
	const continued = buildReceipt({
		now: issuedAt,
		continues: receipt,
		emitter: { plugin: "@srobroek/delivery", version: DELIVERY_VERSION, tool: "delivery_cleanup" },
		repo: receipt.repo,
		pr: {
			number: observed.pr.number,
			url: observed.pr.url,
			state: observed.pr.state,
			baseRefName: observed.pr.baseRefName,
			headRefName: observed.pr.headRefName,
			headRefOid: observed.pr.headRefOid,
			mergeCommitOid: observed.pr.mergeCommitOid,
			mergedAt: observed.pr.mergedAt,
		},
		branch: {
			name: receipt.branch.name,
			deletedRemote: remoteAbsence === "absent",
			remoteAbsenceVerifiedAt: remoteAbsence === "absent" ? verifiedAt : null,
			autoDeleteSetting: receipt.branch.autoDeleteSetting,
		},
		worktree: {
			path,
			removed: true,
			localRefDeleted: true,
			absenceVerifiedAt: verifiedAt,
		},
		beads: receipt.beads,
		proof: {
			// The same field means the same thing on every receipt: the provider CLI and
			// verb that observed this landing. What this call added — four independent
			// absence verdicts — is the evidence, and `emitter.tool` names who verified it.
			method: observed.pr.method,
			observedAt: verifiedAt,
			evidence: {
				worktreeRegistration: registration,
				worktreePath: pathGone,
				localRef: localAbsence,
				remoteBranch: remoteAbsence,
			},
		},
		outcome: "cleaned",
		notes: remoteAbsence === "absent" ? undefined : `remote branch absence observed ${remoteAbsence}`,
	});
	const validation = validateReceipt(continued);
	if (!validation.ok) return { ok: false, reason: `continuation receipt: ${validation.reason}` };
	let written: string;
	try {
		written = writeReceipt(continued, receiptDirectory(env, continued.repo.key));
	} catch (error) {
		return refuse("continuation receipt write", error instanceof Error ? error.message : String(error), "one persisted validated receipt");
	}
	return { ok: true, receipt: continued, path: written, remoteBranchAbsence: remoteAbsence };
}

export default function deliveryCleanupTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "delivery_cleanup",
		label: "Clean landed worktree and branch",
		description:
			"Cleanup after the landing receipt. The lifecycle is conditional: delivery_land, then bd_reconcile, then delivery_cleanup when the ledger classification recomputed at the repository's canonical root is active; a retired or ledger-free repository goes delivery_land, then delivery_cleanup directly. " +
			"This tool recomputes that classification at the canonical root on every call and refuses when it differs from beads.ledgerActive in the receipt, naming the stored value, the recomputed value and bd_reconcile: the stored boolean alone never opens the success path. " +
			"It then resolves exact landing proof from the repository the receipt's own remote resolves to — never from whichever repository a forge CLI infers from the current directory — refuses to remove the worktree it was invoked from, removes one clean pushed worktree identified by the receipt without force, deletes its local branch with -d, records local and remote observations, and writes one continuation receipt. " +
			"The tool performs only read-only bd show calls; repository policy assigns actor ownership.",
		parameters: z.object({
			receipt: z.string().min(1).optional().describe("Path to a canonical landing receipt; omit to select the newest for this repository"),
			pr: z.number().int().positive().optional().describe("PR number, which must equal the selected receipt"),
			branch: z.string().min(1).optional().describe("Branch, which must equal the selected receipt"),
			worktree: z.string().min(1).optional().describe("Worktree path, which must equal the selected receipt"),
			remote: z.string().min(1).optional().describe("Remote name, which must equal the selected receipt"),
		}) as unknown as TSchema,
		approval: "exec",
		execute: async (_id, params: DeliveryCleanupParams, _signal, _onUpdate, ctx) => {
			const result = cleanupDelivery(params, ctx.cwd);
			return {
				content: [{ type: "text" as const, text: result.ok ? `cleaned ${result.receipt.branch.name}` : result.reason }],
				details: result,
			};
		},
	});
}
