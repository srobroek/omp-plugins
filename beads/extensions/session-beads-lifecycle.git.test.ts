import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bashGates from "./bash-gates.ts";
import sessionBeadsLifecycle, {
	admitBdMutation,
	admitBeadsWork,
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
  settleBackgroundWorkForTests,
  staleSkipNotice,
} from "./session-beads-lifecycle.ts";

const inheritedLifecycleEnv = {
	BEADS_DIR: process.env.BEADS_DIR,
	BEADS_ACTOR: process.env.BEADS_ACTOR,
	BD_ACTOR: process.env.BD_ACTOR,
};
const restoreLifecycleEnv = (key: keyof typeof inheritedLifecycleEnv): void => {
	const value = inheritedLifecycleEnv[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
};
beforeAll(() => {
	delete process.env.BEADS_DIR;
	delete process.env.BEADS_ACTOR;
	delete process.env.BD_ACTOR;
});
afterAll(() => {
	restoreLifecycleEnv("BEADS_DIR");
	restoreLifecycleEnv("BEADS_ACTOR");
	restoreLifecycleEnv("BD_ACTOR");
});


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
	}, 60_000); // measured at about 20s under full-suite load; retain 3x headroom for Git setup and cleanup

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
	}, 60_000); // measured at about 20s under full-suite load; retain 3x headroom for Git setup and cleanup
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

	test("a dangling linked-worktree server-mode store stays unpinned when Git identity is unknown", () => {
		const plain = mkdtempSync(join(tmpdir(), "beads-unreadable-server-"));
		writeFileSync(join(plain, ".git"), "gitdir: /missing");
		mkdirSync(join(plain, ".beads"));
		writeFileSync(join(plain, ".beads", "config.yaml"), "dolt_mode: server\nshared_server: true\n");
		const env: NodeJS.ProcessEnv = {};
		const state: { pinned?: string; owner?: string; ownerRepo?: string } = {};
		expect(repoIdentity(plain)).toBeUndefined();
		expect(sessionPinFor(plain)).toBeUndefined();
		expect(autoPinBeadsDir(plain, "dangling", () => false, env, state, repoIdentity)).toEqual({});
		expect(env.BEADS_DIR).toBeUndefined();
		rmSync(plain, { recursive: true, force: true });
	});

test("pins plain bd calls in command text and leaves non-bd calls alone", () => {
	const pin = "/repo/.beads";
	const prefix = `BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${pin}' `;
	expect(pinBashInput({ command: "bd list" }, pin)).toEqual({ command: `${prefix}bd list` });
	expect(pinBashInput({ command: "cd x && bd show a | jq ." }, pin)).toEqual({ command: `cd x && ${prefix}bd show a | jq .` });
	expect(pinBashInput({ command: "bd list && bd show a" }, pin)).toEqual({ command: `${prefix}bd list && ${prefix}bd show a` });
	expect(pinBashInput({ command: "echo done" }, pin)).toBeUndefined();
});

test("uses export fallback when shell parsing cannot place bd", () => {
	const pin = "/repo/.beads";
	const expected = `export BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${pin}';\n`;
	expect(pinBashInput({ command: "if true; then bd list; fi" }, pin)).toEqual({ command: `${expected}if true; then bd list; fi` });
	expect(pinBashInput({ command: "timeout 10 bd list" }, pin)).toEqual({ command: `${expected}timeout 10 bd list` });
	expect(pinBashInput({ command: "echo bd list" }, pin)).toBeUndefined();
});

test("uses an export fallback for command substitutions", () => {
	const pin = "/repo/.beads";
	expect(pinBashInput({ command: "printf '%s' \"$(bd list)\"" }, pin)).toEqual({
		command: `export BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${pin}';\nprintf '%s' "$(bd list)"`,
	});
});

test("leaves explicit command-local and env-unset routing alone", () => {
	expect(pinBashInput({ command: "BEADS_DIR='/mine/.beads' bd list" }, "/repo/.beads")).toBeUndefined();
	expect(pinBashInput({ command: "env -u BEADS_DIR bd list" }, "/repo/.beads")).toBeUndefined();
	expect(pinBashInput({ command: "bd list", env: { BEADS_DIR: "/mine/.beads" } }, "/repo/.beads")).toBeUndefined();
});

test("keeps env merging for named services only", () => {
	expect(pinBashInput({ command: "bd list", name: "bd-read", env: { A: "1" } }, "/repo/.beads")).toEqual({
		command: "bd list",
		name: "bd-read",
		env: { A: "1", BEADS_DOLT_SHARED_SERVER: "", BEADS_DIR: "/repo/.beads" },
	});
	expect(pinBashInput({ command: "bd list", env: { A: "1" } }, "/repo/.beads")).toEqual({ command: `BEADS_DOLT_SHARED_SERVER= BEADS_DIR='/repo/.beads' bd list`, env: { A: "1" } });
	expect(pinBashInput({ command: "bd list", env: "nope" }, "/repo/.beads")).toBeUndefined();
});

