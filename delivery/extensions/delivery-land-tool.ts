/**
 * `delivery_land`: prove a pull request landed, then emit exactly one receipt.
 *
 * The tool is the sequencing layer over two library modules and owns no proof
 * logic of its own. `forge-adapter.ts` classifies the remote, reads and writes
 * the deletion-on-merge setting, builds the merge argv, and owns the single
 * observation that can answer "is the branch gone". `landing-receipt.ts` owns the
 * receipt's shape, its identity, its validation, and its atomic publication. What
 * is left here is order, refusal, and the mapping from two forge dialects onto the
 * receipt's `pr` fields.
 *
 * Four properties this file exists to hold.
 *
 * A merge is issued at most once, and only against the exact subject that was
 * read. A pull request the forge already reports as MERGED is proved, not merged
 * again: no merge argv is built, and the receipt says so in its notes. On the merge
 * path every command binds its repository with `--repo` and the merge binds the
 * first observed head — `--match-head-commit` on GitHub, `--sha` on GitLab — so
 * neither the working directory nor an ambient `GH_REPO` or `GH_HOST` chooses what
 * lands, and a push between the read and the merge fails the merge at the forge
 * instead of landing a commit nobody here observed. Every payload is checked to
 * carry the requested number, and the re-read must still show that head on that
 * base. The proof is the re-read, never the merge's own exit status: a zero exit is
 * a request that was accepted, not an observation of state.
 *
 * Nothing is written before the proof exists. An `expectHeadSha` that disagrees
 * with the observed head, a payload for another pull request, a head or base that
 * moved between the two reads, a re-read that is not MERGED, a merge commit oid
 * that is absent, and a receipt the validator refuses each end the call with no
 * merge issued past that point and no file created. Every refusal names the field,
 * the observed value, and what was expected.
 *
 * A setting changes only when a caller asks for it. `setupAutoDelete` must be
 * exactly `true` to reach {@link enableAutoDelete}; absent, false, or any other
 * value issues no repository-setting write, and the observed setting is recorded
 * either way. `"unknown"` is recorded as `"unknown"` and never promoted.
 *
 * The ledger is not this package's to write, and not this call's directory to
 * classify. Per decision omp-plugins-9ej3.1 delivery proves and beads records, so
 * this tool runs no `bd` verb at all — the receipt is the hand-off, and the result
 * text names the native bead update and close commands before `delivery_cleanup`.
 * Amendment omp-plugins-9ej3.45 fixes where the verdict comes from:
 * `beads.ledgerActive` is classified at the repository's canonical root, so a
 * nested retired `.beads` under the directory this tool was called in cannot record
 * a landing as ledger-free and send cleanup past a reconciliation that never
 * happened. On an active ledger the landing must also be able to name the bead it
 * closes, from the branch convention or from `beadId`, because a receipt with an
 * active ledger and no ids is a gate with nothing to check.
 */

import { resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import {
	allowMergeCommit,
	autoDeleteSetting,
	type CliRunner,
	enableAutoDelete,
	FORGE_TIMEOUT_MS,
	forgeEnvironment,
	forgeTarget,
	gitObservationEnvironment,
	MERGE_METHODS,
	type MergeMethod,
	mergeArgs,
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
	type CanonicalLedger,
	type LandingReceipt,
	RECEIPT_METHOD_UNKNOWN,
	REPOSITORY_OBSERVATION_ARGS,
	type ReceiptAutoDelete,
	receiptDirectory,
	repositoryContext,
	validateReceipt,
	writeReceipt,
} from "./landing-receipt.ts";

/** Wall-clock ceiling for the local Git reads this file issues itself. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * What a pull request number may be before it becomes an argv element.
 *
 * {@link mergeArgs} applies the same rule to the merge argv. It is applied here
 * too, and earlier, because the read that precedes the merge also puts the number
 * on a command line, and a value beginning with `-` is read as an option there
 * just as readily.
 */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * The branch convention that names the work a landing closes.
 *
 * `omp/agent/<bead-id>` is where this estate puts bead ids, so a branch following it
 * needs no `beadId` argument. A branch that does not follow it records no id from
 * the convention, and on a repository whose canonical ledger is active the landing
 * then refuses unless the caller supplies one: a receipt claiming an active ledger
 * with nothing to reconcile would send cleanup past a gate that never ran.
 */
const AGENT_BRANCH = /^omp\/agent\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * What an explicit `beadId` may be.
 *
 * The value is recorded in a receipt that `delivery_cleanup` passes to `bd show` as
 * an argv element, so it is shape-checked here rather than where it is spent: the
 * same charset the branch convention captures, and never a leading `-`.
 */
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The GitHub fields a landing proof needs, in one `--json` projection. */
const PR_FIELDS = "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt";

/**
 * A whole Git object id, in the lower-case hex both forges print.
 *
 * Only a whole id can bind a merge: `gh pr merge --match-head-commit` and
 * `glab mr merge --sha` compare the value they are given against the source head,
 * and an abbreviation or a ref name is a value the forge will not match, which is
 * indistinguishable from not binding at all.
 */
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;


export type LandParams = {
	pr: number | string;
	repo?: string;
	remote?: string;
	expectHeadSha?: string;
	setupAutoDelete?: boolean;
	worktree?: string;
	/**
	 * The bead this landing closes, for a branch the `omp/agent/<bead-id>` convention
	 * does not name. Amendment omp-plugins-9ej3.45 adds it as this tool's one new
	 * input; it is not a way to override the convention's answer.
	 */
	beadId?: string;
	/** The forge landing strategy; defaults to squash for compatibility. */
	merge_method?: MergeMethod | string;
};

/**
 * Injected surroundings.
 *
 * One `run` seam covers every child process — the forge CLIs and Git alike — so a
 * test that records calls records all of them, which is what makes "issued no
 * merge argv" and "issued no `bd` argv" observable rather than argued.
 */
export type LandDeps = {
	run?: CliRunner;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** The single millisecond the receipt id, `emittedAt`, and every proof timestamp share. */
	now?: () => number;
	/** Receipt directory override. Absent, the agent directory is used. */
	receiptsDirectory?: string;
};

export type LandOutcome =
	| { ok: true; receipt: LandingReceipt; receiptPath: string; text: string; next: readonly string[] }
	| { ok: false; reason: string; text: string };

/** One observed pull request, in receipt spelling, from either forge's dialect. */
type PrObservation = {
	number: number;
	url: string;
	state: string;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	mergeCommitOid: string | null;
	mergedAt: string | null;
};

/** The observed value, named so a refusal is actionable without re-running anything. */
function show(value: unknown): string {
	if (value === undefined) return "absent";
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "object") return Array.isArray(value) ? `an array of ${value.length}` : "an object";
	return String(value);
}

