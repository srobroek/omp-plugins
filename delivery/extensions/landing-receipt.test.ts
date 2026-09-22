import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	buildReceipt,
	canonicalLedger,
	type GitRunner,
	type LandingReceipt,
	listReceipts,
	RECEIPT_METHOD_UNKNOWN,
	RECEIPT_SCHEMA,
	RECEIPT_VERSION,
	REPOSITORY_OBSERVATION_ARGS,
	readReceipt,
	receiptDirectory,
	receiptId,
	repoKey,
	validateReceipt,
	writeReceipt,
} from "./landing-receipt.ts";

const ROOT = mkdtempSync(join(tmpdir(), "landing-receipt-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A fresh scratch directory per case, so no test observes another's files. */
function scratch(name: string): string {
	const path = join(ROOT, name);
	mkdirSync(path, { recursive: true });
	return path;
}

/** A fresh receipts directory per case. */
function receiptsIn(name: string): string {
	return join(scratch(name), "receipts", KEY);
}

const NOW = 1_700_000_000_000;
const MERGE_OID = "b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7c8c9d0";
const KEY = "0123456789abcdef";

/** The module's own caps, restated so a silent widening fails here. */
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_LISTED_RECEIPTS = 200;
const MAX_TEMP_ATTEMPTS = 5;

/**
 * A receipt carrying every required key, minted through `buildReceipt`.
 *
 * Fixed clock and oid so `receiptId`, `emittedAt` and the written filename are all
 * assertable literals rather than whatever the machine's clock said.
 */
function landed(
	over: {
		now?: number;
		pr?: number;
		branch?: string;
		mergeCommitOid?: string | null;
		notes?: string;
	} = {},
): LandingReceipt {
	const now = over.now ?? NOW;
	const mergeCommitOid = over.mergeCommitOid === undefined ? MERGE_OID : over.mergeCommitOid;
	return buildReceipt({
		now,
		notes: over.notes,
		emitter: { plugin: "@srobroek/delivery", version: "0.12.0", tool: "delivery_land" },
		repo: {
			key: KEY,
			canonicalRoot: "/Users/sjors/personal/dev/omp-plugins",
			remote: "git@github.com:srobroek/omp-plugins.git",
			forge: "github",
			nameWithOwner: "srobroek/omp-plugins",
		},
		pr: {
			number: over.pr ?? 7,
			url: "https://github.com/srobroek/omp-plugins/pull/7",
			state: "MERGED",
			baseRefName: "omp/integration/omp-plugins-9ej3",
			headRefName: over.branch ?? "omp/agent/omp-plugins-9ej3.3",
			headRefOid: "a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6b7b8b9c0",
			mergeCommitOid,
			mergedAt: "2026-09-21T12:00:00.000Z",
		},
		branch: {
			name: over.branch ?? "omp/agent/omp-plugins-9ej3.3",
			deletedRemote: true,
			remoteAbsenceVerifiedAt: "2026-09-21T12:00:01.000Z",
			autoDeleteSetting: "on",
		},
		worktree: {
			path: "/Users/sjors/tmp/worktrees/omp-plugins/omp-agent-omp-plugins-9ej3.3",
			removed: true,
			localRefDeleted: true,
			absenceVerifiedAt: "2026-09-21T12:00:02.000Z",
		},
		beads: { ids: ["omp-plugins-9ej3.3"], ledgerActive: true },
		proof: {
			method: "gh pr view --json state,mergeCommit",
			observedAt: "2026-09-21T12:00:00.000Z",
			evidence: { state: "MERGED", checks: "passing" },
		},
		outcome: "landed",
	});
}

/** The refusal reason, or a failure if the value was accepted. */
function refusalFor(value: unknown): string {
	const result = validateReceipt(value);
	if (result.ok) throw new Error(`expected a refusal, got an accepted receipt: ${JSON.stringify(value)}`);
	return result.reason;
}

/** The accepted receipt, or a failure carrying the reason it was refused. */
function acceptedFrom(value: unknown): LandingReceipt {
	const result = validateReceipt(value);
	if (!result.ok) throw new Error(`expected acceptance, refused with: ${result.reason}`);
	return result.receipt;
}

/** The reason a read or validation refused, or a failure if it accepted. */
function refusalOf(result: { ok: true } | { ok: false; reason: string }): string {
	if (result.ok) throw new Error("expected a refusal, got acceptance");
	return result.reason;
}

/** The error a thunk threw, or a failure if it returned. */
function threwFrom(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`expected an Error, got ${String(error)}`);
	}
	throw new Error("expected a throw, got a return");
}

type Mutable = Record<string, unknown>;

/** A clone of `landed()` with `field` (`a` or `a.b`) set to `value`. */
function withField(field: string, value: unknown): Mutable {
	const clone = structuredClone(landed()) as Mutable;
	const dot = field.indexOf(".");
	if (dot < 0) {
		clone[field] = value;
		return clone;
	}
	const container = clone[field.slice(0, dot)] as Mutable;
	container[field.slice(dot + 1)] = value;
	return clone;
}

/** A clone of `landed()` with `field` deleted. */
function withoutField(field: string): Mutable {
	const clone = structuredClone(landed()) as Mutable;
	const dot = field.indexOf(".");
	if (dot < 0) {
		delete clone[field];
		return clone;
	}
	const container = clone[field.slice(0, dot)] as Mutable;
	delete container[field.slice(dot + 1)];
	return clone;
}

type PropertyShape = "accessor" | "inherited";

/** A valid receipt whose named property is not an own, enumerable data property. */
function withPropertyShape(field: string, shape: PropertyShape): { receipt: Mutable; reads: () => number } {
	const receipt = structuredClone(landed()) as Mutable;
	const dot = field.indexOf(".");
	const holder = dot < 0 ? receipt : (receipt[field.slice(0, dot)] as Mutable);
	const key = dot < 0 ? field : field.slice(dot + 1);
	const value = holder[key];
	let readCount = 0;
	if (shape === "accessor") {
		Object.defineProperty(holder, key, {
			configurable: true,
			enumerable: true,
			get: () => {
				readCount += 1;
				return value;
			},
		});
	} else {
		delete holder[key];
		Object.setPrototypeOf(holder, { [key]: value });
	}
	return { receipt, reads: () => readCount };
}

/**
 * The v1 key list, restated here rather than imported.
 *
 * The module must not be able to shrink its own contract: this list is the decision
 * bead, and a field dropped from the implementation fails here.
 */
const TEXT_FIELDS = [
	"receiptId",
	"emittedAt",
	"emitter.plugin",
	"emitter.version",
	"emitter.tool",
	"repo.key",
	"repo.canonicalRoot",
	"repo.remote",
	"repo.nameWithOwner",
	"pr.url",
	"pr.state",
	"pr.baseRefName",
	"pr.headRefName",
	"pr.headRefOid",
	"branch.name",
	"proof.method",
	"proof.observedAt",
];

const NULLABLE_TEXT_FIELDS = [
	"pr.mergeCommitOid",
	"pr.mergedAt",
	"branch.remoteAbsenceVerifiedAt",
	"worktree.path",
	"worktree.absenceVerifiedAt",
	"supersedes",
];

const OTHER_FIELDS = [
	"repo.forge",
	"pr.number",
	"branch.deletedRemote",
	"branch.autoDeleteSetting",
	"worktree.removed",
	"worktree.localRefDeleted",
	"beads.ids",
	"beads.ledgerActive",
	"proof.evidence",
	"outcome",
];