test("shell-quotes pin paths containing spaces and quotes", () => {
	const pin = "/repo/with spaces/it's beads";
	expect(pinBashInput({ command: "bd list" }, pin)).toEqual({ command: "BEADS_DOLT_SHARED_SERVER= BEADS_DIR='/repo/with spaces/it'\\''s beads' bd list" });
});

});
describe("lifecycleBdEnvironment", () => {
	test("sets embedded-store safety flags without inheriting a foreign store or shared-server mode", () => {
		const cwd = mkdtempSync(join(tmpdir(), "beads-lifecycle-env-"));
		mkdirSync(join(cwd, ".beads"));
		try {
			const env = lifecycleBdEnvironment(cwd, { BEADS_DIR: "/foreign/.beads", BEADS_DOLT_SHARED_SERVER: "true" });
			expect(env.BEADS_DIR).not.toBe("/foreign/.beads");
			expect(env.BEADS_DIR).toBe(join(cwd, ".beads"));
			expect(env.BD_NO_PAGER).toBe("1");
			expect(env.BD_NON_INTERACTIVE).toBe("1");
			expect(env.BD_DOLT_AUTO_START).toBe("false");
			expect(env.NO_COLOR).toBe("1");
			expect(env.BEADS_DOLT_SHARED_SERVER).toBe("");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});

/**
 * The real `bd`, not a fabricated script: the scratch-isolation test below runs the documented probe
 * recipe end to end. Every other shell-out in this file writes its own `bd` onto PATH, so this is the
 * one test that needs the binary -- it skips cleanly where there is none. Resolved rather than
 * executed: `bd --version` on the embedded store costs tens of seconds under load, and a probe that
 * timed out would silently skip the test on a machine that does have `bd`.
 */
const BD_ON_PATH = Bun.which("bd") !== null;

describe("scratch store isolation", () => {
	/**
	 * beads/skills/build-formula/references/verify.md documents a throwaway workspace for pouring a
	 * formula. The recipe used to `cd` into /tmp and run a bare `bd init`, and under a session pin
	 * `bd` resolves BEADS_DIR rather than the working directory -- so the probe wrote the live project
	 * store. `cd` is not isolation; only the environment is. The invariant pinned here: a probe run
	 * through the documented form never mutates the store the ambient pin names.
	 *
	 * Both stores are temporary. This test never names this repository's own `.beads`.
	 */
	test.skipIf(!BD_ON_PATH)("a probe run the documented way writes its own store, never the ambient pin", () => {
		const probeTitle = "scratch pour probe";
		const baselineTitle = "pinned baseline";
		const pinned = mkdtempSync(join(tmpdir(), "beads-scratch-pinned-")); // stands in for a live project store
		const scratch = mkdtempSync(join(tmpdir(), "beads-scratch-probe-"));
		const pinnedStore = join(pinned, ".beads");
		const scratchStore = join(scratch, ".beads");
		// An actor survives the isolation on purpose: `bd create` without one is rejected, so a probe
		// cannot isolate itself by wiping the environment. Only the store is overridden.
		const ambient: NodeJS.ProcessEnv = {
			...process.env,
			BEADS_DIR: pinnedStore,
			BD_ACTOR: "scratch-probe",
			BEADS_ACTOR: "scratch-probe",
			BD_NON_INTERACTIVE: "1",
			BD_NO_PAGER: "1",
			BD_DOLT_AUTO_START: "false",
			NO_COLOR: "1",
		};
		const scratchEnv: NodeJS.ProcessEnv = {
			...ambient,
			BEADS_DIR: scratchStore, // the whole fix: every probe call names its own store
		};
		const bd = (env: NodeJS.ProcessEnv, cwd: string, args: string[]): string => {
			const run = spawnSync("bd", args, { cwd, env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
			if (run.status !== 0) throw new Error(`bd ${args.join(" ")} exited ${run.status}: ${run.stderr || run.stdout}`);
			return run.stdout ?? "";
		};
		const titles = (listing: string): string[] => {
			const text = listing.trim();
			if (text === "") return [];
			const parsed: unknown = JSON.parse(text);
			if (!Array.isArray(parsed)) throw new Error(`bd list --json returned no array: ${text.slice(0, 200)}`);
			return parsed.map(row => (row !== null && typeof row === "object" && "title" in row && typeof row.title === "string" ? row.title : ""));
		};
		const listing = ["list", "--all", "--limit", "0", "--json"];
		try {
			execFileSync("git", ["-C", pinned, "init", "-q", "."]);
			execFileSync("git", ["-C", scratch, "init", "-q", "."]);
			mkdirSync(join(scratchStore, "formulas"), { recursive: true }); // the recipe's formula drop-off
			bd(ambient, pinned, ["init", "--init-if-missing", "--skip-hooks"]);
			bd(scratchEnv, scratch, ["init", "--init-if-missing", "--skip-hooks"]);
			bd(ambient, pinned, ["create", baselineTitle, "-t", "task", "--silent"]); // a real record to compare against
			bd(scratchEnv, scratch, ["create", probeTitle, "-t", "task", "--silent"]);
			expect(titles(bd(scratchEnv, scratch, listing))).toEqual([probeTitle]); // the probe landed in its own store
			expect(titles(bd(ambient, pinned, listing))).toEqual([baselineTitle]); // and the pinned store never moved
		} finally {
			rmSync(pinned, { recursive: true, force: true });
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 600_000); // six real bd calls against two embedded stores; each costs tens of seconds under load
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
		expect(readCheckOutcome("Checked 1 gates without JSON")).toBeUndefined();
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

	test("unknown commands stay outside the mutation classifier", () => {
		for (const command of ["bd sql 'update issues set status=open'", "bd sync", "bd reclaim", "bd dolt push"]) {
			expect(isBdWrite(command)).toBe(false);
		}
	});

	test("reads are not writes", () => {
		expect(isBdWrite("bd list --status open --json")).toBe(false);
		expect(isBdWrite("bd ready --unassigned --json")).toBe(false);
		expect(isBdWrite("bd comments bd-probe-2m7")).toBe(false);
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
		// Positional text, which is the form bd 1.2.2 accepts. The fixture used to
		// spell it `-m "note"`, a flag bd rejects, so the suite taught the invalid
		// invocation it was meant to classify.
		expect(isBdWrite('bd comments add x "note"')).toBe(true);
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
describe("formatSessionCloseAdvisory", () => {
	test("names the bead, holder, and native guarded remedy", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined), process.env, undefined, true, new Set(["omp/Main/s1"]));
		expect(text).toContain("bd-probe-2m7 [omp/Main/s1] target work");
		expect(text).toContain("bd 'unclaim'");
		expect(text).toContain("--if-assignee");
		expect(text).not.toContain("'--assignee' '' '--status' 'open'");
		expect(text).toContain('bd comments add <id> "..."');
	});
});

describe("releaseClaimArgs", () => {
	const at = "2026-09-14T12:34:56.789Z";
	const reason = `session release by omp/Main/s2 at ${at}; previous holder omp/Main/s1`;
	test("builds one guarded native unclaim argv with its durable reason", () => {
		expect(releaseClaimArgs("bd-probe-2m7", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at)).toEqual(["unclaim", "bd-probe-2m7", "--reason", reason, "--if-assignee", "omp/Main/s1"]);
	});
	test("refuses to mutate when CAS is unavailable", () => {
		expect(releaseClaimArgs("bd-probe-2m7", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at, false)).toBeUndefined();
	});
	test("prefers BD_ACTOR and falls back to BEADS_ACTOR", () => {
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", { BEADS_ACTOR: "omp/Main/fallback" }, at)?.[3]).toContain("omp/Main/fallback");
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", { BD_ACTOR: " ", BEADS_ACTOR: "omp/Main/fallback" }, at)?.[3]).toContain("omp/Main/fallback");
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/wins", BEADS_ACTOR: "omp/Main/loses" }, at)?.[3]).toContain("omp/Main/wins");
		expect(releaseClaimArgs("bd-a-1", "omp/Main/s1", {}, at)).toBeUndefined();
	});
	test("refuses unsafe identifiers instead of interpolating shell text", () => {
		expect(releaseClaimArgs("bd-a-1;rm", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at)).toBeUndefined();
		expect(releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at)).toContain("--if-assignee");
		expect(releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2" }, at, false)).toBeUndefined();
	});
	test("emits command-local actor and native reason", () => {
		const command = releaseClaimCommand("bd-a-1", "omp/Main/s1", { BD_ACTOR: "omp/Main/s2", BEADS_ACTOR: "omp/Main/ambient" }, at);
		expect(command).toContain("BEADS_ACTOR='omp/Main/s2' BD_ACTOR='omp/Main/s2' bd 'unclaim'");
		expect(command).toContain("'session release by omp/Main/s2");
		expect(command).toContain("'--if-assignee' 'omp/Main/s1'");
	});
});

describe("formatSessionCloseAdvisory actor variants", () => {
	const at = "2026-09-14T12:34:56.789Z";
	test("emits an actor-bound guarded command", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined), { BD_ACTOR: "omp/Main/s1" }, at);
		expect(text).toContain("bd 'unclaim'");
		expect(text).toContain("session release by omp/Main/s1");
		expect(text).toContain("previous holder omp/Main/s1");
		expect(text).toContain("'--if-assignee'");
	});
	test("stays advisory-only when CAS is unavailable", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined), { BD_ACTOR: "omp/Main/s1" }, at, false);
		expect(text).toContain("Release unavailable");
		expect(text).not.toContain("Release with:");
	});
	test("does not release another holder when one actor merely touched the bead", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined), { BD_ACTOR: "omp/Main/releaser" }, at);
		expect(text).toContain("Release unavailable");
	});
	test("fails closed when actor discovery is absent", () => {
		const bead = readBeads(BEAD_LIST)[1];
		if (bead === undefined) throw new Error("fixture must contain a second bead");
		expect(formatSessionCloseAdvisory([bead], {}, at)).toContain("Release unavailable");
	});
	test("a long list is capped and counted", () => {
		const many = Array.from({ length: 11 }, (_, i) => ({ id: `b-${i}`, title: "t", status: "in_progress" }));
		expect(formatSessionCloseAdvisory(many)).toContain("...and 3 more");
	});
});

