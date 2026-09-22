import { createHash } from "node:crypto";
import type { Dir } from "node:fs";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdtempSync,
	opendirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { invocationFromArgv } from "./bd-actor-gate.ts";
import {
	embeddedStoreFor,
	withEmbeddedWriteLock,
	writesStore,
} from "./bd-embedded-write-lock.ts";
import {
	claimAnchor,
	envelopeData,
	lifecycleBdEnvironment,
	parseTrailingJson,
	readGateList,
	releaseClaimArgs,
} from "./session-beads-lifecycle.ts";

const RECEIPT_SCHEMA = "omp.receipt.landing";
const RECEIPT_VERSION = 1;
const TOOL_TIMEOUT_MS = 25_000;
const COMMAND_TIMEOUT_MS = 5_000;
const REPO_KEY = /^[0-9a-f]{16}$/;
const RECEIPT_ID = /^(\d+)-(?:[0-9a-f]{12}|nomerge)$/;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.[A-Za-z0-9]+)*$/;
/**
 * Byte cap on one receipt file, matching the producer's `MAX_RECEIPT_BYTES`
 * (delivery/extensions/landing-receipt.ts). The reader allocates one more byte so
 * an oversized file is proven oversized without reading the rest of it.
 */
const MAX_RECEIPT_BYTES = 256 * 1024;
/**
 * Cap on receipt files examined in one directory scan.
 *
 * The producer keeps a bounded newest-first window and drops the rest, which is
 * right for a lister. This is the ledger writer, so a silently reconciled subset
 * is worse than no reconciliation: past the cap the scan stops and refuses,
 * naming the cap, instead of reading further.
 */
const MAX_SCANNED_RECEIPTS = 200;
const RECONCILE_ARBITER = Symbol.for("com.srobroek.beads.bd-reconcile-tool.v1");

export type ReconcileParams = {
	receipt?: string;
	bead?: string;
	repoKey?: string;
	apply?: boolean;
};

export type SpawnResult = {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
};

export type BdSpawn = (
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
) => Promise<SpawnResult>;

export type CommandSpawn = (
	executable: string,
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
) => Promise<SpawnResult>;

export type WriteLock = typeof withEmbeddedWriteLock;

type JsonObject = Record<string, unknown>;

export type ReceiptV1 = {
	[key: string]: unknown;
	schema: typeof RECEIPT_SCHEMA;
	version: 1;
	receiptId: string;
	emittedAt: string;
	emitter: { plugin: string; version: string; tool: string };
	repo: {
		key: string;
		canonicalRoot: string;
		remote: string;
		forge: "github" | "gitlab" | "unknown";
		nameWithOwner: string;
	};
	pr: {
		number: number;
		url: string;
		state: string;
		baseRefName: string;
		headRefName: string;
		headRefOid: string;
		mergeCommitOid: string | null;
		mergedAt: string | null;
	};
	branch: {
		name: string;
		deletedRemote: boolean;
		remoteAbsenceVerifiedAt: string | null;
		autoDeleteSetting: "on" | "off" | "unknown";
	};
	worktree: {
		path: string | null;
		removed: boolean;
		localRefDeleted: boolean;
		absenceVerifiedAt: string | null;
	};
	beads: { ids: string[]; ledgerActive: boolean };
	proof: { method: string; observedAt: string; evidence: JsonObject };
	outcome: "landed" | "cleaned" | "partial";
	supersedes: string | null;
	notes?: string;
};

export type ForgeObservation = {
	repo: { nameWithOwner: string };
	pr: {
		number: number;
		url: string;
		state: string;
		baseRefName: string;
		headRefName: string;
		headRefOid: string;
		mergeCommitOid: string | null;
		mergedAt: string | null;
	};
};

export type ProofObserver = (
	receipt: ReceiptV1,
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
) => Promise<{ observation?: ForgeObservation; failure?: string }>;

export type CleanupObservation = {
	remoteBranchAbsent: boolean;
	localRefAbsent: boolean;
	worktreeAbsent: boolean;
};

export type CleanupObserver = (
	receipt: ReceiptV1,
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
) => Promise<{ observation?: CleanupObservation; failure?: string }>;

type ReceiptSource = {
	path: string;
	receipt?: ReceiptV1;
	reason?: string;
};

export type BeadRecord = {
	id: string;
	status: string;
	assignee?: string;
	metadata: JsonObject;
	dependencies: DependencyRecord[];
	comments: string[];
	parent?: string;
};

type DependencyRecord = {
	id?: string;
	issueId?: string;
	dependsOnId?: string;
	type?: string;
	status?: string;
};

type GateRecord = {
	id: string;
	blocks?: string;
	reason?: string;
	description?: string;
};

export type ReconcileOperation = {
	kind:
		| "release-dead-claim"
		| "set-merge-anchors"
		| "add-discovered-from"
		| "record-merge-audit"
		| "comment-ambiguity"
		| "gate-ambiguity"
		| "close";
	bead: string;
	receipt: string;
	description: string;
	argv: string[];
};

export type ReconcileRefusal = {
	bead?: string;
	receipt: string;
	reason: string;
};

export type ReconcileReport = {
	ok: boolean;
	apply: boolean;
	receipts: string[];
	operations: ReconcileOperation[];
	applied: ReconcileOperation[];
	refusals: ReconcileRefusal[];
	failures: string[];
	text: string;
};

export type ReconcileDependencies = {
	spawn?: BdSpawn;
	lock?: WriteLock;
	observeProof?: ProofObserver;
	observeCleanup?: CleanupObserver;
	cleanupCommand?: CommandSpawn;
	remotePlatform?: NodeJS.Platform;
	receiptRoot?: string;
	repoKey?: (cwd: string, deadline: number) => Promise<string | undefined>;
	pidAlive?: (pid: number) => boolean;
	pidProbe?: (pid: number) => void;
	host?: string;
	/**
	 * Reserved for a repository-native authoritative source carrier. Receipt v1
	 * does not contain source/target roles, so the shipped resolver deliberately
	 * derives nothing. A future recognized ledger carrier can supply this seam.
	 */
	authoritativeSource?: (
		bead: BeadRecord,
		allBeads: ReadonlyMap<string, BeadRecord>,
	) => string | undefined;
};

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
	return value === null ? null : string(value);
}

function isoInstantMillis(value: string): number | undefined {
	const match = ISO_INSTANT.exec(value);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const offsetHour = Number(match[8] ?? 0);
	const offsetMinute = Number(match[9] ?? 0);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)
		|| hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
		return undefined;
	}
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? millis : undefined;
}

function field(record: JsonObject | undefined, key: string): unknown {
	return record?.[key];
}

function observed(value: unknown): string {
	if (value === undefined || value === null || value === "") return "absent";
	return JSON.stringify(value);
}

function requirement(path: string, value: unknown, expected: string): string {
	return `${path}: observed ${observed(value)}, expected ${expected}`;
}

