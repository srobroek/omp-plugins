import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bashGates from "./bash-gates.ts";
import sessionBeadsLifecycle, {
	autoPinBeadsDir,
	bdVerbs,
	beadIdCandidates,
	claimAnchor,
	envelopeData,
	formatGateAdvisory,
	formatSessionCloseAdvisory,
	gatesCanResolve,
	handleSessionStop,
	heldClaims,
	isBdWrite,
	lastPushNotice,
	lifecycleBdEnvironment,
	parseTrailingJson,
	pinBashInput,
	readBeads,
	readCheckOutcome,
	readGateList,
	readGates,
	releaseAutoPin,
	releaseClaimArgs,
	releaseClaimCommand,
	repoIdentity,
  runBdResult,
  sessionPinAfter,
  sessionPinFor,
  setBdStreamForTests,
  staleSkipNotice,
} from "./session-beads-lifecycle.ts";


/** `bd gate list --json` under BD_JSON_ENVELOPE=1, verbatim shape from bd 1.1.2. */
const GATE_LIST = JSON.stringify({
	data: [
		{
			id: "bd-probe-23d",
			title: "Gate: human",
			description: "Ad-hoc gate blocking bd-probe-2m7\n\nReason: needs design review",
			status: "open",
			issue_type: "gate",
			await_type: "human",
		},
		{
			id: "bd-probe-toz",
			title: "Gate: timer",
			description: "Ad-hoc gate blocking bd-probe-2m7",
			status: "open",
			issue_type: "gate",
			await_type: "timer",
			timeout: 172800000000000,
		},
	],
	schema_version: 1,
});

/** `bd gate check --json`: human progress lines, then the envelope. */
const GATE_CHECK = [
	"○ bd-probe-toz: pending - expires in 47h59m53s",
	"",
	"Checked 1 gates: 0 resolved, 0 escalated, 0 errors",
	JSON.stringify({
		data: { checked: 1, dry_run: false, errors: 0, escalated: 0, resolved: 0 },
		schema_version: 1,
	}),
].join("\n");

const BEAD_LIST = JSON.stringify({
	data: [
		{ id: "bd-probe-e8z", title: "second thing", status: "open" },
		{ id: "bd-probe-2m7", title: "target work", status: "in_progress", assignee: "omp/Main/s1" },
		{ id: "bd-probe-r9p", title: "reported handoff", status: "in_progress", labels: ["state:reported"] },
		{ id: "bd-probe-v4k", title: "inconsistent reported owner", status: "in_progress", assignee: "omp/Main/s1", labels: ["state:reported"] },
		{ id: "bd-probe-k2j", title: "malformed reported labels", status: "in_progress", labels: ["state:reported", 42] },
	],
	schema_version: 1,
});

describe("autoPinBeadsDir", () => {
	test("pins the first session, shares within a repository, conflicts across repositories, follows the next owner", () => {
		const root = mkdtempSync(join(tmpdir(), "beads-pin-"));
		const worktree = mkdtempSync(join(tmpdir(), "beads-pin-wt-"));
		const other = mkdtempSync(join(tmpdir(), "beads-pin-other-"));
		const plain = mkdtempSync(join(tmpdir(), "beads-pin-plain-"));
		mkdirSync(join(root, ".beads"));
		mkdirSync(join(other, ".beads"));
		const env: NodeJS.ProcessEnv = {};
		const state: { pinned?: string; owner?: string; ownerRepo?: string } = {};
		const live = new Set<string>(["alpha"]);
		const isLive = (id: string) => live.has(id);
		// identity: root and worktree are one repository; other and plain are their own
		const identity = (cwd: string) => (cwd === worktree ? root : cwd);
		expect(autoPinBeadsDir(plain, "alpha", isLive, env, state, identity)).toEqual({}); // no database here
		expect(autoPinBeadsDir(root, "alpha", isLive, env, state, identity)).toEqual({ pinned: join(root, ".beads") });
		live.add("beta");
		expect(autoPinBeadsDir(worktree, "beta", isLive, env, state, identity)).toEqual({}); // same repository: inherits
		expect(autoPinBeadsDir(other, "beta", isLive, env, state, identity)).toEqual({ conflict: join(root, ".beads") }); // unrelated: warned
		expect(env.BEADS_DIR).toBe(join(root, ".beads")); // alpha's pin untouched either way
		live.delete("alpha");
		expect(autoPinBeadsDir(other, "beta", isLive, env, state, identity)).toEqual({ pinned: join(other, ".beads") }); // owner gone
		releaseAutoPin(env, state);
		expect(env.BEADS_DIR).toBeUndefined();
		const human: NodeJS.ProcessEnv = { BEADS_DIR: "/elsewhere/.beads" };
		expect(autoPinBeadsDir(root, "alpha", isLive, human, {}, identity)).toEqual({}); // a human pin is never replaced
		releaseAutoPin(human, {});
		expect(human.BEADS_DIR).toBe("/elsewhere/.beads");
		for (const dir of [root, worktree, other, plain]) rmSync(dir, { recursive: true, force: true });
	});

	test("sessionPinFor finds the primary checkout's database from a linked worktree", () => {
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		const root = mkdtempSync(join(tmpdir(), "beads-wtpin-"));
		execFileSync("git", ["-C", root, "init", "-q"]);
		writeFileSync(join(root, "a"), "a");
		execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "add", "a"]);
		execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"]);
		mkdirSync(join(root, ".beads"));
		const wt = `${root}-wt`;
		execFileSync("git", ["-C", root, "worktree", "add", "-q", wt, "-b", "wt"]);
		mkdirSync(join(wt, ".beads")); // copied ignored state must not fork the embedded database
		expect(sessionPinFor(wt)).toBe(realpathSync(join(root, ".beads")));
		const bare = mkdtempSync(join(tmpdir(), "beads-wtpin-none-"));
		expect(sessionPinFor(bare)).toBeUndefined();
		execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt]);
		rmSync(root, { recursive: true, force: true });
		rmSync(bare, { recursive: true, force: true });
	}, 20_000); // shells out to git init/commit/worktree add; exceeds the 5s default under full-suite load

	test("repoIdentity resolves worktrees of one repository to the same common dir", () => {
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		const root = mkdtempSync(join(tmpdir(), "beads-ident-"));
		execFileSync("git", ["-C", root, "init", "-q"]);
		writeFileSync(join(root, "a"), "a");
		execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "add", "a"]);
		execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"]);
		const wt = join(root, "..", `${root.split("/").pop()}-wt`);
		execFileSync("git", ["-C", root, "worktree", "add", "-q", wt, "-b", "wt"]);
		expect(repoIdentity(wt)).toBe(repoIdentity(root));
		expect(repoIdentity(tmpdir())).not.toBe(repoIdentity(root));
		execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt]);
		rmSync(root, { recursive: true, force: true });
	}, 20_000); // shells out to git init/commit/worktree add; exceeds the 5s default under full-suite load
});