describe("handleSessionStop", () => {
	test("continues with held claims", () => {
		const r = handleSessionStop({}, BEAD_LIST, new Set(["bd-probe-2m7"]), undefined);
		expect(r?.continue).toBe(true);
		expect(r?.additionalContext).toContain("bd-probe-2m7");
	});
	test("passes the effective actor into guarded native release commands", () => {
		const r = handleSessionStop({}, BEAD_LIST, new Set(["bd-probe-2m7"]), "omp/Main/s1");
		expect(r?.additionalContext).toContain("session release by omp/Main/s1");
		expect(r?.additionalContext).toContain("'--if-assignee'");
	});
	test("skips its own continuation", () => {
		expect(handleSessionStop({ stop_hook_active: true }, BEAD_LIST, new Set(["bd-probe-2m7"]))).toBeUndefined();
		expect(handleSessionStop({ stopHookActive: true }, BEAD_LIST, new Set(["bd-probe-2m7"]))).toBeUndefined();
	});
	test("reports embedded-store read failures without server credential advice", () => {
		const text = handleSessionStop({}, undefined, new Set(), undefined, true, "bd exited with code 1: Error 1045: Access denied")?.additionalContext ?? "";
		expect(text).toContain("could not be read");
		expect(text).not.toContain("shared-server");
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
});


// The lifecycle seam and auto-pin state are process-global; serial cases keep `--concurrent` load from crossing test fixtures.
describe.serial("integration", () => {
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
	/** Extract the `BEADS_DIR` command-local assignment returned for foreground bd calls. */
	const pinnedBeadsDir = (result: unknown): unknown => {
		if (!(result && typeof result === "object" && "input" in result)) throw new Error("the hook did not rewrite the call");
		const { input } = result;
		if (!input || typeof input !== "object") throw new Error("the hook returned malformed input");
		const env = (input as Record<string, unknown>).env;
		if (env && typeof env === "object" && "BEADS_DIR" in env) return (env as Record<string, unknown>).BEADS_DIR;
		const command = (input as Record<string, unknown>).command;
		if (typeof command !== "string") throw new Error("the rewritten call carries no command");
		const match = /BEADS_DIR='([^']*)'/.exec(command);
		if (!match) throw new Error("the rewritten command carries no BEADS_DIR");
		return match[1];
	};
  test.serial("accepts a classified failure from the bd seam", async () => {
    setBdStreamForTests(async () => ({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" }));
    try {
      expect(await runBdResult("/repo", ["list"])).toEqual({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" });
    } finally {
      setBdStreamForTests(null);
    }
  });
	test.serial("dangling server-mode worktree skips session-start bd probes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-dangling-server-start-"));
		writeFileSync(join(dir, ".git"), "gitdir: /missing");
		mkdirSync(join(dir, ".beads"));
		writeFileSync(join(dir, ".beads", "config.yaml"), "dolt_mode: server\nshared_server: true\n");
		let calls = 0;
		setBdStreamForTests(async () => {
			calls++;
			return "unexpected";
		});
		try {
			const { handlers, logged } = wire();
			const start = handlers.session_start?.[0];
			if (start === undefined) throw new Error("session start handler was not registered");
			await start({}, { cwd: dir, sessionManager: { getSessionId: () => "dangling-server-start" } });
			await settleBackgroundWorkForTests();
			expect(calls).toBe(0);
			expect(logged).toEqual(["Beads session-start unverified: repository identity unknown; gate verification was skipped."]);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
  test.serial("session start reports an injected embedded-store failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-fake-start-"));
    mkdirSync(join(dir, ".beads"));
    setBdStreamForTests(async () => ({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" }));
    try {
      const { handlers, logged } = wire();
      const start = handlers.session_start?.[0];
      if (start === undefined) throw new Error("session start handler was not registered");
      await start({}, { cwd: dir });
      // The boundary does not wait for the database, so the failure is reported when the
      // read lands rather than inside the handler's budget.
      expect(logged).toEqual([]);
      await settleBackgroundWorkForTests();
      expect(logged[0]).toContain("Beads gates could not be verified at session start");
    } finally {
      setBdStreamForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.serial("dispatch and a mutating bd command wait for gate verification; a read does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gate-admission-"));
    mkdirSync(join(dir, ".beads"));
    const gates = Promise.withResolvers<string>();
    setBdStreamForTests(async (_cwd, args) => (args[0] === "gate" ? await gates.promise : "[]"));
    try {
      const { handlers } = wire();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "gate-admission" } };
      await handlers.session_start![0]!({}, ctx);

      // A read needs no verdict, so it is never held behind the gate check.
      expect(await admitBdMutation({ command: "bd list", cwd: dir }, ctx as never)).toBeUndefined();

      let claimDecided = false;
      const claim = admitBdMutation({ command: "bd update bd-probe-2m7 --claim", cwd: dir }, ctx as never)
        .then(decision => { claimDecided = true; return decision; });
      let toolDecisions = 0;
      const gatedCalls = [
        { toolName: "task", input: {} },
        { toolName: "bd_formula_check", input: { deep: true, workspace: dir } },
      ].map(call => Promise.resolve(handlers.tool_call![0]!(call, ctx))
        .then((decision: unknown) => { toolDecisions += 1; return decision; }));
      // Nothing but the gate read can advance these, so draining the microtask queue is
      // enough to show neither mutation nor dispatch has been let through.
      await Promise.resolve();
      await Promise.resolve();
      expect(claimDecided).toBe(false);
      expect(toolDecisions).toBe(0);

      gates.resolve(JSON.stringify({ data: null, schema_version: 1 }));
      expect(await claim).toBeUndefined();
      expect(await Promise.all(gatedCalls)).toEqual([undefined, undefined]);
    } finally {
      setBdStreamForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

	test.serial("each gate verification command gets a fresh execution ceiling", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-gate-deadlines-"));
		mkdirSync(join(dir, ".beads"));
		const deadlines: number[] = [];
		let lists = 0;
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		setBdStreamForTests(async (_cwd, args, deadline) => {
			deadlines.push(deadline);
			now += 5;
			if (args[1] === "check") return JSON.stringify({ data: { checked: 1, dry_run: false, errors: 0, escalated: 0, resolved: 1 }, schema_version: 1 });
			return lists++ === 0 ? GATE_LIST : JSON.stringify({ data: [], schema_version: 1 });
		});
		try {
			const { handlers } = wire();
			await handlers.session_start![0]!({}, { cwd: dir, sessionManager: { getSessionId: () => "gate-deadlines" } });
			await settleBackgroundWorkForTests();
			expect(deadlines).toHaveLength(3);
			expect(deadlines[1]!).toBeGreaterThan(deadlines[0]!);
			expect(deadlines[2]!).toBeGreaterThan(deadlines[1]!);
		} finally {
			setBdStreamForTests(null);
			Date.now = originalNow;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("mutation verifies the store selected by BEADS_DIR or a formula workspace", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "beads-gate-session-"));
		const targetDir = mkdtempSync(join(tmpdir(), "beads-gate-target-"));
		const noStoreDir = mkdtempSync(join(tmpdir(), "beads-gate-no-store-"));
		const targetStorePath = join(targetDir, ".beads");
		mkdirSync(join(sessionDir, ".beads"));
		mkdirSync(targetStorePath);
		const targetStore = realpathSync(targetStorePath);
		setBdStreamForTests(async (_cwd, args, _deadline, env) => {
			if (args[0] !== "gate") return "[]";
			const selected = env.BEADS_DIR;
			const targetsStore = typeof selected === "string" && realpathSync(selected) === targetStore;
			return targetsStore
				? { failure: "target store gate read failed" }
				: JSON.stringify({ data: null, schema_version: 1 });
		});
		try {
			const { handlers } = wire();
			const ownerCtx = { cwd: sessionDir, sessionManager: { getSessionId: () => "target-gate-owner" } };
			const conflictCtx = { cwd: targetDir, sessionManager: { getSessionId: () => "target-gate-conflict" } };
			const noStoreCtx = { cwd: noStoreDir, sessionManager: { getSessionId: () => "target-gate-cd" } };
			await handlers.session_start![0]!({}, ownerCtx);
			await handlers.session_start![0]!({}, conflictCtx);
			await handlers.session_start![0]!({}, noStoreCtx);
			await settleBackgroundWorkForTests();
			const explicitRefusal = await admitBdMutation({
				command: "bd update bd-probe-2m7 --claim",
				env: { BEADS_DIR: targetStore },
			}, ownerCtx as never);
			expect(explicitRefusal).toMatchObject({ block: true, reason: expect.stringContaining("target store gate read failed") });
			const rewrittenRefusal = await admitBdMutation({
				command: "bd update bd-probe-2m7 --claim",
			}, conflictCtx as never);
			expect(rewrittenRefusal).toMatchObject({ block: true, reason: expect.stringContaining("target store gate read failed") });
			const directoryRefusal = await admitBdMutation({
				command: `bd -C '${targetDir}' update bd-probe-2m7 --claim`,
			}, ownerCtx as never);
			const prefixedRefusal = await admitBdMutation({
				command: `BEADS_DIR='${targetStore}' bd update bd-probe-2m7 --claim`,
			}, ownerCtx as never);
			expect(prefixedRefusal).toMatchObject({ block: true, reason: expect.stringContaining("target store gate read failed") });
			const dynamicPrefixRefusal = await admitBdMutation({
				command: "BEADS_DIR=$TARGET bd update bd-probe-2m7 --claim",
			}, ownerCtx as never);
			expect(dynamicPrefixRefusal).toMatchObject({ block: true, reason: expect.stringContaining("dynamically") });
			expect(directoryRefusal).toMatchObject({ block: true, reason: expect.stringContaining("target store gate read failed") });
			let settingsCwd: string | undefined;
			const targetScopedRefusal = await admitBdMutation({
				command: `bd -C '${targetDir}' update bd-probe-2m7 --claim`,
			}, ownerCtx as never, cwd => {
				settingsCwd = cwd;
				return true;
			});
			expect(settingsCwd).toBe(realpathSync(targetDir));
			expect(targetScopedRefusal).toMatchObject({ block: true, reason: expect.stringContaining("target store gate read failed") });
			const targetDisabled = await admitBdMutation({
				command: `bd -C '${targetDir}' update bd-probe-2m7 --claim`,
			}, ownerCtx as never, () => false);
			expect(targetDisabled).toBeUndefined();
			const dynamicDirectoryRefusal = await admitBdMutation({
				command: 'cd "$TARGET" && bd update bd-probe-2m7 --claim',
			}, noStoreCtx as never);
			expect(dynamicDirectoryRefusal).toMatchObject({ block: true, reason: expect.stringContaining("cannot resolve") });
			const formulaRefusal = await handlers.tool_call![0]!({
				toolName: "bd_formula_check",
				input: { deep: true, workspace: targetDir },
			}, ownerCtx) as { block?: true; reason?: string } | undefined;
			expect(formulaRefusal).toMatchObject({ block: true, reason: expect.stringContaining("target store gate read failed") });
		} finally {
			setBdStreamForTests(null);
			rmSync(sessionDir, { recursive: true, force: true });
			rmSync(targetDir, { recursive: true, force: true });
			rmSync(noStoreDir, { recursive: true, force: true });
		}
	});

	test.serial("selector-looking positional data still verifies the ambient store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-gate-sentinel-"));
		mkdirSync(join(dir, ".beads"));
		setBdStreamForTests(async () => ({ failure: "ambient store gate read failed" }));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "gate-sentinel" } };
			await handlers.session_start![0]!({}, ctx);
			await settleBackgroundWorkForTests();
			const refusal = await admitBdMutation({
				command: "bd comments add bd-probe-2m7 -- --global",
			}, ctx as never);
			expect(refusal).toMatchObject({ block: true, reason: expect.stringContaining("ambient store gate read failed") });
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

  test.serial("a failed gate check blocks mutation and reports the failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gate-admission-fail-"));
    mkdirSync(join(dir, ".beads"));
    setBdStreamForTests(async () => ({ failure: "bd exited with code 1: Error 1045 (28000): Access denied" }));
    try {
      const { handlers, logged } = wire();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "gate-admission-fail" } };
      await handlers.session_start![0]!({}, ctx);
      await settleBackgroundWorkForTests();
      const refusal = await admitBdMutation({ command: "bd update bd-probe-2m7 --claim", cwd: dir }, ctx as never);
      expect(refusal).toMatchObject({ block: true, reason: expect.stringContaining("could not be verified") });
      expect(logged.join("\n")).toContain("Beads gates could not be verified at session start");
    } finally {
      setBdStreamForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.serial("a malformed gate check blocks mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gate-admission-malformed-"));
    mkdirSync(join(dir, ".beads"));
    setBdStreamForTests(async (_cwd, args) => args[0] === "gate" && args[1] === "list" ? GATE_LIST : "not-json");
    try {
      const { handlers } = wire();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "gate-admission-malformed" } };
      await handlers.session_start![0]!({}, ctx);
      await settleBackgroundWorkForTests();
      const refusal = await admitBdMutation({ command: "bd update bd-probe-2m7 --claim", cwd: dir }, ctx as never);
      expect(refusal).toMatchObject({ block: true, reason: expect.stringContaining("malformed data") });
    } finally {
      setBdStreamForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.serial("a gate check with errors blocks mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gate-admission-errors-"));
    mkdirSync(join(dir, ".beads"));
    const errored = JSON.stringify({ data: { resolved: 0, escalated: 0, errors: 1 }, schema_version: 1 });
    setBdStreamForTests(async (_cwd, args) => args[0] === "gate" && args[1] === "list" ? GATE_LIST : errored);
    try {
      const { handlers } = wire();
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "gate-admission-errors" } };
      await handlers.session_start![0]!({}, ctx);
      await settleBackgroundWorkForTests();
      const refusal = await admitBdMutation({ command: "bd update bd-probe-2m7 --claim", cwd: dir }, ctx as never);
      expect(refusal).toMatchObject({ block: true, reason: expect.stringContaining("reported 1 error") });
    } finally {
      setBdStreamForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

	test.serial("a later admission retries a settled failed gate verification", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-gate-admission-retry-"));
		mkdirSync(join(dir, ".beads"));
		let reads = 0;
		setBdStreamForTests(async (_cwd, args) => {
			if (args[0] !== "gate") return "[]";
			reads += 1;
			return reads < 3
				? { failure: "transient gate read failure" }
				: JSON.stringify({ data: null, schema_version: 1 });
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "gate-admission-retry" } };
			await handlers.session_start![0]!({}, ctx);
			await settleBackgroundWorkForTests();
			const command = { command: "bd update bd-probe-2m7 --claim", cwd: dir };
			expect(await admitBdMutation(command, ctx as never)).toMatchObject({
				block: true,
				reason: expect.stringContaining("transient gate read failure"),
			});
			expect(await admitBdMutation(command, ctx as never)).toBeUndefined();
			expect(reads).toBe(3);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("a completed verdict is consumed before a later dispatch refreshes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-gate-dispatch-refresh-"));
		mkdirSync(join(dir, ".beads"));
		let reads = 0;
		setBdStreamForTests(async (_cwd, args) => {
			if (args[0] === "gate" && args[1] === "list") reads++;
			return JSON.stringify({ data: null, schema_version: 1 });
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "gate-dispatch-refresh" } };
			await handlers.session_start![0]!({}, ctx);
			await settleBackgroundWorkForTests();
			expect(await admitBeadsWork(ctx as never)).toBeUndefined();
			expect(reads).toBe(1);
			expect(await admitBeadsWork(ctx as never)).toBeUndefined();
			expect(reads).toBe(2);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});






	test.serial("slow terminal claim reads are detached and late results are consumed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-agent-end-slow-read-"));
		mkdirSync(join(dir, ".beads"));
		const late = Promise.withResolvers<void>();
		const calls: string[][] = [];
		setBdStreamForTests(async (_cwd, args, _deadline, env) => {
			calls.push(args);
			if (args[0] === "show") {
				await late.promise;
				return { output: JSON.stringify({ data: [{ id: args[1], issue_type: "task", status: "blocked", assignee: env.BD_ACTOR }], schema_version: 1 }) };
			}
			return { output: "unclaimed" };
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "agent-end-slow-read" } };
			handlers.tool_result?.[0]?.({ toolName: "bash", toolCallId: "slow-claim", isError: false, input: { command: `BEADS_ACTOR=actor/slow bd update bd-slow --claim`, cwd: dir, env: { BD_ACTOR: "actor/slow" } }, content: [{ type: "text", text: "Updated issue: bd-slow" }] }, ctx);
			const end = handlers.agent_end?.[0];
			if (end === undefined) throw new Error("agent_end handler was not registered");
			const started = Date.now();
			expect(await end({ willContinue: false, outcome: "completed" }, ctx)).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(500);
			await Promise.resolve();
			expect(calls).toEqual([["show", "bd-slow", "--json"]]);
			late.resolve();
			await settleBackgroundWorkForTests();
			expect(calls).toEqual([
				["show", "bd-slow", "--json"],
				["unclaim", "bd-slow", "--reason", expect.any(String), "--if-assignee", "actor/slow"],
				["update", "bd-slow", "--status", "blocked", "--if-status", "open", "--if-assignee", ""],
			]);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("gate verification uses the two-minute command ceiling", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-gate-ceiling-"));
		mkdirSync(join(dir, ".beads"));
		const deadlines: number[] = [];
		const originalNow = Date.now;
		Date.now = () => 50_000;
		setBdStreamForTests(async (_cwd, _args, deadline) => {
			deadlines.push(deadline);
			return JSON.stringify({ data: null, schema_version: 1 });
		});
		try {
			const { handlers } = wire();
			await handlers.session_start![0]!({}, { cwd: dir, sessionManager: { getSessionId: () => "gate-ceiling" } });
			await settleBackgroundWorkForTests();
			expect(deadlines[0]).toBe(170_000);
		} finally {
			setBdStreamForTests(null);
			Date.now = originalNow;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("session close reports a successful claim without another bd read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-shutdown-budget-"));
		mkdirSync(join(dir, ".beads"));
		let calls = 0;
		setBdStreamForTests(async () => {
			calls++;
			return { failure: "bd command timed out" };
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "cached-close" } };
			handlers.tool_result?.[0]?.({
				toolName: "bash",
				toolCallId: "claim",
				isError: false,
				input: {
					command: `cd ${dir} && BEADS_ACTOR=omp/Main/s1 BD_ACTOR=omp/Main/s1 bd update bd-probe-2m7 --claim`,
					cwd: dir,
					env: { BEADS_ACTOR: "omp/Main/s1", BD_ACTOR: "omp/Main/s1" },
				},
				content: [{ type: "text", text: "Updated issue: bd-probe-2m7" }],
			}, ctx);
			const stop = handlers.session_stop?.[0];
			if (stop === undefined) throw new Error("session stop handler was not registered");
			const result = await stop({}, ctx) as { additionalContext?: string };
			expect(calls).toBe(0);
			expect(result.additionalContext).toContain("bd-probe-2m7");
			expect(result.additionalContext).not.toContain("bd command timed out");
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("quoted and escaped bd claims remain tracked without a ledger read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-quoted-claim-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "quoted-claims" } };
			const result = handlers.tool_result![0]!;
			for (const [command, id] of [
				["BD_ACTOR=actor/a 'bd' update bd-quoted-1 --claim", "bd-quoted-1"],
				["BD_ACTOR=actor/a b\\d update bd-escaped-2 --claim", "bd-escaped-2"],
				["BD_ACTOR=actor/a command 'bd' update bd-command-3 --claim", "bd-command-3"],
			]) {
				result({ toolName: "bash", isError: false, input: { command, cwd: dir }, content: [{ type: "text", text: `Updated issue: ${id}` }] }, ctx);
			}
			const stop = await handlers.session_stop![0]!({}, ctx) as { additionalContext?: string };
			expect(stop.additionalContext).toContain("bd-quoted-1");
			expect(stop.additionalContext).toContain("bd-escaped-2");
			expect(stop.additionalContext).toContain("bd-command-3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("same-id claims retain independent store-bound release commands", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "beads-claim-session-"));
		const targetDir = mkdtempSync(join(tmpdir(), "beads-claim-target-"));
		mkdirSync(join(sessionDir, ".beads"));
		mkdirSync(join(targetDir, ".beads"));
		const sessionStore = realpathSync(join(sessionDir, ".beads"));
		const targetStore = realpathSync(join(targetDir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: sessionDir, sessionManager: { getSessionId: () => "store-bound-claims" } };
			const result = handlers.tool_result![0]!;
			for (const command of [
				`BD_ACTOR=actor/a bd -C '${targetDir}' update bd-same-1 --claim`,
				"BD_ACTOR=actor/a bd update bd-same-1 --claim",
			]) {
				result({ toolName: "bash", isError: false, input: { command, cwd: sessionDir, env: { BEADS_DIR: sessionStore } }, content: [{ type: "text", text: "Updated issue: bd-same-1" }] }, ctx);
			}
			result({ toolName: "bash", isError: false, input: { command: `BD_ACTOR=actor/a bd --db '${targetStore}' update bd-same-1 --claim`, cwd: sessionDir, env: { BEADS_DIR: sessionStore } }, content: [{ type: "text", text: "Updated issue: bd-same-1" }] }, ctx);
			const first = await handlers.session_stop![0]!({}, ctx) as { additionalContext: string };
			expect(first.additionalContext).toContain(`BEADS_DIR='${sessionStore}'`);
			expect(first.additionalContext).toContain(`BEADS_DIR='${targetStore}'`);
			expect(first.additionalContext.split(targetStore).length - 1).toBe(1);
			handlers.turn_start![0]!({}, ctx);
			result({ toolName: "bash", isError: false, input: { command: `BD_ACTOR=actor/a bd --db '${targetStore}' close bd-same-1`, cwd: sessionDir, env: { BEADS_DIR: sessionStore } }, content: [{ type: "text", text: "Closed bd-same-1" }] }, ctx);
			const remaining = await handlers.session_stop![0]!({}, ctx) as { additionalContext: string };
			expect(remaining.additionalContext).toContain(`BEADS_DIR='${sessionStore}'`);
			expect(remaining.additionalContext).not.toContain(`BEADS_DIR='${targetStore}'`);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
			rmSync(targetDir, { recursive: true, force: true });
		}
	});
	test.serial("a failed claim is neither reported nor released", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-failed-claim-"));
		mkdirSync(join(dir, ".beads"));
		let calls = 0;
		setBdStreamForTests(async () => {
			calls++;
			return "unexpected";
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "failed-claim" } };
			handlers.tool_result?.[0]?.({
				toolName: "bash",
				toolCallId: "claim",
				isError: true,
				input: { command: "BD_ACTOR=omp/Main/s1 bd update bd-probe-2m7 --claim", cwd: dir, env: { BD_ACTOR: "omp/Main/s1" } },
				content: [{ type: "text", text: "Command exited with code 1" }],
			}, ctx);
			expect(await handlers.session_stop?.[0]?.({}, ctx)).toBeUndefined();
			await handlers.session_shutdown?.[0]?.({}, ctx);
			expect(calls).toBe(0);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("a masked bd failure cannot clear a tracked claim", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-masked-close-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "masked-close" } };
			const result = handlers.tool_result?.[0];
			result?.({ toolName: "bash", toolCallId: "claim", isError: false, input: { command: "bd update bd-probe-2m7 --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-probe-2m7" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "help-close", isError: false, input: { command: "bd close bd-probe-2m7 --help", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Usage: bd close" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "help-claim", isError: false, input: { command: "bd update bd-help-6h6 --claim --help", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Usage: bd update" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "global-help-close", isError: false, input: { command: "bd --help close bd-probe-2m7", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Usage: bd" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "global-help-claim", isError: false, input: { command: "bd -h update bd-global-help-7h7 --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Usage: bd" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "help-value-claim", isError: false, input: { command: "bd update bd-help-value-8v8 --notes --help --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-help-value-8v8" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "global-value-help-claim", isError: false, input: { command: "bd update bd-global-value-9v9 --mem-profile --help --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-global-value-9v9" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "post-verb-actor-claim", isError: false, input: { command: "bd update bd-post-actor-0a0 --actor=someone/else --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-post-actor-0a0" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "post-verb-actor-assignee", isError: false, input: { command: "bd update bd-post-actor-0a0 --assignee someone/else", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-post-actor-0a0" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "actor-looking-value-claim", isError: false, input: { command: "bd update bd-actor-value-1a1 --notes --actor=someone/else --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-actor-value-1a1" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "actor-consumed-claim", isError: false, input: { command: "bd update bd-actor-consumed-2a2 --actor --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-actor-consumed-2a2" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "notes-consumed-claim", isError: false, input: { command: "bd update bd-notes-consumed-3a3 --notes --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "Updated issue: bd-notes-consumed-3a3" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "masked", isError: false, input: { command: "bd close bd-probe-2m7 || true", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "close failed" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "masked-claim", isError: false, input: { command: "bd update bd-false-9z9 --claim || true", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "claim failed" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "background-claim", isError: false, input: { command: "BD_ACTOR=omp/Main/s1 bd update bd-background-8q8 --claim &", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "backgrounded" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "skipped-close", isError: false, input: { command: "true || bd close bd-probe-2m7", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "skipped-claim", isError: false, input: { command: "true || bd update bd-skipped-7w7 --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "substitution-close", isError: false, input: { command: "echo $(BD_ACTOR=omp/Main/s1 bd close bd-probe-2m7)", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "heredoc-close", isError: false, input: { command: "cat <<EOF\nbd close bd-probe-2m7\nEOF", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "bd close bd-probe-2m7\n" }] }, ctx);
			const advisory = await handlers.session_stop?.[0]?.({}, ctx) as { additionalContext?: string } | undefined;
			expect(advisory?.additionalContext).toContain("bd-probe-2m7");
			expect(advisory?.additionalContext).not.toContain("bd-false-9z9");
			expect(advisory?.additionalContext).not.toContain("bd-background-8q8");
			expect(advisory?.additionalContext).not.toContain("bd-skipped-7w7");
			expect(advisory?.additionalContext).not.toContain("bd-help-6h6");
			expect(advisory?.additionalContext).not.toContain("bd-global-help-7h7");
			expect(advisory?.additionalContext).toContain("bd-help-value-8v8");
			expect(advisory?.additionalContext).toContain("bd-global-value-9v9");
			expect(advisory?.additionalContext).toContain("bd-post-actor-0a0 [someone/else]");
			expect(advisory?.additionalContext).toContain("BEADS_ACTOR='someone/else' BD_ACTOR='someone/else' bd");
			expect(advisory?.additionalContext).toContain("bd-actor-value-1a1");
			expect(advisory?.additionalContext).not.toContain("bd-actor-consumed-2a2");
			expect(advisory?.additionalContext).not.toContain("bd-notes-consumed-3a3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("tracks boolean claim flags and structured claim stdout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-claim-spellings-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "claim-spellings" } };
			const result = handlers.tool_result?.[0];
			for (const command of ["bd update bd-true-1 --claim=true", "bd update bd-one-1 --claim=1", "bd update bd-multi-1 bd-multi-2 --claim"]) {
				result?.({ toolName: "bash", toolCallId: command, isError: false, input: { command, env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "updated" }] }, ctx);
			}
			result?.({ toolName: "bash", toolCallId: "ready", isError: false, input: { command: "bd ready --claim", env: { BD_ACTOR: "omp/Main/s1" } }, content: [{ type: "text", text: "output spilled" }], details: { exitCode: 0, stdout: '{"id":"orc-e2e-3ef.1.1"}' } }, ctx);
			const advisory = await handlers.session_stop?.[0]?.({}, ctx) as { additionalContext?: string } | undefined;
			expect(advisory?.additionalContext).toContain("bd-true-1");
			expect(advisory?.additionalContext).toContain("bd-one-1");
			expect(advisory?.additionalContext).toContain("bd-multi-1");
			expect(advisory?.additionalContext).toContain("bd-multi-2");
			expect(advisory?.additionalContext).toContain("orc-e2e-3ef.1.1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("tracks direct assignment to a session actor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-direct-assign-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "direct-assign" } };
			handlers.tool_result?.[0]?.({
				toolName: "bash",
				toolCallId: "assign",
				isError: false,
				input: { command: "BD_ACTOR=omp/Main/s1 bd assign bd-assigned-1 omp/Main/s1", env: { BD_ACTOR: "omp/Main/s1" } },
				content: [{ type: "text", text: "Assigned bd-assigned-1 to omp/Main/s1" }],
			}, ctx);
			const advisory = await handlers.session_stop?.[0]?.({}, ctx) as { additionalContext?: string } | undefined;
			expect(advisory?.additionalContext).toContain("bd-assigned-1 [omp/Main/s1]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("compound claims retain each invocation's actor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-compound-actors-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "compound-actors" } };
			handlers.tool_result?.[0]?.({
				toolName: "bash", toolCallId: "claims", isError: false,
				input: { command: "BD_ACTOR=actor/a bd update bd-a-1 --claim; BD_ACTOR=actor/b bd update bd-b-2 --claim", env: {} },
				content: [{ type: "text", text: "Claimed bd-a-1\nClaimed bd-b-2" }],
			}, ctx);
			const advisory = await handlers.session_stop?.[0]?.({}, ctx) as { additionalContext?: string } | undefined;
			expect(advisory?.additionalContext).toContain("bd-a-1 [actor/a]");
			expect(advisory?.additionalContext).toContain("bd-b-2 [actor/b]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("ambiguous compound claims retain the id without guessing an actor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-ambiguous-actor-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "ambiguous-actor" } };
			handlers.tool_result?.[0]?.({
				toolName: "bash", toolCallId: "ambiguous-claim", isError: false,
				input: { command: "BD_ACTOR=actor/a bd update bd-x-1 --claim; BD_ACTOR=actor/b bd update bd-x-1 --claim || true", env: {} },
				content: [{ type: "text", text: "Claimed bd-x-1" }],
			}, ctx);
			const advisory = await handlers.session_stop?.[0]?.({}, ctx) as { additionalContext?: string } | undefined;
			expect(advisory?.additionalContext).toContain("- bd-x-1 claim recorded by this session");
			expect(advisory?.additionalContext).toContain("Release unavailable: the effective actor is missing or ambiguous");
			expect(advisory?.additionalContext).not.toContain("bd-x-1 [actor/");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("multi-ID updates honor short status and assignee flags", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-multi-update-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "multi-update" } };
			const result = handlers.tool_result?.[0];
			for (const id of ["bd-a-1", "bd-b-2", "bd-c-3", "bd-d-4"]) {
				result?.({ toolName: "bash", toolCallId: `claim-${id}`, isError: false, input: { command: `bd update ${id} --claim`, env: { BD_ACTOR: "actor/a" } }, content: [{ type: "text", text: "updated" }] }, ctx);
			}
			result?.({ toolName: "bash", toolCallId: "release", isError: false, input: { command: "bd update -a '' bd-a-1 bd-b-2", env: { BD_ACTOR: "actor/a" } }, content: [{ type: "text", text: "updated" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "close", isError: false, input: { command: "bd update bd-c-3 bd-d-4 -s closed", env: { BD_ACTOR: "actor/a" } }, content: [{ type: "text", text: "updated" }] }, ctx);
			expect(await handlers.session_stop?.[0]?.({}, ctx)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("unknown update options cannot consume tracked claim IDs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-ambiguous-update-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "ambiguous-update" } };
			const result = handlers.tool_result?.[0];
			for (const id of ["bd-a-1", "bd-b-2"]) {
				result?.({ toolName: "bash", toolCallId: `claim-${id}`, isError: false, input: { command: `bd update ${id} --claim`, env: { BD_ACTOR: "actor/a" } }, content: [{ type: "text", text: "updated" }] }, ctx);
			}
			result?.({ toolName: "bash", toolCallId: "ambiguous", isError: false, input: { command: "bd update bd-a-1 --assignee '' --status open --set-metadata release_actor=actor/a --set-metadata released_at=2026-09-22T18:00:00.000Z --set-metadata released_from=actor/a --if-assignee actor/a --spec-id bd-b-2", env: { BD_ACTOR: "actor/a" } }, content: [{ type: "text", text: "updated" }] }, ctx);
			const advisory = await handlers.session_stop?.[0]?.({}, ctx) as { additionalContext?: string } | undefined;
			expect(advisory?.additionalContext).not.toContain("bd-a-1");
			expect(advisory?.additionalContext).toContain("bd-b-2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("compound JSON from a no-ID claim is not attributed as claim evidence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-ambiguous-output-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "ambiguous-output" } };
			handlers.tool_result?.[0]?.({
				toolName: "bash", toolCallId: "compound", isError: false,
				input: { command: "BD_ACTOR=actor/a bd ready --claim --json; bd show bd-other-1 --json", env: {} },
				content: [{ type: "text", text: '{"id":"bd-claimed-1"}\n{"id":"bd-other-1"}' }],
			}, ctx);
			expect(await handlers.session_stop?.[0]?.({}, ctx)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("session close forgets claims that the session closed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-close-cleared-claim-"));
		mkdirSync(join(dir, ".beads"));
		let calls = 0;
		setBdStreamForTests(async () => {
			calls++;
			return { failure: "bd command timed out" };
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "cleared-close" } };
			const result = handlers.tool_result?.[0];
			const input = (command: string) => ({
				toolName: "bash",
				toolCallId: command,
				isError: false,
				input: { command, cwd: dir, env: { BD_ACTOR: "omp/Main/s1" } },
				content: [{ type: "text", text: "command succeeded" }],
			});
			result?.(input("BD_ACTOR=omp/Main/s1 bd update bd-probe-2m7.1.1 --claim"), ctx);
			result?.(input("BD_ACTOR=omp/Main/s1 bd update bd-other-4k2 --claim"), ctx);
			result?.(input("BD_ACTOR=omp/Main/s1 bd done bd-probe-2m7.1.1"), ctx);
			result?.(input("BD_ACTOR=omp/Main/s1 bd close --reason finished bd-other-4k2"), ctx);
			const stop = handlers.session_stop?.[0];
			if (stop === undefined) throw new Error("session stop handler was not registered");
			expect(await stop({}, ctx)).toBeUndefined();
			expect(calls).toBe(0);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("equivalent external database selector spellings clear tracked claims", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-external-selector-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "external-selector" } };
			const result = handlers.tool_result?.[0];
			const event = (command: string) => ({
				toolName: "bash", toolCallId: command, isError: false,
				input: { command, cwd: dir, env: { BD_ACTOR: "omp/Main/s1" } },
				content: [{ type: "text", text: "command succeeded" }],
			});
			result?.(event("BD_ACTOR=omp/Main/s1 bd --database=/external -C /irrelevant-a update bd-probe-2m7 --claim"), ctx);
			result?.(event("BD_ACTOR=omp/Main/s1 bd --database /external -C /irrelevant-b close bd-probe-2m7"), ctx);
			expect(await handlers.session_stop?.[0]?.({}, ctx)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("relative db selectors keep their effective directory identity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-relative-db-selector-"));
		mkdirSync(join(dir, ".beads"));
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "relative-db-selector" } };
			const result = handlers.tool_result?.[0];
			const event = (command: string) => ({
				toolName: "bash", toolCallId: command, isError: false,
				input: { command, cwd: dir, env: { BD_ACTOR: "omp/Main/s1" } },
				content: [{ type: "text", text: "command succeeded" }],
			});
			result?.(event("BEADS_DIR=$X BD_ACTOR=omp/Main/s1 bd -C /A --db .beads update bd-probe-2m7 --claim"), ctx);
			result?.(event("BEADS_DIR=$X BD_ACTOR=omp/Main/s1 bd -C /B --db .beads close bd-probe-2m7"), ctx);
			const held = await handlers.session_stop?.[0]?.({}, ctx) as { continue?: boolean } | undefined;
			expect(held?.continue).toBe(true);
			result?.(event("BEADS_DIR=$X BD_ACTOR=omp/Main/s1 bd -C /A --db .beads close bd-probe-2m7"), ctx);
			expect(await handlers.session_stop?.[0]?.({}, ctx)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("shutdown reports tracked claims without spawning git or bd", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-shutdown-claims-"));
		mkdirSync(join(dir, ".beads"));
		let calls = 0;
		setBdStreamForTests(async () => {
			calls++;
			return { failure: "bd command timed out" };
		});
		try {
			const { handlers, logged } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "shutdown-claims" } };
			handlers.tool_result?.[0]?.({
				toolName: "bash",
				toolCallId: "claim",
				isError: false,
				input: { command: "BD_ACTOR=omp/Main/s1 bd update bd-probe-2m7 --claim", cwd: dir, env: { BD_ACTOR: "omp/Main/s1" } },
				content: [{ type: "text", text: "Updated issue: bd-probe-2m7" }],
			}, ctx);
			await handlers.session_shutdown?.[0]?.({}, ctx);
			expect(calls).toBe(0);
			expect(logged.join("\n")).toContain("bd-probe-2m7");
			expect(logged.join("\n")).toContain("--if-assignee");
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("the tool_call hook pins bash for the session's checkout and nothing else", async () => {
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
			expect(await call({ toolName: "bash", toolCallId: "1", input: { command: "printenv BEADS_DIR" } }, ctx)).toBeUndefined();
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

	test.serial("a live session keeps its auto-pin; a concurrent session in another checkout does not overwrite it", async () => {
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
			await settleBackgroundWorkForTests();
			expect(await call({ toolName: "task", toolCallId: "dispatch", input: {} }, ctx(b, "beta"))).toMatchObject({
				block: true,
				reason: expect.stringContaining("could not be verified"),
			});
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
	}, 90_000); // git init/commit/worktree add plus several session_start hooks; measured 37.9s on an idle M4 Pro, so 20s could not hold

	test.serial("session start accepts bd's null empty-list response", async () => {
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
			await settleBackgroundWorkForTests();
			expect(logged).toEqual([]);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("session start warns when the gate list is malformed", async () => {
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
			expect(logged).toEqual([]);
			await settleBackgroundWorkForTests();
			expect(logged).toEqual(["Beads gate list returned malformed data; unresolved gates remain unverified."]);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			rmSync(dir, { recursive: true, force: true });
		}
	});



	test.serial("session isolation preserves sibling notices, claims and repeated starts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-session-isolation-"));
		const originalBeads = process.env.BEADS_DIR;
		const originalActor = process.env.BEADS_ACTOR;
		const calls: string[] = [];
		setBdStreamForTests(async (_cwd, args) => {
			calls.push(args.join(" "));
			if (args[0] === "gate") return '[{"id":"bd-human","status":"open","await_type":"human"}]';
			if (args[0] === "list") return '[{"id":"bd-alpha","status":"in_progress"},{"id":"bd-beta","status":"in_progress"}]';
			return "unexpected memory replay";
		});
		try {
			mkdirSync(join(dir, ".beads"));
			delete process.env.BEADS_DIR;
			delete process.env.BEADS_ACTOR;
			const { handlers, logged } = wire();
			const context = (id: string, cwd = dir) => ({ cwd, sessionManager: { getSessionId: () => id } });
			const invoke = async (name: string, id: string, event: unknown = {}, cwd = dir) =>
				await handlers[name]?.[0]?.(event, context(id, cwd)) as { additionalContext?: string; content?: unknown[] } | undefined;
			const mutation = (id: string) => ({
				toolName: "bash", isError: false,
				input: { command: `BD_ACTOR=omp/Main/${id} bd update bd-${id} --claim` },
				content: [{ type: "text", text: "Imported 3 issues (2 stale skipped)" }],
			});

			await invoke("session_start", "alpha", {}, join(dir, "absent"));
			await invoke("session_start", "beta");
			await invoke("session_start", "alpha");
			await settleBackgroundWorkForTests();
			expect(logged.filter(text => text.includes("bd-human"))).toHaveLength(2);
			expect(logged.some(text => text.includes("unexpected memory replay"))).toBe(false);
			await invoke("auto_compaction_end", "alpha");
			expect(logged.some(text => text.includes("unexpected memory replay"))).toBe(false);
			expect(calls.join("\n")).not.toMatch(/prime|memories|remember|forget/);

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
			setBdStreamForTests(null);
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			if (originalActor === undefined) delete process.env.BEADS_ACTOR;
			else process.env.BEADS_ACTOR = originalActor;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("tracks tool-level BD_ACTOR for ready --claim without a bead id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-actor-alias-"));
		const originalBeads = process.env.BEADS_DIR;
		const originalBeadsActor = process.env.BEADS_ACTOR;
		const originalBdActor = process.env.BD_ACTOR;
		setBdStreamForTests(async (_cwd, args) => {
			if (args[0] === "update" && args[1] === "--help") return "Usage: bd update [--if-assignee HOLDER]";
			if (args[0] === "list") return '[{"id":"bd-owned","title":"owned claim","status":"in_progress","assignee":"omp/Main/alias"}]';
			return "[]";
		});
		try {
			mkdirSync(join(dir, ".beads"));
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
				content: [{ type: "text", text: "Claimed issue: bd-owned" }],
			}, { cwd: dir });

			const advisory = await sessionStop({}, { cwd: dir }) as { additionalContext?: string };
			expect(advisory.additionalContext).toContain("bd-owned [omp/Main/alias] claim recorded by this session");
		} finally {
			setBdStreamForTests(null);
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			if (originalBeadsActor === undefined) delete process.env.BEADS_ACTOR;
			else process.env.BEADS_ACTOR = originalBeadsActor;
			if (originalBdActor === undefined) delete process.env.BD_ACTOR;
			else process.env.BD_ACTOR = originalBdActor;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("a stale-skip import result is advised in band, once", () => {
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

	test.serial("a non-bd command is ignored", () => {
		const { handlers } = wire();
		expect(
			handlers.tool_result![0]!(
				{ toolName: "bash", toolCallId: "c1", isError: false, input: { command: "git status" }, content: [{ type: "text", text: "Imported 3 issues (2 stale skipped)" }] },
				{ cwd: "/repo" },
			),
		).toBeUndefined();
	});
	test.serial("session close stays silent until a bd write lands", async () => {
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

	test.serial("a non-beads cwd produces no session-start message", async () => {
		const originalBeads = process.env.BEADS_DIR;
		process.env.BEADS_DIR = "/nonexistent-beads-dir";
		try {
			const { handlers, logged } = wire();
			await handlers.session_start![0]!({}, { cwd: "/nonexistent-repo" });
			await settleBackgroundWorkForTests();
			expect(logged).toEqual([]);
		} finally {
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
		}
	});


	test.serial("registered stop emits per-bead CAS commands without a capability probe", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-release-cas-"));
		mkdirSync(join(dir, ".beads"));
		let calls = 0;
		setBdStreamForTests(async () => {
			calls++;
			return { failure: "bd command timed out" };
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "release-cas" } };
			const result = handlers.tool_result?.[0];
			result?.({ toolName: "bash", toolCallId: "a", isError: false, input: { command: "bd ready --claim", env: { BD_ACTOR: "actor/a" } }, content: [{ type: "text", text: "Claimed bd-a-1" }] }, ctx);
			result?.({ toolName: "bash", toolCallId: "b", isError: false, input: { command: "bd ready --claim", env: { BD_ACTOR: "actor/b" } }, content: [{ type: "text", text: "Claimed bd-b-2" }] }, ctx);
			const sessionStop = handlers.session_stop?.[0];
			if (sessionStop === undefined) throw new Error("session stop handler was not registered");
			const advisory = await sessionStop({}, ctx) as { additionalContext: string };
			expect(advisory.additionalContext).toContain("BEADS_ACTOR='actor/a' BD_ACTOR='actor/a' bd");
			expect(advisory.additionalContext).toContain("BEADS_ACTOR='actor/b' BD_ACTOR='actor/b' bd");
			expect(advisory.additionalContext).toContain("'--if-assignee' 'actor/a'");
			expect(advisory.additionalContext).toContain("'--if-assignee' 'actor/b'");
			expect(calls).toBe(0);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("agent_end skips continuations and releases aborted/cancelled terminal claims", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-agent-end-matrix-"));
		mkdirSync(join(dir, ".beads"));
		const calls: string[][] = [];
		const statuses: Record<string, string> = {
			"bd-completed": "in_progress",
			"bd-aborted": "blocked",
			"bd-error": "deferred",
			"bd-fail": "open",
		};
		setBdStreamForTests(async (_cwd, args, _deadline, env) => {
			calls.push(args);
			if (args[0] === "show") {
				if (args[1] === "bd-fail") return { failure: "foreign read failed" };
				return { output: JSON.stringify({ data: [{ id: args[1], issue_type: "task", status: statuses[args[1] ?? ""], assignee: env.BD_ACTOR }], schema_version: 1 }) };
			}
			return { output: "updated" };
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "agent-end-matrix" } };
			const result = handlers.tool_result?.[0];
			if (result === undefined) throw new Error("tool_result handler was not registered");
			for (const id of Object.keys(statuses)) result({ toolName: "bash", toolCallId: id, isError: false, input: { command: `BD_ACTOR=actor/${id} bd update ${id} --claim`, cwd: dir, env: { BD_ACTOR: `actor/${id}` } }, content: [{ type: "text", text: `Updated issue: ${id}` }] }, ctx);
			const end = handlers.agent_end?.[0];
			if (end === undefined) throw new Error("agent_end handler was not registered");
			expect(await end({ willContinue: true, outcome: "completed" }, ctx)).toBeUndefined();
			expect(calls).toEqual([]);
			expect(await end({ willContinue: false, outcome: "aborted", status: "cancelled" }, ctx)).toBeUndefined();
			await settleBackgroundWorkForTests();
			expect(calls.filter(args => args[0] === "unclaim").length).toBe(3);
			expect(calls.filter(args => args[0] === "show").length).toBe(4);
			expect(calls.filter(args => args[0] === "update").map(args => args.slice(0, 8))).toEqual([
				["update", "bd-completed", "--status", "open", "--if-status", "open", "--if-assignee", ""],
				["update", "bd-aborted", "--status", "blocked", "--if-status", "open", "--if-assignee", ""],
				["update", "bd-error", "--status", "deferred", "--if-status", "open", "--if-assignee", ""],
			]);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test.serial("agent_end refuses old CLI CAS and leaves claim assigned", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-agent-end-old-cli-"));
		mkdirSync(join(dir, ".beads"));
		const calls: string[][] = [];
		setBdStreamForTests(async (_cwd, args, _deadline, env) => {
			calls.push(args);
			if (args[0] === "show") {
				return { output: JSON.stringify({ data: [{ id: args[1], issue_type: "task", status: "in_progress", assignee: env.BD_ACTOR }], schema_version: 1 }) };
			}
			if (args[0] === "unclaim") return { failure: "unknown flag: --if-assignee" };
			return { output: "updated" };
		});
		try {
			const { handlers } = wire();
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "agent-end-old-cli" } };
			handlers.tool_result?.[0]?.({ toolName: "bash", toolCallId: "old-cli-claim", isError: false, input: { command: "BD_ACTOR=actor/old bd update bd-old-cli --claim", cwd: dir, env: { BD_ACTOR: "actor/old" } }, content: [{ type: "text", text: "Updated issue: bd-old-cli" }] }, ctx);
			const end = handlers.agent_end?.[0];
			if (end === undefined) throw new Error("agent_end handler was not registered");
			await end({ willContinue: false, outcome: "cancelled" }, ctx);
			await settleBackgroundWorkForTests();
			expect(calls.map(args => args[0])).toEqual(["show", "unclaim"]);
			const stop = handlers.session_stop?.[0];
			if (stop === undefined) throw new Error("session stop handler was not registered");
			const advisory = await stop({}, ctx) as { additionalContext?: string };
			expect(advisory.additionalContext).toContain("bd >= 1.3 is required");
			expect(advisory.additionalContext).not.toContain("Lease anchor");
			expect(advisory.additionalContext).toContain("bd-old-cli");
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("sub-agent agent_end awaits its claim finalizer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-agent-end-await-"));
		mkdirSync(join(dir, ".beads"));
		const calls: string[][] = [];
		setBdStreamForTests(async (_cwd, args, _deadline, env) => {
			calls.push(args);
			if (args[0] === "show") return { output: JSON.stringify({ data: [{ id: args[1], issue_type: "task", status: "in_progress", assignee: env.BD_ACTOR }], schema_version: 1 }) };
			return { output: "unclaimed" };
		});
		try {
			const { handlers } = wire();
			const run = "12345678-1234-4234-8234-123456789abc";
			const sessionDir = join(dir, "sessions");
			const ctx = {
				cwd: dir,
				sessionManager: {
					getSessionId: () => "agent-end-await",
					getHeader: () => ({ parentSession: join(sessionDir, "main.jsonl") }),
					getSessionFile: () => join(sessionDir, run, "worker.jsonl"),
					getSessionDir: () => sessionDir,
				},
			};
			const result = handlers.tool_result?.[0];
			if (result === undefined) throw new Error("tool_result handler was not registered");
			result({ toolName: "bash", toolCallId: "claim", isError: false, input: { command: "BD_ACTOR=actor/sub bd update bd-sub --claim", cwd: dir, env: { BD_ACTOR: "actor/sub" } }, content: [{ type: "text", text: "Updated issue: bd-sub" }] }, ctx);
			const end = handlers.agent_end?.[0];
			if (end === undefined) throw new Error("agent_end handler was not registered");
			await end({ willContinue: false, outcome: "completed" }, ctx);
			expect(calls.map(args => args[0])).toEqual(["show", "unclaim", "update"]);
		} finally {
			setBdStreamForTests(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.serial("configured production bundles share lifecycle admission and pin Bash calls", async () => {
		const bridgeKey = Symbol.for("com.srobroek.beads.session-lifecycle.bridge.v1");
		const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
		delete globals[bridgeKey];
		const dir = mkdtempSync(join(tmpdir(), "beads-manifest-pin-"));
		execFileSync("git", ["-C", dir, "init", "-q"]);
		mkdirSync(join(dir, ".beads"));
		const originalBeadsDir = process.env.BEADS_DIR;
		delete process.env.BEADS_DIR;
		setBdStreamForTests(async () => "[]");
		try {
			const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { omp?: { extensions?: unknown } };
			const entries = manifest.omp?.extensions;
			if (!Array.isArray(entries) || entries.length === 0 || entries.some(entry => typeof entry !== "string")) throw new Error("Beads package manifest has no valid extension entries");
			const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
			const pi = {
				logger: { error: () => {}, info: () => {} },
				on: (event: string, handler: (call: unknown, ctx: unknown) => unknown) => { handlers[event] = [...(handlers[event] ?? []), handler]; },
				sendMessage: () => {},
			};
			const nonce = `${Date.now()}-${Math.random()}`;
			for (const entry of entries as string[]) {
				const bundle = await import(`${join(import.meta.dir, "..", entry)}?manifest=${nonce}`);
				if (typeof bundle.default !== "function") throw new Error(`manifest entry ${entry} has no extension function`);
				bundle.default(pi as never);
			}
			const bridge = globals[bridgeKey] as { gateAdmitter?: () => Promise<{ block: true; reason: string }> } | undefined;
			expect(typeof bridge?.gateAdmitter).toBe("function");
			if (bridge === undefined) throw new Error("lifecycle bundle did not publish its bridge");
			bridge.gateAdmitter = async () => ({ block: true, reason: "cross-bundle admission proof" });
			const ctx = { cwd: dir, sessionManager: { getSessionId: () => "manifest-pin" } };
			await handlers.session_start?.[0]?.({}, ctx);
			const result = await handlers.tool_call?.[0]?.({ toolName: "bash", input: { command: "bd list", cwd: dir } }, ctx);
			expect(result).toMatchObject({ input: { command: `BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${join(dir, ".beads")}' bd list` } });
		} finally {
			delete globals[bridgeKey];
			rmSync(dir, { recursive: true, force: true });
			setBdStreamForTests(null);
			if (originalBeadsDir === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeadsDir;
		}
	});
});