const REQUIRED_FIELDS = [...TEXT_FIELDS, ...NULLABLE_TEXT_FIELDS, ...OTHER_FIELDS];

const REQUIRED_CONTAINERS = ["emitter", "repo", "pr", "branch", "worktree", "beads", "proof"];
const REQUIRED_DATA_PROPERTIES = ["schema", "version", ...REQUIRED_CONTAINERS, ...REQUIRED_FIELDS];

/**
 * The producer must not be able to mint an id the validator would refuse, so every
 * `receiptId` result is either schema-valid or a throw.
 */
describe("receiptId", () => {
	test("epoch millis and the first 12 characters of the merge oid", () => {
		expect(receiptId(NOW, MERGE_OID)).toBe("1700000000000-b1b2b3b4b5b6");
	});

	test("nomerge only for an explicit null", () => {
		expect(receiptId(NOW, null)).toBe("1700000000000-nomerge");
	});

	test("normalises oid case, because hex is case-insensitive and git prints lower", () => {
		expect(receiptId(NOW, MERGE_OID.toUpperCase())).toBe("1700000000000-b1b2b3b4b5b6");
		expect(receiptId(NOW, `  ${MERGE_OID}  `)).toBe("1700000000000-b1b2b3b4b5b6");
	});

	/**
	 * An unusable oid is not absence. Returning `nomerge` would assert there was no
	 * merge commit, which is inferring absence from a value nobody filled in.
	 */
	test.each(["", "   ", "abc123", "b1b2b3b4b5b", "../../../etc", "zzzzzzzzzzzz", "b1b2 b3b4b5b6"])(
		"refuses the unusable merge oid %p rather than calling it nomerge",
		bad => {
			const error = threwFrom(() => receiptId(NOW, bad));
			expect(error.message).toContain("pr.mergeCommitOid");
			expect(error.message).toContain("at least 12 hex characters");
		},
	);

	test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e16])("refuses the unusable clock %p", bad => {
		const error = threwFrom(() => receiptId(bad, null));
		expect(error.message).toContain("now");
	});

	/**
	 * Built through `buildReceipt` rather than by swapping the id into a fixture,
	 * because the id and `emittedAt` have to move together: a receipt with one clock in
	 * its id and another in its timestamp is invalid by design.
	 */
	test("whatever the producer mints, the validator accepts", () => {
		for (const [now, oid] of [
			[NOW, MERGE_OID],
			[1, MERGE_OID],
			[9, "abcdef012345"],
			[NOW, null],
		] as const) {
			const receipt = landed({ now, mergeCommitOid: oid });
			expect(receipt.receiptId).toBe(receiptId(now, oid));
			expect(acceptedFrom(receipt).receiptId).toBe(receiptId(now, oid));
		}
	});
});

describe("buildReceipt", () => {
	test("stamps the schema, the version, the id and the emission time", () => {
		const receipt = landed();
		expect(receipt.schema).toBe(RECEIPT_SCHEMA);
		expect(RECEIPT_SCHEMA).toBe("omp.receipt.landing");
		expect(receipt.version).toBe(RECEIPT_VERSION);
		expect(RECEIPT_VERSION).toBe(1);
		expect(receipt.receiptId).toBe("1700000000000-b1b2b3b4b5b6");
		expect(receipt.emittedAt).toBe(new Date(NOW).toISOString());
		expect(receipt.supersedes).toBeNull();
		expect(receipt.notes).toBeUndefined();
	});

	test("a receipt with no merge commit is still named and still valid", () => {
		const receipt = landed({ mergeCommitOid: null });
		expect(receipt.receiptId).toBe("1700000000000-nomerge");
		expect(acceptedFrom(receipt).pr.mergeCommitOid).toBeNull();
	});

	test("refuses to build at all when the merge oid cannot make a valid id", () => {
		expect(() => landed({ mergeCommitOid: "nope" })).toThrow(/pr\.mergeCommitOid/);
	});

	test("refuses a clock whose ISO spelling needs an extended year", () => {
		const firstExtendedYear = 253_402_300_800_000;
		expect(new Date(firstExtendedYear).toISOString()).toStartWith("+010000");
		expect(() => landed({ now: firstExtendedYear })).toThrow(/now/);
	});
});

describe("validateReceipt", () => {
	test("accepts a receipt carrying every required key", () => {
		expect(acceptedFrom(landed()).receiptId).toBe("1700000000000-b1b2b3b4b5b6");
	});

	test.each(REQUIRED_FIELDS)("refuses %s when absent, naming it", field => {
		expect(refusalFor(withoutField(field))).toContain(field);
	});

	test.each([...TEXT_FIELDS, ...NULLABLE_TEXT_FIELDS])("refuses %s when empty, naming it", field => {
		expect(refusalFor(withField(field, ""))).toContain(field);
		expect(refusalFor(withField(field, "   "))).toContain(field);
	});

	test("a nullable field accepts null but never an empty string", () => {
		expect(acceptedFrom(withField("worktree.path", null)).worktree.path).toBeNull();
		expect(refusalFor(withField("worktree.path", ""))).toBe(
			'worktree.path: observed string "", expected a non-empty string or null',
		);
	});

	test.each([
		["pr.number", "7", "string"],
		["pr.number", 7.5, "number"],
		["branch.deletedRemote", "yes", "string"],
		["beads.ids", "omp-plugins-1", "string"],
		["proof.evidence", [1, 2], "array"],
		["repo.key", 16, "number"],
		["worktree.removed", null, "null"],
	] as const)("refuses a wrong-typed %s, naming the key and the observed type", (field, value, observed) => {
		const reason = refusalFor(withField(field, value));
		expect(reason).toContain(field);
		expect(reason).toContain(observed);
	});

	test("refuses a non-string bead id, naming its index", () => {
		expect(refusalFor(withField("beads.ids", ["ok", 2]))).toContain("beads.ids[1]");
	});

	test("refuses a missing container, naming the container and the expected shape", () => {
		const clone = structuredClone(landed()) as Mutable;
		delete clone.pr;
		expect(refusalFor(clone)).toBe("pr: observed absent, expected an object");
	});

	test.each(REQUIRED_DATA_PROPERTIES)("refuses inherited required data property %s", field => {
		const hostile = withPropertyShape(field, "inherited");
		expect(refusalFor(hostile.receipt)).toContain(field.split(".")[0] ?? field);
		expect(hostile.reads()).toBe(0);
	});

	test.each(REQUIRED_DATA_PROPERTIES)("refuses accessor-backed required data property %s without invoking it", field => {
		const hostile = withPropertyShape(field, "accessor");
		expect(refusalFor(hostile.receipt)).toContain(field.split(".")[0] ?? field);
		expect(hostile.reads()).toBe(0);
	});

	test("binds the receiptId suffix to the normalized merge commit OID, with nomerge iff the OID is null", () => {
		expect(refusalFor(withField("pr.mergeCommitOid", null))).toContain("receiptId");
		expect(refusalFor(withField("pr.mergeCommitOid", "cccccccccccccccccccccccccccccccccccccccc"))).toContain(
			"receiptId",
		);
		expect(refusalFor(withField("pr.mergeCommitOid", "not-an-oid"))).toContain("pr.mergeCommitOid");

		const noMerge = landed({ mergeCommitOid: null });
		const falseNoMerge = structuredClone(noMerge) as Mutable;
		(falseNoMerge.pr as Mutable).mergeCommitOid = MERGE_OID;
		expect(refusalFor(falseNoMerge)).toContain("receiptId");

		const normalized = withField("pr.mergeCommitOid", `  ${MERGE_OID.toUpperCase()}  `);
		expect(acceptedFrom(normalized).receiptId).toBe("1700000000000-b1b2b3b4b5b6");
	});

	test.each([
		["repo.forge", "bitbucket"],
		["branch.autoDeleteSetting", "maybe"],
		["outcome", "merged"],
	] as const)("refuses an out-of-vocabulary %s, listing what is allowed", (field, value) => {
		const reason = refusalFor(withField(field, value));
		expect(reason).toContain(field);
		expect(reason).toContain(JSON.stringify(value));
		expect(reason).toContain("one of");
	});

	test("refuses a foreign schema", () => {
		const reason = refusalFor(withField("schema", "omp.receipt.something-else"));
		expect(reason).toContain("foreign schema");
		expect(reason).toContain("omp.receipt.something-else");
		expect(reason).toContain(RECEIPT_SCHEMA);
	});

	test("refuses a forward version, stating the observed version and its own", () => {
		const reason = refusalFor(withField("version", 2));
		expect(reason).toContain("2");
		expect(reason).toContain("1");
		expect(reason).toContain("version");
	});

	test("refuses a version that is not a whole number at or above 1", () => {
		expect(refusalFor(withField("version", 0))).toContain("version");
		expect(refusalFor(withField("version", "1"))).toContain("version");
	});

	test("refuses a value that is not an object at all", () => {
		expect(refusalFor("omp.receipt.landing")).toBe(
			'receipt: observed string "omp.receipt.landing", expected an object',
		);
		expect(refusalFor([landed()])).toContain("expected an object");
		expect(refusalFor(null)).toBe("receipt: observed null, expected an object");
	});

	test("accepts an unknown key and leaves it in place", () => {
		const forward = withField("mergeQueueEntry", { id: "q-1" });
		expect(acceptedFrom(forward).mergeQueueEntry).toEqual({ id: "q-1" });
	});

	test("notes are optional, and refused when not a string", () => {
		expect(acceptedFrom(withField("notes", "cleaned by hand")).notes).toBe("cleaned by hand");
		expect(refusalFor(withField("notes", 5))).toContain("notes");
	});
});

