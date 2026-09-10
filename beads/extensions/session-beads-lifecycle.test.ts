import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sessionBeadsLifecycle, {
	autoPinBeadsDir,
	pinBashInput,
	releaseAutoPin,
	repoIdentity,
	bdVerbs,
	beadIdCandidates,
	envelopeData,
	formatGateAdvisory,
	formatSessionCloseAdvisory,
	gatesCanResolve,
	handleSessionStop,
	heldClaims,
	isBdWrite,
	lastPushNotice,
	parseTrailingJson,
	readBeads,
	readCheckOutcome,
	readGates,
	readGateList,
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
	});
});

describe("pinBashInput", () => {
	test("adds the session pin to a bash call, keeps a caller pin, ignores malformed env", () => {
		expect(pinBashInput({ command: "bd list" }, "/repo/.beads")).toEqual({ command: "bd list", env: { BEADS_DIR: "/repo/.beads" } });
		expect(pinBashInput({ command: "bd list", env: { A: "1" } }, "/repo/.beads")).toEqual({ command: "bd list", env: { A: "1", BEADS_DIR: "/repo/.beads" } });
		expect(pinBashInput({ command: "bd list", env: { BEADS_DIR: "/mine/.beads" } }, "/repo/.beads")).toBeUndefined();
		expect(pinBashInput({ command: "bd list" }, undefined)).toBeUndefined();
		expect(pinBashInput({ command: "bd list", env: "nope" }, "/repo/.beads")).toBeUndefined();
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

	test("an untouched backlog bead is not this session's problem", () => {
		expect(heldClaims(beads, new Set(), undefined)).toEqual([]);
	});

	test("a touched open bead is filed work, not an omission", () => {
		expect(heldClaims(beads, new Set(["bd-probe-e8z"]), undefined)).toEqual([]);
	});

	test("this actor's own claim counts even when the id was never seen", () => {
		expect(heldClaims(beads, new Set(), "omp/Main/s1").map(b => b.id)).toEqual(["bd-probe-2m7"]);
		expect(heldClaims(beads, new Set(), "omp/Other/s2")).toEqual([]);
		expect(heldClaims(beads, new Set(), "")).toEqual([]);
	});
});

describe("formatSessionCloseAdvisory", () => {
	test("names the bead, the holder, and every remedy", () => {
		const text = formatSessionCloseAdvisory(heldClaims(readBeads(BEAD_LIST), new Set(["bd-probe-2m7"]), undefined));
		expect(text).toContain("bd-probe-2m7 [omp/Main/s1] target work");
		expect(text).toContain("bd unclaim");
		expect(text).toContain("bd comments add");
		expect(text).toContain("discovered work");
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

	test("skips its own continuation", () => {
		expect(handleSessionStop({ stop_hook_active: true }, BEAD_LIST, new Set(["bd-probe-2m7"]))).toBeUndefined();
		expect(handleSessionStop({ stopHookActive: true }, BEAD_LIST, new Set(["bd-probe-2m7"]))).toBeUndefined();
	});

	test("nothing held, nothing said", () => {
		expect(handleSessionStop({}, BEAD_LIST, new Set(), undefined)).toBeUndefined();
	});

	test("an unreadable database reports uncertainty", () => {
		expect(handleSessionStop({}, undefined, new Set(["bd-probe-2m7"]), undefined)?.additionalContext).toContain("could not be verified");
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
		return { handlers, logged };
	};
	test("the tool_call hook pins bash for the session's checkout and nothing else", async () => {
		const root = mkdtempSync(join(tmpdir(), "beads-callpin-"));
		mkdirSync(join(root, ".beads"));
		const { handlers } = wire();
		const call = handlers.tool_call![0]!;
		const ctx = { cwd: root, sessionManager: { getSessionId: () => "pin-session" } };
		expect(await call({ toolName: "bash", toolCallId: "1", input: { command: "printenv BEADS_DIR" } }, ctx)).toEqual({
			input: { command: "printenv BEADS_DIR", env: { BEADS_DIR: join(root, ".beads") } },
		});
		expect(await call({ toolName: "read", toolCallId: "2", input: { path: "x" } }, ctx)).toBeUndefined();
		const plain = mkdtempSync(join(tmpdir(), "beads-callpin-plain-"));
		expect(await call({ toolName: "bash", toolCallId: "3", input: { command: "bd list" } }, { cwd: plain, sessionManager: { getSessionId: () => "other" } })).toBeUndefined();
		rmSync(root, { recursive: true, force: true });
		rmSync(plain, { recursive: true, force: true });
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
			const { handlers, logged } = wire();
			const start = handlers.session_start![0]!;
			const stop = handlers.session_shutdown![0]!;
			const ctx = (cwd: string, id: string) => ({ cwd, sessionManager: { getSessionId: () => id } });
			await start({}, ctx(a, "alpha"));
			expect(process.env.BEADS_DIR).toBe(join(a, ".beads"));
			await start({}, ctx(b, "beta")); // concurrent session in an unrelated checkout
			expect(process.env.BEADS_DIR).toBe(join(a, ".beads")); // alpha's live pin is not overwritten under it
			expect(logged.some((m) => m.includes("another repository's beads database"))).toBe(true); // beta is told to pin per call
			await start({}, ctx(aWorktree, "delta")); // same repository as alpha: shares the pin
			await start({}, ctx(a, "alpha")); // owner restarts: delta must not be forgotten
			stop({}, ctx(a, "alpha"));
			expect(process.env.BEADS_DIR).toBe(join(a, ".beads")); // delta keeps it alive after alpha ends
			stop({}, ctx(aWorktree, "delta"));
			expect(process.env.BEADS_DIR).toBeUndefined(); // released with the last same-repo session
			await start({}, ctx(b, "beta"));
			expect(process.env.BEADS_DIR).toBe(join(b, ".beads"));
			stop({}, ctx(b, "beta"));
			await start({}, ctx(c, "gamma"));
			expect(process.env.BEADS_DIR).toBeUndefined(); // c has no database: nothing inherited
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalBeads === undefined) delete process.env.BEADS_DIR;
			else process.env.BEADS_DIR = originalBeads;
			for (const dir of [a, aWorktree, b, c]) rmSync(dir, { recursive: true, force: true });
		}
	});

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
			handlers.tool_result![0]!({
				toolName: "bash",
				toolCallId: "alias-claim",
				isError: false,
				input: { command: "bd ready --claim", env: { BD_ACTOR: "omp/Main/alias" } },
				content: [{ type: "text", text: "claimed" }],
			}, { cwd: dir });

			const advisory = await handlers.session_stop![0]!({}, { cwd: dir }) as { additionalContext?: string };
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


});
