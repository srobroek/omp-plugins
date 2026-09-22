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
	remoteBranchAbsent,
	runCli,
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
const DELIVERY_VERSION = "0.11.5";
const LOCAL_REF_PREFIX = "refs/heads/";

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
 */
type PullRequestObservation = ReceiptPr & { nameWithOwner: string; method: string };
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

const REPOSITORY_SEGMENT = /^(?=[^/]*[A-Za-z0-9])[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function repositoryPath(value: unknown, maxSegments: number): string | null {
	if (typeof value !== "string") return null;
	const segments = value.trim().split("/");
	if (segments.length < 2 || segments.length > maxSegments) return null;
	if (segments.some(segment => !REPOSITORY_SEGMENT.test(segment))) return null;
	return segments.join("/");
}

function firstRepositoryPath(holder: Record<string, unknown>, keys: readonly string[], maxSegments: number): string | null {
	for (const key of keys) {
		const path = repositoryPath(own(holder, key), maxSegments);
		if (path !== null) return path;
	}
	return null;
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

function githubObservation(
	receipt: LandingReceipt,
	run: CliRunner,
	cwd: string,
	env: Readonly<Record<string, string>>,
): PullRequestObservation | CleanupFailure {
	const repoArgv = ["gh", "repo", "view", "--json", "nameWithOwner"];
	const repoResult = run(repoArgv, { cwd, timeoutMs: FORGE_TIMEOUT_MS, env });
	if (!completed(repoResult)) return commandFailure("repo", repoArgv, repoResult, "a successful bounded local GitHub repository read");
	const repoRoot = parseJsonObject("repo", repoResult);
	if (isFailure(repoRoot)) return repoRoot;
	const nameWithOwner = repositoryPath(own(repoRoot, "nameWithOwner"), 2);
	if (nameWithOwner === null) {
		return refuse("repo.nameWithOwner", own(repoRoot, "nameWithOwner"), "a complete owner/name from gh repo view");
	}

	const argv = [
		"gh",
		"pr",
		"view",
		String(receipt.pr.number),
		"--repo",
		nameWithOwner,
		"--json",
		"number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
	];
	const method = argv.slice(0, 3).join(" ");
	const result = run(argv, { cwd, timeoutMs: FORGE_TIMEOUT_MS, env });
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
		nameWithOwner,
		method,
	};
}

function gitlabObservation(
	receipt: LandingReceipt,
	run: CliRunner,
	cwd: string,
	env: Readonly<Record<string, string>>,
): PullRequestObservation | CleanupFailure {
	const repoArgv = ["glab", "repo", "view", "--output", "json"];
	const repoResult = run(repoArgv, { cwd, timeoutMs: FORGE_TIMEOUT_MS, env });
	if (!completed(repoResult)) return commandFailure("repo", repoArgv, repoResult, "a successful bounded local GitLab repository read");
	const repoRoot = parseJsonObject("repo", repoResult);
	if (isFailure(repoRoot)) return repoRoot;
	const nameWithOwner = firstRepositoryPath(
		repoRoot,
		["path_with_namespace", "pathWithNamespace", "fullPath", "nameWithOwner"],
		21,
	);
	if (nameWithOwner === null) {
		return refuse("repo.nameWithOwner", repoRoot, "a complete group/project path from glab repo view");
	}

	const argv = ["glab", "mr", "view", String(receipt.pr.number), "--repo", nameWithOwner, "--output", "json"];
	const method = argv.slice(0, 3).join(" ");
	const result = run(argv, { cwd, timeoutMs: FORGE_TIMEOUT_MS, env });
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
		nameWithOwner,
		method,
	};
}

export function observePullRequest(
	receipt: LandingReceipt,
	run: CliRunner = runCli,
	cwd: string = receipt.repo.canonicalRoot,
	env: NodeJS.ProcessEnv = process.env,
): PullRequestObservation | CleanupFailure {
	const forgeEnv = forgeEnvironment(env);
	if (receipt.repo.forge === "github") return githubObservation(receipt, run, cwd, forgeEnv);
	if (receipt.repo.forge === "gitlab") return gitlabObservation(receipt, run, cwd, forgeEnv);
	return refuse("repo.forge", receipt.repo.forge, '"github" or "gitlab"');
}

function compare(field: string, observed: unknown, expected: unknown): CleanupFailure | null {
	return observed === expected ? null : refuse(field, observed, `receipt value ${show(expected)}`);
}

function verifyObservation(receipt: LandingReceipt, observed: PullRequestObservation): CleanupFailure | null {
	const observedState = observed.state.trim().toUpperCase();
	const receiptState = receipt.pr.state.trim().toUpperCase();
	const comparisons: readonly [string, unknown, unknown][] = [
		["repo.nameWithOwner", observed.nameWithOwner, receipt.repo.nameWithOwner],
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
	const observed = observePullRequest(receipt, run, cwd, env);
	if (isFailure(observed)) return observed;
	const observedFailure = verifyObservation(receipt, observed);
	if (observedFailure !== null) return observedFailure;

	const path = receipt.worktree.path as string;
	const dirty = verifyCleanTarget(path, run);
	if (dirty !== null) return dirty;
	const pushed = verifyPushed(path, run);
	if (pushed !== null) return pushed;
	const ledger = verifyLedger(receipt, cwd, run);
	if (ledger !== null) return ledger;
	const identity = verifyTargetIdentity(receipt, cwd, run);
	if (isFailure(identity)) return identity;
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

	// `repo.remote` is a remote name, so the probe is asked from the worktree the rest
	// of this call ran its Git reads in — the target is gone by now, and a name only
	// resolves inside the repository that configures it.
	const remoteAbsence = remoteBranchAbsent(receipt.repo.remote, receipt.branch.name, executionCwd, run);
	const issuedAt = nextReceiptEpoch(receipt, now);
	const verifiedAt = new Date(issuedAt).toISOString();
	const continued = buildReceipt({
		now: issuedAt,
		continues: receipt,
		emitter: { plugin: "@srobroek/delivery", version: DELIVERY_VERSION, tool: "delivery_cleanup" },
		repo: receipt.repo,
		pr: {
			number: observed.number,
			url: observed.url,
			state: observed.state,
			baseRefName: observed.baseRefName,
			headRefName: observed.headRefName,
			headRefOid: observed.headRefOid,
			mergeCommitOid: observed.mergeCommitOid,
			mergedAt: observed.mergedAt,
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
			method: observed.method,
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
			"It then resolves exact landing proof, refuses to remove the worktree it was invoked from, removes one clean pushed worktree identified by the receipt without force, deletes its local branch with -d, records local and remote observations, and writes one continuation receipt. " +
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