describe("pinBashInput", () => {
	test("sessionPinAfter mirrors a foreign process pin, uses the checkout on conflict or when unpinned", () => {
		const root = mkdtempSync(join(tmpdir(), "beads-pinafter-"));
		mkdirSync(join(root, ".beads"));
		expect(sessionPinAfter({}, root, { BEADS_DIR: "/human/.beads" })).toBe("/human/.beads");
		expect(sessionPinAfter({ pinned: join(root, ".beads") }, root, { BEADS_DIR: join(root, ".beads") })).toBe(join(root, ".beads"));
		expect(sessionPinAfter({ conflict: "/alpha/.beads" }, root, { BEADS_DIR: "/alpha/.beads" })).toBe(join(root, ".beads"));
		expect(sessionPinAfter({}, root, {})).toBe(join(root, ".beads"));
		const plain = mkdtempSync(join(tmpdir(), "beads-pinafter-plain-"));
		expect(sessionPinAfter({}, plain, {})).toBeUndefined();
		rmSync(root, { recursive: true, force: true });
		rmSync(plain, { recursive: true, force: true });
	});

	test("adds the session pin to a bash call, keeps a caller pin, ignores malformed env", () => {
		expect(pinBashInput({ command: "bd list" }, "/repo/.beads")).toEqual({ command: "bd list", env: { BEADS_DIR: "/repo/.beads" } });
		expect(pinBashInput({ command: "bd list", env: { A: "1" } }, "/repo/.beads")).toEqual({ command: "bd list", env: { A: "1", BEADS_DIR: "/repo/.beads" } });
		expect(pinBashInput({ command: "bd list", env: { BEADS_DIR: "/mine/.beads" } }, "/repo/.beads")).toBeUndefined();
		expect(pinBashInput({ command: "bd list" }, undefined)).toBeUndefined();
		expect(pinBashInput({ command: "bd list", env: "nope" }, "/repo/.beads")).toBeUndefined();
	});
});

describe("lifecycleBdEnvironment", () => {
	test("sets embedded-store safety flags without inheriting a foreign store", () => {
		const cwd = mkdtempSync(join(tmpdir(), "beads-lifecycle-env-"));
		mkdirSync(join(cwd, ".beads"));
		try {
			const env = lifecycleBdEnvironment(cwd, { BEADS_DIR: "/foreign/.beads" });
			expect(env.BEADS_DIR).not.toBe("/foreign/.beads");
			expect(env.BEADS_DIR).toBe(join(cwd, ".beads"));
			expect(env.BD_NO_PAGER).toBe("1");
			expect(env.BD_NON_INTERACTIVE).toBe("1");
			expect(env.BD_DOLT_AUTO_START).toBe("false");
			expect(env.NO_COLOR).toBe("1");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});

describe("parseTrailingJson / envelopeData", () => {
	test("finds the envelope after bd's human summary", () => {
		expect(readCheckOutcome(GATE_CHECK)).toEqual({ resolved: 0, escalated: 0, errors: 0 });
	});

	test("plain text alone yields nothing", () => {
		expect(parseTrailingJson("No open gates found.")).toBeUndefined();
		expect(parseTrailingJson("   ")).toBeUndefined();
	});

	test("bare --json output passes through unwrapping", () => {
		expect(envelopeData([{ id: "a" }])).toEqual([{ id: "a" }]);
		expect(envelopeData({ data: null, schema_version: 1 })).toBeNull();
	});

	test("counts read from a resolved check", () => {
		const out = readCheckOutcome(
			`Checked 2 gates\n${JSON.stringify({ data: { resolved: 1, escalated: 1, errors: 0 }, schema_version: 1 })}`,
		);
		expect(out).toEqual({ resolved: 1, escalated: 1, errors: 0 });
	});
});

describe("readGates", () => {
	test("reads type, blocked issue, and reason", () => {
		const gates = readGates(GATE_LIST);
		expect(gates).toHaveLength(2);
		expect(gates[0]).toEqual({
			id: "bd-probe-23d",
			awaitType: "human",
			blocks: "bd-probe-2m7",
			reason: "needs design review",
		});
		expect(gates[1]!.reason).toBeUndefined();
	});

	test("an empty database yields no gates", () => {
		expect(readGates(JSON.stringify({ data: null, schema_version: 1 }))).toEqual([]);
		expect(readGates("No open gates found.")).toEqual([]);
	});

	test("accepts bd's null empty-list contract but rejects malformed rows", () => {
		expect(readGateList("null")).toEqual([]);
		expect(readGateList(JSON.stringify({ data: null, schema_version: 1 }))).toEqual([]);
		expect(readGateList(JSON.stringify({ data: null, error: null, schema_version: 1 }))).toEqual([]);
		expect(readGateList(JSON.stringify({ data: null, error: "database unavailable", schema_version: 1 }))).toBeUndefined();
		expect(readGateList(JSON.stringify({ data: [{ id: "g1" }], schema_version: 1 }))).toBeUndefined();
		expect(readGateList(JSON.stringify({ error: "database unavailable" }))).toBeUndefined();
	});

	test("closed rows are not open gates", () => {
		const text = JSON.stringify({
			data: [{ id: "g1", status: "closed", await_type: "timer" }],
			schema_version: 1,
		});
		expect(readGates(text)).toEqual([]);
	});
});

describe("gatesCanResolve", () => {
	test("a human gate alone never earns a check", () => {
		expect(gatesCanResolve([{ id: "g", awaitType: "human" }])).toBe(false);
	});

	test("timer and github gates do", () => {
		expect(gatesCanResolve([{ id: "g", awaitType: "human" }, { id: "t", awaitType: "timer" }])).toBe(true);
		expect(gatesCanResolve([{ id: "r", awaitType: "gh:run" }])).toBe(true);
		expect(gatesCanResolve([{ id: "b", awaitType: "bead" }])).toBe(true);
	});
});

describe("formatGateAdvisory", () => {
	test("names every gate and the check outcome", () => {
		const text = formatGateAdvisory(readGates(GATE_LIST), readCheckOutcome(GATE_CHECK))!;
		expect(text).toContain("bd-probe-23d (human) blocks bd-probe-2m7 -- needs design review");
		expect(text).toContain("bd-probe-toz (timer)");
		expect(text).toContain("0 resolved");
		expect(text).toContain("bd gate resolve");
	});

	test("no gates, no advisory", () => {
		expect(formatGateAdvisory([], undefined)).toBeUndefined();
	});

	test("a long list is capped and counted", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, awaitType: "human" }));
		const text = formatGateAdvisory(many, undefined)!;
		expect(text).toContain("12 open beads gate(s)");
		expect(text).toContain("...and 4 more");
	});

	test("the check outcome is omitted when no check ran", () => {
		expect(formatGateAdvisory([{ id: "g", awaitType: "human" }], undefined)).not.toContain("bd gate check");
	});
});