export function parseReceipt(value: unknown): { receipt?: ReceiptV1; reason?: string } {
	const root = object(value);
	if (root === undefined) return { reason: "receipt: observed a non-object, expected one JSON object" };
	if (root.schema !== RECEIPT_SCHEMA) {
		return {
			reason: requirement("schema", root.schema, JSON.stringify(RECEIPT_SCHEMA)),
		};
	}
	if (typeof root.version === "number" && root.version > RECEIPT_VERSION) {
		return {
			reason: `version: observed ${root.version}, expected at most ${RECEIPT_VERSION}; forward receipt versions are refused`,
		};
	}
	if (root.version !== RECEIPT_VERSION) {
		return { reason: requirement("version", root.version, String(RECEIPT_VERSION)) };
	}

	const emitter = object(root.emitter);
	const repo = object(root.repo);
	const pr = object(root.pr);
	const branch = object(root.branch);
	const worktree = object(root.worktree);
	const beads = object(root.beads);
	const proof = object(root.proof);
	const failures: string[] = [];
	const needString = (path: string, value: unknown): string => {
		const parsed = string(value);
		if (parsed === undefined) failures.push(requirement(path, value, "a non-empty string"));
		return parsed ?? "";
	};
	const needNullable = (path: string, value: unknown): string | null => {
		const parsed = nullableString(value);
		if (parsed === undefined) failures.push(requirement(path, value, "null or a non-empty string"));
		return parsed ?? null;
	};
	const needBoolean = (path: string, value: unknown): boolean => {
		if (typeof value !== "boolean") failures.push(requirement(path, value, "a boolean"));
		return value === true;
	};
	const receiptId = needString("receiptId", root.receiptId);
	if (!RECEIPT_ID.test(receiptId)) failures.push(requirement("receiptId", root.receiptId, "<epochMillis>-<12 lowercase merge hex> or <epochMillis>-nomerge"));
	const emittedAt = needString("emittedAt", root.emittedAt);
	const emittedAtMillis = isoInstantMillis(emittedAt);
	if (emittedAtMillis === undefined) failures.push(requirement("emittedAt", root.emittedAt, "a calendar-valid ISO 8601 instant"));
	const emitterPlugin = needString("emitter.plugin", field(emitter, "plugin"));
	const emitterVersion = needString("emitter.version", field(emitter, "version"));
	const emitterTool = needString("emitter.tool", field(emitter, "tool"));
	const repoKey = needString("repo.key", field(repo, "key"));
	if (!REPO_KEY.test(repoKey)) failures.push(requirement("repo.key", field(repo, "key"), "16 lowercase hexadecimal characters"));
	const canonicalRoot = needString("repo.canonicalRoot", field(repo, "canonicalRoot"));
	const remote = needString("repo.remote", field(repo, "remote"));
	const forge = field(repo, "forge");
	if (forge !== "github" && forge !== "gitlab" && forge !== "unknown") {
		failures.push(requirement("repo.forge", forge, '"github", "gitlab", or "unknown"'));
	}
	const nameWithOwner = needString("repo.nameWithOwner", field(repo, "nameWithOwner"));
	const prNumber = field(pr, "number");
	if (!Number.isInteger(prNumber) || Number(prNumber) <= 0) {
		failures.push(requirement("pr.number", prNumber, "a positive integer"));
	}
	const prUrl = needString("pr.url", field(pr, "url"));
	const prState = needString("pr.state", field(pr, "state"));
	const baseRefName = needString("pr.baseRefName", field(pr, "baseRefName"));
	const headRefName = needString("pr.headRefName", field(pr, "headRefName"));
	const headRefOid = needString("pr.headRefOid", field(pr, "headRefOid"));
	if (!GIT_OID.test(headRefOid)) failures.push(requirement("pr.headRefOid", field(pr, "headRefOid"), "a 40- or 64-character lowercase hexadecimal Git object id"));
	const mergeCommitOid = needNullable("pr.mergeCommitOid", field(pr, "mergeCommitOid"));
	const validMergeCommitOid = mergeCommitOid === null || GIT_OID.test(mergeCommitOid);
	if (!validMergeCommitOid) failures.push(requirement("pr.mergeCommitOid", field(pr, "mergeCommitOid"), "null or a 40- or 64-character lowercase hexadecimal Git object id"));
	const mergedAt = needNullable("pr.mergedAt", field(pr, "mergedAt"));
	if (emittedAtMillis !== undefined && validMergeCommitOid) {
		const expectedReceiptId = `${emittedAtMillis}-${mergeCommitOid === null ? "nomerge" : mergeCommitOid.slice(0, 12)}`;
		if (receiptId !== expectedReceiptId) failures.push(requirement("receiptId", receiptId, JSON.stringify(expectedReceiptId)));
	}
	const branchName = needString("branch.name", field(branch, "name"));
	const deletedRemote = needBoolean("branch.deletedRemote", field(branch, "deletedRemote"));
	const remoteAbsence = needNullable(
		"branch.remoteAbsenceVerifiedAt",
		field(branch, "remoteAbsenceVerifiedAt"),
	);
	const autoDelete = field(branch, "autoDeleteSetting");
	if (autoDelete !== "on" && autoDelete !== "off" && autoDelete !== "unknown") {
		failures.push(requirement("branch.autoDeleteSetting", autoDelete, '"on", "off", or "unknown"'));
	}
	const worktreePath = needNullable("worktree.path", field(worktree, "path"));
	const removed = needBoolean("worktree.removed", field(worktree, "removed"));
	const localRefDeleted = needBoolean("worktree.localRefDeleted", field(worktree, "localRefDeleted"));
	const absence = needNullable("worktree.absenceVerifiedAt", field(worktree, "absenceVerifiedAt"));
	const idsValue = field(beads, "ids");
	const ids = Array.isArray(idsValue) && idsValue.every((id) => typeof id === "string" && BEAD_ID.test(id))
		? [...new Set(idsValue as string[])]
		: [];
	const ledgerActive = needBoolean("beads.ledgerActive", field(beads, "ledgerActive"));
	// A ledger-free repository has no bead to name, so an empty list is the honest
	// value there. With an active ledger it is the one thing a landing must carry.
	if (ids.length === 0 && (ledgerActive || !Array.isArray(idsValue) || idsValue.length > 0)) {
		failures.push(requirement(
			"beads.ids",
			idsValue,
			ledgerActive ? "a non-empty array of bead ids when beads.ledgerActive is true" : "an array of bead ids",
		));
	}
	const method = needString("proof.method", field(proof, "method"));
	const proofObservedAt = needString("proof.observedAt", field(proof, "observedAt"));
	const evidence = object(field(proof, "evidence"));
	if (evidence === undefined || Object.keys(evidence).length === 0) {
		failures.push(requirement("proof.evidence", field(proof, "evidence"), "a non-empty object naming independently observed forge evidence"));
	}
	// `proof.method` names the provider CLI and verb that observed the landing, or
	// "unknown" when none did. Whether a given method is landing proof is decided by
	// forgeObservedLanding at the close gate, not here: a `cleaned` continuation and
	// an unobserved receipt are both valid v1 and both still drive safe repairs.
	const outcome = root.outcome;
	if (outcome !== "landed" && outcome !== "cleaned" && outcome !== "partial") {
		failures.push(requirement("outcome", outcome, '"landed", "cleaned", or "partial"'));
	}
	const notes = root.notes === undefined ? undefined : needString("notes", root.notes);
	const supersedes = needNullable("supersedes", root.supersedes);
	if (failures.length > 0) return { reason: failures.join("; ") };
	return {

		receipt: {
			...root,
			schema: RECEIPT_SCHEMA,
			version: RECEIPT_VERSION,
			receiptId,
			emittedAt,
			emitter: { ...emitter, plugin: emitterPlugin, version: emitterVersion, tool: emitterTool },
			repo: {
				...repo,
				key: repoKey,
				canonicalRoot,
				remote,
				forge: forge as ReceiptV1["repo"]["forge"],
				nameWithOwner,
			},
			pr: {
				...pr,
				number: Number(prNumber),
				url: prUrl,
				state: prState,
				baseRefName,
				headRefName,
				headRefOid,
				mergeCommitOid,
				mergedAt,
			},
			branch: {
				...branch,
				name: branchName,
				deletedRemote,
				remoteAbsenceVerifiedAt: remoteAbsence,
				autoDeleteSetting: autoDelete as ReceiptV1["branch"]["autoDeleteSetting"],
			},
			worktree: {
				...worktree,
				path: worktreePath,
				removed,
				localRefDeleted,
				absenceVerifiedAt: absence,
			},
			beads: { ...beads, ids, ledgerActive },
			proof: { ...proof, method, observedAt: proofObservedAt, evidence: evidence ?? {} },
			outcome: outcome as ReceiptV1["outcome"],
			supersedes,
			...(notes === undefined ? {} : { notes }),
		},
	};
}

async function defaultRepoKey(cwd: string, deadline: number): Promise<string | undefined> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return undefined;
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
			killSignal: "SIGKILL",
		});
		const [exitCode, stdout] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
		]);
		if (exitCode !== 0) return undefined;
		const raw = stdout.trim();
		if (!raw) return undefined;
		const common = realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
		return createHash("sha256").update(common).digest("hex").slice(0, 16);
	} catch {
		return undefined;
	}
}

/**
 * The receipt root both sides of the contract resolve to.
 *
 * A whitespace-only `PI_CODING_AGENT_DIR` is unset, because the producer already
 * reads it that way (delivery/extensions/landing-receipt.ts): an untrimmed value
 * would point the consumer at a directory named " " that no receipt was ever
 * written to, and the divergence would look like a missing receipt.
 */
function receiptRoot(env: NodeJS.ProcessEnv, deps: ReconcileDependencies): string {
	if (deps.receiptRoot !== undefined) return deps.receiptRoot;
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() ?? "";
	const home = env.HOME?.trim() ?? "";
	const base = agentDir === "" ? join(home === "" ? homedir() : home, ".omp") : agentDir;
	return join(base, "receipts");
}

function safeReceiptPath(root: string, repoKey: string, input: string): string | undefined {
	const repository = resolve(root, repoKey);
	let candidate: string;
	if (isAbsolute(input)) candidate = resolve(input);
	else {
		const name = input.endsWith(".json") ? input : `${input}.json`;
		candidate = resolve(repository, name);
	}
	if (dirname(candidate) !== repository || !basename(candidate).endsWith(".json")) return undefined;
	return candidate;
}

type BoundedRead = { text?: string; reason?: string };

/**
 * Read at most {@link MAX_RECEIPT_BYTES} + 1 bytes through a single descriptor.
 *
 * This mirrors the producer's reader deliberately. One descriptor, so the file that
 * is measured is the file that is read. `O_NOFOLLOW` because a symlink planted at a
 * receipt path must not redirect the ledger writer outside the receipt root, and
 * `O_NONBLOCK` because a FIFO there would otherwise park the extension thread
 * forever on `open`. The regular-file check rejects a FIFO or device node that
 * opened anyway, and the extra byte proves a file oversized without reading it all.
 */
