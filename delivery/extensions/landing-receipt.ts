import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	type Dir,
	fchmodSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The landing receipt: the proof a branch landed, written by delivery and read by
 * whoever reconciles the ledger.
 *
 * The receipt exists so the package that proves a landing is not the package that
 * writes the ledger. Both sides then fail independently: a landing that cannot be
 * proved emits no receipt, and a ledger write with no receipt has no authority.
 *
 * Transport is a file rather than an in-process signal because the reconciling
 * session is frequently not the landing session. It lives under the agent
 * directory rather than the repository because a receipt describes a branch that
 * cleanup is about to delete, and because scratch state inside a worktree is
 * forbidden.
 *
 * This module is a library, not an extension: the tools import it, and it is never
 * declared in `delivery/package.json`. It makes no forge call, no `bd` call, and no
 * Beads write.
 *
 * Three properties the rest of the file exists to hold up:
 *
 * - A receipt is untrusted input. It is read from a shared directory, it may have
 *   been written by a newer version, and two of its fields become path segments.
 * - The producer can only mint what the validator accepts. `receiptId` refuses to
 *   build an id that `validateReceipt` would reject, so an invalid receipt cannot
 *   originate here.
 * - Publishing is exclusive and idempotent. Two writers racing on one id never
 *   clobber each other, and neither deletes the other's temporary file.
 */

/** Schema discriminator. A consumer ignores any object carrying another value. */
export const RECEIPT_SCHEMA = "omp.receipt.landing";

/** Version this module implements. A greater observed version is refused, never guessed at. */
export const RECEIPT_VERSION = 1;

/** Git calls are bounded: a receipt is written at a session boundary, never blocking it. */
const GIT_TIMEOUT_MS = 2000;

/**
 * Cap on a single receipt read. A receipt is a few kilobytes; anything larger is
 * not one, and reading it unbounded would stall the boundary it is written at.
 */
const MAX_RECEIPT_BYTES = 256 * 1024;

/** Cap on receipts retained and returned from one streamed directory scan. */
const MAX_LISTED_RECEIPTS = 200;

/**
 * Temporary-name attempts before giving up.
 *
 * A collision means another writer holds that name, so the only safe response is a
 * different name. Deleting the file we collided with would destroy that writer's
 * in-flight receipt.
 */
const MAX_TEMP_ATTEMPTS = 5;

/** Last epoch millisecond whose UTC representation has a four-digit year. */
const MAX_RECEIPT_EPOCH = 253_402_300_799_999;

/**
 * Exactly what `repoKey` mints, and the only thing accepted as a directory name.
 *
 * This is the whole defence against a receipt whose `repo.key` is `../../../etc`:
 * the pattern admits no separator, no dot and no upper case, so the value cannot
 * leave the receipts tree once it reaches `join`.
 */
const REPO_KEY = /^[0-9a-f]{16}$/;
const REPO_KEY_TEXT = "16 lowercase hex characters";

/**
 * Exactly what `receiptId` mints, and the only thing accepted as a filename stem.
 *
 * Epoch millis, a hyphen, then either 12 lowercase hex characters of the merge oid
 * or the literal `nomerge`. As with {@link REPO_KEY}, admitting no separator and no
 * dot is what makes the value safe to join.
 */
const RECEIPT_ID = /^[0-9]{1,15}-(?:[0-9a-f]{12}|nomerge)$/;
const RECEIPT_ID_TEXT = 'epoch millis of at most 15 digits, "-", then 12 lowercase hex characters or "nomerge"';

/**
 * An ISO-8601 instant: date, `T`, time, optional milliseconds, then `Z` or an
 * offset.
 *
 * Shape-checked rather than handed straight to `Date.parse`, because `Date.parse`
 * also accepts a pile of non-ISO formats whose meaning is implementation-defined.
 * An offset form is allowed: {@link sameInstant} compares instants, not text, so
 * `2023-11-15T02:13:20.000+04:00` and `2023-11-14T22:13:20.000Z` are equally
 * acceptable ways to say the same millisecond.
 */
const EMITTED_AT =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

/** A receipt filename: a {@link RECEIPT_ID} stem and nothing else. */
const RECEIPT_FILE = /^[0-9]{1,15}-(?:[0-9a-f]{12}|nomerge)\.json$/;

/**
 * A usable merge oid: hex, and long enough that its first 12 characters identify a
 * commit. Git emits 40 (SHA-1) or 64 (SHA-256); anything shorter is not an oid.
 */
const MERGE_OID = /^[0-9a-f]{12,}$/;

export type ReceiptForge = "github" | "gitlab" | "unknown";
export type ReceiptAutoDelete = "on" | "off" | "unknown";
export type ReceiptOutcome = "landed" | "cleaned" | "partial";

export type ReceiptEmitter = { plugin: string; version: string; tool: string };

export type ReceiptRepo = {
	key: string;
	canonicalRoot: string;
	remote: string;
	forge: ReceiptForge;
	nameWithOwner: string;
};

export type ReceiptPr = {
	number: number;
	url: string;
	state: string;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	mergeCommitOid: string | null;
	mergedAt: string | null;
};

export type ReceiptBranch = {
	name: string;
	deletedRemote: boolean;
	remoteAbsenceVerifiedAt: string | null;
	autoDeleteSetting: ReceiptAutoDelete;
};

export type ReceiptWorktree = {
	path: string | null;
	removed: boolean;
	localRefDeleted: boolean;
	absenceVerifiedAt: string | null;
};

export type ReceiptBeads = { ids: string[]; ledgerActive: boolean };

export type ReceiptProof = { method: string; observedAt: string; evidence: Record<string, unknown> };