describe("lastPushNotice", () => {
	test("a failed verdict is reported with its line", () => {
		const notice = lastPushNotice("started: dbd\nfailed: pre-push rejected; set custom.bd-push-command\n")!;
		expect(notice).toContain("FAILED");
		expect(notice).toContain("custom.bd-push-command");
	});

	test("a surviving start line means the push was cut off", () => {
		expect(lastPushNotice("started: dbd\n")).toContain("did not finish");
	});

	test("a successful verdict says nothing", () => {
		expect(lastPushNotice("started: dbd\nok: pushed 3 commits\n")).toBeUndefined();
		expect(lastPushNotice("")).toBeUndefined();
	});
});

describe("staleSkipNotice", () => {
	test("ids from the json envelope", () => {
		const output = JSON.stringify({
			data: { source: ".beads/issues.jsonl", created: 4, skipped: 1, stale_skipped_ids: ["bd-probe-2m7"] },
			schema_version: 1,
		});
		const notice = staleSkipNotice(output)!;
		expect(notice).toContain("bd-probe-2m7");
		expect(notice).toContain("BEHIND this database");
		expect(notice).toContain("BEFORE pulling peer changes");
	});

	test("bd's plain-text form counts too", () => {
		const notice = staleSkipNotice(
			"Imported 3 issues from .beads/issues.jsonl (2 stale skipped; use --allow-stale to restore older rows)",
		)!;
		expect(notice).toContain("2 row(s)");
	});

	test("a clean import is silent", () => {
		expect(
			staleSkipNotice(JSON.stringify({ data: { created: 5, skipped: 0 }, schema_version: 1 })),
		).toBeUndefined();
		expect(staleSkipNotice("Imported 5 issues from .beads/issues.jsonl")).toBeUndefined();
		expect(staleSkipNotice("Imported 5 issues (0 stale skipped)")).toBeUndefined();
	});
});

describe("bdVerbs / isBdWrite", () => {
	test("verbs behind global flags are still verbs", () => {
		expect(bdVerbs("bd -C /repo close x")).toEqual(["close"]);
		expect(bdVerbs("bd show a && bd close b")).toEqual(["show", "close"]);
	});

	test("a write anywhere in the line counts", () => {
		expect(isBdWrite("bd show a && bd close b")).toBe(true);
		expect(isBdWrite("bd import .beads/issues.jsonl")).toBe(true);
		expect(isBdWrite("bd gate resolve g1")).toBe(true);
		expect(isBdWrite("bd defer x --until 2026-09-01 --reason later")).toBe(true);
	});

	test("documented top-level mutations mark the session written", () => {
		for (const command of [
			"bd assign x worker",
			"bd delete x",
			"bd edit x",
			"bd link a b",
			"bd note x hi",
			"bd priority x 1",
			"bd promote x",
			"bd q task",
			"bd rename x y",
			"bd reopen x",
			"bd tag x blocked",
			"bd undefer x",
		]) {
			expect(isBdWrite(command)).toBe(true);
		}
	});

	test("reads are not writes", () => {
		expect(isBdWrite("bd list --status open --json")).toBe(false);
		expect(isBdWrite("bd ready --unassigned --json")).toBe(false);
		expect(isBdWrite("bd comments x")).toBe(false);
		expect(isBdWrite("bd swarm validate root --json")).toBe(false);
	});

	test("grouped reads and previews do not mark the session written", () => {
		for (const command of [
			"bd mol list",
			"bd mol show mol-1",
			"bd mol current mol-1",
			"bd mol progress mol-1",
			"bd mol ready",
			"bd mol stale",
			"bd mol last-activity mol-1",
			"bd mol seed formula",
			"bd mol pour formula --dry-run",
			"bd mol wisp list",
			"bd dep tree x",
			"bd label list x",
			"bd audit list",
		]) {
			expect(isBdWrite(command)).toBe(false);
		}
	});

	test("grouped writes mark the session written", () => {
		for (const command of [
			"bd mol pour formula",
			"bd mol wisp formula",
			"bd dep add a b",
			"bd label add x foo",
			"bd audit record --kind tool_call",
		]) {
			expect(isBdWrite(command)).toBe(true);
		}
	});

	test("the claim forms of read verbs are writes", () => {
		expect(isBdWrite("bd ready --parent e --unassigned --claim --json")).toBe(true);
		expect(isBdWrite('bd comments add x -m "note"')).toBe(true);
	});
});

describe("beadIdCandidates", () => {
	test("id-shaped arguments only", () => {
		expect(beadIdCandidates("bd close bd-probe-2m7 --reason done")).toContain("bd-probe-2m7");
		expect(beadIdCandidates("bd close bd-probe-2m7 --reason done")).not.toContain("--reason");
	});

	test("molecule children keep their suffix", () => {
		expect(beadIdCandidates("bd update orc-e2e-3ef.1 --claim")).toContain("orc-e2e-3ef.1");
	});

	test("plain words are not ids", () => {
		expect(beadIdCandidates("bd list --json")).toEqual([]);
	});
});

describe("heldClaims", () => {
	const beads = readBeads(BEAD_LIST);

	test("a touched in_progress bead is held", () => {
		expect(heldClaims(beads, new Set(["bd-probe-2m7"]), undefined).map(b => b.id)).toEqual(["bd-probe-2m7"]);
	});

	test("a reported handoff is no longer held by this session", () => {
		expect(heldClaims(beads, new Set(["bd-probe-r9p"]), undefined)).toEqual([]);
	});

	test("reported state fails closed while assigned or malformed", () => {
		expect(heldClaims(beads, new Set(["bd-probe-v4k", "bd-probe-k2j"]), undefined).map(b => b.id)).toEqual([
			"bd-probe-v4k",
			"bd-probe-k2j",
		]);
	});

	test("an untouched backlog bead is not this session's problem", () => {
		expect(heldClaims(beads, new Set(), undefined)).toEqual([]);
	});

	test("a touched open bead is filed work, not an omission", () => {
		expect(heldClaims(beads, new Set(["bd-probe-e8z"]), undefined)).toEqual([]);
	});

	test("this actor's own claim counts even when the id was never seen", () => {
		expect(heldClaims(beads, new Set(), "omp/Main/s1").map(b => b.id)).toEqual(["bd-probe-2m7", "bd-probe-v4k"]);
		expect(heldClaims(beads, new Set(), "omp/Other/s2")).toEqual([]);
		expect(heldClaims(beads, new Set(), "")).toEqual([]);
	});
});