function readBoundedReceipt(path: string): BoundedRead {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch (error) {
		return { reason: `receipt file is unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { reason: requirement("receipt file", `${path} (not a regular file)`, "a regular file") };
		const buffer = Buffer.allocUnsafe(MAX_RECEIPT_BYTES + 1);
		let filled = 0;
		while (filled < buffer.length) {
			let read: number;
			try {
				read = readSync(fd, buffer, filled, buffer.length - filled, null);
			} catch (error) {
				return { reason: `receipt file is unreadable: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (read === 0) break;
			filled += read;
		}
		if (filled > MAX_RECEIPT_BYTES) {
			return { reason: requirement("receipt file", `${path} (over ${MAX_RECEIPT_BYTES} bytes)`, `at most ${MAX_RECEIPT_BYTES} bytes`) };
		}
		return { text: buffer.toString("utf8", 0, filled) };
	} finally {
		try {
			closeSync(fd);
		} catch {
			// Nothing left to do about a descriptor that will not close.
		}
	}
}

/**
 * Receipt file names directly under one repository directory, sorted, bounded.
 *
 * Streamed with `opendirSync` so the cap is reached without materialising a
 * hostile directory listing, and only regular files count: a symlink or FIFO is
 * not a receipt and is skipped here rather than opened and refused later.
 */