/**
 * One receipt.
 *
 * The index signature is load-bearing: a receipt written by a later version carries
 * keys this version does not know, and a continuation receipt must write them back
 * out rather than silently drop a successor's proof.
 */
export type LandingReceipt = {
	schema: typeof RECEIPT_SCHEMA;
	version: number;
	receiptId: string;
	emittedAt: string;
	emitter: ReceiptEmitter;
	repo: ReceiptRepo;
	pr: ReceiptPr;
	branch: ReceiptBranch;
	worktree: ReceiptWorktree;
	beads: ReceiptBeads;
	proof: ReceiptProof;
	outcome: ReceiptOutcome;
	/** The `receiptId` this receipt continues, or null when it starts a chain. */
	supersedes: string | null;
	notes?: string;
	[key: string]: unknown;
};

export type ReceiptInput = {
	emitter: ReceiptEmitter;
	repo: ReceiptRepo;
	pr: ReceiptPr;
	branch: ReceiptBranch;
	worktree: ReceiptWorktree;
	beads: ReceiptBeads;
	proof: ReceiptProof;
	outcome: ReceiptOutcome;
	/**
	 * The single clock for both `receiptId` and `emittedAt`; injected so tests fix
	 * both. There is deliberately no override for either field: they must agree on
	 * the same millisecond, and two independent inputs is how they would stop
	 * agreeing.
	 */
	now?: number;
	notes?: string;
	/** Overrides the `supersedes` that `continues` would imply. */
	supersedes?: string | null;
	/** The receipt this one continues: its unknown keys are carried forward. */
	continues?: LandingReceipt | null;
};

export type ReceiptValidation = { ok: true; receipt: LandingReceipt } | { ok: false; reason: string };

/**
 * Seam for {@link writeReceipt}'s temporary filename.
 *
 * Exists so a test can force the collision path deterministically; random names
 * cannot be collided with on purpose.
 */
export type WriteOptions = { tempName?: () => string };

/**
 * The git seam: argv without the `git` word, a working directory, and a bound.
 *
 * Returns stdout exactly as Git wrote it, or null when Git failed for any reason.
 * Repository paths may contain spaces, so parsing owns any delimiters rather than
 * trimming them at this process boundary.
 */
export type GitRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => string | null;

const spawnGit: GitRunner = (argv, cwd, timeoutMs) => {
	try {
		const proc = Bun.spawnSync(["git", ...argv], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: Math.max(1, timeoutMs),
		});
		if (proc.exitCode !== 0) return null;
		return proc.stdout.toString();
	} catch {
		return null;
	}
};

/** One Git read that binds repository identity and the current checkout placement together. */
export const REPOSITORY_OBSERVATION_ARGS = [
	"rev-parse",
	"--path-format=absolute",
	"--git-common-dir",
	"--show-toplevel",
] as const;

/** The physical repository paths and classification derived from one Git read. */
export type RepositoryContext = {
	key: string;
	commonDir: string;
	topLevel: string;
	ledger: CanonicalLedger;
};

/** A real, existing directory, or null when the path cannot prove one. */
function physicalDirectory(path: string): string | null {
	try {
		const real = realpathSync(path);
		return lstatSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
}

/** Resolve a checkout's `.git` directory through either a directory or a strict Git file. */
function checkoutGitDirectory(checkout: string): string | null {
	const marker = join(checkout, ".git");
	try {
		const stat = lstatSync(marker);
		if (stat.isDirectory()) return physicalDirectory(marker);
		if (!stat.isFile() || stat.size > 4096) return null;
		const match = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, "utf8"));
		if (match === null) return null;
		const target = match[1];
		if (target === undefined || target === "" || target.includes("\0")) return null;
		return physicalDirectory(isAbsolute(target) ? target : resolve(checkout, target));
	} catch {
		return null;
	}
}

/**
 * Parse Git's two newline-delimited paths without guessing through malformed or
 * ambiguous output. A path containing a newline cannot be represented by this
 * command without colliding with its delimiter, so it fails closed.
 */
function repositoryPaths(output: string): { commonDir: string; topLevel: string } | null {
	const body = output.endsWith("\n") ? output.slice(0, -1) : output;
	const records = body.split("\n");
	if (records.length !== 2) return null;
	const [common, top] = records;
	if (common === undefined || top === undefined || common === "" || top === "") return null;
	if (!isAbsolute(common) || !isAbsolute(top)) return null;
	if (common.includes("\0") || top.includes("\0") || common.includes("\r") || top.includes("\r")) return null;
	const commonDir = physicalDirectory(common);
	const topLevel = physicalDirectory(top);
	return commonDir === null || topLevel === null ? null : { commonDir, topLevel };
}

/**
 * Stable repository identity and canonical-ledger classification from one Git
 * observation containing the absolute common directory and checkout root.
 *
 * A normal checkout owns its common directory when resolving its `.git` marker
 * reaches that directory. Separate Git directories and submodules have the same
 * relationship, so Git's observed top level remains their canonical checkout.
 * A linked worktree's `.git` marker instead resolves below the common directory;
 * only then may the common directory's parent become the canonical checkout, and
 * only when that candidate's own `.git` marker resolves back to the common
 * directory. This prevents a separate Git directory literally named `.git` from
 * impersonating a canonical checkout.
 *
 * Every input and selected output is realpathed. Missing, malformed, non-directory,
 * or ambiguous observations return null rather than a ledger-free verdict.
 */