/**
 * `repo.key` and `receiptId` become path segments, so a receipt that merely carries
 * a non-empty string in them is not safe to act on.
 */
describe("path-bearing fields are shape-checked, not merely non-empty", () => {
	test.each([
		"../../../etc",
		"0123456789ABCDEF",
		"0123456789abcde",
		"0123456789abcdef0",
		"0123456789abcde/",
		"0123456789abcde.",
		"..",
		"0123456789abcdeg",
	])("refuses repo.key %p", bad => {
		const reason = refusalFor(withField("repo.key", bad));
		expect(reason).toContain("repo.key");
		expect(reason).toContain("16 lowercase hex characters");
	});

	test.each([
		"../../../escape",
		"1700000000000-../../x",
		"1700000000000-B1B2B3B4B5B6",
		"1700000000000-b1b2b3b4b5b",
		"1700000000000-b1b2b3b4b5b6b",
		"nomerge",
		"1700000000000-NOMERGE",
		"-nomerge",
		"1700000000000-b1b2b3b4b5b6.json",
		"1700000000000000-nomerge",
	])("refuses receiptId %p", bad => {
		const reason = refusalFor(withField("receiptId", bad));
		expect(reason).toContain("receiptId");
		expect(reason).toContain("nomerge");
	});

	test("accepts the two legitimate receiptId shapes", () => {
		expect(acceptedFrom(landed({ mergeCommitOid: null })).receiptId).toBe("1700000000000-nomerge");
		expect(acceptedFrom(landed({ now: 1, mergeCommitOid: "abcdef012345" })).receiptId).toBe("1-abcdef012345");
	});

	test("supersedes is shape-checked too, because a consumer will go looking for it", () => {
		expect(acceptedFrom(withField("supersedes", "1699999999999-nomerge")).supersedes).toBe("1699999999999-nomerge");
		expect(acceptedFrom(withField("supersedes", null)).supersedes).toBeNull();
		expect(refusalFor(withField("supersedes", "../../other"))).toContain("supersedes");
	});

	test("receiptDirectory refuses a key that would leave the receipts tree", () => {
		const env = { PI_CODING_AGENT_DIR: "/var/agent" };
		for (const bad of ["../../../etc", "0123456789ABCDEF", "..", "", "   ", "0123456789abcde/x"]) {
			const error = threwFrom(() => receiptDirectory(env, bad));
			expect(error.message).toContain("repo.key");
			expect(error.message).toContain("16 lowercase hex characters");
		}
	});

	test("writeReceipt refuses a traversing receiptId and creates nothing", () => {
		const directory = receiptsIn("write-traversal");
		const hostile = { ...landed(), receiptId: "../../../escaped" } as LandingReceipt;

		const error = threwFrom(() => writeReceipt(hostile, directory));

		expect(error.message).toContain("receiptId");
		expect(error.message).toContain("../../../escaped");
		expect(() => readdirSync(directory)).toThrow();
		expect(readdirSync(join(ROOT, "write-traversal"))).toEqual([]);
	});

	/** Validated before persistence, not only on the way back in. */
	test("writeReceipt refuses a traversing supersedes before persisting anything", () => {
		const directory = receiptsIn("write-supersedes");
		const hostile = { ...landed(), supersedes: "../../../other" } as LandingReceipt;

		const error = threwFrom(() => writeReceipt(hostile, directory));

		expect(error.message).toContain("supersedes");
		expect(() => readdirSync(directory)).toThrow();
	});

	test("writeReceipt refuses any receipt the reader would refuse", () => {
		const directory = receiptsIn("write-invalid");
		const missing = withoutField("proof.method") as unknown as LandingReceipt;

		const error = threwFrom(() => writeReceipt(missing, directory));

		expect(error.message).toContain("refusing to persist an invalid receipt");
		expect(error.message).toContain("proof.method");
	});
});

/**
 * `emittedAt` must name the same millisecond as the epoch in `receiptId`.
 *
 * That equivalence is what lets `listReceipts` honour its documented
 * "newest first by emittedAt then receiptId" order while choosing its bounded window
 * from filenames alone. Without it the cheap key and the promised key are two
 * different keys, and a receipt carrying any `emittedAt` it likes would reorder the
 * result against the window it came from.
 */