function scanReceiptNames(repository: string): { names?: string[]; reason?: string } {
	let directory: Dir;
	try {
		directory = opendirSync(repository);
	} catch (error) {
		return { reason: `receipt directory ${repository} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
	const names: string[] = [];
	try {
		for (;;) {
			const entry = directory.readSync();
			if (entry === null) break;
			if (!entry.name.endsWith(".json") || !entry.isFile()) continue;
			if (names.length === MAX_SCANNED_RECEIPTS) {
				return { reason: `receipt directory ${repository} holds more than ${MAX_SCANNED_RECEIPTS} receipt files; refusing rather than reconciling a subset. Name one receipt id.` };
			}
			names.push(entry.name);
		}
	} catch (error) {
		return { reason: `receipt directory ${repository} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		try {
			directory.closeSync();
		} catch {
			// Nothing left to do about a directory handle that will not close.
		}
	}
	return { names: names.sort() };
}

async function readReceiptSources(
	params: ReconcileParams,
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
	deps: ReconcileDependencies,
): Promise<{ sources: ReceiptSource[]; repoKey?: string; refusal?: string }> {
	if (params.bead !== undefined && !BEAD_ID.test(params.bead)) {
		return { sources: [], refusal: requirement("bead", params.bead, "a bead id") };
	}
	const key = await (deps.repoKey ?? defaultRepoKey)(cwd, deadline);
	if (key === undefined) {
		return { sources: [], refusal: "repoKey: observed absent, expected a key derived from the current git common directory" };
	}
	if (params.repoKey !== undefined && (!REPO_KEY.test(params.repoKey) || params.repoKey !== key)) {
		return { sources: [], repoKey: key, refusal: requirement("repoKey", params.repoKey, JSON.stringify(key)) };
	}
	const root = receiptRoot(env, deps);
	const repository = resolve(root, key);
	// The receipt travels the whole path or not at all: any caller-supplied
	// non-string or JSON string is an object no delivery tool wrote, so it is
	// named and refused rather than coerced, parsed, or read.
	if (params.receipt !== undefined && (typeof params.receipt !== "string" || /^[[{"]/.test(params.receipt.trim()))) {
		return {
			sources: [],
			repoKey: key,
			refusal: `receipt: observed inline JSON, expected a receipt id or the path of a file a delivery tool wrote at ${join(repository, "<receiptId>.json")}`,
		};
	}
	let names: string[];
	if (params.receipt !== undefined) {
		const candidate = safeReceiptPath(root, key, params.receipt);
		if (candidate === undefined) {
			return { sources: [], repoKey: key, refusal: `receipt: observed ${JSON.stringify(params.receipt)}, expected a v1 JSON file directly under ${repository}${sep}` };
		}
		names = [basename(candidate)];
	} else {
		const scanned = scanReceiptNames(repository);
		if (scanned.names === undefined) return { sources: [], repoKey: key, refusal: scanned.reason };
		names = scanned.names;
	}
	if (names.length === 0) {
		return { sources: [], repoKey: key, refusal: `receipt directory ${repository} contains no receipt v1 JSON files` };
	}
	const sources: ReceiptSource[] = [];
	for (const name of names) {
		const path = join(repository, name);
		const bounded = readBoundedReceipt(path);
		if (bounded.text === undefined) {
			sources.push({ path, reason: bounded.reason });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(bounded.text);
		} catch (error) {
			sources.push({ path, reason: `receipt file is unreadable JSON: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		const result = parseReceipt(parsed);
		// The filename is part of the receipt's identity: a receipt copied under
		// another id is a different claim about which landing it describes.
		const stem = name.slice(0, -".json".length);
		if (result.receipt !== undefined && result.receipt.receiptId !== stem) {
			sources.push({ path, reason: requirement("receiptId", result.receipt.receiptId, `${JSON.stringify(stem)}, the receiptId in its filename`) });
			continue;
		}
		sources.push({ path, ...result });
	}
	return { sources, repoKey: key };
}

async function spawnExecutable(
	executable: string,
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
): Promise<SpawnResult> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: `${executable} command timed out` };
	}
	try {
		const proc = Bun.spawn([executable, ...argv], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
			timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
			killSignal: "SIGKILL",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return {
			ok: exitCode === 0,
			exitCode,
			stdout,
			stderr,
			...(exitCode === null ? { error: `${executable} command timed out` } : {}),
		};
	} catch (error) {
		return {
			ok: false,
			exitCode: null,
			stdout: "",
			stderr: "",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function defaultSpawn(
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
): Promise<SpawnResult> {
	return spawnExecutable("bd", argv, cwd, env, deadline);
}

function commandObject(result: SpawnResult, label: string): { value?: JsonObject; failure?: string } {
	if (!result.ok) {
		const detail = result.error ?? [result.stderr, result.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
		return { failure: `${label} failed: ${detail || `exit ${result.exitCode}`}` };
	}
	const value = object(parseTrailingJson(result.stdout));
	return value === undefined ? { failure: `${label} returned malformed JSON` } : { value };
}

function githubObservation(repo: JsonObject, pr: JsonObject): { observation?: ForgeObservation; failure?: string } {
	const nameWithOwner = string(repo.nameWithOwner);
	const number = pr.number;
	const merge = pr.mergeCommit;
	const mergeCommitOid = merge === null ? null : string(object(merge)?.oid);
	const mergedAt = nullableString(pr.mergedAt);
	const values = {
		url: string(pr.url),
		state: string(pr.state),
		baseRefName: string(pr.baseRefName),
		headRefName: string(pr.headRefName),
		headRefOid: string(pr.headRefOid),
	};
	if (nameWithOwner === undefined || !Number.isInteger(number) || Number(number) <= 0
		|| Object.values(values).some((value) => value === undefined)
		|| mergeCommitOid === undefined || mergedAt === undefined) {
		return { failure: "gh returned incomplete repository or pull-request identity" };
	}
	return {
		observation: {
			repo: { nameWithOwner },
			pr: {
				number: Number(number),
				url: values.url as string,
				state: values.state as string,
				baseRefName: values.baseRefName as string,
				headRefName: values.headRefName as string,
				headRefOid: values.headRefOid as string,
				mergeCommitOid,
				mergedAt,
			},
		},
	};
}

function gitlabObservation(repo: JsonObject, pr: JsonObject): { observation?: ForgeObservation; failure?: string } {
	const nameWithOwner = string(repo.path_with_namespace)
		?? string(repo.pathWithNamespace)
		?? string(repo.fullPath)
		?? string(repo.nameWithOwner);
	const number = pr.iid ?? pr.number;
	const mergeCommitOid = nullableString(pr.merge_commit_sha ?? pr.mergeCommitSha);
	const mergedAt = nullableString(pr.merged_at ?? pr.mergedAt);
	const values = {
		url: string(pr.web_url) ?? string(pr.webUrl) ?? string(pr.url),
		state: string(pr.state),
		baseRefName: string(pr.target_branch) ?? string(pr.targetBranch),
		headRefName: string(pr.source_branch) ?? string(pr.sourceBranch),
		headRefOid: string(pr.sha) ?? string(pr.headRefOid),
	};
	if (nameWithOwner === undefined || !Number.isInteger(number) || Number(number) <= 0
		|| Object.values(values).some((value) => value === undefined)
		|| mergeCommitOid === undefined || mergedAt === undefined) {
		return { failure: "glab returned incomplete repository or merge-request identity" };
	}
	return {
		observation: {
			repo: { nameWithOwner },
			pr: {
				number: Number(number),
				url: values.url as string,
				state: values.state as string,
				baseRefName: values.baseRefName as string,
				headRefName: values.headRefName as string,
				headRefOid: values.headRefOid as string,
				mergeCommitOid,
				mergedAt,
			},
		},
	};
}

async function defaultObserveProof(
	receipt: ReceiptV1,
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
): Promise<{ observation?: ForgeObservation; failure?: string }> {
	if (receipt.repo.forge === "github") {
		const repoResult = commandObject(
			await spawnExecutable("gh", ["repo", "view", "--json", "nameWithOwner"], cwd, env, deadline),
			"gh repo view",
		);
		if (repoResult.value === undefined) return { failure: repoResult.failure };
		const nameWithOwner = string(repoResult.value.nameWithOwner);
		if (nameWithOwner === undefined) return { failure: "gh repo view returned no nameWithOwner" };
		const prResult = commandObject(
			await spawnExecutable("gh", ["pr", "view", String(receipt.pr.number), "--repo", nameWithOwner, "--json", "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt"], cwd, env, deadline),
			"gh pr view",
		);
		return prResult.value === undefined ? { failure: prResult.failure } : githubObservation(repoResult.value, prResult.value);
	}
	if (receipt.repo.forge === "gitlab") {
		const repoResult = commandObject(
			await spawnExecutable("glab", ["repo", "view", "--output", "json"], cwd, env, deadline),
			"glab repo view",
		);
		if (repoResult.value === undefined) return { failure: repoResult.failure };
		const nameWithOwner = string(repoResult.value.path_with_namespace)
			?? string(repoResult.value.pathWithNamespace)
			?? string(repoResult.value.fullPath)
			?? string(repoResult.value.nameWithOwner);
		if (nameWithOwner === undefined) return { failure: "glab repo view returned no repository path" };
		const prResult = commandObject(
			await spawnExecutable("glab", ["api", `projects/${encodeURIComponent(nameWithOwner)}/merge_requests/${receipt.pr.number}`], cwd, env, deadline),
			"glab api merge request",
		);
		return prResult.value === undefined ? { failure: prResult.failure } : gitlabObservation(repoResult.value, prResult.value);
	}
	return { failure: `repo.forge ${JSON.stringify(receipt.repo.forge)} has no authoritative observer` };
}

function observationFailures(receipt: ReceiptV1, observation: ForgeObservation): string[] {
	const failures: string[] = [];
	const expected = {
		"repo.nameWithOwner": receipt.repo.nameWithOwner,
		"pr.number": receipt.pr.number,
		"pr.url": receipt.pr.url,
		"pr.state": receipt.pr.state.toUpperCase(),
		"pr.baseRefName": receipt.pr.baseRefName,
		"pr.headRefName": receipt.pr.headRefName,
		"pr.headRefOid": receipt.pr.headRefOid,
		"pr.mergeCommitOid": receipt.pr.mergeCommitOid,
		"pr.mergedAt": receipt.pr.mergedAt,
	};
	const actual = {
		"repo.nameWithOwner": observation.repo.nameWithOwner,
		"pr.number": observation.pr.number,
		"pr.url": observation.pr.url,
		"pr.state": observation.pr.state.toUpperCase(),
		"pr.baseRefName": observation.pr.baseRefName,
		"pr.headRefName": observation.pr.headRefName,
		"pr.headRefOid": observation.pr.headRefOid,
		"pr.mergeCommitOid": observation.pr.mergeCommitOid,
		"pr.mergedAt": observation.pr.mergedAt,
	};
	for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
		if (actual[key] !== expected[key]) failures.push(requirement(`authoritative ${key}`, actual[key], JSON.stringify(expected[key])));
	}
	return failures;
}

type ResolvedRemoteIdentity = {
	forge: "github" | "gitlab";
	nameWithOwner: string;
	transport: "git" | "http" | "https" | "ssh";
};

function resolvedRemoteIdentity(value: string): ResolvedRemoteIdentity | undefined {
	let host: string;
	let path: string;
	let transport: ResolvedRemoteIdentity["transport"];
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
		try {
			const parsed = new URL(value);
			if (parsed.search !== "" || parsed.hash !== "") return undefined;
			const protocol = parsed.protocol.slice(0, -1).toLowerCase();
			if (protocol !== "git" && protocol !== "http" && protocol !== "https" && protocol !== "ssh") return undefined;
			transport = protocol;
			host = parsed.hostname.toLowerCase();
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	} else {
		const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(value);
		if (scp === null) return undefined;
		host = (scp[1] ?? "").toLowerCase();
		path = scp[2] ?? "";
		transport = "ssh";
	}
	const forge = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined;
	if (forge === undefined) return undefined;
	const rawSegments = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
	if (rawSegments.length < 2 || (forge === "github" && rawSegments.length !== 2)) return undefined;
	const segments: string[] = [];
	for (const segment of rawSegments) {
		try {
			const decoded = decodeURIComponent(segment);
			if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return undefined;
			segments.push(decoded);
		} catch {
			return undefined;
		}
	}
	return { forge, nameWithOwner: segments.join("/"), transport };
}

function trustedRemoteGit(platform: NodeJS.Platform): string | undefined {
	if (platform === "win32") return undefined;
	try {
		const executable = realpathSync("/usr/bin/git");
		return isAbsolute(executable) ? executable : undefined;
	} catch {
		return undefined;
	}
}

function trustedGitEnvironment(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
	const trusted: NodeJS.ProcessEnv = {};
	for (const key of ["HOME", "LANG", "LC_ALL", "LOGNAME", "SSH_AUTH_SOCK", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USER"] as const) {
		const value = base[key];
		if (value !== undefined) trusted[key] = value;
	}
	trusted.GIT_CONFIG_NOSYSTEM = "1";
	trusted.GIT_CONFIG_GLOBAL = platform === "win32" ? "NUL" : "/dev/null";
	trusted.GIT_TERMINAL_PROMPT = "0";
	trusted.PATH = platform === "win32" ? "" : "/usr/bin:/bin";
	return trusted;
}

function isolatedRemoteEnvironment(
	base: NodeJS.ProcessEnv,
	cwd: string,
	transport: ResolvedRemoteIdentity["transport"],
	platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
	const isolated = trustedGitEnvironment(base, platform);
	isolated.GIT_CEILING_DIRECTORIES = cwd;
	isolated.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";
	if (transport === "ssh" && platform !== "win32") {
		isolated.GIT_SSH_COMMAND = "/usr/bin/ssh -F /dev/null -o BatchMode=yes -o ClearAllForwardings=yes -o ProxyCommand=none -o ProxyJump=none -o PermitLocalCommand=no -o CanonicalizeHostname=no";
		isolated.GIT_SSH_VARIANT = "ssh";
	}
	return isolated;
}

async function defaultObserveCleanup(
	receipt: ReceiptV1,
	authoritativeNameWithOwner: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
	command: CommandSpawn = spawnExecutable,
	platform: NodeJS.Platform = process.platform,
): Promise<{ observation?: CleanupObservation; failure?: string }> {
	const trustedGit = trustedRemoteGit(platform);
	if (trustedGit === undefined) {
		return { failure: `trusted absolute Git executable unavailable for ${platform}; refusing cleanup proof` };
	}
	const localEnv = trustedGitEnvironment(env, platform);
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(receipt.repo.remote)) {
		return { failure: requirement("repo.remote", receipt.repo.remote, "a safe configured git remote name") };
	}
	const configured = await command(trustedGit, ["remote", "get-url", receipt.repo.remote], cwd, localEnv, deadline);
	if (!configured.ok) {
		const detail = configured.error ?? [configured.stderr, configured.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
		return { failure: `git remote get-url could not resolve configured remote ${JSON.stringify(receipt.repo.remote)}: ${detail || `exit ${configured.exitCode}`}` };
	}
	const configuredUrls = configured.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	if (configuredUrls.length !== 1) {
		return { failure: `git remote get-url returned ${configuredUrls.length} URLs for ${JSON.stringify(receipt.repo.remote)}, expected exactly one` };
	}
	const remoteUrl = configuredUrls[0] as string;
	const remoteIdentity = resolvedRemoteIdentity(remoteUrl);
	if (remoteIdentity === undefined) {
		return { failure: requirement("configured remote URL", remoteUrl, "a parseable github.com or gitlab.com repository URL") };
	}
	if (remoteIdentity.forge !== receipt.repo.forge) {
		return { failure: requirement("configured remote forge", remoteIdentity.forge, JSON.stringify(receipt.repo.forge)) };
	}
	if (remoteIdentity.nameWithOwner !== authoritativeNameWithOwner) {
		return { failure: requirement("configured remote nameWithOwner", remoteIdentity.nameWithOwner, JSON.stringify(authoritativeNameWithOwner)) };
	}
	const branchRef = `refs/heads/${receipt.branch.name}`;
	let remoteCwd: string;
	try {
		remoteCwd = mkdtempSync(join(tmpdir(), "bd-reconcile-remote-"));
	} catch (error) {
		return { failure: `could not create isolated remote probe directory: ${error instanceof Error ? error.message : String(error)}` };
	}
	const remoteEnv = isolatedRemoteEnvironment(localEnv, remoteCwd, remoteIdentity.transport, platform);
	let results: [SpawnResult, SpawnResult, SpawnResult] | undefined;
	try {
		results = await Promise.all([
			command(trustedGit, [
				"-c", "protocol.allow=never",
				"-c", `protocol.${remoteIdentity.transport}.allow=always`,
				"ls-remote", "--exit-code", "--heads", "--", remoteUrl, branchRef,
			], remoteCwd, remoteEnv, deadline),
			command(trustedGit, ["show-ref", "--verify", "--quiet", branchRef], cwd, localEnv, deadline),
			command(trustedGit, ["worktree", "list", "--porcelain"], cwd, localEnv, deadline),
		]);
	} finally {
		try { rmSync(remoteCwd, { recursive: true, force: true }); } catch { /* The OS can reclaim an empty probe directory. */ }
	}
	if (results === undefined) return { failure: "isolated remote probe returned no command results" };
	const [remote, local, worktrees] = results;
	const remoteAbsent = remote.exitCode === 2 && remote.stdout.trim() === "";
	if (!remoteAbsent && remote.exitCode !== 0) {
		const detail = remote.error ?? [remote.stderr, remote.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
		return { failure: `git ls-remote could not prove branch presence or absence: ${detail || `exit ${remote.exitCode}`}` };
	}
	const localAbsent = local.exitCode === 1 && local.stdout.trim() === "";
	if (!localAbsent && local.exitCode !== 0) {
		const detail = local.error ?? [local.stderr, local.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
		return { failure: `git show-ref could not prove local ref presence or absence: ${detail || `exit ${local.exitCode}`}` };
	}
	if (!worktrees.ok) {
		const detail = worktrees.error ?? [worktrees.stderr, worktrees.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
		return { failure: `git worktree list failed: ${detail || `exit ${worktrees.exitCode}`}` };
	}
	const records = worktrees.stdout.trim().split(/\n\s*\n/).filter(Boolean);
	if (records.length === 0 || records.some((record) => !record.startsWith("worktree "))) {
		return { failure: "git worktree list returned malformed porcelain output" };
	}
	const receiptPath = receipt.worktree.path === null ? undefined : resolve(receipt.worktree.path);
	const worktreeAbsent = records.every((record) => {
		const lines = record.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
		return branch !== branchRef && (receiptPath === undefined || path === undefined || resolve(path) !== receiptPath);
	});
	return {
		observation: {
			remoteBranchAbsent: remoteAbsent,
			localRefAbsent: localAbsent,
			worktreeAbsent,
		},
	};
}

/** One cleanup step a receipt asserts, and the observed field that would prove it. */
type ClaimedCleanup = "remoteBranchAbsent" | "localRefAbsent" | "worktreeAbsent";

const CLAIMED_CLEANUP_LABEL: Record<ClaimedCleanup, string> = {
	remoteBranchAbsent: "remote branch",
	localRefAbsent: "local ref",
	worktreeAbsent: "worktree",
};

/**
 * The cleanup steps this receipt asserts already happened.
 *
 * A `delivery_land` receipt written before cleanup asserts none, so nothing is
 * observed and nothing is refused. Each assertion, including a bare absence
 * timestamp, opts that one step into live verification.
 */
function claimedCleanup(receipt: ReceiptV1): ClaimedCleanup[] {
	const claimed: ClaimedCleanup[] = [];
	if (receipt.branch.deletedRemote || receipt.branch.remoteAbsenceVerifiedAt !== null) claimed.push("remoteBranchAbsent");
	if (receipt.worktree.localRefDeleted) claimed.push("localRefAbsent");
	if (receipt.worktree.removed || receipt.worktree.absenceVerifiedAt !== null) claimed.push("worktreeAbsent");
	return claimed;
}

/**
 * Where the live repository contradicts the cleanup this receipt claims.
 *
 * A stale receipt asserting a cleanup that never happened, or was undone, is the
 * case this catches. Only claimed steps are judged: an unclaimed one is not a
 * discrepancy, and a claim that cannot be observed at all fails closed.
 */
function claimedCleanupFailures(
	claimed: readonly ClaimedCleanup[],
	observation: CleanupObservation | undefined,
	failure: string | undefined,
): string[] {
	if (observation === undefined) return [`current cleanup observation: ${failure ?? "observer returned no state"}`];
	const failures: string[] = [];
	for (const step of claimed) {
		if (!observation[step]) failures.push(requirement(`current ${CLAIMED_CLEANUP_LABEL[step]}`, "present", "absent, as this receipt claims"));
	}
	return failures;
}

let internalRuns = 0;

export async function runBd(
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
	toolCallId: string,
	deps: ReconcileDependencies = {},
): Promise<SpawnResult> {
	const execute = () => (deps.spawn ?? defaultSpawn)(argv, cwd, env, deadline);
	if (!writesStore(invocationFromArgv(argv))) return execute();
	const locked = await (deps.lock ?? withEmbeddedWriteLock)(
		cwd,
		`${toolCallId}-bd-reconcile-${internalRuns++}`,
		execute,
		env,
		deadline,
	);
	if (locked.kind === "failed") {
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: locked.reason };
	}
	return locked.value;
}

function parseRows(result: SpawnResult, label: string): { rows?: JsonObject[]; failure?: string } {
	if (!result.ok) {
		const detail = result.error ?? [result.stderr, result.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
		return { failure: `${label} failed: ${detail || `exit ${result.exitCode}`}` };
	}
	const data = envelopeData(parseTrailingJson(result.stdout));
	if (!Array.isArray(data)) return { failure: `${label} returned malformed JSON` };
	const rows = data.map(object);
	if (rows.some((row) => row === undefined)) return { failure: `${label} returned malformed rows` };
	return { rows: rows as JsonObject[] };
}

function dependency(row: unknown): DependencyRecord | undefined {
	const value = object(row);
	if (value === undefined) return undefined;
	const dependencyType = string(value.dependency_type) ?? string(value.type);
	return {
		id: string(value.id),
		issueId: string(value.issue_id),
		dependsOnId: string(value.depends_on_id),
		type: dependencyType,
		status: string(value.status),
	};
}

function comments(row: JsonObject): string[] {
	if (!Array.isArray(row.comments)) return [];
	return row.comments
		.map((entry) => object(entry))
		.map((entry) => string(entry?.text))
		.filter((entry): entry is string => entry !== undefined);
}

function beadFromRow(row: JsonObject): BeadRecord | undefined {
	const id = string(row.id);
	const status = string(row.status);
	if (id === undefined || status === undefined) return undefined;
	return {
		id,
		status,
		assignee: string(row.assignee),
		metadata: object(row.metadata) ?? {},
		dependencies: Array.isArray(row.dependencies)
			? row.dependencies.map(dependency).filter((item): item is DependencyRecord => item !== undefined)
			: [],
		comments: comments(row),
		parent: string(row.parent),
	};
}

function gatesFromOutput(output: string): GateRecord[] | undefined {
	const parsed = readGateList(output);
	if (parsed === undefined) return undefined;
	const data = envelopeData(parseTrailingJson(output));
	if (data === null) return [];
	if (!Array.isArray(data)) return undefined;
	const gates: GateRecord[] = [];
	for (const item of data) {
		const row = object(item);
		const id = string(row?.id);
		if (row === undefined || id === undefined) return undefined;
		const description = string(row.description);
		gates.push({
			id,
			blocks: string(row.blocks) ?? description?.match(/blocking\s+(\S+)/)?.[1],
			reason: string(row.reason) ?? description?.match(/Reason:\s*(.+)$/m)?.[1],
			description,
		});
	}
	return gates;
}

function metadataValue(bead: BeadRecord, key: string): string | undefined {
	const value = bead.metadata[key];
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return string(value);
}

function prMatches(value: string | undefined, receipt: ReceiptV1): boolean {
	if (value === undefined) return false;
	const expectedNumber = String(receipt.pr.number);
	return value.split(",").map((item) => item.trim()).some((item) =>
		item === expectedNumber || item === receipt.pr.url
	);
}

/**
 * The bead metadata anchors a landing receipt is authoritative for.
 *
 * Each is set when the bead carries none and reported as a conflict when the bead
 * carries a different one. Reconciliation never overwrites an anchor: a human put
 * the differing value there, or two landings disagree, and both need an answer
 * rather than a silent repair.
 */
const ANCHOR_KEYS = ["pr", "merge_sha", "base", "branch", "head_sha"] as const;

type AnchorKey = (typeof ANCHOR_KEYS)[number];

/** The value the receipt carries for one anchor, or undefined when it carries none. */
function anchorValue(key: AnchorKey, receipt: ReceiptV1): string | undefined {
	switch (key) {
		case "pr":
			return String(receipt.pr.number);
		case "merge_sha":
			return receipt.pr.mergeCommitOid ?? undefined;
		case "base":
			return receipt.pr.baseRefName;
		case "branch":
			return receipt.pr.headRefName;
		case "head_sha":
			return receipt.pr.headRefOid;
	}
}

/** Does the anchor the bead already carries agree with the receipt? */
function anchorSatisfied(key: AnchorKey, current: string, receipt: ReceiptV1): boolean {
	// `pr` is the one anchor written in more than one shape: a number, the PR URL, or
	// a comma-separated list when a bead landed more than once.
	if (key === "pr") return prMatches(current, receipt);
	return current === anchorValue(key, receipt);
}

function isPidAlive(pid: number, probe?: (pid: number) => void): boolean {
	try {
		if (probe === undefined) process.kill(pid, 0);
		else probe(pid);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
	}
}

/** The provider CLI whose verbs can observe a landing on each forge. */
const FORGE_CLI: Record<string, string> = { github: "gh", gitlab: "glab" };

/**
 * Did a provider CLI observe this landing, as `proof.method` records it?
 *
 * `proof.method` is the provider CLI and the verb that was issued (`gh pr view`,
 * `glab mr view`), on a continuation receipt too: which tool re-observed the landing
 * is recorded in `emitter.tool`, not here. The sentinel `unknown` means no provider
 * observed it, so it is not landing proof and cannot close a bead, and neither is
 * any other string a provider never issued.
 */
function forgeObservedLanding(receipt: ReceiptV1): boolean {
	const cli = FORGE_CLI[receipt.repo.forge];
	if (cli === undefined) return false;
	const tokens = receipt.proof.method.trim().split(/\s+/);
	return tokens[0] === cli && tokens.length > 1;
}

/**
 * The receipt's own claim to describe an exact merged pull request.
 *
 * Every check reads the receipt alone. Bead metadata is judged separately, by the
 * anchor table, so that a bead missing an anchor is repaired rather than treated as
 * contradicting the receipt.
 */
function landingProofFailures(receipt: ReceiptV1): string[] {
	const failures: string[] = [];
	if (receipt.emitter.tool !== "delivery_land" && receipt.emitter.tool !== "delivery_cleanup") {
		failures.push(requirement("emitter.tool", receipt.emitter.tool, '"delivery_land" or "delivery_cleanup"'));
	}
	if (receipt.repo.forge === "unknown") {
		failures.push(requirement("repo.forge", receipt.repo.forge, '"github" or "gitlab"'));
	}
	if (receipt.pr.state !== "MERGED") failures.push(requirement("pr.state", receipt.pr.state, '"MERGED"'));
	if (!receipt.pr.headRefOid) failures.push(requirement("pr.headRefOid", receipt.pr.headRefOid, "a non-empty string"));
	if (receipt.pr.mergeCommitOid === null) failures.push(requirement("pr.mergeCommitOid", null, "a non-empty string"));
	if (receipt.pr.mergedAt === null) failures.push(requirement("pr.mergedAt", null, "a non-empty string"));
	if (receipt.branch.name !== receipt.pr.headRefName) failures.push(requirement("branch.name", receipt.branch.name, JSON.stringify(receipt.pr.headRefName)));
	return failures;
}

/**
 * What still stands between this receipt and closing a bead.
 *
 * Reconciliation runs BEFORE cleanup, so nothing here may require cleanup to have
 * happened: at this point the remote branch and the worktree are still present by
 * design. Requiring their absence is what deadlocked the lifecycle, because
 * delivery_cleanup in turn refuses while the ledger is unreconciled. The receipt's
 * cleanup flags and the live absence verdict therefore never grant a close; the
 * forge-observed landing does.
 */
function closeProofFailures(receipt: ReceiptV1): string[] {
	const failures = landingProofFailures(receipt);
	if (receipt.outcome !== "landed") {
		failures.push(requirement("outcome", receipt.outcome, '"landed" for automatic close'));
	}
	if (!forgeObservedLanding(receipt)) {
		failures.push(requirement("proof.method", receipt.proof.method, `a ${FORGE_CLI[receipt.repo.forge] ?? "provider"} CLI query that observed the landing`));
	}
	if (!receipt.beads.ledgerActive) failures.push(requirement("beads.ledgerActive", false, "true"));
	return failures;
}

function auditResponses(store: string | undefined): { entries?: JsonObject[]; failure?: string } {
	if (store === undefined) return { failure: "audit history store is unavailable" };
	const path = join(store, "interactions.jsonl");
	if (!existsSync(path)) return { entries: [] };
	try {
		const content = readFileSync(path, "utf8");
		if (content !== "" && !content.endsWith("\n")) {
			return { failure: `audit history ${path} is truncated: final JSONL record has no newline` };
		}
		const entries: JsonObject[] = [];
		for (const [index, line] of content.split("\n").entries()) {
			if (line === "") continue;
			const entry = object(JSON.parse(line));
			if (entry === undefined) return { failure: `audit history ${path} line ${index + 1} is not an object` };
			entries.push(entry);
		}
		return { entries };
	} catch (error) {
		return { failure: `audit history ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function hasMergeAudit(entries: JsonObject[], bead: string, mergeOid: string): boolean {
	for (const entry of entries) {
		if (entry.kind !== "semantic_event" || entry.issue_id !== bead) continue;
		let response: unknown = entry.response;
		if (typeof response === "string") {
			try { response = JSON.parse(response); } catch { continue; }
		}
		const record = object(response);
		if (record?.event !== "merge_outcome" || record.outcome !== "merged") continue;
		if (record.mergeCommitOid === mergeOid) return true;
		const artifact = string(record.artifact);
		if (artifact === undefined || !existsSync(artifact)) continue;
		try {
			const parsed = parseReceipt(JSON.parse(readFileSync(artifact, "utf8"))).receipt;
			if (parsed?.pr.mergeCommitOid === mergeOid) return true;
		} catch {
			// A stale or unreadable artifact cannot prove equivalence.
		}
	}
	return false;
}

function existingDiscoveredSource(bead: BeadRecord, source: string): boolean {
	return bead.dependencies.some((edge) =>
		edge.type === "discovered-from" && (edge.id === source || edge.dependsOnId === source)
	);
}

function operation(
	kind: ReconcileOperation["kind"],
	bead: string,
	receipt: string,
	description: string,
	argv: string[],
): ReconcileOperation {
	return { kind, bead, receipt, description, argv };
}

function depthOf(id: string, beads: ReadonlyMap<string, BeadRecord>, seen = new Set<string>()): number {
	if (seen.has(id)) return 0;
	seen.add(id);
	const bead = beads.get(id);
	return bead?.parent ? 1 + depthOf(bead.parent, beads, seen) : 0;
}

function formatReport(report: Omit<ReconcileReport, "text">): string {
	const lines = [
		`bd_reconcile ${report.apply ? "apply" : "scan"}: ${report.receipts.length} receipt(s), ${report.operations.length} planned ledger write(s).`,
	];
	for (const refusal of report.refusals) {
		lines.push(`REFUSE ${refusal.bead ? `${refusal.bead} ` : ""}${refusal.receipt}: ${refusal.reason}`);
	}
	for (const item of report.operations) lines.push(`PLAN ${item.bead}: ${item.description}`);
	for (const item of report.applied) lines.push(`APPLIED ${item.bead}: ${item.description}`);
	for (const failure of report.failures) lines.push(`FAIL ${failure}`);
	if (report.operations.length === 0 && report.failures.length === 0 && report.refusals.length === 0) {
		lines.push("No ledger writes are needed; receipt-derived state is converged.");
	} else if (report.operations.length === 0 && report.failures.length === 0 && report.refusals.length > 0) {
		lines.push("No ledger writes were planned; resolve the refusals above before treating receipt-derived state as converged.");
	} else if (!report.apply && report.operations.length > 0) {
		lines.push("Scan mode wrote nothing. Re-run with apply=true to request exec approval and apply this plan.");
	}
	return lines.join("\n");
}

async function reconcileReceiptsUnlocked(
	params: ReconcileParams,
	toolCallId: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	deps: ReconcileDependencies,
	deadline: number,
): Promise<ReconcileReport> {
	const bdEnv = lifecycleBdEnvironment(cwd, env);
	bdEnv.BD_JSON_ENVELOPE = "1";
	const loaded = await readReceiptSources(params, cwd, bdEnv, deadline, deps);
	const refusals: ReconcileRefusal[] = [];
	if (loaded.refusal !== undefined) refusals.push({ receipt: params.receipt ?? "(scan)", reason: loaded.refusal });
	const validSources: ReceiptSource[] = [];
	for (const source of loaded.sources) {
		if (source.reason !== undefined || source.receipt === undefined) {
			refusals.push({ receipt: source.path, reason: source.reason ?? "receipt v1 was not recognized" });
			continue;
		}
		if (loaded.repoKey !== source.receipt.repo.key) {
			refusals.push({ receipt: source.path, reason: requirement("repo.key", source.receipt.repo.key, JSON.stringify(loaded.repoKey)) });
			continue;
		}
		const expectedPath = resolve(receiptRoot(bdEnv, deps), source.receipt.repo.key, `${source.receipt.receiptId}.json`);
		if (resolve(source.path) !== expectedPath) {
			refusals.push({ receipt: source.path, reason: requirement("receipt path", source.path, JSON.stringify(expectedPath)) });
			continue;
		}
		if (params.bead !== undefined && !source.receipt.beads.ids.includes(params.bead)) {
			refusals.push({ receipt: source.path, reason: `beads.ids: observed ${JSON.stringify(source.receipt.beads.ids)}, expected to include ${JSON.stringify(params.bead)}` });
			continue;
		}
		validSources.push(source);
	}
	if (validSources.length === 0) {
		const base = { ok: refusals.length === 0, apply: Boolean(params.apply), receipts: loaded.sources.map((source) => source.path), operations: [], applied: [], refusals, failures: [] };
		return { ...base, text: formatReport(base) };
	}
	const authoritativeSources: ReceiptSource[] = [];
	const cleanupFailuresByReceipt = new Map<string, string[]>();
	for (const source of validSources) {
		const receipt = source.receipt as ReceiptV1;
		const observedProof = await (deps.observeProof ?? defaultObserveProof)(receipt, cwd, bdEnv, deadline);
		if (observedProof.observation === undefined) {
			refusals.push({ receipt: source.path, reason: `authoritative forge proof unavailable: ${observedProof.failure ?? "observer returned no identity"}` });
			continue;
		}
		const mismatches = observationFailures(receipt, observedProof.observation);
		if (mismatches.length > 0) {
			refusals.push({ receipt: source.path, reason: `receipt does not match current repository and PR: ${mismatches.join("; ")}` });
			continue;
		}
		// Verify only the cleanup the receipt actually claims. A pre-cleanup landing
		// claims none, and observing one would refuse every receipt reconciled in the
		// documented order. A continuation that claims cleanup is checked against the
		// live repository, because its stored booleans are the thing under suspicion.
		const claimed = claimedCleanup(receipt);
		if (claimed.length > 0) {
			const cleanup = deps.observeCleanup === undefined
				? await defaultObserveCleanup(receipt, observedProof.observation.repo.nameWithOwner, cwd, bdEnv, deadline, deps.cleanupCommand, deps.remotePlatform)
				: await deps.observeCleanup(receipt, cwd, bdEnv, deadline);
			cleanupFailuresByReceipt.set(source.path, claimedCleanupFailures(claimed, cleanup.observation, cleanup.failure));
		}
		authoritativeSources.push(source);
	}
	if (authoritativeSources.length === 0) {
		const base = { ok: refusals.length === 0, apply: Boolean(params.apply), receipts: validSources.map((source) => source.path), operations: [], applied: [], refusals, failures: [] };
		return { ...base, text: formatReport(base) };
	}
 
	const targets = new Map<string, ReceiptSource>();
	const receiptConflicts = new Map<string, string[]>();
	for (const source of authoritativeSources) {
		const receipt = source.receipt as ReceiptV1;
		const ids = params.bead === undefined ? receipt.beads.ids : [params.bead];
		for (const id of ids) {
			const prior = targets.get(id)?.receipt;
			if (prior !== undefined && (prior.pr.number !== receipt.pr.number || prior.pr.mergeCommitOid !== receipt.pr.mergeCommitOid)) {
				const conflict = `ambiguous receipts: observed PR #${prior.pr.number}/${prior.pr.mergeCommitOid ?? "absent"} and PR #${receipt.pr.number}/${receipt.pr.mergeCommitOid ?? "absent"}, expected one exact PR identity`;
				const existing = receiptConflicts.get(id) ?? [];
				existing.push(conflict);
				receiptConflicts.set(id, existing);
				refusals.push({ bead: id, receipt: source.path, reason: conflict });
				continue;
			}
			if (prior === undefined || Date.parse(prior.emittedAt) < Date.parse(receipt.emittedAt)
				|| (Date.parse(prior.emittedAt) === Date.parse(receipt.emittedAt) && prior.receiptId < receipt.receiptId)) {
				targets.set(id, source);
			}
		}
	}
	const ids = [...targets.keys()];
	// No targets and no refusals is a ledger-free repository whose receipts name no
	// bead: there is nothing to reconcile, which is success rather than failure.
	if (ids.length === 0) {
		const base = { ok: refusals.length === 0, apply: Boolean(params.apply), receipts: authoritativeSources.map((source) => source.path), operations: [], applied: [], refusals, failures: [] };
		return { ...base, text: formatReport(base) };
	}

	const [shown, listed, gateResult] = await Promise.all([
		runBd(["show", ...ids, "--include-comments", "--json"], cwd, bdEnv, deadline, toolCallId, deps),
		runBd(["list", "--all", "--include-gates", "--flat", "--brief", "--limit", "0", "--json"], cwd, bdEnv, deadline, toolCallId, deps),
		runBd(["gate", "list", "--json"], cwd, bdEnv, deadline, toolCallId, deps),
	]);
	const showRows = parseRows(shown, "bd show");
	const listRows = parseRows(listed, "bd list --all");
	const gates = gateResult.ok ? gatesFromOutput(gateResult.stdout) : undefined;
	const failures = [showRows.failure, listRows.failure, gates === undefined ? "bd gate list returned unreadable state" : undefined]
		.filter((failure): failure is string => failure !== undefined);
	if (failures.length > 0) {
		const base = { ok: false, apply: Boolean(params.apply), receipts: authoritativeSources.map((source) => source.path), operations: [], applied: [], refusals, failures };
		return { ...base, text: formatReport(base) };
	}

	const allBeads = new Map<string, BeadRecord>();
	for (const row of listRows.rows ?? []) {
		const bead = beadFromRow(row);
		if (bead !== undefined) allBeads.set(bead.id, bead);
	}
	for (const row of showRows.rows ?? []) {
		const bead = beadFromRow(row);
		if (bead !== undefined) allBeads.set(bead.id, bead);
	}
	const sorted = ids.sort((left, right) => depthOf(right, allBeads) - depthOf(left, allBeads) || left.localeCompare(right));
	const operations: ReconcileOperation[] = [];
	const plannedClosed = new Set<string>();
	const audit = auditResponses(embeddedStoreFor(cwd, bdEnv));
	const localHost = deps.host ?? hostname().split(".")[0] ?? hostname();

	for (const id of sorted) {
		const source = targets.get(id);
		const receipt = source?.receipt;
		const bead = allBeads.get(id);
		if (source === undefined || receipt === undefined) continue;
		if (bead === undefined) {
			refusals.push({ bead: id, receipt: source.path, reason: `bead: observed missing ${id}, expected an existing ledger bead` });
			continue;
		}
		const conflicts: string[] = [...(receiptConflicts.get(id) ?? [])];
		const missingAnchors: AnchorKey[] = [];
		for (const key of ANCHOR_KEYS) {
			const expected = anchorValue(key, receipt);
			const current = metadataValue(bead, key);
			if (current === undefined) {
				if (expected !== undefined) missingAnchors.push(key);
				continue;
			}
			if (!anchorSatisfied(key, current, receipt)) {
				conflicts.push(requirement(`metadata.${key}`, current, expected === undefined ? "absent" : JSON.stringify(expected)));
			}
		}
		if (conflicts.length > 0) {
			const marker = `bd_reconcile ambiguity ${receipt.receiptId}`;
			const reason = `${marker}: ${conflicts.join("; ")}; receipt ${source.path}`;
			refusals.push({ bead: id, receipt: source.path, reason });
			if (bead.status !== "closed") {
				if (!bead.comments.some((comment) => comment.includes(marker))) {
					operations.push(operation("comment-ambiguity", id, source.path, "record the close-out ambiguity", ["comments", "add", id, reason]));
				}
				if (!(gates ?? []).some((gate) => gate.blocks === id && `${gate.reason ?? ""} ${gate.description ?? ""}`.includes(marker))) {
					operations.push(operation("gate-ambiguity", id, source.path, "create a human gate for the close-out ambiguity", ["gate", "create", "--type", "human", "--blocks", id, "--title", "Gate: bd_reconcile ambiguity", "--reason", reason, "--json"]));
				}
			}
		}

		const leaseHost = metadataValue(bead, "lease_host");
		const leasePid = metadataValue(bead, "lease_pid");
		const anchor = claimAnchor({
			id: bead.id,
			title: "",
			status: bead.status,
			assignee: bead.assignee,
			metadata: leaseHost !== undefined && leasePid !== undefined
				? { lease_host: leaseHost, lease_pid: leasePid }
				: undefined,
		});
		const localAnchor = anchor !== undefined && anchor.host.split(".")[0] === localHost.split(".")[0];
		const anchorAlive = anchor === undefined ? true : (deps.pidAlive?.(anchor.pid) ?? isPidAlive(anchor.pid, deps.pidProbe));
		const deadLocalClaim = bead.status !== "closed" && bead.assignee !== undefined && anchor !== undefined && localAnchor && !anchorAlive;
		let guardedReleasePlanned = false;
		if (deadLocalClaim && bead.assignee !== undefined) {
			const release = releaseClaimArgs(id, bead.assignee, bdEnv);
			if (release === undefined) {
				refusals.push({ bead: id, receipt: source.path, reason: "dead claim release: observed no safe actor-bound CAS argv, expected BD_ACTOR or BEADS_ACTOR and a valid assignee" });
			} else {
				operations.push(operation("release-dead-claim", id, source.path, `release dead claim ${bead.assignee} with --if-assignee`, [...release, "--json"]));
				guardedReleasePlanned = true;
			}
		}

		if (conflicts.length === 0 && receipt.pr.mergeCommitOid !== null && missingAnchors.length > 0) {
			const argv = missingAnchors.flatMap((key) => ["--set-metadata", `${key}=${anchorValue(key, receipt) as string}`]);
			operations.push(operation("set-merge-anchors", id, source.path, `set the missing receipt-derived ${missingAnchors.join(", ")} anchor(s)`, ["update", id, ...argv, "--json"]));
		}

		const authoritativeSource = deps.authoritativeSource?.(bead, allBeads);
		if (authoritativeSource !== undefined && (!BEAD_ID.test(authoritativeSource) || !allBeads.has(authoritativeSource))) {
			refusals.push({ bead: id, receipt: source.path, reason: requirement("authoritative discovered-from source", authoritativeSource, "an existing bead id") });
		} else if (authoritativeSource !== undefined && !existingDiscoveredSource(bead, authoritativeSource)) {
			operations.push(operation("add-discovered-from", id, source.path, `add authoritative discovered-from edge to ${authoritativeSource}`, ["dep", "add", id, authoritativeSource, "--type", "discovered-from", "--json"]));
		}

		const exactMerge = conflicts.length === 0 && landingProofFailures(receipt).length === 0;
		if (exactMerge && receipt.pr.mergeCommitOid !== null && audit.failure === undefined && !hasMergeAudit(audit.entries ?? [], id, receipt.pr.mergeCommitOid)) {
			const response = JSON.stringify({ event: "merge_outcome", outcome: "merged", artifact: source.path, mergeCommitOid: receipt.pr.mergeCommitOid });
			operations.push(operation("record-merge-audit", id, source.path, "record the missing merge audit event", ["audit", "record", "--kind", "semantic_event", "--issue-id", id, "--response", response, "--json"]));
		}
		if (audit.failure !== undefined) {
			refusals.push({ bead: id, receipt: source.path, reason: audit.failure });
			continue;
		}

		if (bead.status === "closed" || conflicts.length > 0) continue;
		const closeFailures = closeProofFailures(receipt);
		closeFailures.push(...(cleanupFailuresByReceipt.get(source.path) ?? []));
		if (bead.assignee !== undefined && !guardedReleasePlanned) {
			const lease = anchor === undefined ? "absent" : `${anchor.host}:${anchor.pid}`;
			closeFailures.push(requirement("live assignment/lease", `${bead.assignee} (${lease})`, "absent or a locally proven dead lease with a planned --if-assignee release"));
		}
		const openGates = (gates ?? []).filter((gate) => gate.blocks === id);
		if (openGates.length > 0) closeFailures.push(requirement("open gates", openGates.map((gate) => gate.id), "[]"));
		const blockers = bead.dependencies.filter((edge) => edge.type === "blocks" && edge.status !== "closed");
		if (blockers.length > 0) closeFailures.push(requirement("live blockers", blockers.map((edge) => edge.id), "[]"));
		const openChildren = [...allBeads.values()].filter((candidate) => candidate.parent === id && candidate.status !== "closed" && !plannedClosed.has(candidate.id));
		if (openChildren.length > 0) closeFailures.push(requirement("open children", openChildren.map((child) => child.id), "[]"));
		if (closeFailures.length > 0) {
			for (const reason of closeFailures) refusals.push({ bead: id, receipt: source.path, reason });
			continue;
		}
		const reason = `PR #${receipt.pr.number} merged as ${receipt.pr.mergeCommitOid}; exact receipt ${receipt.receiptId} reconciled.`;
		operations.push(operation("close", id, source.path, `close with PR #${receipt.pr.number} and merge ${receipt.pr.mergeCommitOid}`, ["close", id, "--reason", reason, "--json"]));
		plannedClosed.add(id);
	}

	const applied: ReconcileOperation[] = [];
	if (params.apply) {
		for (const item of operations) {
			const result = await (deps.spawn ?? defaultSpawn)(item.argv, cwd, bdEnv, deadline);
			if (!result.ok) {
				const detail = result.error ?? [result.stderr, result.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
				failures.push(`${item.bead} ${item.kind} failed: ${detail || `exit ${result.exitCode}`}; applied work remains convergent and a retry will resume from ledger state`);
				break;
			}
			applied.push(item);
		}
	}
	const base = {
		ok: failures.length === 0 && refusals.length === 0,
		apply: Boolean(params.apply),
		receipts: authoritativeSources.map((source) => source.path),
		operations,
		applied,
		refusals,
		failures,
	};
	return { ...base, text: formatReport(base) };
}

export async function reconcileReceipts(
	params: ReconcileParams,
	toolCallId: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	deps: ReconcileDependencies = {},
): Promise<ReconcileReport> {
	const deadline = Date.now() + TOOL_TIMEOUT_MS;
	if (!params.apply) return reconcileReceiptsUnlocked(params, toolCallId, cwd, env, deps, deadline);
	const bdEnv = lifecycleBdEnvironment(cwd, env);
	bdEnv.BD_JSON_ENVELOPE = "1";
	const locked = await (deps.lock ?? withEmbeddedWriteLock)(
		cwd,
		`${toolCallId}-bd-reconcile-transaction-${internalRuns++}`,
		() => reconcileReceiptsUnlocked(params, toolCallId, cwd, bdEnv, deps, deadline),
		bdEnv,
		deadline,
	);
	if (locked.kind === "done") return locked.value;
	const base = {
		ok: false,
		apply: true,
		receipts: [],
		operations: [],
		applied: [],
		refusals: [],
		failures: [`apply refused before ledger reads: ${locked.reason}`],
	};
	return { ...base, text: formatReport(base) };
}

export function resetReconcileArbiterForTests(): void {
	Reflect.deleteProperty(globalThis, RECONCILE_ARBITER);
}

function registrationArbiter(): WeakSet<object> {
	const existing = Reflect.get(globalThis, RECONCILE_ARBITER);
	if (existing instanceof WeakSet) return existing;
	const arbiter = new WeakSet<object>();
	Reflect.set(globalThis, RECONCILE_ARBITER, arbiter);
	return arbiter;
}

function takeRegistration(pi: ExtensionAPI): boolean {
	const arbiter = registrationArbiter();
	if (arbiter.has(pi)) return false;
	arbiter.add(pi);
	return true;
}

function releaseRegistration(pi: ExtensionAPI): void {
	registrationArbiter().delete(pi);
}

export function reconcileApproval(toolCall: unknown): "read" | "exec" {
	const input = object(object(toolCall)?.input);
	return input?.apply === true ? "exec" : "read";
}

export default function bdReconcileTool(pi: ExtensionAPI): void {
	if (!takeRegistration(pi)) return;
	const z = pi.zod;
	try {
		pi.registerTool({
			name: "bd_reconcile",
			label: "Reconcile landing receipts into Beads",
			description:
				"Scan landing receipt v1 files a delivery tool wrote and plan convergent Beads ledger repairs. Default apply=false is read-only. " +
				"apply=true requires exec approval and is the only receipt-derived ledger writer; it never force-closes, reopens, supersedes, prunes, purges, flattens, compacts, runs gc, or deletes beads.",
			parameters: z.object({
				receipt: z.string().optional().describe("Receipt id, or the exact path of a receipt file under the receipt root; inline receipt JSON is refused"),
				bead: z.string().optional().describe("Limit reconciliation to this receipt-named bead"),
				repoKey: z.string().optional().describe("16-character repository key; defaults to the current git common directory"),
				apply: z.boolean().optional().describe("Apply the planned ledger repairs (exec approval); defaults to false"),
			}) as unknown as TSchema,
			approval: reconcileApproval,
			execute: async (
				toolCallId: string,
				params: ReconcileParams,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionContext | undefined,
			) => {
				const result = await reconcileReceipts(params, toolCallId, ctx?.cwd ?? process.cwd());
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	} catch (error) {
		releaseRegistration(pi);
		throw error;
	}
}