describe("claimAnchor", () => {
	test("preserves host and pid from a claimed bead for liveness checks", () => {
		const [bead] = readBeads(JSON.stringify({data: [{id: "bd-live-1", status: "in_progress", assignee: "omp/Other/s2", metadata: {lease_host: "worker-1", lease_pid: "4242"}}], schema_version: 1}));
		expect(bead && claimAnchor(bead)).toEqual({ host: "worker-1", pid: 4242 });
	});
});

describe("releaseClaimArgs", () => {
	const at = "2026-09-14T12:34:56.789Z";
	test("builds one guarded argv and preserves release metadata", () => {
		expect(releaseClaimArgs("bd-probe-2m7", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at)).toEqual([
			"update", "bd-probe-2m7", "--assignee", "", "--status", "open",
			"--set-metadata", "release_actor=omp/Main/s2", "--set-metadata", `released_at=${at}`,
			"--set-metadata", "released_from=omp/Main/s1", "--if-assignee", "omp/Main/s1",
		]);
	});
	test("builds a readback-verified argv when CAS is unavailable", () => {
		const args = releaseClaimArgs("bd-probe-2m7", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at, false);
		expect(args).toEqual([
			"update", "bd-probe-2m7", "--assignee", "", "--status", "open",
			"--set-metadata", "release_actor=omp/Main/s2", "--set-metadata", `released_at=${at}`,
			"--set-metadata", "released_from=omp/Main/s1",
		]);
		expect(args).not.toContain("--if-assignee");
	});
	test("prefers BD_ACTOR and falls back to BEADS_ACTOR", () => {
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", { BEADS_ACTOR: "omp/Main/fallback" }, at)?.[7]).toBe("release_actor=omp/Main/fallback");
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", { BD_ACTOR: " ", BEADS_ACTOR: "omp/Main/fallback" }, at)?.[7]).toBe("release_actor=omp/Main/fallback");
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/wins", BEADS_ACTOR: "omp/Main/loses" }, at)?.[7]).toBe("release_actor=omp/Main/wins");
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", {}, at)).toBeUndefined();
	});
	test("refuses unsafe identifiers instead of interpolating shell text", () => {
		expect(releaseClaimArgs("bd-a-1;rm", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at)).toBeUndefined();
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2;rm" }, at)).toBeUndefined();
		expect(releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at)).toContain("--if-assignee");
		expect(releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at, false)).not.toContain("--if-assignee");
		expect(releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at, false)).toContain("released_from=omp/Main/s1");
	});
	test("emits a command-local BD_ACTOR matching release metadata", () => {
		const command = releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2", BEADS_ACTOR: "omp/Main/ambient" }, at);
		expect(command).toContain("BEADS_ACTOR='omp/Main/s2' BD_ACTOR='omp/Main/s2' 'bd'");
		expect(command).toContain("'release_actor=omp/Main/s2'");
		expect(command).toContain("'released_from=omp/Main/s1'");
		expect(command).toContain("'--if-assignee' 'omp/Main/s1'");
	});
	test("refuses quote-bearing actors instead of interpolating shell text", () => {
		expect(releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/o'hare" }, at)).toBeUndefined();
	});
});
describe("formatSessionCloseAdvisory", () => {
	const at = "2026-09-14T12:34:56.789Z";
	test("names the bead and emits an actor-bound guarded command", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined), { BD_ACTOR: "omp/Main/s1" }, at);
		expect(text).toContain("bd-probe-2m7 [omp/Main/s1] target work");
		expect(text).toContain("'release_actor=omp/Main/s1'");
		expect(text).toContain(`'released_at=${at}'`);
		expect(text).toContain("'--if-assignee'");
		expect(text).toContain("'omp/Main/s1'");
		expect(text).not.toContain("<actor>");
		expect(text).not.toContain("<current-assignee>");
		expect(text).toContain("bd comments add");
	});
	test("emits a readback verification for bd without CAS support", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined), { BD_ACTOR: "omp/Main/s1" }, at, false);
		expect(text).toContain("Release with:");
		expect(text).not.toContain("does not advertise atomic");
		expect(text).toContain("Then verify: bd show <id> --json must show no assignee.");
	});
	test("does not release another holder when one actor merely touched the bead", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined), { BD_ACTOR: "omp/Main/releaser" }, at);
		expect(text).toContain("Release unavailable");
		expect(text).not.toContain("release_actor=");
		expect(text).not.toContain("--if-assignee");
	});
	test("fails closed when actor discovery is absent", () => {
		const bead = readBeads(BEAD_LIST)[1];
		if (bead === undefined) throw new Error("fixture must contain a second bead");
		const text = formatSessionCloseAdvisory([bead], {}, at);
		expect(text).toContain("Release unavailable");
		expect(text).not.toContain("release_actor=");
	});
	test("a long list is capped and counted", () => {
		const many = Array.from({ length: 11 }, (_, i) => ({ id: `b-${i}`, title: "t", status: "in_progress" }));
		expect(formatSessionCloseAdvisory(many)).toContain("...and 3 more");
	});
});