describe("emittedAt is provably the epoch in receiptId", () => {
	test("buildReceipt derives both from one clock", () => {
		for (const now of [NOW, 1, 9, 100, NOW + 5_000]) {
			const receipt = landed({ now });
			expect(Date.parse(receipt.emittedAt)).toBe(now);
			expect(receipt.receiptId.slice(0, receipt.receiptId.indexOf("-"))).toBe(String(now));
		}
	});

	test.each([
		"yesterday",
		"2026-09-21",
		"2026-09-21 12:00:00Z",
		"Mon, 21 Sep 2026 12:00:00 GMT",
		"2026-09-21T12:00:00",
		"1700000000000",
	])("refuses the non-ISO emittedAt %p", bad => {
		const reason = refusalFor(withField("emittedAt", bad));
		expect(reason).toContain("emittedAt");
		expect(reason).toContain("ISO-8601");
	});

	test("refuses a shape-valid string that is not a date at all", () => {
		const reason = refusalFor(withField("emittedAt", "2026-13-45T99:99:99.000Z"));
		expect(reason).toContain("emittedAt");
		expect(reason).toContain("real calendar date");
	});

	/** `Date.parse` normalises some impossible dates instead of rejecting them. */
	test("refuses an impossible calendar date even when its id names the normalised instant", () => {
		const impossible = "2026-02-31T04:00:00.000Z";
		const normalised = Date.parse(impossible);
		expect(normalised).toBe(Date.parse("2026-03-03T04:00:00.000Z"));
		const hostile = {
			...landed({ now: normalised }),
			emittedAt: impossible,
		} as LandingReceipt;
		expect(refusalFor(hostile)).toContain("real calendar date");
	});

	test("refuses drift between the two, naming the observed instant and the id's epoch", () => {
		const reason = refusalFor(withField("emittedAt", new Date(NOW + 1).toISOString()));
		expect(reason).toContain("emittedAt");
		expect(reason).toContain(String(NOW + 1));
		expect(reason).toContain(String(NOW));
	});

	/** The receipt records an instant, not a spelling, so an offset form is fine. */
	test("accepts another spelling of the same instant", () => {
		const offset = "2023-11-15T02:13:20.000+04:00";
		expect(Date.parse(offset)).toBe(NOW);
		expect(acceptedFrom(withField("emittedAt", offset)).emittedAt).toBe(offset);
	});

	test("writeReceipt refuses a drifted receipt before persisting anything", () => {
		const directory = receiptsIn("write-drift");
		const drifted = { ...landed(), emittedAt: new Date(NOW + 1).toISOString() } as LandingReceipt;

		const error = threwFrom(() => writeReceipt(drifted, directory));

		expect(error.message).toContain("emittedAt");
		expect(() => readdirSync(directory)).toThrow();
	});
});