export function repositoryContext(cwd: string, run: GitRunner = spawnGit): RepositoryContext | null {
	const printed = run(REPOSITORY_OBSERVATION_ARGS, cwd, GIT_TIMEOUT_MS);
	if (printed === null || printed === "") return null;
	const paths = repositoryPaths(printed);
	if (paths === null) return null;

	const topLevelGitDir = checkoutGitDirectory(paths.topLevel);
	if (topLevelGitDir === null) return null;
	let candidate = paths.topLevel;
	if (topLevelGitDir !== paths.commonDir) {
		const canonicalCandidate = physicalDirectory(dirname(paths.commonDir));
		if (canonicalCandidate !== null && checkoutGitDirectory(canonicalCandidate) === paths.commonDir) {
			candidate = canonicalCandidate;
		}
	}

	const root = physicalDirectory(candidate);
	if (root === null) return null;
	const key = createHash("sha256").update(paths.commonDir).digest("hex").slice(0, 16);
	return {
		key,
		commonDir: paths.commonDir,
		topLevel: paths.topLevel,
		ledger: { root, active: ledgerActive(root) },
	};
}

/** Stable identity shared by a repository's primary checkout and linked worktrees. */
export function repoKey(cwd: string, run: GitRunner = spawnGit): string | null {
	const printed = run(["rev-parse", "--git-common-dir"], cwd, GIT_TIMEOUT_MS);
	if (printed === null || printed === "") return null;
	const common = printed.endsWith("\n") ? printed.slice(0, -1) : printed;
	if (common === "" || common.includes("\n") || common.includes("\r") || common.includes("\0")) return null;
	const real = physicalDirectory(isAbsolute(common) ? common : resolve(cwd, common));
	return real === null ? null : createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/**
 * Whether the nearest `.beads` ledger is active for a repository path.
 *
 * A regular-file `.beads/RETIRED` marker opts out of the nearest ledger. This
 * intentionally mirrors the PR-link gate: a malformed marker (or any read error)
 * keeps the ledger active rather than silently weakening closure and cleanup gates.
 *
 * The directory this walk starts from decides the answer, so no caller passes it an
 * invocation directory: {@link canonicalLedger} is the one seam that chooses it.
 */
export function ledgerActive(dir: string): boolean {
	let current = resolve(dir);
	for (;;) {
		const beads = join(current, ".beads");
		let beadsStat: Stats;
		try {
			beadsStat = lstatSync(beads);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
			const parent = dirname(current);
			if (parent === current) return false;
			current = parent;
			continue;
		}
		if (!beadsStat.isDirectory()) return true;
		try {
			return !lstatSync(join(beads, "RETIRED")).isFile();
		} catch {
			return true;
		}
	}
}

/** A repository's canonical root and the ledger verdict computed at it. */
export type CanonicalLedger = { root: string; active: boolean };

/**
 * The repository's canonical root, and its ledger verdict classified there.
 *
 * Producer and cleanup consumer both use {@link repositoryContext}; neither can
 * substitute the invocation directory or reinterpret the Git layout. Returns null
 * whenever the combined common-dir/top-level observation cannot be resolved
 * unambiguously, which keeps the destructive cleanup path closed.
 */
export function canonicalLedger(cwd: string, run: GitRunner = spawnGit): CanonicalLedger | null {
	return repositoryContext(cwd, run)?.ledger ?? null;
}

/**
 * Where receipts live: `<agentDir>/receipts[/<key>]`.
 *
 * Never inside a checkout — a receipt outlives the branch it describes, and the
 * worktree that would hold it is the one cleanup is about to remove.
 *
 * A key that is not {@link REPO_KEY} throws rather than being dropped or sanitised.
 * Returning the unscoped directory instead would quietly mix two repositories'
 * receipts, and sanitising would invent a key nothing else agrees on.
 */
export function receiptDirectory(env: NodeJS.ProcessEnv = process.env, key?: string): string {
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() ?? "";
	const home = env.HOME?.trim() ?? "";
	const base = agentDir === "" ? join(home === "" ? homedir() : home, ".omp") : agentDir;
	const receipts = join(base, "receipts");
	if (key === undefined) return receipts;
	if (!REPO_KEY.test(key)) throw new Error(`repo.key: observed ${show(key)}, expected ${REPO_KEY_TEXT}`);
	return join(receipts, key);
}

/**
 * `<epochMillis>-<first 12 of the merge oid>`, or `<epochMillis>-nomerge`.
 *
 * The timestamp leads so the epoch can be read back off the filename; the oid
 * follows so two receipts minted in the same millisecond cannot collide.
 *
 * Throws rather than returning anything {@link validateReceipt} would refuse: the
 * producer must not be able to mint an id the consumer rejects.
 *
 * Only `null` becomes `nomerge`. An empty, short or non-hex oid throws instead,
 * because `nomerge` asserts there was no merge commit, and turning a malformed value
 * into that assertion would infer absence from a value nobody filled in correctly.
 * Case is normalised, since hex is case-insensitive and git's own output is lower.
 */
export function receiptId(now: number, mergeCommitOid: string | null): string {
	if (!Number.isSafeInteger(now) || now < 0 || now > MAX_RECEIPT_EPOCH) {
		throw new Error(
			`now: observed ${show(now)}, expected an integer from 0 through ${MAX_RECEIPT_EPOCH} whose ISO timestamp has a four-digit year`,
		);
	}
	if (mergeCommitOid === null) return `${now}-nomerge`;
	const oid = mergeCommitOid.trim().toLowerCase();
	if (!MERGE_OID.test(oid)) {
		throw new Error(
			`pr.mergeCommitOid: observed ${show(mergeCommitOid)}, expected at least 12 hex characters, or null for no merge commit`,
		);
	}
	return `${now}-${oid.slice(0, 12)}`;
}

/** Top-level keys v1 defines. Everything else on an object is carried, not dropped. */
const V1_KEYS: Record<string, true> = {
	schema: true,
	version: true,
	receiptId: true,
	emittedAt: true,
	emitter: true,
	repo: true,
	pr: true,
	branch: true,
	worktree: true,
	beads: true,
	proof: true,
	outcome: true,
	supersedes: true,
	notes: true,
};

/**
 * Keys of `prior` that v1 does not define.
 *
 * Two hostile shapes are handled here, both reachable from `JSON.parse`, which
 * creates `__proto__` as an ordinary own data property:
 *
 * - The accumulator has a null prototype. `carried.__proto__ = value` on a normal
 *   object reaches `Object.prototype`'s inherited setter, which replaces the
 *   prototype and stores nothing, so the key would vanish — or worse, land.
 * - Values are read from property descriptors, and accessors are skipped. Reading
 *   `prior[key]` would run a getter a receipt has no business carrying, and no
 *   accessor survives a JSON round trip anyway.
 *
 * `Object.hasOwn`, never `V1_KEYS[key]`: a bare lookup accepts `"constructor"`
 * through the prototype chain and would drop a key named that.
 */
function carriedKeys(prior: LandingReceipt | null | undefined): Record<string, unknown> {
	const carried = Object.create(null) as Record<string, unknown>;
	if (prior === null || prior === undefined) return carried;
	for (const key of Object.getOwnPropertyNames(prior)) {
		if (Object.hasOwn(V1_KEYS, key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(prior, key);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) continue;
		carried[key] = descriptor.value;
	}
	return carried;
}

/**
 * Assemble a receipt. Pure: no clock, no filesystem, no git beyond what the caller
 * already read.
 *
 * Carried keys are spread first so a v1 field always wins over a stale key of the
 * same name in the receipt being continued. Spread is also what keeps a carried
 * `__proto__` intact: object spread defines own data properties, where
 * `Object.assign` would invoke the inherited setter and lose the key.
 *
 * Throws when the inputs cannot produce a valid id — see {@link receiptId}.
 */
export function buildReceipt(input: ReceiptInput): LandingReceipt {
	const now = input.now ?? Date.now();
	const receipt: LandingReceipt = {
		...carriedKeys(input.continues),
		schema: RECEIPT_SCHEMA,
		version: RECEIPT_VERSION,
		// Both from the one `now`, so the invariant validateReceipt enforces —
		// emittedAt is the same instant as the id's epoch — holds by construction.
		receiptId: receiptId(now, input.pr.mergeCommitOid),
		emittedAt: new Date(now).toISOString(),
		emitter: input.emitter,
		repo: input.repo,
		pr: input.pr,
		branch: input.branch,
		worktree: input.worktree,
		beads: input.beads,
		proof: input.proof,
		outcome: input.outcome,
		// `!== undefined`, never `??`: an explicit null is a caller deliberately
		// starting a new chain from a receipt it read, and must beat `continues`.
		supersedes: input.supersedes !== undefined ? input.supersedes : (input.continues?.receiptId ?? null),
	};
	if (input.notes !== undefined) receipt.notes = input.notes;
	return receipt;
}

type Expectation =
	| { kind: "text" }
	| { kind: "nullableText" }
	| { kind: "integer" }
	| { kind: "boolean" }
	| { kind: "object" }
	| { kind: "ids" }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "pattern"; pattern: RegExp; text: string; nullable: boolean };

const TEXT: Expectation = { kind: "text" };
const NULLABLE_TEXT: Expectation = { kind: "nullableText" };
const INTEGER: Expectation = { kind: "integer" };
const BOOLEAN: Expectation = { kind: "boolean" };
const OBJECT: Expectation = { kind: "object" };
const IDS: Expectation = { kind: "ids" };
const FORGE: Expectation = { kind: "enum", values: ["github", "gitlab", "unknown"] };
const AUTO_DELETE: Expectation = { kind: "enum", values: ["on", "off", "unknown"] };
const OUTCOME: Expectation = { kind: "enum", values: ["landed", "cleaned", "partial"] };
const KEY_SHAPE: Expectation = { kind: "pattern", pattern: REPO_KEY, text: REPO_KEY_TEXT, nullable: false };
const ID_SHAPE: Expectation = { kind: "pattern", pattern: RECEIPT_ID, text: RECEIPT_ID_TEXT, nullable: false };
const NULLABLE_ID_SHAPE: Expectation = { kind: "pattern", pattern: RECEIPT_ID, text: RECEIPT_ID_TEXT, nullable: true };

/**
 * Every required field, in refusal order: the container holding it (empty for the
 * top level), its key, and what it must be.
 *
 * Nullable fields take `null` and never `""`: absence is a decision someone
 * recorded, an empty string is a field nobody filled in. Neither is ever read as
 * proof, and "unknown" is never promoted to true.
 *
 * `receiptId`, `repo.key` and `supersedes` are shape-checked rather than merely
 * non-empty. The first two become path segments; the third names a receipt a
 * consumer will go looking for, which makes it one too.
 */
const REQUIRED: readonly (readonly [string, string, Expectation])[] = [
	["", "receiptId", ID_SHAPE],
	["", "emittedAt", TEXT],
	["emitter", "plugin", TEXT],
	["emitter", "version", TEXT],
	["emitter", "tool", TEXT],
	["repo", "key", KEY_SHAPE],
	["repo", "canonicalRoot", TEXT],
	["repo", "remote", TEXT],
	["repo", "forge", FORGE],
	["repo", "nameWithOwner", TEXT],
	["pr", "number", INTEGER],
	["pr", "url", TEXT],
	["pr", "state", TEXT],
	["pr", "baseRefName", TEXT],
	["pr", "headRefName", TEXT],
	["pr", "headRefOid", TEXT],
	["pr", "mergeCommitOid", NULLABLE_TEXT],
	["pr", "mergedAt", NULLABLE_TEXT],
	["branch", "name", TEXT],
	["branch", "deletedRemote", BOOLEAN],
	["branch", "remoteAbsenceVerifiedAt", NULLABLE_TEXT],
	["branch", "autoDeleteSetting", AUTO_DELETE],
	["worktree", "path", NULLABLE_TEXT],
	["worktree", "removed", BOOLEAN],
	["worktree", "localRefDeleted", BOOLEAN],
	["worktree", "absenceVerifiedAt", NULLABLE_TEXT],
	["beads", "ids", IDS],
	["beads", "ledgerActive", BOOLEAN],
	["proof", "method", TEXT],
	["proof", "observedAt", TEXT],
	["proof", "evidence", OBJECT],
	["", "outcome", OUTCOME],
	["", "supersedes", NULLABLE_ID_SHAPE],
];

/**
 * The one canonical object guard in this package.
 *
 * It proves an object and nothing about its fields, which is exactly what receipt
 * validation needs: every field is then checked by name against {@link REQUIRED}.
 * `delivery` has no shared type-guard module and this bead owns only this file, so
 * the guard lives here and is not re-created at any call site.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type OwnDataProperty = { ok: true; value: unknown } | { ok: false };

/** Read only an own, enumerable data property, without ever invoking an accessor. */
function ownDataProperty(holder: Record<string, unknown>, key: string): OwnDataProperty {
	const descriptor = Object.getOwnPropertyDescriptor(holder, key);
	if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return { ok: false };
	return { ok: true, value: descriptor.value };
}

/** The observed value, naming its type, so a refusal is actionable without the file. */
function show(value: unknown): string {
	if (value === undefined) return "absent";
	if (value === null) return "null";
	if (Array.isArray(value)) return `array of ${value.length}`;
	switch (typeof value) {
		case "string":
			return `string ${JSON.stringify(value)}`;
		case "number":
		case "boolean":
			return `${typeof value} ${String(value)}`;
		case "object":
			return "object";
		default:
			return typeof value;
	}
}

function expectationText(expectation: Expectation): string {
	switch (expectation.kind) {
		case "text":
			return "a non-empty string";
		case "nullableText":
			return "a non-empty string or null";
		case "integer":
			return "an integer";
		case "boolean":
			return "a boolean";
		case "object":
			return "an object";
		case "ids":
			return "an array of non-empty strings";
		case "enum":
			return `one of ${expectation.values.map(allowed => JSON.stringify(allowed)).join(", ")}`;
		case "pattern":
			return expectation.nullable ? `${expectation.text}, or null` : expectation.text;
	}
}

/**
 * The one refusal shape: the field, the observed value, and the expected value.
 *
 * Every refusal in this module goes through here, so no caller can invent a vaguer
 * one and no reader has to guess which field failed.
 */
function refuse(field: string, observed: unknown, expected: string): { ok: false; reason: string } {
	return { ok: false, reason: `${field}: observed ${show(observed)}, expected ${expected}` };
}

/** Check one table row against `root`; null means it holds. */
function checkField(
	root: Record<string, unknown>,
	container: string,
	key: string,
	expectation: Expectation,
): { ok: false; reason: string } | null {
	let holder = root;
	if (container !== "") {
		const property = ownDataProperty(root, container);
		const nested = property.ok ? property.value : undefined;
		if (!isRecord(nested)) return refuse(container, nested, "an object");
		holder = nested;
	}
	const field = container === "" ? key : `${container}.${key}`;
	const property = ownDataProperty(holder, key);
	const value = property.ok ? property.value : undefined;
	const nonEmptyString = typeof value === "string" && value.trim() !== "";
	switch (expectation.kind) {
		case "text":
			return nonEmptyString ? null : refuse(field, value, expectationText(expectation));
		case "nullableText":
			return value === null || nonEmptyString ? null : refuse(field, value, expectationText(expectation));
		case "integer":
			return typeof value === "number" && Number.isInteger(value)
				? null
				: refuse(field, value, expectationText(expectation));
		case "boolean":
			return typeof value === "boolean" ? null : refuse(field, value, expectationText(expectation));
		case "object":
			return isRecord(value) ? null : refuse(field, value, expectationText(expectation));
		case "ids": {
			if (!Array.isArray(value)) return refuse(field, value, expectationText(expectation));
			for (let index = 0; index < value.length; index += 1) {
				const id: unknown = value[index];
				if (typeof id !== "string" || id.trim() === "") {
					return refuse(`${field}[${index}]`, id, "a non-empty string");
				}
			}
			return null;
		}
		case "enum":
			return typeof value === "string" && expectation.values.includes(value)
				? null
				: refuse(field, value, expectationText(expectation));
		case "pattern":
			if (expectation.nullable && value === null) return null;
			return typeof value === "string" && expectation.pattern.test(value)
				? null
				: refuse(field, value, expectationText(expectation));
	}
}

/**
 * The epoch millis a receipt id or filename leads with.
 *
 * Named rather than inlined because validation and ordering must compute it
 * identically. Safe to parse unchecked: every caller has already matched the value
 * against {@link RECEIPT_ID} or {@link RECEIPT_FILE}, whose leading epoch has at
 * most 15 digits and is therefore exact as a JavaScript number.
 */
function epochOf(idOrFilename: string): number {
	return Number(idOrFilename.slice(0, idOrFilename.indexOf("-")));
}

/**
 * Do the receipt id's epoch and `emittedAt` name the same millisecond? Null means
 * they do.
 *
 * This is the invariant the whole ordering strategy rests on. `listReceipts` must
 * return newest first by `emittedAt` then `receiptId`; requiring the two to agree
 * makes the filename's cheap key provably the same key as the documented one.
 *
 * Instants are compared, not text, so an offset form is accepted: the receipt says
 * when, not how it was spelled.
 */
function sameInstant(id: string, emittedAt: unknown): { ok: false; reason: string } | null {
	if (typeof emittedAt !== "string") {
		return refuse("emittedAt", emittedAt, "an ISO-8601 instant such as 2026-09-21T12:00:00.000Z");
	}
	const match = EMITTED_AT.exec(emittedAt);
	if (match === null) {
		return refuse("emittedAt", emittedAt, "an ISO-8601 instant such as 2026-09-21T12:00:00.000Z");
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
	const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	if (
		daysInMonth === undefined ||
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59
	) {
		return refuse("emittedAt", emittedAt, "a real calendar date");
	}
	const parsed = Date.parse(emittedAt);
	if (Number.isNaN(parsed)) return refuse("emittedAt", emittedAt, "a real calendar date");
	const epoch = epochOf(id);
	if (parsed !== epoch) {
		return refuse("emittedAt", `${emittedAt} (${parsed})`, `the same instant as receiptId's epoch ${epoch}`);
	}
	return null;
}

/** Require the id suffix to identify exactly the merge commit recorded in the payload. */
function sameMergeCommit(id: string, mergeCommitOid: unknown): { ok: false; reason: string } | null {
	const suffix = id.slice(id.indexOf("-") + 1);
	if (mergeCommitOid === null) {
		return suffix === "nomerge"
			? null
			: refuse("receiptId", id, 'a "nomerge" suffix when pr.mergeCommitOid is null');
	}
	if (typeof mergeCommitOid !== "string") {
		return refuse("pr.mergeCommitOid", mergeCommitOid, "at least 12 hex characters, or null");
	}
	const normalized = mergeCommitOid.trim().toLowerCase();
	if (!MERGE_OID.test(normalized)) {
		return refuse("pr.mergeCommitOid", mergeCommitOid, "at least 12 hex characters, or null");
	}
	const expected = normalized.slice(0, 12);
	return suffix === expected
		? null
		: refuse("receiptId", id, `a suffix equal to pr.mergeCommitOid's normalized prefix ${expected}`);
}

/**
 * The `proof.method` sentinel: no provider observed this landing.
 *
 * Exported because it is half of an invariant two packages rely on — a receipt
 * carrying it never claims `landed` — and a consumer that spells the sentinel
 * itself would be free to drift from the producer.
 */
export const RECEIPT_METHOD_UNKNOWN = "unknown";

/**
 * The two cross-field claims a receipt may not make, checked after every field has
 * the right shape so each refusal names a real value.
 *
 * An active ledger with no bead id is a claim with nothing to reconcile: cleanup
 * would ask `bd` about an empty list, find nothing open, and pass a gate that never
 * ran. The producer derives the ids from the branch or takes an explicit one, so no
 * honest landing reaches the pair — and a tampered or stale file that carries it is
 * refused here, at the trust boundary, rather than acted on later.
 *
 * An unobserved proof with `outcome: "landed"` is the same bypass in the other
 * field: `proof.method` names the provider CLI and verb that saw the landing, and
 * {@link RECEIPT_METHOD_UNKNOWN} says nobody did. A receipt may not give an
 * unproven merge the authority of a proven one.
 */
function crossFieldClaims(value: Record<string, unknown>): { ok: false; reason: string } | null {
	const beads = value.beads as ReceiptBeads;
	if (beads.ledgerActive && beads.ids.length === 0) {
		return refuse("beads.ids", beads.ids, "at least one bead id when beads.ledgerActive is true");
	}
	const proof = value.proof as ReceiptProof;
	if (value.outcome === "landed" && proof.method.trim() === RECEIPT_METHOD_UNKNOWN) {
		return refuse("proof.method", proof.method, 'the provider CLI and verb that observed the landing, never "unknown", when outcome is "landed"');
	}
	return null;
}

/**
 * Accept a receipt this version can act on, or refuse it naming the exact field, the
 * observed value, and what was expected.
 *
 * Unknown keys are accepted untouched: a consumer refuses a version it cannot read,
 * but never a key it merely does not recognise.
 */
export function validateReceipt(value: unknown): ReceiptValidation {
	if (!isRecord(value)) return refuse("receipt", value, "an object");
	const schemaProperty = ownDataProperty(value, "schema");
	const schema = schemaProperty.ok ? schemaProperty.value : undefined;
	if (schema !== RECEIPT_SCHEMA) {
		return {
			ok: false,
			reason: `foreign schema: observed ${show(schema)}, expected ${JSON.stringify(RECEIPT_SCHEMA)}`,
		};
	}
	const versionProperty = ownDataProperty(value, "version");
	const version = versionProperty.ok ? versionProperty.value : undefined;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		return refuse("version", version, `an integer from 1 to ${RECEIPT_VERSION}`);
	}
	if (version > RECEIPT_VERSION) {
		return {
			ok: false,
			reason: `version: observed ${version}, expected at most ${RECEIPT_VERSION}; this consumer implements version ${RECEIPT_VERSION}`,
		};
	}
	for (const [container, key, expectation] of REQUIRED) {
		const failure = checkField(value, container, key, expectation);
		if (failure !== null) return failure;
	}
	const drift = sameInstant(value.receiptId as string, value.emittedAt);
	if (drift !== null) return drift;
	const mergeIdentity = sameMergeCommit(value.receiptId as string, (value.pr as ReceiptPr).mergeCommitOid);
	if (mergeIdentity !== null) return mergeIdentity;
	const claims = crossFieldClaims(value);
	if (claims !== null) return claims;
	const notesProperty = Object.getOwnPropertyDescriptor(value, "notes");
	if (
		notesProperty !== undefined &&
		(!notesProperty.enumerable || !("value" in notesProperty) || typeof notesProperty.value !== "string")
	) {
		const notes = "value" in notesProperty ? notesProperty.value : undefined;
		return refuse("notes", notes, "an own enumerable string data property when present");
	}
	return { ok: true, receipt: value as LandingReceipt };
}

type BoundedRead = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Read at most `MAX_RECEIPT_BYTES + 1` bytes through a single descriptor.
 *
 * One descriptor, so the file that is measured is the file that is read. Opened
 * non-blocking and with no-follow semantics, then rejected unless regular, because
 * a symlink or FIFO at a receipt path must never escape or park the caller. The
 * extra byte proves the file is oversized without reading the rest.
 */
function readBounded(path: string): BoundedRead {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch {
		return refuse("path", path, "a readable receipt file");
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return refuse("path", `${path} (not a regular file)`, "a regular file");
		const buffer = Buffer.allocUnsafe(MAX_RECEIPT_BYTES + 1);
		let filled = 0;
		while (filled < buffer.length) {
			const read = readSync(fd, buffer, filled, buffer.length - filled, null);
			if (read === 0) break;
			filled += read;
		}
		if (filled > MAX_RECEIPT_BYTES) {
			return refuse("path", `${path} (over ${MAX_RECEIPT_BYTES} bytes)`, `at most ${MAX_RECEIPT_BYTES} bytes`);
		}
		return { ok: true, text: buffer.toString("utf8", 0, filled) };
	} finally {
		try {
			closeSync(fd);
		} catch {
			// Nothing left to do about a descriptor that will not close.
		}
	}
}

/**
 * Link the finished temporary file into place, or decide what an existing receipt at
 * that id means.
 *
 * `link`, not `rename`: link fails when the target exists, so publishing can never
 * clobber a receipt another writer already published. Rename would replace it
 * silently, which for a proof artefact is the worst available behaviour.
 *
 * Byte-identical content is idempotent success — the same receipt written twice is
 * the same fact twice. Differing content refuses: two different proofs cannot share
 * one id, and picking a winner here would discard evidence.
 */
function publish(temporary: string, target: string, payload: string): void {
	try {
		linkSync(temporary, target);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	let safeMetadata = false;
	try {
		const stat = lstatSync(target);
		safeMetadata = !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o777) === 0o600;
	} catch {
		// The target changed or became unreadable after EEXIST; it is not idempotent.
	}
	const existing = safeMetadata ? readBounded(target) : null;
	if (existing?.ok && existing.text === payload) return;
	const detail =
		existing === null
			? "unsafe metadata"
			: existing.ok
				? "different content"
				: `unreadable content (${existing.reason})`;
	throw new Error(
		`${target}: observed an existing receipt with ${detail}, expected none or a non-symlink regular 0600 file with byte-identical content`,
	);
}

/**
 * Persist one receipt and return the path written.
 *
 * The receipt is validated first: this is the store, and persisting something the
 * reader would refuse only moves the failure somewhere less useful. That also covers
 * `receiptId` and `supersedes`, both of which become paths.
 *
 * Writes go to an exclusively created temporary file in the same directory, then
 * link into place. A name collision is never resolved by deleting the file we
 * collided with — that file belongs to another writer.
 *
 * The default directory is under the agent directory, so a receipt is never written
 * inside a worktree or checkout.
 */
export function writeReceipt(receipt: LandingReceipt, directory?: string, options?: WriteOptions): string {
	const validation = validateReceipt(receipt);
	if (!validation.ok) throw new Error(`refusing to persist an invalid receipt: ${validation.reason}`);
	const into = resolve(directory ?? receiptDirectory(process.env, receipt.repo.key));
	mkdirSync(into, { recursive: true, mode: 0o700 });
	let directoryFd: number;
	try {
		directoryFd = openSync(into, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch {
		throw new Error(`${into}: observed an unsafe receipt directory, expected a non-symlink directory`);
	}
	try {
		const stat = fstatSync(directoryFd);
		if (!stat.isDirectory()) {
			throw new Error(`${into}: observed a non-directory, expected a non-symlink directory`);
		}
		// Descriptor-based chmod cannot follow a replacement symlink to another target.
		fchmodSync(directoryFd, 0o700);
	} finally {
		closeSync(directoryFd);
	}
	const targetName = `${receipt.receiptId}.json`;
	const target = join(into, targetName);
	// Serialised before anything is created, so an unserialisable receipt cannot
	// leave a partial file behind.
	const payload = `${JSON.stringify(receipt, null, 2)}\n`;
	const nextName =
		options?.tempName ?? (() => `.${receipt.receiptId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

	let temporary = "";
	let fd: number | undefined;
	for (let attempt = 1; fd === undefined; attempt += 1) {
		const temporaryName: unknown = nextName();
		if (
			typeof temporaryName !== "string" ||
			temporaryName === "" ||
			temporaryName === "." ||
			temporaryName === ".." ||
			temporaryName === targetName ||
			temporaryName.includes("/") ||
			temporaryName.includes("\\") ||
			temporaryName.includes("\0")
		) {
			throw new Error(
				`temporary file: observed ${show(temporaryName)}, expected a safe basename distinct from ${JSON.stringify(targetName)}`,
			);
		}
		temporary = join(into, temporaryName);
		try {
			// "wx" is O_CREAT|O_EXCL: it refuses an existing name, so a planted file or
			// symlink cannot capture the write.
			fd = openSync(temporary, "wx", 0o600);
		} catch (error) {
			// EEXIST means the name is not ours. Never unlink it: it is very likely
			// another writer's temporary file, mid-write.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (attempt >= MAX_TEMP_ATTEMPTS) {
				throw new Error(
					`temporary file: observed ${attempt} name collisions in ${into}, expected a free name`,
				);
			}
		}
	}
	try {
		fchmodSync(fd, 0o600);
		writeFileSync(fd, payload);
		closeSync(fd);
		fd = undefined;
		publish(temporary, target, payload);
	} catch (error) {
		// One cleanup scope covers the write as well as the publish, and unlinks only
		// the name this call created.
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Already closed; the original failure is the one worth propagating.
			}
		}
		try {
			unlinkSync(temporary);
		} catch {
			// Already gone.
		}
		throw error;
	}
	// Published. The temporary name is ours and no longer needed; the content lives on
	// at `target` through the link.
	try {
		unlinkSync(temporary);
	} catch {
		// Harmless: the receipt is in place either way.
	}
	return target;
}

/** Read and validate one canonically named, non-symlink receipt file. */
export function readReceipt(path: string): ReceiptValidation {
	const name = basename(path);
	if (!RECEIPT_FILE.test(name)) {
		return refuse("path", path, "a canonical receiptId.json basename");
	}
	const read = readBounded(path);
	if (!read.ok) return read;
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text);
	} catch {
		return refuse("path", `${path} (unparseable)`, "a JSON object");
	}
	const validation = validateReceipt(parsed);
	if (!validation.ok) return validation;
	const expected = `${validation.receipt.receiptId}.json`;
	if (name !== expected) {
		return refuse("path", name, `${expected} from the payload receiptId`);
	}
	return validation;
}

/** A validated receipt and the ordering key bound to its filename. */
type Candidate = { epoch: number; name: string; receipt: LandingReceipt };

/**
 * Is `a` newer than `b`?
 *
 * Epoch numerically, then the whole filename as a deterministic tie-break for two
 * receipts minted in the same millisecond. Numeric, because the epoch is
 * variable-width: as strings, `9-…` sorts above `1700000000000-…`.
 */
function isNewer(a: Candidate, b: Candidate): boolean {
	if (a.epoch !== b.epoch) return a.epoch > b.epoch;
	return a.name > b.name;
}

/** Insert `candidate` into `kept`, held newest-first and capped, dropping the oldest. */
function keepNewest(kept: Candidate[], candidate: Candidate): void {
	const oldest = kept[kept.length - 1];
	if (kept.length >= MAX_LISTED_RECEIPTS && oldest !== undefined && !isNewer(candidate, oldest)) return;
	let low = 0;
	let high = kept.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		const at = kept[mid];
		if (at !== undefined && isNewer(at, candidate)) low = mid + 1;
		else high = mid;
	}
	kept.splice(low, 0, candidate);
	if (kept.length > MAX_LISTED_RECEIPTS) kept.pop();
}

/**
 * The newest {@link MAX_LISTED_RECEIPTS} valid, filename-bound receipts, newest
 * first.
 *
 * Streamed with `opendirSync` and held in a bounded window, so a tree holding a
 * million receipts costs 200 retained objects — not a million-entry array that is
 * then sorted and sliced. Each receipt-shaped candidate is validated before it can
 * consume a window slot, including proving that its filename stem equals its
 * payload `receiptId`.
 */
function newestReceipts(directory: string): LandingReceipt[] {
	let dir: Dir;
	try {
		dir = opendirSync(directory);
	} catch {
		return [];
	}
	const kept: Candidate[] = [];
	try {
		for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
			if (!entry.isFile() || !RECEIPT_FILE.test(entry.name)) continue;
			const result = readReceipt(join(directory, entry.name));
			if (!result.ok) continue;
			keepNewest(kept, {
				epoch: epochOf(entry.name),
				name: entry.name,
				receipt: result.receipt,
			});
		}
	} finally {
		try {
			dir.closeSync();
		} catch {
			// The scan is done; a failed close changes nothing about the result.
		}
	}
	return kept.map(candidate => candidate.receipt);
}

/**
 * Valid receipts in one directory, newest first by `emittedAt` then `receiptId`.
 *
 * Candidates are validated and bound to their filename before entering the bounded
 * window. {@link sameInstant} then proves ordering by the filename epoch and id is
 * the same ordering as by `emittedAt` and `receiptId`; a candidate that would break
 * either identity is never admitted.
 *
 * The epoch is compared numerically. Ids are variable-width, so as text `9-…` sorts
 * above `1700000000000-…`.
 *
 * Objects that fail validation are skipped rather than thrown on: one corrupt file
 * must not hide the rest.
 */
export function listReceipts(directory: string, filter?: { pr?: number; branch?: string }): LandingReceipt[] {
	const receipts: LandingReceipt[] = [];
	for (const receipt of newestReceipts(directory)) {
		if (filter?.pr !== undefined && receipt.pr.number !== filter.pr) continue;
		if (filter?.branch !== undefined && receipt.branch.name !== filter.branch) continue;
		receipts.push(receipt);
	}
	return receipts;
}