function landingMethod(value: unknown): { method: MergeMethod } | { reason: string } {
	const method = value === undefined ? "squash" : value;
	if (typeof method === "string" && MERGE_METHODS.includes(method as MergeMethod)) return { method: method as MergeMethod };
	return { reason: `merge_method: observed ${show(value)}, expected one of "squash", "merge", "rebase"` };
}

/**
 * Read an own, enumerable data property.
 *
 * A forge CLI's JSON is untrusted input, so `in` and a plain member read are both
 * wrong: each consults the prototype chain, and a polluted `Object.prototype`
 * would supply a `state` or a `mergeCommit` the forge never sent. An accessor is
 * skipped rather than invoked — reading a payload must execute nothing.
 */
function ownValue(holder: unknown, key: string): unknown {
	if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(holder, key);
	if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
	return descriptor.value;
}

function stringField(holder: unknown, key: string): string | null {
	const value = ownValue(holder, key);
	return typeof value === "string" ? value : null;
}

function integerField(holder: unknown, key: string): number | null {
	const value = ownValue(holder, key);
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * A merge commit oid in canonical spelling, or null when the payload holds none.
 *
 * Case is normalised because the receipt id is built from the first 12 characters
 * and `landing-receipt.ts` mints and validates them lowercase. An empty or
 * whitespace-only field becomes null: a forge that returns `""` for an unmerged
 * request has not named a commit, and carrying `""` forward would let an empty
 * string stand in for proof.
 */
function mergeOid(value: string | null): string | null {
	if (value === null) return null;
	const trimmed = value.trim().toLowerCase();
	return trimmed === "" ? null : trimmed;
}

/**
 * Map one forge's pull-request payload onto {@link PrObservation}.
 *
 * Refuses by field name when a required field is not the type the receipt needs.
 * Emptiness is deliberately not judged here: `validateReceipt` is the one place
 * that decides what a receipt field may hold, and duplicating its rules would
 * create a second, drifting opinion.
 */
function observePr(forge: "github" | "gitlab", payload: unknown): PrObservation | { reason: string } {
	const keys =
		forge === "github"
			? { number: "number", url: "url", state: "state", base: "baseRefName", head: "headRefName", oid: "headRefOid", mergedAt: "mergedAt" }
			: { number: "iid", url: "web_url", state: "state", base: "target_branch", head: "source_branch", oid: "sha", mergedAt: "merged_at" };
	const number = integerField(payload, keys.number);
	if (number === null) return { reason: `pr.number: observed ${show(ownValue(payload, keys.number))}, expected an integer in field ${keys.number}` };
	for (const [field, key] of [
		["pr.url", keys.url],
		["pr.state", keys.state],
		["pr.baseRefName", keys.base],
		["pr.headRefName", keys.head],
		["pr.headRefOid", keys.oid],
	] as const) {
		if (stringField(payload, key) === null) {
			return { reason: `${field}: observed ${show(ownValue(payload, key))}, expected a string in field ${key}` };
		}
	}
	const merge =
		forge === "github"
			? mergeOid(stringField(ownValue(payload, "mergeCommit"), "oid"))
			: (mergeOid(stringField(payload, "merge_commit_sha")) ?? mergeOid(stringField(payload, "squash_commit_sha")));
	const mergedAt = stringField(payload, keys.mergedAt);
	return {
		number,
		url: stringField(payload, keys.url) ?? "",
		state: stringField(payload, keys.state) ?? "",
		baseRefName: stringField(payload, keys.base) ?? "",
		headRefName: stringField(payload, keys.head) ?? "",
		headRefOid: stringField(payload, keys.oid) ?? "",
		mergeCommitOid: merge,
		mergedAt: mergedAt === null || mergedAt.trim() === "" ? null : mergedAt,
	};
}

/** Read and normalise one pull request, or say why it could not be read. */
function readPr(
	run: CliRunner,
	forge: "github" | "gitlab",
	repo: string,
	pr: string,
	timeoutMs: number,
	env: Readonly<Record<string, string>>,
): { argv: string[]; pr: PrObservation } | { argv: string[]; reason: string } {
	const argv =
		forge === "github"
			? ["gh", "pr", "view", pr, "--repo", repo, "--json", PR_FIELDS]
			: ["glab", "mr", "view", pr, "--repo", repo, "--output", "json"];
	const result = run(argv, { timeoutMs, env });
	if (!result.ok || result.error !== undefined || result.exitCode !== 0) {
		const observed = result.error ?? (result.exitCode === null ? "no exit status" : `exit ${result.exitCode}`);
		const stderr = result.stderr.trim();
		const detail = stderr === "" ? "" : `; stderr: ${stderr.slice(0, 400)}`;
		return { argv, reason: `${argv.join(" ")}: observed ${observed}, expected exit 0${detail}` };
	}
	const text = result.stdout.trim();
	if (text === "") return { argv, reason: `${argv.join(" ")}: observed empty output, expected one JSON object` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { argv, reason: `${argv.join(" ")}: observed unparseable output, expected one JSON object` };
	}
	const observed = observePr(forge, parsed);
	if ("reason" in observed) return { argv, reason: `${argv.join(" ")}: ${observed.reason}` };
	return { argv, pr: observed };
}

/**
 * Whether a payload still describes the pull request this call is landing.
 *
 * `number` is checked on every read, against the number that was requested. A
 * payload for a different pull request is not a partial answer: a forge that
 * resolved the request against the wrong repository, or a `--repo` that was
 * ignored, would otherwise produce a receipt naming a landing nobody asked for.
 *
 * With `previous` given — the read the merge was bound to — the head and the base
 * must match it as well. The merge is bound to that head, so a differing head in
 * the re-read means the answer describes some other state than the one that
 * merged, and a differing base means the request was re-targeted between the two
 * reads. Both refuse: a receipt may name only what one continuous observation
 * supports.
 */
function subjectDrift(observed: PrObservation, requested: number, previous: PrObservation | null, source: string): string | null {
	if (observed.number !== requested) {
		return `${source}: observed pr.number ${show(observed.number)}, expected ${requested}`;
	}
	if (previous === null) return null;
	if (observed.headRefOid.trim().toLowerCase() !== previous.headRefOid.trim().toLowerCase()) {
		return `${source}: observed pr.headRefOid ${show(observed.headRefOid)}, expected ${show(previous.headRefOid)} — the head moved after the merge was bound to it`;
	}
	if (observed.baseRefName !== previous.baseRefName) {
		return `${source}: observed pr.baseRefName ${show(observed.baseRefName)}, expected ${show(previous.baseRefName)} — the pull request was re-targeted`;
	}
	return null;
}

type MergeShapeProof = { oid: string; parents: string[]; headReachable: boolean | null } | { reason: string };

/**
 * Prove that the observed commit has the shape requested by the landing method.
 * Merge and squash are distinguished by parent count; a merge commit must retain
 * the exact reviewed head as its second parent. Rebase is linear and additionally
 * requires the reviewed head to be reachable from the resulting tip.
 */
function mergeProof(
	pr: PrObservation,
	method: MergeMethod | null,
	run: CliRunner,
	cwd: string,
	env: Readonly<Record<string, string>>,
): MergeShapeProof {
	if (pr.state.trim().toUpperCase() !== "MERGED" || pr.mergeCommitOid === null) {
		return { reason: `observed pr.state ${show(pr.state)} and pr.mergeCommitOid ${show(pr.mergeCommitOid)}, expected state "MERGED" and a non-empty merge commit oid` };
	}
	const oid = pr.mergeCommitOid.trim().toLowerCase();
	const output = gitOutput(run, cwd, ["show", "-s", "--format=%P", oid], env);
	if (output === null) return { reason: `git show -s --format=%P ${oid}: observed no completed read, expected the merge commit's parents` };
	const text = output.trim();
	const parents = text === "" ? [] : text.split(/\s+/);
	if (parents.some(parent => !FULL_OID.test(parent))) {
		return { reason: `git show -s --format=%P ${oid}: observed malformed parent ids ${show(text)}, expected full hexadecimal object ids` };
	}
	if (method === null) {
		if (parents.length === 1) return { oid, parents, headReachable: null };
		if (parents.length === 2 && parents[1]?.toLowerCase() === pr.headRefOid.trim().toLowerCase()) return { oid, parents, headReachable: null };
		return { reason: `pre-merged request: observed ${parents.length} parents, expected one parent or two with the reviewed head as the second parent` };
	}
	if (method === "merge") {
		if (parents.length !== 2) return { reason: `merge_method "merge": observed ${parents.length} parents, expected exactly 2 with the reviewed head as the second parent` };
		if (parents[1]?.toLowerCase() !== pr.headRefOid.trim().toLowerCase()) {
			return { reason: `merge_method "merge": observed second parent ${show(parents[1])}, expected reviewed head ${show(pr.headRefOid)}` };
		}
		return { oid, parents, headReachable: null };
	}
	if (parents.length !== 1) return { reason: `merge_method "${method}": observed ${parents.length} parents, expected exactly 1 for a linear landing` };
	if (method === "squash") return { oid, parents, headReachable: null };
	const reachable = run(["git", "merge-base", "--is-ancestor", pr.headRefOid.trim().toLowerCase(), oid], { cwd, timeoutMs: GIT_TIMEOUT_MS, env });
	if (!reachable.ok || reachable.error !== undefined || reachable.exitCode !== 0) {
		const observed = reachable.error ?? (reachable.exitCode === null ? "no exit status" : `exit ${reachable.exitCode}`);
		return { reason: `merge_method "rebase": git merge-base --is-ancestor observed ${observed}, expected reviewed head ${show(pr.headRefOid)} to be reachable from ${show(oid)}` };
	}
	return { oid, parents, headReachable: true };
}

/** Exact stdout of one successful local Git read, or null when Git did not complete it. */
function gitOutput(
	run: CliRunner,
	cwd: string,
	argv: readonly string[],
	env: Readonly<Record<string, string>>,
): string | null {
	const result = run(["git", ...argv], { cwd, timeoutMs: GIT_TIMEOUT_MS, env });
	if (!result.ok || result.error !== undefined || result.exitCode !== 0) return null;
	return result.stdout;
}

/**
 * The repository's stable key, canonical checkout root, and ledger verdict.
 *
 * {@link repositoryContext} is the producer/consumer seam: this producer feeds it
 * the exact stdout from one combined common-dir/top-level Git read, while cleanup
 * invokes the same seam directly. The key, recorded root, and ledger verdict cannot
 * therefore come from different observations or layout heuristics.
 */
function observeRepository(
	run: CliRunner,
	cwd: string,
	env: Readonly<Record<string, string>>,
): { key: string; canonicalRoot: string; ledger: CanonicalLedger } | { reason: string } {
	const repository = repositoryContext(cwd, (argv, gitCwd) => gitOutput(run, gitCwd, argv, env));
	if (repository === null) {
		return {
			reason: `git ${REPOSITORY_OBSERVATION_ARGS.join(" ")} in ${cwd}: observed no unambiguous repository paths, expected absolute git common directory and checkout top level`,
		};
	}
	return { key: repository.key, canonicalRoot: repository.ledger.root, ledger: repository.ledger };
}

/** The bead ids a landing closes, read from the agent branch convention. */
export function beadIdsFromBranch(branch: string): string[] {
	const id = AGENT_BRANCH.exec(branch.trim())?.[1];
	return id === undefined ? [] : [id];
}

/**
 * The bead ids this landing closes: an explicit `beadId` when the caller gave one,
 * otherwise whatever the branch convention names.
 *
 * An explicit id wins over the convention only when the branch carries none, because
 * the two agreeing is the normal case and the two disagreeing is a caller naming a
 * bead other than the one its own branch is for — which is a mistake to report, not
 * to pick a side in.
 */
function beadIdentity(beadId: string | undefined, branch: string): { ids: string[] } | { reason: string } {
	const fromBranch = beadIdsFromBranch(branch);
	const explicit = beadId?.trim() ?? "";
	if (explicit === "") return { ids: fromBranch };
	if (!BEAD_ID.test(explicit)) {
		return { reason: `beadId: observed ${show(beadId)}, expected a bead id of letters, digits, ".", "_" or "-", starting with a letter or digit` };
	}
	if (fromBranch.length > 0 && fromBranch[0] !== explicit) {
		return {
			reason: `beadId: observed ${show(explicit)}, expected ${show(fromBranch[0])} from branch ${show(branch)}, which already names the bead this landing closes`,
		};
	}
	return { ids: [explicit] };
}

function nativeCloseoutSteps(receipt: LandingReceipt, receiptPath: string, mergeSha: string): readonly string[] {
	const commands = receipt.beads.ids.flatMap(id => [
		`bd update ${id} --set-metadata pr=${receipt.pr.number} --set-metadata merge_sha=${mergeSha}`,
		`bd close ${id} --reason "PR #${receipt.pr.number} merged as ${mergeSha}; receipt ${receiptPath}"`,
	]);
	return [...commands, "delivery_cleanup"];
}

/**
 * Why a landing with no bead identity may not be recorded, or null when it may.
 *
 * A receipt whose ledger is active and whose id list is empty claims that work was
 * landed into a repository that tracks it, and names nothing for the native close-out
 * commands. `delivery_cleanup` would then ask `bd` about an empty list and pass a
 * gate that verified nothing, so the landing refuses here instead — before the merge
 * when the branch is already known, and again before the receipt is built.
 */
function missingBeadIdentity(ids: readonly string[], branch: string, ledger: CanonicalLedger): string | null {
	if (!ledger.active || ids.length > 0) return null;
	return `beads.ids: observed no bead identity for branch ${show(branch)}, expected an "omp/agent/<bead-id>" branch or an explicit beadId; the ledger at canonical root ${show(ledger.root)} is active, so this landing has no bead for the native close-out commands`;
}

/**
 * The provider CLI and verb that observed this landing — `gh pr view`,
 * `glab mr view` — taken from the argv of the read that proved it.
 *
 * Read off the issued command rather than composed from the forge name, so
 * `proof.method` cannot describe a command this tool did not run. An argv that names
 * no CLI and verb yields {@link RECEIPT_METHOD_UNKNOWN}, which `validateReceipt`
 * refuses to combine with `outcome: "landed"`.
 */
function observationMethod(argv: readonly string[]): string {
	const head = argv.slice(0, 3);
	const named = head.length === 3 && head.every(element => element !== "" && !/\s/.test(element));
	return named ? head.join(" ") : RECEIPT_METHOD_UNKNOWN;
}

/**
 * Land one pull request and emit its receipt.
 *
 * The whole tool, as a function, so every refusal and every issued argv is
 * observable from a test without a host session.
 */
export function landPullRequest(params: LandParams, deps: LandDeps = {}): LandOutcome {
	const run = deps.run ?? runCli;
	const cwd = deps.cwd ?? process.cwd();
	const env = deps.env ?? process.env;
	const forgeEnv = forgeEnvironment(env);
	const gitEnv = gitObservationEnvironment(env);
	// Every adapter call runs with the same neutralised environment, except where the
	// adapter passes one of its own: `remoteBranchAbsent` hardens Git's environment
	// itself, and that choice belongs to the module that owns the observation.
	const forgeRun: CliRunner = (argv, options) => run(argv, { ...options, env: options.env ?? forgeEnv });
	const now = deps.now?.() ?? Date.now();
	const observedAt = new Date(now).toISOString();
	const refuse = (reason: string): LandOutcome => ({ ok: false, reason, text: `delivery_land refused: ${reason}` });
	const selected = landingMethod(params.merge_method);
	if ("reason" in selected) return refuse(selected.reason);
	const mergeMethod = selected.method;

	const number = typeof params.pr === "number" ? String(params.pr) : typeof params.pr === "string" ? params.pr.trim() : "";
	if (!POSITIVE_INTEGER.test(number)) return refuse(`pr: observed ${show(params.pr)}, expected a positive integer`);
	const requested = Number(number);
	if (!Number.isSafeInteger(requested)) {
		return refuse(`pr: observed ${show(params.pr)}, expected a positive integer of at most ${Number.MAX_SAFE_INTEGER}`);
	}

	// Before reading any repository state, reject an explicit identity that cannot
	// be valid for either supported forge. GitLab's bounded nested-group form is
	// the superset; the forge-specific boundary below tightens GitHub to exactly
	// two segments once the trusted remote identifies the forge.
	const explicitRepo = params.repo === undefined || params.repo.trim() === "" ? null : params.repo.trim();
	if (explicitRepo !== null && normalizeRepoPath("gitlab", explicitRepo) === null) {
		return refuse(
			`repo: observed ${show(explicitRepo)}, expected an unqualified "<owner>/<name>" or bounded GitLab "<group>/.../<project>" path`,
		);
	}

	const remote = params.remote === undefined || params.remote.trim() === "" ? "origin" : params.remote.trim();
	if (!REMOTE_NAME.test(remote)) return refuse(`remote: observed ${show(params.remote)}, expected a git remote name`);

	const repository = observeRepository(run, cwd, gitEnv);
	if ("reason" in repository) return refuse(repository.reason);

	// The raw stdout, parsed as exactly one record rather than trimmed: `URL` deletes
	// embedded tabs and newlines before parsing, so a remote spelled with one, or a
	// remote printing two URLs, would classify here as an ordinary forge URL while Git
	// contacts something else. This identity binds the merge argv, so the disagreement
	// would not merely misreport — it would merge somewhere nobody named.
	//
	// The refusal names the shape, never the bytes: a remote URL may carry userinfo or a
	// token query, and output no parser here accepts cannot be redacted, because
	// `redactRemote` can only locate a secret in a spelling it understands.
	const printed = gitOutput(run, cwd, ["remote", "get-url", remote], gitEnv);
	const remoteText = printed === null ? null : singleRemoteRecord(printed);
	if (remoteText === null) {
		const observed = printed === null ? "no completed read" : "malformed Git remote output";
		return refuse(
			`git remote get-url ${remote}: observed ${observed}, expected exactly one URL record for a configured remote in ${cwd}`,
		);
	}
	const target = forgeTarget(remoteText);
	// The URL is classified before it is redacted: `forgeTarget` owns that
	// judgement and must see the spelling Git will actually contact.
	const remoteUrl = redactRemote(remoteText);
	if (target === null) {
		return refuse(`repo.forge: observed "unknown" for remote ${remote} at ${show(remoteUrl)}, expected "github" or "gitlab"`);
	}
	const { forge } = target;

	const fromRemote = repoPathFromRemote(remoteText);
	if (fromRemote === null && explicitRepo === null) {
		return refuse(`repo.nameWithOwner: observed no owner/name in remote ${remote} at ${show(remoteUrl)}, expected "<owner>/<name>"`);
	}
	const normalizedRemote = fromRemote === null ? null : normalizeRepoPath(forge, fromRemote);
	if (fromRemote !== null && normalizedRemote === null) {
		const expected = forge === "github" ? 'exactly "<owner>/<name>"' : 'a bounded "<group>/.../<project>" path';
		return refuse(`repo: observed ${show(fromRemote)} from remote ${remote}, expected ${expected}`);
	}
	const candidate = explicitRepo ?? normalizedRemote;
	if (candidate === null) {
		return refuse(`repo.nameWithOwner: observed no owner/name in remote ${remote} at ${show(remoteUrl)}, expected "<owner>/<name>"`);
	}
	// This adapter-owned normalization is the one path boundary every forge
	// command below shares, and it runs before any host is prefixed: an explicit
	// `repo` is reduced to exactly two segments on GitHub and a bounded group path
	// on GitLab, so no caller-supplied string can occupy the host position.
	const nameWithOwner = normalizeRepoPath(forge, candidate);
	if (nameWithOwner === null) {
		const expected = forge === "github" ? 'exactly "<owner>/<name>"' : 'a bounded "<group>/.../<project>" path';
		return refuse(`repo: observed ${show(candidate)}, expected ${expected}`);
	}
	// A `repo` override that disagrees with the remote is still refused, naming both:
	// the remote is what `git ls-remote` will be asked about when the branch's absence
	// is verified, so a receipt built from two different repositories would be proof
	// of neither.
	if (normalizedRemote !== null && nameWithOwner !== normalizedRemote) {
		return refuse(
			`repo: observed ${show(nameWithOwner)}, expected ${show(normalizedRemote)} from remote ${remote}; the branch absence is verified against ${remote}, so both must name one repository`,
		);
	}
	// Only now, on top of a normalized path, is the host added — and it is added to
	// both forges. `gh` documents `--repo [HOST/]OWNER/REPO` and `glab` the same
	// shape, so each CLI is told the host explicitly rather than resolving a bare
	// path against whichever host it has configured. The value is not caller data:
	// it is what `forgeTarget` returned for the transport host Git will contact, so
	// an alternate SSH endpoint such as `altssh.gitlab.com` still addresses the
	// vendor's canonical API host. The same verified host is pinned in the
	// environment, which is where a CLI would otherwise read a default from.
	const cliRepo = `${target.canonicalHost}/${nameWithOwner}`;
	const forgeCommandEnv = Object.assign(
		Object.create(null) as Record<string, string>,
		forgeEnv,
		forge === "github"
			? { GH_HOST: target.canonicalHost }
			: { GITLAB_HOST: target.canonicalHost, GITLAB_API_HOST: target.canonicalHost },
	);
	const boundForgeRun: CliRunner = (argv, options) => run(argv, { ...options, env: options.env ?? forgeCommandEnv });

	const first = readPr(run, forge, cliRepo, number, FORGE_TIMEOUT_MS, forgeCommandEnv);
	if ("reason" in first) return refuse(first.reason);
	const subject = subjectDrift(first.pr, requested, null, first.argv.join(" "));
	if (subject !== null) return refuse(`${subject}; no merge was issued and no receipt was written`);

	if (params.expectHeadSha !== undefined) {
		const expected = params.expectHeadSha.trim();
		if (expected === "") return refuse(`expectHeadSha: observed ${show(params.expectHeadSha)}, expected a non-empty commit sha`);
		if (expected.toLowerCase() !== first.pr.headRefOid.trim().toLowerCase()) {
			return refuse(
				`expectHeadSha: observed pr.headRefOid ${show(first.pr.headRefOid)}, expected ${show(expected)}; no merge was issued and no receipt was written`,
			);
		}
	}

	// The bead identity is settled before anything is merged: the branch the forge
	// just named is the branch the receipt will record, so a landing that cannot name
	// the work it closes refuses while refusing is still free.
	const identity = beadIdentity(params.beadId, first.pr.headRefName);
	if ("reason" in identity) return refuse(`${identity.reason}; no merge was issued and no receipt was written`);
	const unnamed = missingBeadIdentity(identity.ids, first.pr.headRefName, repository.ledger);
	if (unnamed !== null) return refuse(`${unnamed}; no merge was issued and no receipt was written`);

	const observedAutoDelete: ReceiptAutoDelete = autoDeleteSetting(forge, nameWithOwner, boundForgeRun);
	const notes: string[] = [];
	if (params.setupAutoDelete === true) {
		const enabled = enableAutoDelete(forge, nameWithOwner, boundForgeRun);
		notes.push(
			enabled.ok
				? `setupAutoDelete: the forge accepted a deletion-on-merge write; the setting observed before the request was ${observedAutoDelete}, which is what this receipt records because acceptance is not a re-read.`
				: `setupAutoDelete: the deletion-on-merge write was refused: ${enabled.reason ?? "no reason reported"}. The setting observed before the request was ${observedAutoDelete}.`,
		);
	} else {
		notes.push(`setupAutoDelete was not requested, so no repository setting was written; autoDeleteSetting was observed as ${observedAutoDelete}.`);
	}

	const alreadyMerged = first.pr.state.trim().toUpperCase() === "MERGED";
	let mergeArgv: string[] | null = null;
	let proved = first.pr;
	let rereadArgv: string[] | null = null;
	let mergePolicy: boolean | "unknown" | null = null;
	if (!alreadyMerged && mergeMethod === "merge") {
		mergePolicy = allowMergeCommit(forge, nameWithOwner, boundForgeRun);
		if (mergePolicy === false) {
			return refuse(`merge_method "merge": repository policy allow_merge_commit observed false, expected true; no merge was issued and no receipt was written`);
		}
	}
	if (alreadyMerged) {
		notes.push(`The pull request was already MERGED when it was read, so no merge argv was issued: ${first.argv.join(" ")} is the proof.`);
	} else {
		// The merge is bound to the head that was just read and checked against
		// `expectHeadSha`. A push between the read and the merge then fails the merge at
		// the forge instead of landing a commit nobody in this call observed, so the
		// binding must be a whole object id: a value the forge would not match exactly
		// is no binding, and merging without one is the race itself.
		const head = first.pr.headRefOid.trim().toLowerCase();
		if (!FULL_OID.test(head)) {
			return refuse(
				`pr.headRefOid: observed ${show(first.pr.headRefOid)}, expected a 40- or 64-character hex object id to bind the merge to; no merge was issued`,
			);
		}
		try {
			// `gh pr merge --match-head-commit` and `glab mr merge --sha` each fail the merge
			// unless the source head is still this commit. Neither is a default.
			const binding = forge === "github" ? ["--match-head-commit", head] : ["--sha", head];
			mergeArgv = [...mergeArgs(forge, number, { mergeMethod }), "--repo", cliRepo, ...binding];
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error));
		}
		const merged = run(mergeArgv, { cwd, timeoutMs: FORGE_TIMEOUT_MS, env: forgeCommandEnv });
		if (!merged.ok || merged.error !== undefined || merged.exitCode !== 0) {
			const observed = merged.error ?? (merged.exitCode === null ? "no exit status" : `exit ${merged.exitCode}`);
			const stderr = merged.stderr.trim();
			const detail = stderr === "" ? "" : `; stderr: ${stderr.slice(0, 400)}`;
			return refuse(`${mergeArgv.join(" ")}: observed ${observed}, expected exit 0${detail}; no receipt was written`);
		}
		const second = readPr(run, forge, cliRepo, number, FORGE_TIMEOUT_MS, forgeCommandEnv);
		rereadArgv = second.argv;
		if ("reason" in second) return refuse(second.reason);
		// The re-read must describe the same pull request, at the same head, on the same
		// base. A merge proves a landing only of what was read: a re-target or a push
		// between the two reads would otherwise let this receipt name a head and a base
		// that never merged.
		const drift = subjectDrift(second.pr, requested, first.pr, second.argv.join(" "));
		if (drift !== null) return refuse(`${drift}; no receipt was written`);
		proved = second.pr;
	}

	const proof = mergeProof(proved, alreadyMerged ? null : mergeMethod, run, cwd, gitEnv);
	if ("reason" in proof) {
		const source = alreadyMerged ? "the pull request read" : `the re-read after ${(mergeArgv ?? []).join(" ")}`;
		return refuse(`${source}: ${proof.reason}; no receipt was written`);
	}

	// The probe is asked from this call's own working directory: `remote` is a name,
	// and a name only resolves in the repository that configures it.
	const verdict = remoteBranchAbsent(remote, proved.headRefName, cwd, forgeRun, env);
	if (verdict !== "absent") {
		notes.push(
			`The remote branch ${proved.headRefName} on ${remote} is ${verdict}, not proved absent, so branch.deletedRemote stays false and remoteAbsenceVerifiedAt stays null.`,
		);
	}

	// The proof of the landing is the read that observed it: the re-read when a merge
	// was issued here, the first read when the forge had already merged it.
	const observingArgv = rereadArgv ?? first.argv;
	const evidence: Record<string, unknown> = {
		remote,
		mergeMethod,
		mergePolicy,
		// The URL lives here and not in `repo.remote`, which records the configured
		// remote NAME: the name is what a later `git ls-remote` is given, and the URL is
		// the redacted spelling of what was contacted.
		remoteUrl,
		// Both the repository and the head the merge was bound to are recorded, because a
		// reader of this receipt cannot otherwise tell a bound merge from an ambient one.
		boundRepo: nameWithOwner,
		ledger: { root: repository.ledger.root, active: repository.ledger.active },
		prView: { argv: first.argv.join(" "), number: first.pr.number, state: first.pr.state, headRefOid: first.pr.headRefOid, baseRefName: first.pr.baseRefName },
		expectHeadSha: params.expectHeadSha?.trim() ?? null,
		autoDelete: { observed: observedAutoDelete, requested: params.setupAutoDelete === true },
		merge: mergeArgv === null ? null : { argv: mergeArgv.join(" "), method: mergeMethod, boundHead: first.pr.headRefOid.trim().toLowerCase() },
		mergeShape: { parents: proof.parents, headReachable: proof.headReachable },
		reread:
			rereadArgv === null
				? null
				: { argv: rereadArgv.join(" "), number: proved.number, state: proved.state, headRefOid: proved.headRefOid, baseRefName: proved.baseRefName, mergeCommitOid: proved.mergeCommitOid },
		remoteBranch: { ref: `refs/heads/${proved.headRefName}`, verdict },
	};

	// Re-derived from the branch the re-read proved, which need not be the branch the
	// first read named, and checked again: no receipt claims an active ledger with
	// nothing for the native close-out commands to process.
	const proven = beadIdentity(params.beadId, proved.headRefName);
	if ("reason" in proven) return refuse(`${proven.reason}; no receipt was written`);
	const unproven = missingBeadIdentity(proven.ids, proved.headRefName, repository.ledger);
	if (unproven !== null) return refuse(`${unproven}; no receipt was written`);

	let receipt: LandingReceipt;
	try {
		receipt = buildReceipt({
			emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_land" },
			repo: { key: repository.key, canonicalRoot: repository.canonicalRoot, remote, forge, nameWithOwner },
			pr: {
				number: proved.number,
				url: proved.url,
				state: proved.state,
				baseRefName: proved.baseRefName,
				headRefName: proved.headRefName,
				headRefOid: proved.headRefOid,
				mergeCommitOid: proof.oid,
				mergedAt: proved.mergedAt,
			},
			branch: {
				name: proved.headRefName,
				deletedRemote: verdict === "absent",
				remoteAbsenceVerifiedAt: verdict === "absent" ? observedAt : null,
				autoDeleteSetting: observedAutoDelete,
			},
			worktree: {
				path: params.worktree === undefined || params.worktree.trim() === "" ? null : resolve(cwd, params.worktree.trim()),
				removed: false,
				localRefDeleted: false,
				absenceVerifiedAt: null,
			},
			beads: { ids: proven.ids, ledgerActive: repository.ledger.active },
			proof: {
				method: observationMethod(observingArgv),
				observedAt,
				evidence,
			},
			outcome: "landed",
			now,
			notes: notes.join(" "),
		});
	} catch (error) {
		return refuse(`the receipt could not be built: ${error instanceof Error ? error.message : String(error)}`);
	}

	const validation = validateReceipt(receipt);
	if (!validation.ok) return refuse(`the receipt was refused by its validator, so no file was written: ${validation.reason}`);

	let receiptPath: string;
	try {
		receiptPath = writeReceipt(validation.receipt, deps.receiptsDirectory ?? receiptDirectory(env, validation.receipt.repo.key));
	} catch (error) {
		return refuse(`the receipt could not be written: ${error instanceof Error ? error.message : String(error)}`);
	}

	const next = validation.receipt.beads.ledgerActive
		? nativeCloseoutSteps(validation.receipt, receiptPath, proof.oid)
		: ["delivery_cleanup"] as const;
	const text = [
		`delivery_land proved ${nameWithOwner}#${proved.number} merged as ${proof.oid.slice(0, 12)} on ${forge}.`,
		`branch ${proved.headRefName}: remote ${verdict}, deletedRemote ${verdict === "absent"}, autoDeleteSetting ${observedAutoDelete}.`,
		`receipt: ${receiptPath}`,
		validation.receipt.beads.ledgerActive
			? `next (children before parents):\n${next.slice(0, -1).map(step => `  ${step}`).join("\n")}\n  delivery_cleanup to remove the worktree and the local branch.`
			: "next: run delivery_cleanup to remove the worktree and the local branch.",
	].join("\n");
	return { ok: true, receipt: validation.receipt, receiptPath, text, next };
}