describe("handleSessionStop", () => {
	test("continues with the held claims", () => {
		const r = handleSessionStop({}, BEAD_LIST, new Set(["bd-probe-2m7"]), undefined);
		expect(r?.continue).toBe(true);
		expect(r?.additionalContext).toContain("bd-probe-2m7");
	});
test("passes the effective actor into actual release commands", () => {
		const r = handleSessionStop({}, BEAD_LIST, new Set(["bd-probe-2m7"]), "omp/Main/s1");
		expect(r?.additionalContext).toContain("'release_actor=omp/Main/s1'");
		expect(r?.additionalContext).toContain("'released_from=omp/Main/s1'");
		expect(r?.additionalContext).toContain("'--if-assignee'");
		expect(r?.additionalContext).toContain("'omp/Main/s1'");
		expect(r?.additionalContext).not.toContain("<actor>");
	});

	test("skips its own continuation", () => {
		expect(handleSessionStop({ stop_hook_active: true }, BEAD_LIST, new Set(["bd-probe-2m7"]))).toBeUndefined();
		expect(handleSessionStop({ stopHookActive: true }, BEAD_LIST, new Set(["bd-probe-2m7"]))).toBeUndefined();
	});

	test("reports embedded-store read failures without server credential advice", () => {
		const text = handleSessionStop({}, undefined, new Set(), undefined, true, 'bd exited with code 1: Error 1045 (28000): Access denied for user root')?.additionalContext ?? "";
		expect(text).toContain("Beads claims could not be read at session close");
	});
	test("nothing held, nothing said", () => {
		expect(handleSessionStop({}, BEAD_LIST, new Set(), undefined)).toBeUndefined();
	});

	test("an unreadable database reports uncertainty", () => {
		expect(handleSessionStop({}, undefined, new Set(["bd-probe-2m7"]), undefined)?.additionalContext).toContain("could not be read");
	});
	test("includes a bounded nonzero exit reason and keeps the inspection instruction", () => {
		const reason = `bd exited with code 7: ${"permission denied ".repeat(30)}`;
		const text = handleSessionStop({}, undefined, new Set(), undefined, true, reason)?.additionalContext ?? "";
		expect(text).toContain("bd exited with code 7: permission denied");
		expect(text).toContain("inspect assigned and touched work before stopping");
		expect(text.length).toBeLessThan(400);
	});
	test("distinguishes a timeout failure", () => {
		const text = handleSessionStop({}, undefined, new Set(), undefined, true, "bd command timed out")?.additionalContext ?? "";
		expect(text).toContain("Beads claims could not be read at session close: bd command timed out.");
	});
	test("successful reads retain the held claims advisory", () => {
		const text = handleSessionStop({}, BEAD_LIST, new Set(["bd-probe-2m7"]), undefined)?.additionalContext ?? "";
		expect(text).toContain("bd-probe-2m7");
	});
});