describe("continuation", () => {
	test("unknown keys survive a continuation, and v1 fields are re-stamped", () => {
		const first = acceptedFrom(withField("mergeQueueEntry", { id: "q-1", attempts: 2 }));
		const second = buildReceipt({
			now: NOW + 5_000,
			continues: first,
			emitter: first.emitter,
			repo: first.repo,
			pr: first.pr,
			branch: first.branch,
			worktree: { ...first.worktree, removed: true, absenceVerifiedAt: "2026-09-21T12:05:00.000Z" },
			beads: first.beads,
			proof: first.proof,
			outcome: "cleaned",
		});

		expect(second.mergeQueueEntry).toEqual({ id: "q-1", attempts: 2 });
		expect(second.supersedes).toBe(first.receiptId);
		expect(second.outcome).toBe("cleaned");
		expect(second.emittedAt).toBe(new Date(NOW + 5_000).toISOString());
		expect(second.receiptId).toBe("1700000005000-b1b2b3b4b5b6");
		expect(acceptedFrom(second).worktree.absenceVerifiedAt).toBe("2026-09-21T12:05:00.000Z");
	});

	test("a v1 field is never taken from the receipt being continued", () => {
		const first = landed();
		const second = buildReceipt({
			now: NOW + 1,
			continues: first,
			emitter: first.emitter,
			repo: first.repo,
			pr: first.pr,
			branch: first.branch,
			worktree: first.worktree,
			beads: first.beads,
			proof: first.proof,
			outcome: "partial",
			supersedes: null,
		});
		expect(second.outcome).toBe("partial");
		expect(second.supersedes).toBeNull();
	});

	/**
	 * A receipt carrying own `__proto__` and `constructor` data properties.
	 *
	 * Spliced from JSON text, not written as an object literal: `{__proto__: value}`
	 * is the one property syntax that sets the prototype instead of defining a key, so
	 * a literal fixture is not hostile at all and the test would pass while proving
	 * nothing. `JSON.parse` produces an ordinary own data property, which is exactly
	 * the shape a receipt read off disk has.
	 */
	function hostileReceipt(): LandingReceipt {
		const body = JSON.stringify(landed()).slice(1);
		return JSON.parse(`{"__proto__":{"polluted":"yes"},"constructor":{"also":"carried"},${body}`) as LandingReceipt;
	}

	test("a hostile __proto__ key survives continuation without polluting anything", () => {
		const hostile = hostileReceipt();
		expect(Object.hasOwn(hostile, "__proto__")).toBe(true);
		expect(Object.hasOwn(hostile, "constructor")).toBe(true);

		const second = buildReceipt({
			now: NOW + 9,
			continues: hostile,
			emitter: hostile.emitter,
			repo: hostile.repo,
			pr: hostile.pr,
			branch: hostile.branch,
			worktree: hostile.worktree,
			beads: hostile.beads,
			proof: hostile.proof,
			outcome: "cleaned",
		});

		expect(Object.hasOwn(second, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(second, "__proto__")?.value).toEqual({ polluted: "yes" });
		// Widened to unknown: `constructor` is typed `Function` on any object type, so
		// the descriptor's value needs to escape that before it can be compared.
		const carriedConstructor: unknown = Object.getOwnPropertyDescriptor(second, "constructor")?.value;
		expect(carriedConstructor).toEqual({ also: "carried" });
		expect(Object.getPrototypeOf(second)).toBe(Object.prototype);
		expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
		expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("a hostile __proto__ key round-trips through the filesystem", () => {
		const directory = receiptsIn("proto-roundtrip");
		const hostile = hostileReceipt();

		const read = readReceipt(writeReceipt(hostile, directory));

		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(Object.getOwnPropertyDescriptor(read.receipt, "__proto__")?.value).toEqual({ polluted: "yes" });
		expect(Object.getPrototypeOf(read.receipt)).toBe(Object.prototype);
		expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("an accessor is not carried, because reading it would run foreign code", () => {
		let reads = 0;
		const prior = landed();
		Object.defineProperty(prior, "trap", {
			enumerable: true,
			get() {
				reads += 1;
				return "ran";
			},
		});

		const second = buildReceipt({
			now: NOW + 3,
			continues: prior,
			emitter: prior.emitter,
			repo: prior.repo,
			pr: prior.pr,
			branch: prior.branch,
			worktree: prior.worktree,
			beads: prior.beads,
			proof: prior.proof,
			outcome: "cleaned",
		});

		expect(reads).toBe(0);
		expect(Object.hasOwn(second, "trap")).toBe(false);
	});
});

describe("receiptDirectory", () => {
	test("honours PI_CODING_AGENT_DIR and scopes by repo key", () => {
		const env = { PI_CODING_AGENT_DIR: "/var/agent", HOME: "/Users/nobody" };
		expect(receiptDirectory(env, KEY)).toBe(`/var/agent/receipts/${KEY}`);
		expect(receiptDirectory(env)).toBe("/var/agent/receipts");
	});

	test("falls back to $HOME/.omp when the agent directory is unset or blank", () => {
		expect(receiptDirectory({ HOME: "/Users/nobody" }, KEY)).toBe(`/Users/nobody/.omp/receipts/${KEY}`);
		expect(receiptDirectory({ HOME: "/Users/nobody", PI_CODING_AGENT_DIR: "  " }, KEY)).toBe(
			`/Users/nobody/.omp/receipts/${KEY}`,
		);
	});

	test("never lands inside the repository", () => {
		const repository = scratch("dir-repository");
		const agent = scratch("dir-agent");
		mkdirSync(join(repository, ".git"), { recursive: true });

		const fromAgentDir = receiptDirectory({ PI_CODING_AGENT_DIR: agent, HOME: repository }, KEY);
		const fromHome = receiptDirectory({ HOME: agent }, KEY);

		expect(fromAgentDir.startsWith(repository)).toBe(false);
		expect(fromHome.startsWith(repository)).toBe(false);
		expect(fromAgentDir).toBe(join(agent, "receipts", KEY));
	});
});

describe("repoKey", () => {
	test("16 lowercase hex characters from the realpath of the common git directory", () => {
		const common = scratch("key-common");
		const seen: { argv: readonly string[]; cwd: string; timeoutMs: number }[] = [];
		const run: GitRunner = (argv, cwd, timeoutMs) => {
			seen.push({ argv, cwd, timeoutMs });
			return `${common}\n`;
		};

		const key = repoKey("/anywhere", run);
		expect(key).toMatch(/^[0-9a-f]{16}$/);
		expect(seen).toEqual([{ argv: ["rev-parse", "--git-common-dir"], cwd: "/anywhere", timeoutMs: 2000 }]);
		expect(repoKey("/elsewhere", () => common)).toBe(key);
	});

	test("what repoKey mints is always accepted as a directory name", () => {
		const key = repoKey("/anywhere", () => scratch("key-accepted"));
		expect(key).not.toBeNull();
		expect(receiptDirectory({ PI_CODING_AGENT_DIR: "/var/agent" }, key ?? "")).toBe(`/var/agent/receipts/${key}`);
	});

	test("null when git reports no repository", () => {
		expect(repoKey("/anywhere", () => null)).toBeNull();
		expect(repoKey("/anywhere", () => "")).toBeNull();
		expect(repoKey("/anywhere", () => join(ROOT, "key-absent", ".git"))).toBeNull();
		expect(repoKey(scratch("key-not-a-repo"))).toBeNull();
	});

	test("a canonical checkout and a linked worktree share one key", () => {
		const repository = scratch("key-repo");
		const linked = join(ROOT, "key-linked");
		git(repository, "init", "-b", "main");
		writeFileSync(join(repository, "file.txt"), "one\n");
		git(repository, "add", "file.txt");
		git(repository, "commit", "-m", "one");
		git(repository, "worktree", "add", linked, "-b", "side");

		const canonicalKey = repoKey(repository);
		expect(canonicalKey).toMatch(/^[0-9a-f]{16}$/);
		expect(repoKey(linked)).toBe(canonicalKey);
		expect(repoKey(join(repository, ".git"))).toBe(canonicalKey);
	});
});

/**
 * The ledger classification is a security boundary, not a convenience: a wrong
 * verdict here is a worktree deleted and a branch removed with no reconciliation.
 */
describe("canonicalLedger", () => {
	test("uses one combined absolute common-dir and top-level Git observation", () => {
		const repository = scratch("ledger-combined-observation");
		const common = join(repository, ".git");
		mkdirSync(common);
		mkdirSync(join(repository, ".beads"));
		const seen: { argv: readonly string[]; cwd: string; timeoutMs: number }[] = [];
		const run: GitRunner = (argv, cwd, timeoutMs) => {
			seen.push({ argv, cwd, timeoutMs });
			return `${common}\n${repository}\n`;
		};

		expect(canonicalLedger("/anywhere", run)).toEqual({ root: realpathSync(repository), active: true });
		expect(seen).toEqual([{ argv: REPOSITORY_OBSERVATION_ARGS, cwd: "/anywhere", timeoutMs: 2000 }]);
	});
	test("classifies at the canonical root, so a nested marker below the cwd does not vote", () => {
		const repository = scratch("ledger-canonical");
		const nested = join(repository, "deep", "deeper");
		mkdirSync(join(repository, ".beads"), { recursive: true });
		mkdirSync(join(nested, ".beads"), { recursive: true });
		writeFileSync(join(nested, ".beads", "RETIRED"), "retired\n");
		git(repository, "init", "-b", "main");

		expect(canonicalLedger(repository)).toEqual({ root: realpathSync(repository), active: true });
		expect(canonicalLedger(nested)).toEqual({ root: realpathSync(repository), active: true });
	});

	test("a retired canonical root stays retired however active a nested ledger is", () => {
		const repository = scratch("ledger-canonical-retired");
		const nested = join(repository, "nested");
		mkdirSync(join(repository, ".beads"), { recursive: true });
		writeFileSync(join(repository, ".beads", "RETIRED"), "retired\n");
		mkdirSync(join(nested, ".beads"), { recursive: true });
		git(repository, "init", "-b", "main");

		expect(canonicalLedger(nested)).toEqual({ root: realpathSync(repository), active: false });
	});

	test("a linked worktree classifies from the same root as its canonical checkout", () => {
		const repository = scratch("ledger-linked");
		const linked = join(ROOT, "ledger-linked-worktree");
		mkdirSync(join(repository, ".beads"), { recursive: true });
		git(repository, "init", "-b", "main");
		writeFileSync(join(repository, "file.txt"), "one\n");
		git(repository, "add", "file.txt");
		git(repository, "commit", "-m", "one");
		git(repository, "worktree", "add", linked, "-b", "side");

		expect(canonicalLedger(linked)).toEqual({ root: realpathSync(repository), active: true });
	});

	test("a linked worktree of a separate-git-dir repository fails closed", () => {
		const parent = scratch("ledger-linked-separate-git-dir");
		const checkout = join(parent, "checkout");
		const common = join(parent, "store.git");
		const linked = join(parent, "linked");
		mkdirSync(checkout);
		git(checkout, "init", "-b", "main", `--separate-git-dir=${common}`);
		writeFileSync(join(checkout, "file.txt"), "one\n");
		git(checkout, "add", "file.txt");
		git(checkout, "commit", "-m", "one");
		git(checkout, "worktree", "add", linked, "-b", "side");

		expect(canonicalLedger(linked)).toBeNull();
	});

	test("a linked worktree of a bare repository fails closed", () => {
		const parent = scratch("ledger-linked-bare");
		const source = join(parent, "source");
		const bare = join(parent, "bare.git");
		const linked = join(parent, "linked");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		writeFileSync(join(source, "file.txt"), "one\n");
		git(source, "add", "file.txt");
		git(source, "commit", "-m", "one");
		git(parent, "clone", "--bare", source, bare);
		git(bare, "worktree", "add", linked, "-b", "side");

		expect(canonicalLedger(linked)).toBeNull();
	});

	test("a separate git directory still classifies from its checkout root", () => {
		const parent = scratch("ledger-separate-git-dir");
		const checkout = join(parent, "checkout");
		const common = join(parent, "store.git");
		mkdirSync(checkout);
		git(checkout, "init", "-b", "main", `--separate-git-dir=${common}`);
		mkdirSync(join(checkout, ".beads"));
		mkdirSync(join(parent, ".beads"));
		writeFileSync(join(parent, ".beads", "RETIRED"), "retired\n");

		expect(canonicalLedger(checkout)).toEqual({ root: realpathSync(checkout), active: true });
	});

	test("a separate git directory ending in .git still classifies from its checkout root", () => {
		const parent = scratch("ledger-separate-dot-git-dir");
		const checkout = join(parent, "checkout");
		const common = join(parent, "store", ".git");
		mkdirSync(checkout);
		mkdirSync(dirname(common), { recursive: true });
		git(checkout, "init", "-b", "main", `--separate-git-dir=${common}`);
		mkdirSync(join(checkout, ".beads"));
		mkdirSync(join(dirname(common), ".beads"));
		writeFileSync(join(dirname(common), ".beads", "RETIRED"), "retired\n");

		expect(canonicalLedger(checkout)).toEqual({ root: realpathSync(checkout), active: true });
	});

	test("a submodule classifies from the submodule checkout, not its common-dir metadata", () => {
		const parent = scratch("ledger-submodule");
		const source = join(parent, "source");
		const superproject = join(parent, "superproject");
		const submodule = join(superproject, "sub");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		writeFileSync(join(source, "file.txt"), "one\n");
		git(source, "add", "file.txt");
		git(source, "commit", "-m", "one");
		mkdirSync(superproject);
		git(superproject, "init", "-b", "main");
		git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", source, "sub");
		mkdirSync(join(submodule, ".beads"));
		mkdirSync(join(superproject, ".beads"));
		writeFileSync(join(superproject, ".beads", "RETIRED"), "retired\n");

		expect(canonicalLedger(submodule)).toEqual({ root: realpathSync(submodule), active: true });
	});

	test("null, never a verdict, when Git output is absent, malformed, ambiguous, or unresolvable", () => {
		const common = scratch("ledger-observation-common");
		const topLevel = scratch("ledger-observation-top");
		expect(canonicalLedger("/anywhere", () => null)).toBeNull();
		expect(canonicalLedger("/anywhere", () => "")).toBeNull();
		expect(canonicalLedger("/anywhere", () => common)).toBeNull();
		expect(canonicalLedger("/anywhere", () => `${common}\nrelative`)).toBeNull();
		expect(canonicalLedger("/anywhere", () => `${common}\n${topLevel}\n${topLevel}`)).toBeNull();
		expect(canonicalLedger("/anywhere", () => `${common}\n${join(ROOT, "ledger-absent")}`)).toBeNull();
	});
});

/**
 * Two claims a receipt may not make. Both are refusals at the trust boundary rather
 * than checks in a consumer, because each one is a gate that would otherwise be
 * satisfied by a file instead of by an observation.
 */
describe("cross-field claims", () => {
	test("an active ledger with no bead ids is refused, naming the field", () => {
		const reason = refusalFor({ ...landed(), beads: { ids: [], ledgerActive: true } });
		expect(reason).toContain("beads.ids");
		expect(reason).toContain("at least one bead id when beads.ledgerActive is true");
		expect(acceptedFrom({ ...landed(), beads: { ids: [], ledgerActive: false } }).beads.ids).toEqual([]);
	});

	test('an unobserved proof is never "landed", so an unproven merge cannot borrow the authority', () => {
		const unobserved = { ...landed(), proof: { ...landed().proof, method: RECEIPT_METHOD_UNKNOWN } };
		const reason = refusalFor(unobserved);
		expect(reason).toContain("proof.method");
		expect(reason).toContain('never "unknown", when outcome is "landed"');
		expect(acceptedFrom({ ...unobserved, outcome: "partial" }).proof.method).toBe("unknown");
	});

	test("writeReceipt refuses both pairs before persisting anything", () => {
		const directory = receiptsIn("write-cross-field");
		mkdirSync(directory, { recursive: true });
		for (const hostile of [
			{ ...landed(), beads: { ids: [], ledgerActive: true } },
			{ ...landed(), proof: { ...landed().proof, method: RECEIPT_METHOD_UNKNOWN } },
		]) {
			expect(() => writeReceipt(hostile as LandingReceipt, directory)).toThrow(/refusing to persist an invalid receipt/);
		}
		expect(readdirSync(directory)).toEqual([]);
	});
});

/**
 * Run git in a fixture repository with the developer's environment neutralised.
 *
 * A global `commit.gpgsign=true` costs seconds per commit and hook paths can refuse
 * the commit outright, either of which would fail this file on a machine rather than
 * on the code.
 */
function git(cwd: string, ...args: string[]): void {
	const proc = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	});
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
}

describe("writeReceipt and readReceipt", () => {
	test("a written receipt reads back deeply equal, unknown key included", () => {
		const directory = receiptsIn("write-roundtrip");
		const receipt = acceptedFrom(withField("mergeQueueEntry", { id: "q-1" }));

		const path = writeReceipt(receipt, directory);

		expect(path).toBe(join(directory, "1700000000000-b1b2b3b4b5b6.json"));
		const read = readReceipt(path);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.receipt).toEqual(receipt);
		expect(read.receipt.mergeQueueEntry).toEqual({ id: "q-1" });
	});

	test("creates the receipts directory at 0700 and the receipt at 0600", () => {
		const directory = receiptsIn("write-mode");
		const path = writeReceipt(landed(), directory);
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("tightens a pre-existing receipts directory to 0700", () => {
		const directory = receiptsIn("write-lax");
		mkdirSync(directory, { recursive: true });
		chmodSync(directory, 0o755);
		expect(statSync(directory).mode & 0o777).toBe(0o755);

		writeReceipt(landed(), directory);

		expect(statSync(directory).mode & 0o777).toBe(0o700);
	});

	test("rejects a symlinked receipt directory before changing its target or creating a file", () => {
		const root = scratch("write-directory-symlink");
		const outside = scratch("write-directory-symlink-target");
		chmodSync(outside, 0o755);
		const directory = join(root, "receipts");
		symlinkSync(outside, directory);

		expect(() => writeReceipt(landed(), directory)).toThrow(/directory/);
		expect(lstatSync(directory).isSymbolicLink()).toBe(true);
		expect(statSync(outside).mode & 0o777).toBe(0o755);
		expect(readdirSync(outside)).toEqual([]);
	});

	test("a successful write leaves the receipt and no temporary file", () => {
		const directory = receiptsIn("write-no-residue");
		writeReceipt(landed(), directory);
		expect(readdirSync(directory)).toEqual(["1700000000000-b1b2b3b4b5b6.json"]);
	});

	test("an unserialisable receipt creates nothing", () => {
		const directory = receiptsIn("write-unserialisable");
		const poisoned = { ...landed(), weird: 1n } as unknown as LandingReceipt;

		expect(() => writeReceipt(poisoned, directory)).toThrow();

		expect(readdirSync(directory)).toEqual([]);
	});

	test("refuses an unreadable or unparseable path, naming it", () => {
		const directory = scratch("read-bad");
		const missing = join(directory, "1700000000000-nope.json");
		expect(refusalOf(readReceipt(missing))).toContain(missing);

		const garbage = join(directory, "1700000000001-nope.json");
		writeFileSync(garbage, "{not json");
		expect(refusalOf(readReceipt(garbage))).toContain(garbage);
	});

	test("refuses a foreign object found at a receipt path", () => {
		const directory = scratch("read-foreign");
		const path = join(directory, "1700000000000-b1b2b3b4b5b6.json");
		writeFileSync(path, JSON.stringify({ schema: "something.else", version: 1 }));
		expect(refusalOf(readReceipt(path))).toContain("foreign schema");
	});

	test("refuses direct reads through a symlink even when the target is a valid receipt", () => {
		const directory = scratch("read-symlink");
		const outside = join(scratch("read-symlink-target"), "receipt.json");
		const receipt = landed();
		writeFileSync(outside, JSON.stringify(receipt));
		const path = join(directory, `${receipt.receiptId}.json`);
		symlinkSync(outside, path);

		expect(refusalOf(readReceipt(path))).toContain(path);
		expect(lstatSync(path).isSymbolicLink()).toBe(true);
	});

	test("requires a direct read path basename to equal the payload receiptId", () => {
		const directory = scratch("read-filename-identity");
		const receipt = landed();
		for (const name of ["renamed.json", `${NOW + 1}-b1b2b3b4b5b6.json`]) {
			const path = join(directory, name);
			writeFileSync(path, JSON.stringify(receipt));
			expect(refusalOf(readReceipt(path))).toContain("receiptId");
		}
	});

	test("refuses a directory at a receipt path", () => {
		const directory = scratch("read-directory");
		const path = join(directory, "1700000000000-b1b2b3b4b5b6.json");
		mkdirSync(path);
		expect(refusalOf(readReceipt(path))).toContain("a regular file");
	});

	/**
	 * A FIFO reports size 0 and then blocks forever on read. Opening non-blocking and
	 * rejecting anything that is not a regular file is what keeps a session boundary
	 * from hanging on one. If this regresses, the test times out rather than fails.
	 */
	test("refuses a FIFO promptly instead of waiting for a writer", () => {
		const directory = scratch("read-fifo");
		const path = join(directory, "1700000000000-b1b2b3b4b5b6.json");
		const made = Bun.spawnSync(["mkfifo", path]);
		expect(made.exitCode).toBe(0);

		const started = Date.now();
		const reason = refusalOf(readReceipt(path));

		expect(reason).toContain("a regular file");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("refuses a file one byte over the cap, and reads one exactly at it", () => {
		const directory = scratch("read-oversized");
		const over = join(directory, "1700000000000-b1b2b3b4b5b6.json");
		writeFileSync(over, Buffer.alloc(MAX_RECEIPT_BYTES + 1, 0x20));
		expect(refusalOf(readReceipt(over))).toContain(String(MAX_RECEIPT_BYTES));

		const at = join(directory, "1700000000001-b1b2b3b4b5b6.json");
		writeFileSync(at, Buffer.alloc(MAX_RECEIPT_BYTES, 0x20));
		expect(refusalOf(readReceipt(at))).toContain("unparseable");
	});
});

/**
 * Publishing is exclusive. Two writers can reach the same id — same millisecond, same
 * merge oid — and a proof artefact must never be silently replaced.
 */
describe("publishing is exclusive and idempotent", () => {
	test("writing the identical receipt twice succeeds and changes nothing", () => {
		const directory = receiptsIn("publish-idempotent");
		const first = writeReceipt(landed(), directory);
		const before = readFileSync(first, "utf8");

		const second = writeReceipt(landed(), directory);

		expect(second).toBe(first);
		expect(readFileSync(first, "utf8")).toBe(before);
		expect(readdirSync(directory)).toEqual(["1700000000000-b1b2b3b4b5b6.json"]);
	});

	test("byte-identical symlink targets are never idempotent success", () => {
		const directory = receiptsIn("publish-idempotent-symlink");
		mkdirSync(directory, { recursive: true });
		const receipt = landed();
		const target = join(directory, `${receipt.receiptId}.json`);
		const outside = join(scratch("publish-symlink-outside"), "receipt.json");
		writeFileSync(outside, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		symlinkSync(outside, target);

		expect(() => writeReceipt(receipt, directory)).toThrow(/byte-identical/);
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
	});

	test("byte-identical targets with a mode other than 0600 are never idempotent success", () => {
		const directory = receiptsIn("publish-idempotent-mode");
		mkdirSync(directory, { recursive: true });
		const receipt = landed();
		const target = join(directory, `${receipt.receiptId}.json`);
		writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
		chmodSync(target, 0o644);

		expect(() => writeReceipt(receipt, directory)).toThrow(/byte-identical/);
		expect(statSync(target).mode & 0o777).toBe(0o644);
	});

	test("a different receipt under the same id refuses and leaves the original intact", () => {
		const directory = receiptsIn("publish-conflict");
		const path = writeReceipt(landed(), directory);
		const before = readFileSync(path, "utf8");

		const error = threwFrom(() => writeReceipt(landed({ notes: "a different fact" }), directory));

		expect(error.message).toContain(path);
		expect(error.message).toContain("byte-identical");
		expect(readFileSync(path, "utf8")).toBe(before);
		// The refused write left no temporary file behind either.
		expect(readdirSync(directory)).toEqual(["1700000000000-b1b2b3b4b5b6.json"]);
	});

	test("an unreadable obstruction at the target refuses rather than replacing it", () => {
		const directory = receiptsIn("publish-obstructed");
		mkdirSync(directory, { recursive: true });
		const obstacle = join(directory, "1700000000000-b1b2b3b4b5b6.json");
		mkdirSync(obstacle);

		const error = threwFrom(() => writeReceipt(landed(), directory));

		expect(error.message).toContain(obstacle);
		expect(statSync(obstacle).isDirectory()).toBe(true);
		expect(readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile())).toEqual([]);
	});

	/**
	 * A temporary-name collision means the name belongs to somebody else. Deleting it
	 * would destroy another writer's in-flight receipt, so the only safe response is a
	 * different name.
	 */
	test("a temporary-name collision never deletes the other writer's file", () => {
		const directory = receiptsIn("publish-temp-collision");
		mkdirSync(directory, { recursive: true });
		const foreign = join(directory, ".foreign.tmp");
		writeFileSync(foreign, "another writer's bytes");

		let call = 0;
		const path = writeReceipt(landed(), directory, {
			tempName: () => {
				call += 1;
				return call === 1 ? ".foreign.tmp" : ".mine.tmp";
			},
		});

		expect(call).toBe(2);
		expect(readFileSync(foreign, "utf8")).toBe("another writer's bytes");
		expect(readReceipt(path).ok).toBe(true);
		expect(readdirSync(directory).sort()).toEqual([".foreign.tmp", "1700000000000-b1b2b3b4b5b6.json"]);
	});

	test("gives up after a bounded number of collisions, still deleting nothing", () => {
		const directory = receiptsIn("publish-temp-exhausted");
		mkdirSync(directory, { recursive: true });
		const foreign = join(directory, ".foreign.tmp");
		writeFileSync(foreign, "another writer's bytes");

		let call = 0;
		const error = threwFrom(() =>
			writeReceipt(landed(), directory, {
				tempName: () => {
					call += 1;
					return ".foreign.tmp";
				},
			}),
		);

		expect(call).toBe(MAX_TEMP_ATTEMPTS);
		expect(error.message).toContain("collisions");
		expect(readFileSync(foreign, "utf8")).toBe("another writer's bytes");
		expect(readdirSync(directory)).toEqual([".foreign.tmp"]);
	});

	test.each(["1700000000000-b1b2b3b4b5b6.json", "../escaped.tmp", "nested/name.tmp", "nested\\name.tmp", "", ".", ".."])(
		"refuses unsafe temporary basename %p before opening or unlinking anything",
		name => {
			const directory = receiptsIn(`publish-temp-unsafe-${Buffer.from(name).toString("hex")}`);
			const outside = join(directory, "..", "escaped.tmp");
			expect(() => writeReceipt(landed(), directory, { tempName: () => name })).toThrow(/temporary file/);
			expect(() => statSync(outside)).toThrow();
			expect(readdirSync(directory)).toEqual([]);
		},
	);
});

describe("listReceipts", () => {
	test("newest first, ignoring anything that is not a valid receipt", () => {
		const directory = receiptsIn("list-order");
		writeReceipt(landed({ now: NOW }), directory);
		writeReceipt(landed({ now: NOW + 2_000 }), directory);
		writeReceipt(landed({ now: NOW + 1_000 }), directory);
		writeFileSync(join(directory, "1900000000000-bogus.json"), JSON.stringify({ schema: "other" }));
		writeFileSync(join(directory, "notes.txt"), "not a receipt");
		mkdirSync(join(directory, "1900000000001-directory.json"), { recursive: true });

		expect(listReceipts(directory).map(receipt => receipt.receiptId)).toEqual([
			"1700000002000-b1b2b3b4b5b6",
			"1700000001000-b1b2b3b4b5b6",
			"1700000000000-b1b2b3b4b5b6",
		]);
	});

	test("rejects a candidate whose filename stem is not its validated payload receiptId", () => {
		const directory = receiptsIn("list-filename-identity");
		mkdirSync(directory, { recursive: true });
		const receipt = landed({ now: NOW });
		writeFileSync(join(directory, `${NOW + 1_000}-b1b2b3b4b5b6.json`), JSON.stringify(receipt));

		expect(listReceipts(directory)).toEqual([]);
	});

	test("rejects mismatched candidates before they can consume the bounded window", () => {
		const directory = receiptsIn("list-filename-window");
		mkdirSync(directory, { recursive: true });
		const genuine = landed({ now: NOW });
		writeFileSync(join(directory, `${genuine.receiptId}.json`), JSON.stringify(genuine));
		for (let index = 1; index <= MAX_LISTED_RECEIPTS; index += 1) {
			const payload = landed({ now: NOW + index });
			const falseStem = `${NOW + MAX_LISTED_RECEIPTS + index}-b1b2b3b4b5b6`;
			writeFileSync(join(directory, `${falseStem}.json`), JSON.stringify(payload));
		}

		expect(listReceipts(directory).map(receipt => receipt.receiptId)).toEqual([genuine.receiptId]);
	});

	/**
	 * The epoch is variable-width, so comparing ids as strings puts `9-…` above
	 * `1700000000000-…`. One numeric key, used for both the bounded window and the
	 * returned order, is what keeps those from disagreeing.
	 */
	test("orders by the epoch numerically, not as a string", () => {
		const directory = receiptsIn("list-numeric");
		writeReceipt(landed({ now: 9 }), directory);
		writeReceipt(landed({ now: NOW }), directory);
		writeReceipt(landed({ now: 1 }), directory);
		writeReceipt(landed({ now: 100 }), directory);

		expect(listReceipts(directory).map(receipt => receipt.receiptId)).toEqual([
			"1700000000000-b1b2b3b4b5b6",
			"100-b1b2b3b4b5b6",
			"9-b1b2b3b4b5b6",
			"1-b1b2b3b4b5b6",
		]);
	});

	/**
	 * The bounded window is chosen from filenames, but the documented order is by
	 * `emittedAt` then `receiptId`. Those are the same order only because a receipt
	 * whose `emittedAt` disagrees with its id's epoch cannot validate, so the
	 * equivalence is what this asserts: the returned sequence is sorted by `emittedAt`
	 * as well as by id.
	 */
	test("the filename order it selects by is also the emittedAt order it promises", () => {
		const directory = receiptsIn("list-equivalence");
		for (const now of [NOW + 2_000, NOW, 9, NOW + 1_000, 100]) writeReceipt(landed({ now }), directory);

		const listed = listReceipts(directory);
		const byEmittedAt = [...listed].sort((a, b) => Date.parse(b.emittedAt) - Date.parse(a.emittedAt));

		expect(listed.map(receipt => receipt.receiptId)).toEqual(byEmittedAt.map(receipt => receipt.receiptId));
		expect(listed.map(receipt => Date.parse(receipt.emittedAt))).toEqual([
			NOW + 2_000,
			NOW + 1_000,
			NOW,
			100,
			9,
		]);
	});

	test("orders receipts minted in the same millisecond by id, newest first", () => {
		const directory = receiptsIn("list-tie");
		writeReceipt(landed({ mergeCommitOid: "aaaaaaaaaaaa" }), directory);
		writeReceipt(landed({ mergeCommitOid: "cccccccccccc" }), directory);

		expect(listReceipts(directory).map(receipt => receipt.receiptId)).toEqual([
			"1700000000000-cccccccccccc",
			"1700000000000-aaaaaaaaaaaa",
		]);
	});

	test("applies the pr and branch filters", () => {
		const directory = receiptsIn("list-filter");
		writeReceipt(landed({ now: NOW, pr: 7, branch: "omp/agent/a" }), directory);
		writeReceipt(landed({ now: NOW + 1_000, pr: 9, branch: "omp/agent/b" }), directory);

		expect(listReceipts(directory, { pr: 7 }).map(receipt => receipt.pr.number)).toEqual([7]);
		expect(listReceipts(directory, { branch: "omp/agent/b" }).map(receipt => receipt.pr.number)).toEqual([9]);
		expect(listReceipts(directory, { pr: 7, branch: "omp/agent/b" })).toEqual([]);
		expect(listReceipts(directory, { pr: 11 })).toEqual([]);
	});

	/**
	 * The cap has to bound what is held, not just what is returned: reading every name
	 * into an array and slicing it is the same unbounded read the cap exists to stop.
	 */
	test("holds at most the newest 200 receipts, dropping the oldest", () => {
		const directory = receiptsIn("list-cap");
		mkdirSync(directory, { recursive: true });
		const total = MAX_LISTED_RECEIPTS + 1;
		for (let index = 0; index < total; index += 1) {
			const receipt = landed({ now: NOW + index });
			writeFileSync(join(directory, `${receipt.receiptId}.json`), JSON.stringify(receipt));
		}

		const listed = listReceipts(directory);

		expect(listed).toHaveLength(MAX_LISTED_RECEIPTS);
		expect(listed[0]?.receiptId).toBe(`${NOW + total - 1}-b1b2b3b4b5b6`);
		expect(listed.at(-1)?.receiptId).toBe(`${NOW + 1}-b1b2b3b4b5b6`);
		expect(listed.some(receipt => receipt.receiptId === `${NOW}-b1b2b3b4b5b6`)).toBe(false);
	});

	/** The window must keep the newest even when the oldest are seen first, and vice versa. */
	test("keeps the newest regardless of the order the directory yields them", () => {
		const directory = receiptsIn("list-cap-order");
		mkdirSync(directory, { recursive: true });
		const epochs = [NOW + 5, NOW + 1, NOW + 4, NOW + 2, NOW + 3];
		for (const epoch of epochs) {
			const receipt = landed({ now: epoch });
			writeFileSync(join(directory, `${receipt.receiptId}.json`), JSON.stringify(receipt));
		}

		expect(listReceipts(directory).map(receipt => receipt.receiptId)).toEqual(
			[NOW + 5, NOW + 4, NOW + 3, NOW + 2, NOW + 1].map(epoch => `${epoch}-b1b2b3b4b5b6`),
		);
	});

	test("an absent directory lists nothing rather than throwing", () => {
		expect(listReceipts(join(ROOT, "list-absent", "receipts"))).toEqual([]);
	});
});