export default function deliveryLandTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "delivery_land",
		label: "Land a pull request and emit a receipt",
		description:
			"Prove a pull request landed and emit one landing receipt. Reads the pull request, refuses on an expectHeadSha mismatch, " +
			"merges at most once (an already MERGED request is proved, not re-merged) using merge_method (squash by default, or merge/rebase), " +
			"checks the method-specific commit shape, and refuses an explicit merge when the forge policy disallows merge commits. " +
			"The merge is bound to the observed repository and head, reread at the same head and base, and then the remote branch is observed " +
			"with git ls-remote before exactly one validated receipt is written under the agent directory. Writes no Beads ledger: when receipt " +
			"beads.ledgerActive is true, close receipt beads in child-before-parent order, then delivery_cleanup; inactive repositories go directly to cleanup.",
		parameters: z.object({
			pr: z.union([z.number(), z.string()]).describe("Pull request or merge request number"),
			merge_method: z.enum(MERGE_METHODS).optional().describe('Landing strategy: "squash" (default), "merge", or "rebase"'),
			repo: z.string().optional().describe('Repository as "<owner>/<name>"; defaults to the path of the remote URL'),
			remote: z.string().optional().describe('Git remote to resolve the forge and observe the branch on; defaults to "origin"'),
			expectHeadSha: z.string().optional().describe("Refuse unless the pull request head is exactly this sha; nothing is merged on a mismatch"),
			setupAutoDelete: z.boolean().optional().describe("Only true writes the repository's deletion-on-merge setting; absent or false writes nothing"),
			worktree: z.string().optional().describe("Worktree this landing belongs to, recorded for delivery_cleanup"),
			beadId: z.string().optional().describe("Bead this landing closes, for a branch the omp/agent/<bead-id> convention does not name; required on an active ledger when the branch names none"),
		}) as unknown as TSchema,
		approval: "exec",
		execute: async (_toolCallId, params: LandParams, _signal, _onUpdate, ctx) => {
			const result = landPullRequest(params, { cwd: ctx?.cwd });
			return {
				content: [{ type: "text", text: result.text }],
				details: result.ok
					? { ok: true, receipt: result.receipt, receiptPath: result.receiptPath, next: result.next }
					: { ok: false, reason: result.reason },
			};
		},
	});
}