describe("runBdResult", () => {
	test("keeps nonzero stderr bounded in the failure result", async () => {
		const root = mkdtempSync(join(tmpdir(), "beads-run-fail-"));
		const script = join(root, "bd");
		writeFileSync(script, "#!/bin/sh\nprintf '%s' 'permission denied by the embedded ledger' >&2\nexit 7\n");
		chmodSync(script, 0o755);
		try {
			const result = await runBdResult(root, ["list"], Date.now() + 5_000, { ...process.env, PATH: root });
			expect(result).toEqual({ failure: "bd exited with code 7: permission denied by the embedded ledger" });
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	test("distinguishes a timed-out bd process", async () => {
		const root = mkdtempSync(join(tmpdir(), "beads-run-timeout-"));
		const script = join(root, "bd");
		writeFileSync(script, "#!/bin/sh\nexec /bin/sleep 1\n");
		chmodSync(script, 0o755);
		try {
			const result = await runBdResult(root, ["list"], Date.now() + 30, { ...process.env, PATH: root });
			expect(result).toEqual({ failure: "bd command timed out" });
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
  test("accepts a classified failure from the bd seam", async () => {
    setBdStreamForTests(async () => ({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" }));
    try {
      expect(await runBdResult("/repo", ["list"])).toEqual({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" });
    } finally {
      setBdStreamForTests(null);
    }
  });
});


describe("integration", () => {
	/** Collect handlers the way the runtime would, then drive them directly. */
	const wire = () => {
		const handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
		const logged: string[] = [];
		const fakePi = {
			zod: {},
			registerTool: () => {},
			sendMessage: (m: { content: string }) => logged.push(m.content),
			logger: { error: () => {}, info: () => {} },
			on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
				const registered = handlers[event] ?? [];
				registered.push(handler);
				handlers[event] = registered;
			},
		};
		sessionBeadsLifecycle(fakePi as never);
bashGates(fakePi as never);
		return { handlers, logged };
	};
	/**
	 * The `BEADS_DIR` a `tool_call` rewrite pins, narrowed rather than asserted.
	 *
	 * Each step throws on a shape the hook should never return, so a changed return
	 * type fails the test loudly instead of being read through an unchecked cast.
	 */
	const pinnedBeadsDir = (result: unknown): unknown => {
		if (!(result && typeof result === "object" && "input" in result)) throw new Error("the hook did not rewrite the call");
		const { input } = result;
		if (!(input && typeof input === "object" && "env" in input)) throw new Error("the rewritten call carries no env");
		const { env } = input;
		if (!(env && typeof env === "object" && "BEADS_DIR" in env)) throw new Error("the rewritten env carries no BEADS_DIR");
		return env.BEADS_DIR;
	};
  test("session start reports an injected embedded-store failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-fake-start-"));
    mkdirSync(join(dir, ".beads"));
    setBdStreamForTests(async () => ({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" }));
    try {
      const { handlers, logged } = wire();
      const start = handlers.session_start?.[0];
      if (start === undefined) throw new Error("session start handler was not registered");
      await start({}, { cwd: dir });
      expect(logged[0]).toContain("Beads gates could not be verified at session start");
    } finally {
      setBdStreamForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session close reports an injected embedded-store read failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-fake-close-"));
    mkdirSync(join(dir, ".beads"));
    setBdStreamForTests(async () => ({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" }));
    try {
      const { handlers } = wire();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "fake-close" } };
      const toolResult = handlers.tool_result?.[0];
      const stop = handlers.session_stop?.[0];
      if (toolResult === undefined || stop === undefined) throw new Error("lifecycle handlers were not registered");
      toolResult({ toolName: "bash", toolCallId: "write", isError: false, input: { command: "bd update bd-fake --claim" }, content: [] }, ctx);
      const result = await stop({}, ctx) as { additionalContext?: string };
      expect(result.additionalContext).toContain("Beads claims could not be read at session close");
    } finally {
      setBdStreamForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
	test("the tool_call hook pins bash for the session's checkout and nothing else", async () => {
		// This test asserts the branch where NO pin is inherited, so it has to establish
		// that precondition. The plugin exports `BEADS_DIR` into every session it runs
		// in, and an inherited value deliberately wins (asserted in the middle block);
		// left ambient, the first and last assertions would read that pin instead of the
		// checkout's own. The sibling test below saves and restores the same way.
		const ambient = process.env.BEADS_DIR;
		delete process.env.BEADS_DIR;
		try {
			const root = mkdtempSync(join(tmpdir(), "beads-callpin-"));
			mkdirSync(join(root, ".beads"));
			const { handlers } = wire();
			const call = handlers.tool_call![0]!;
			const ctx = { cwd: root, sessionManager: { getSessionId: () => "pin-session" } };
			expect(await call({ toolName: "bash", toolCallId: "1", input: { command: "printenv BEADS_DIR" } }, ctx)).toEqual({
				input: { command: "printenv BEADS_DIR", env: { BEADS_DIR: join(root, ".beads") } },
			});
			expect(await call({ toolName: "read", toolCallId: "2", input: { path: "x" } }, ctx)).toBeUndefined();
			const human = mkdtempSync(join(tmpdir(), "beads-callpin-human-"));
			mkdirSync(join(human, ".beads"));
			const savedPath = process.env.PATH;
			process.env.BEADS_DIR = "/human/pinned/.beads";
			process.env.PATH = "/nonexistent"; // no bd: the pin decision is the only effect
			try {
				await handlers.session_start![0]!({}, { cwd: human, sessionManager: { getSessionId: () => "human-session" } });
				const pinned = await call({ toolName: "bash", toolCallId: "4", input: { command: "bd list" } }, { cwd: human, sessionManager: { getSessionId: () => "human-session" } });
				expect(pinnedBeadsDir(pinned)).toBe("/human/pinned/.beads"); // never the checkout's own
			} finally {
				delete process.env.BEADS_DIR; // cleared for this test; the outer finally puts the ambient value back
				if (savedPath === undefined) delete process.env.PATH;
				else process.env.PATH = savedPath;
				rmSync(human, { recursive: true, force: true });
			}
			const plain = mkdtempSync(join(tmpdir(), "beads-callpin-plain-"));
			expect(await call({ toolName: "bash", toolCallId: "3", input: { command: "bd list" } }, { cwd: plain, sessionManager: { getSessionId: () => "other" } })).toBeUndefined();
			rmSync(root, { recursive: true, force: true });
			rmSync(plain, { recursive: true, force: true });
		} finally {
			if (ambient === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = ambient;
		}
	});

	test("a live session keeps its auto-pin; a concurrent session in another checkout does not overwrite it", async () => {
		const a = mkdtempSync(join(tmpdir(), "beads-pin-a-"));
		const b = mkdtempSync(join(tmpdir(), "beads-pin-b-"));
		const c = mkdtempSync(join(tmpdir(), "beads-pin-c-"));
		const aWorktree = `${a}-wt`;
		const originalPath = process.env.PATH;
		const originalBeads = process.env.BEADS_DIR;
		try {
			mkdirSync(join(a, ".beads"));
			mkdirSync(join(b, ".beads"));
			const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
			execFileSync("git", ["-C", a, "init", "-q"]);
			writeFileSync(join(a, "f"), "f");
			execFileSync("git", ["-C", a, "-c", "user.email=t@t", "-c", "user.name=t", "add", "f"]);
			execFileSync("git", ["-C", a, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "f"]);
			execFileSync("git", ["-C", a, "worktree", "add", "-q", aWorktree, "-b", "wt"]);
			execFileSync("git", ["-C", b, "init", "-q"]);
			process.env.PATH = `/nonexistent:${originalPath ?? ""}`; // git resolves; bd does not
			delete process.env.BEADS_DIR;
			// Read through a call: `delete process.env.BEADS_DIR` above narrows the
			// property to `undefined`, and TS cannot see the handlers re-setting it.
			const pinned = () => process.env.BEADS_DIR;
			const { handlers, logged } = wire();
			const start = handlers.session_start![0]!;
			const stop = handlers.session_shutdown![0]!;
			const call = handlers.tool_call![0]!;
			const ctx = (cwd: string, id: string) => ({ cwd, sessionManager: { getSessionId: () => id } });
			await start({}, ctx(a, "alpha"));
			expect(pinned()).toBe(join(a, ".beads"));
			expect(await call({ toolName: "bash", toolCallId: "foreign", input: { command: "bd list", cwd: b } }, ctx(a, "alpha"))).toBeUndefined();
			expect(pinnedBeadsDir(await call({ toolName: "bash", toolCallId: "worktree", input: { command: "bd list", cwd: aWorktree } }, ctx(a, "alpha")))).toBe(join(a, ".beads"));
			await start({}, ctx(b, "beta")); // concurrent session in an unrelated checkout
			expect(pinned()).toBe(join(a, ".beads")); // alpha's live pin is not overwritten under it
			expect(logged.some((m) => m.includes("another repository's beads database"))).toBe(true); // beta is told to pin per call
			await start({}, ctx(aWorktree, "delta")); // same repository as alpha: shares the pin
			await start({}, ctx(a, "alpha")); // owner restarts: delta must not be forgotten
			stop({}, ctx(a, "alpha"));
			expect(pinned()).toBe(join(a, ".beads")); // delta keeps it alive after alpha ends
			stop({}, ctx(aWorktree, "delta"));
			expect(pinned()).toBeUndefined(); // released with the last same-repo session
			await start({}, ctx(b, "beta"));
			expect(pinned()).toBe(join(b, ".beads"));
			stop({}, ctx(b, "beta"));
			await start({}, ctx(c, "gamma"));
			expect(pinned()).toBeUndefined(); // c has no database: nothing inherited
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			for (const dir of [a, aWorktree, b, c]) rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000); // creates a git worktree and runs several session_start hooks; slow under full-suite load

	test("session start accepts bd's null empty-list response", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-empty-gates-"));
		const originalPath = process.env.PATH;
		const originalBeads = process.env.BEADS_DIR;
		try {
			mkdirSync(join(dir, ".beads"));
			writeFileSync(join(dir, "bd"), `#!/bin/sh
printf '%s\\n' '{"data":null,"schema_version":1}'
`);
			chmodSync(join(dir, "bd"), 0o755);
			process.env.PATH = `${dir}:${originalPath ?? ""}`;
			delete process.env.BEADS_DIR;
			const { handlers, logged } = wire();
			await handlers.session_start![0]!({}, { cwd: dir });
			expect(logged).toEqual([]);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("session start warns when the gate list is malformed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-malformed-gates-"));
		const originalPath = process.env.PATH;
		const originalBeads = process.env.BEADS_DIR;
		try {
			mkdirSync(join(dir, ".beads"));
			writeFileSync(join(dir, "bd"), `#!/bin/sh
printf '%s\\n' '{"data":[{"id":"bd-bad"}],"schema_version":1}'
`);
			chmodSync(join(dir, "bd"), 0o755);
			process.env.PATH = `${dir}:${originalPath ?? ""}`;
			delete process.env.BEADS_DIR;
			const { handlers, logged } = wire();
			await handlers.session_start![0]!({}, { cwd: dir });
			expect(logged).toEqual(["Beads gate list returned malformed data; unresolved gates remain unverified."]);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			rmSync(dir, { recursive: true, force: true });
		}
	});



	test("session isolation preserves sibling notices, claims and repeated starts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-session-isolation-"));
		const originalPath = process.env.PATH;
		const originalBeads = process.env.BEADS_DIR;
		const originalActor = process.env.BEADS_ACTOR;
		try {
			mkdirSync(join(dir, ".beads"));
			writeFileSync(join(dir, "bd"), `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/calls'
case "$1" in
gate) printf '%s\\n' '[{"id":"bd-human","status":"open","await_type":"human"}]' ;;
list) printf '%s\\n' '[{"id":"bd-alpha","status":"in_progress"},{"id":"bd-beta","status":"in_progress"}]' ;;
*) printf '%s\\n' 'unexpected memory replay' ;;
esac
`);
			chmodSync(join(dir, "bd"), 0o755);
			process.env.PATH = `${dir}:${originalPath ?? ""}`;
			delete process.env.BEADS_DIR;
			delete process.env.BEADS_ACTOR;
			const { handlers, logged } = wire();
			const context = (id: string, cwd = dir) => ({ cwd, sessionManager: { getSessionId: () => id } });
			const invoke = async (name: string, id: string, event: unknown = {}, cwd = dir) =>
				await handlers[name]?.[0]?.(event, context(id, cwd)) as { additionalContext?: string; content?: unknown[] } | undefined;
			const mutation = (id: string) => ({
				toolName: "bash", isError: true,
				input: { command: `bd update bd-${id} --claim && false` },
				content: [{ type: "text", text: "Imported 3 issues (2 stale skipped)" }],
			});

			await invoke("session_start", "alpha", {}, join(dir, "absent"));
			await invoke("session_start", "beta");
			await invoke("session_start", "alpha");
			expect(logged.filter(text => text.includes("bd-human"))).toHaveLength(2);
			expect(logged.some(text => text.includes("unexpected memory replay"))).toBe(false);
			await invoke("auto_compaction_end", "alpha");
			expect(logged.some(text => text.includes("unexpected memory replay"))).toBe(false);
			expect(readFileSync(join(dir, "calls"), "utf8")).not.toMatch(/prime|memories|remember|forget/);

			expect((await invoke("tool_result", "alpha", mutation("alpha")))?.content).toBeDefined();
			expect(await invoke("tool_result", "alpha", mutation("alpha"))).toBeUndefined();
			expect(await invoke("session_stop", "beta")).toBeUndefined();
			expect((await invoke("tool_result", "beta", mutation("beta")))?.content).toBeDefined();
			const alpha = await invoke("session_stop", "alpha");
			expect(alpha?.additionalContext).toContain("bd-alpha");
			expect(alpha?.additionalContext).not.toContain("bd-beta");
			const beta = await invoke("session_stop", "beta");
			expect(beta?.additionalContext).toContain("bd-beta");
			expect(beta?.additionalContext).not.toContain("bd-alpha");
			expect(await invoke("session_stop", "alpha")).toBeUndefined();
			await invoke("turn_start", "beta");
			expect(await invoke("session_stop", "alpha")).toBeUndefined();
			expect((await invoke("session_stop", "beta"))?.additionalContext).toContain("bd-beta");

			await invoke("session_start", "alpha", {}, join(dir, "absent"));
			expect(await invoke("session_stop", "alpha")).toBeUndefined();
			expect((await invoke("tool_result", "alpha", mutation("beta")))?.content).toBeDefined();
			const restarted = await invoke("session_stop", "alpha");
			expect(restarted?.additionalContext).toContain("bd-beta");
			expect(restarted?.additionalContext).not.toContain("bd-alpha");
			await invoke("session_shutdown", "alpha");
			expect(await invoke("session_stop", "alpha")).toBeUndefined();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			if (originalActor === undefined) delete process.env.BEADS_ACTOR;
			else process.env.BEADS_ACTOR = originalActor;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("tracks tool-level BD_ACTOR for ready --claim without a bead id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-actor-alias-"));
		const originalPath = process.env.PATH;
		const originalBeads = process.env.BEADS_DIR;
		const originalBeadsActor = process.env.BEADS_ACTOR;
		const originalBdActor = process.env.BD_ACTOR;
		try {
			mkdirSync(join(dir, ".beads"));
			writeFileSync(join(dir, "bd"), `#!/bin/sh
case "$1" in
list) printf '%s\\n' '[{"id":"bd-owned","title":"owned claim","status":"in_progress","assignee":"omp/Main/alias"}]' ;;
*) printf '%s\\n' '[]' ;;
esac
`);
			chmodSync(join(dir, "bd"), 0o755);
			process.env.PATH = `${dir}:${originalPath ?? ""}`;
			delete process.env.BEADS_DIR;
			delete process.env.BEADS_ACTOR;
			delete process.env.BD_ACTOR;
			const { handlers } = wire();
			const toolResult = handlers.tool_result?.[0];
			const sessionStop = handlers.session_stop?.[0];
			if (toolResult === undefined || sessionStop === undefined) throw new Error("lifecycle handlers were not registered");
			toolResult({
				toolName: "bash",
				toolCallId: "alias-claim",
				isError: false,
				input: { command: "bd ready --claim", env: { BD_ACTOR: "omp/Main/alias" } },
				content: [{ type: "text", text: "claimed" }],
			}, { cwd: dir });

			const advisory = await sessionStop({}, { cwd: dir }) as { additionalContext?: string };
			expect(advisory.additionalContext).toContain("bd-owned [omp/Main/alias] owned claim");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			if (originalBeadsActor === undefined) delete process.env.BEADS_ACTOR;
			else process.env.BEADS_ACTOR = originalBeadsActor;
			if (originalBdActor === undefined) delete process.env.BD_ACTOR;
			else process.env.BD_ACTOR = originalBdActor;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a stale-skip import result is advised in band, once", () => {
		const { handlers } = wire();
		const result = (text: string, id: string) =>
			handlers.tool_result![0]!(
				{
					toolName: "bash",
					toolCallId: id,
					isError: false,
					input: { command: "bd import .beads/issues.jsonl" },
					content: [{ type: "text", text }],
				},
				{ cwd: "/repo" },
			);

		const stale = "Imported 3 issues from .beads/issues.jsonl (2 stale skipped; use --allow-stale)";
		const patched = result(stale, "c1") as { content: Array<{ text: string }> };
		expect(patched.content[0]!.text).toContain("BEHIND this database");
		expect(patched.content[1]!.text).toBe(stale);
		expect(result(stale, "c2")).toBeUndefined();
	});

	test("a non-bd command is ignored", () => {
		const { handlers } = wire();
		expect(
			handlers.tool_result![0]!(
				{ toolName: "bash", toolCallId: "c1", isError: false, input: { command: "git status" }, content: [] },
				{ cwd: "/repo" },
			),
		).toBeUndefined();
	});
	test("session close stays silent until a bd write lands", async () => {
		const originalBeads = process.env.BEADS_DIR;
		process.env.BEADS_DIR = "/nonexistent-beads-dir";
		try {
			const { handlers } = wire();
			// No write recorded yet: the stop hook must not even reach the database.
			expect(await handlers.session_stop![0]!({}, { cwd: "/nonexistent-repo" })).toBeUndefined();

			handlers.tool_result![0]!({
				toolName: "bash",
				toolCallId: "c1",
				isError: false,
				input: { command: "bd update bd-probe-2m7 --claim" },
				content: [{ type: "text", text: "claimed" }],
			}, { cwd: "/repo" });
			// A write landed, but the cwd is not a beads repo, so there is nothing to read.
			expect(await handlers.session_stop![0]!({}, { cwd: "/nonexistent-repo" })).toBeUndefined();
		} finally {
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
		}
	});

	test("a non-beads cwd produces no session-start message", async () => {
		const originalBeads = process.env.BEADS_DIR;
		process.env.BEADS_DIR = "/nonexistent-beads-dir";
		try {
			const { handlers, logged } = wire();
			await handlers.session_start![0]!({}, { cwd: "/nonexistent-repo" });
			expect(logged).toEqual([]);
		} finally {
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
		}
	});


	test("registered stop emits per-bead CAS commands only when help advertises support", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-release-cas-"));
		const originalPath = process.env.PATH;
		const originalBeadsActor = process.env.BEADS_ACTOR;
		const originalBdActor = process.env.BD_ACTOR;
		try {
			mkdirSync(join(dir, ".beads"));
			writeFileSync(join(dir, "bd"), `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/calls'
if [ "$1" = update ] && [ "$2" = --help ]; then printf '%s\\n' 'Usage: bd update [--if-assignee HOLDER]'; exit 0; fi
if [ "$1" = list ]; then printf '%s\\n' '[{"id":"bd-a-1","title":"a","status":"in_progress","assignee":"actor/a"},{"id":"bd-b-2","title":"b","status":"in_progress","assignee":"actor/b"}]'; exit 0; fi
printf '%s\\n' '[]'
`);
			chmodSync(join(dir, "bd"), 0o755);
			process.env.PATH = `${dir}:${originalPath ?? ""}`;
			// Ambient identities must not leak into the generated release command.
			process.env.BEADS_ACTOR = "ambient/canonical";
			process.env.BD_ACTOR = "ambient/legacy";
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "release-cas" } };
			handlers.tool_result?.[0]?.({ toolName: "bash", toolCallId: "a", isError: false, input: { command: "bd ready --claim", env: { BD_ACTOR: "actor/a" } }, content: [] }, ctx);
			handlers.tool_result?.[0]?.({ toolName: "bash", toolCallId: "b", isError: false, input: { command: "bd ready --claim", env: { BD_ACTOR: "actor/b" } }, content: [] }, ctx);
			const sessionStop = handlers.session_stop?.[0];
			if (sessionStop === undefined) throw new Error("session stop handler was not registered");
			const result = await sessionStop({}, ctx) as { additionalContext: string };
			expect(result.additionalContext).toContain("BEADS_ACTOR='actor/a' BD_ACTOR='actor/a' 'bd'");
			expect(result.additionalContext).toContain("BEADS_ACTOR='actor/b' BD_ACTOR='actor/b' 'bd'");
			expect(result.additionalContext).toContain("'release_actor=actor/a'");
			expect(result.additionalContext).toContain("'release_actor=actor/b'");
			expect(result.additionalContext).toContain("'released_from=actor/a'");
			expect(result.additionalContext).toContain("'released_from=actor/b'");
		expect(result.additionalContext).toContain("'--if-assignee' 'actor/a'");
			expect(result.additionalContext).toContain("'--if-assignee' 'actor/b'");
			expect(result.additionalContext).not.toContain("<actor>");
			expect(result.additionalContext).not.toContain("<current-assignee>");
			const commands = readFileSync(join(dir, "calls"), "utf8").split("\\n");
			expect(commands.filter(line => line.includes("update --help"))).toHaveLength(1);
			const timestamps = [...(result.additionalContext.matchAll(/released_at=([^']+)/g))].map(match => match[1]);
			expect(new Set(timestamps).size).toBe(1);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeadsActor === undefined) delete process.env.BEADS_ACTOR;
			else process.env.BEADS_ACTOR = originalBeadsActor;
			if (originalBdActor === undefined) delete process.env.BD_ACTOR;
			else process.env.BD_ACTOR = originalBdActor;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("registered stop emits a readback-verified release when CAS is unavailable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-release-stable-"));
		const originalPath = process.env.PATH;
		try {
			mkdirSync(join(dir, ".beads"));
			writeFileSync(join(dir, "bd"), `#!/bin/sh
		if [ "$1" = update ] && [ "$2" = --help ]; then printf '%s\\n' 'Usage: bd update [--status STATUS]'; exit 0; fi
		if [ "$1" = list ]; then printf '%s\\n' '[{"id":"bd-stable-1","title":"stable","status":"in_progress","assignee":"actor/a"}]'; exit 0; fi
		printf '%s\\n' '[]'
		`);
			chmodSync(join(dir, "bd"), 0o755);
			process.env.PATH = `${dir}:${originalPath ?? ""}`;
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "release-stable" } };
			const toolResult = handlers.tool_result?.[0];
			const sessionStop = handlers.session_stop?.[0];
			if (toolResult === undefined || sessionStop === undefined) throw new Error("lifecycle handlers were not registered");
			toolResult({ toolName: "bash", toolCallId: "stable", isError: false, input: { command: "bd update bd-stable-1 --claim", env: { BD_ACTOR: "actor/a" } }, content: [] }, ctx);
			const stable = await sessionStop({}, ctx) as { additionalContext?: string };
			expect(stable.additionalContext).toContain("Release with:");
			expect(stable.additionalContext).not.toContain("does not advertise atomic");
			expect(stable.additionalContext).toContain("Then verify: bd show <id> --json must show no assignee.");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
