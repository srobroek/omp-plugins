import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { invocationFromArgv } from "./bd-actor-gate.ts";
import bdEmbeddedWriteLock, { embeddedStores, embeddedWriteTargets, hold, release, setLeaseTimingForTests, withEmbeddedWriteLock, writesStore } from "./bd-embedded-write-lock.ts";
import bdLeaseGate, { setBdRunForTests } from "./bd-lease-gate.ts";
import { cookCheck, deepAssert, type SpawnResult, setBdSpawnForTests } from "./formula-check-tool.ts";
import { runBd, setBdStreamForTests } from "./session-beads-lifecycle.ts";

const LOCK = "omp-embedded-write.lock";
const HOST = hostname().split(".")[0] ?? "localhost";
/** Above the macOS and Linux pid ceilings, so `kill(pid, 0)` reports ESRCH. */
const DEAD_PID = 999_999;

const roots: string[] = [];

/**
 * Classifier matrix.
 *
 * The reads are the allowlist's whole justification and the writes are the verbs a
 * write-list classifier forgot; both directions are asserted from one table so a
 * verb cannot quietly change sides.
 */
const WRITES: Record<string, string[]> = {
	"comments add": ["comments", "add", "bd-1", "text"],
	"comments add from a file": ["comments", "add", "bd-1", "-f", "notes.txt"],
	"a comments subcommand bd adds later": ["comments", "delete", "bd-1"],
	"comments with no issue id": ["comments"],
	"orphans --fix": ["orphans", "--fix"],
	"orphans -f": ["orphans", "-f"],
	"preflight --fix": ["preflight", "--fix"],
	"orphans -fj fused": ["orphans", "-fj"],
	"orphans -jf fused": ["orphans", "-jf"],
	"ready --claim=true": ["ready", "--claim=true"],
	"ready --claim=1": ["ready", "--claim=1"],
	"a disabled --readonly": ["--readonly=false", "close", "x"],
	"a disabled --help": ["--help=false", "close", "x"],
	"a disabled --global still writes this store": ["--global=false", "close", "x"],
	"admin repair": ["admin", "repair"],
	batch: ["batch"],
	"branch create x": ["branch", "create", "x"],
	close: ["close", "x"],
	compact: ["compact"],
	conflicts: ["conflicts"],
	"config set k v": ["config", "set", "k", "v"],
	"dep add": ["dep", "add", "a", "b"],
	"dolt push": ["dolt", "push"],
	doctor: ["doctor"],
	events: ["events"],
	flatten: ["flatten"],
	"gate check": ["gate", "check", "--json"],
	gc: ["gc"],
	heartbeat: ["heartbeat", "x"],
	import: ["import"],
	migrate: ["migrate"],
	"mol pour": ["mol", "pour", "f"],
	provenance: ["provenance"],
	prune: ["prune"],
	purge: ["purge"],
	"ready --claim": ["ready", "--claim"],
	reclaim: ["reclaim"],
	"recompute-blocked": ["recompute-blocked"],
	"rename-prefix": ["rename-prefix", "z"],
	restore: ["restore", "x"],
	sql: ["sql", "SELECT 1"],
	sync: ["sync"],
	unclaim: ["unclaim", "x"],
	"unknown future verb": ["teleport", "x"],
	vc: ["vc", "log"],
};

const READ_ARGV: Record<string, string[]> = {
	blocked: ["blocked"],
	"comments listing an issue": ["comments", "bd-1"],
	"orphans without --fix": ["orphans"],
	"orphans with an unrelated fused short run": ["orphans", "-jq"],
	"orphans with --fix disabled": ["orphans", "--fix=false"],
	"ready with --claim disabled": ["ready", "--claim=false"],
	"an enabled --readonly": ["--readonly=true", "close", "x"],
	"comments listing as JSON": ["comments", "bd-1", "--json"],
	"config get": ["config", "get", "k"],
	"dep list": ["dep", "list", "x"],
	"dolt status": ["dolt", "status"],
	export: ["export"],
	"gate list": ["gate", "list", "--json"],
	"help flag on a write": ["close", "--help"],
	list: ["list", "--all", "--json"],
	"mol show": ["mol", "show", "x", "--json"],
	ready: ["ready"],
	"readonly mode on a write": ["--readonly", "close", "x"],
	show: ["show", "x", "--json"],
	status: ["status"],
	where: ["where"],
};

describe("writesStore", () => {
	for (const [name, argv] of Object.entries(WRITES)) {
		test(`treats ${name} as a write`, () => {
			expect(writesStore(invocationFromArgv(argv))).toBe(true);
		});
	}

	for (const [name, argv] of Object.entries(READ_ARGV)) {
		test(`leaves ${name} unserialised`, () => {
			expect(writesStore(invocationFromArgv(argv))).toBe(false);
		});
	}

	test("treats an argv it could not read as a write", () => {
		expect(writesStore(invocationFromArgv([]))).toBe(true);
		expect(writesStore(undefined)).toBe(true);
	});
});

describe("store resolution follows the store bd will really write", () => {
	test("a path-valued --db names the store, so those writes cannot escape", () => {
		const beads = store();
		expect(embeddedStores(`bd --db ${beads} close x`, "/repo", {})).toEqual([beads]);
	});

	test("a --db inside the store resolves to the store itself", () => {
		const beads = store();
		const file = join(beads, "beads.db");
		writeFileSync(file, "");
		expect(embeddedStores(`bd --db ${file} close x`, "/repo", {})).toEqual([beads]);
	});


	test("--directory=<path> resolves the same store as -C <path>", () => {
		const beads = store();
		const checkout = join(beads, "..");
		expect(embeddedStores(`bd --directory=${checkout} close x`, "/elsewhere", {})).toEqual([beads]);
	});

	test("--global addresses another database, so this store is left alone", () => {
		const beads = store();
		expect(embeddedStores("bd --global close x", "/repo", { BEADS_DIR: beads })).toEqual([]);
	});


	test("a global flag's value is never mistaken for the verb", () => {
		const beads = store();
		// `--database other` once made `other` look like the verb, which classified as
		// a write for the wrong reason; the store is still left alone, but via --database.
		expect(embeddedStores("bd --actor me list --json", "/repo", { BEADS_DIR: beads })).toEqual([]);
		expect(embeddedStores("bd --actor me close x", "/repo", { BEADS_DIR: beads })).toEqual([beads]);
	});

	test("bd reached by path is the same command, so it takes the same lock", () => {
		const beads = store();
		expect(embeddedStores("/usr/local/bin/bd close x", "/repo", { BEADS_DIR: beads })).toEqual([beads]);
	});

	test("two spellings of one store are one lock domain", () => {
		const beads = store();
		const roundabout = join(beads, "..", ".beads", ".", "..", ".beads");
		expect(embeddedStores(`bd close x`, "/repo", { BEADS_DIR: roundabout })).toEqual([beads]);
	});
});

describe("a call that never executes cannot strand its hold", () => {
	/** The handlers a host would call, including the lifecycle events. */
	function lifecycle(): Record<string, Handler[]> {
		const registered: Record<string, Handler[]> = {};
		bdEmbeddedWriteLock({
			on: (event: string, handler: Handler) => {
				const list = registered[event] ?? [];
				list.push(handler);
				registered[event] = list;
			},
			logger: { error: () => {}, info: () => {} },
		} as never);
		return registered;
	}

	test("a turn that ends without a tool result gives the hold back", async () => {
		const beads = store();
		const handlers = lifecycle();
		await handlers.tool_call?.[0]?.(bashCall("timed-out", "bd create a -t task", beads));
		expect(existsSync(join(beads, LOCK))).toBe(true);

		// No tool_result: the host timed the command out, or another extension blocked
		// it after this one had acquired. The turn still ends.
		handlers.turn_end?.[0]?.({});
		expect(existsSync(join(beads, LOCK))).toBe(false);
		expect((await hold(beads, "next", 60)).kind).toBe("held");
		release(beads, "next");
	});

	test("a denied approval gives the hold back without waiting for the turn", async () => {
		const beads = store();
		const handlers = lifecycle();
		await handlers.tool_call?.[0]?.(bashCall("denied", "bd create a -t task", beads));
		handlers.tool_approval_resolved?.[0]?.({ toolCallId: "denied", approved: false });
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});

	test("an approved call keeps its hold until the result arrives", async () => {
		const beads = store();
		const handlers = lifecycle();
		await handlers.tool_call?.[0]?.(bashCall("approved", "bd create a -t task", beads));
		handlers.tool_approval_resolved?.[0]?.({ toolCallId: "approved", approved: true });
		expect(existsSync(join(beads, LOCK))).toBe(true);
		handlers.tool_result?.[0]?.({ toolName: "bash", toolCallId: "approved", input: {}, content: [] });
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});

	test("a hold whose lease lapsed is taken over even though its pid is alive", async () => {
		const beads = store();
		// Exactly the shape a stranded hold leaves behind: this very process, alive,
		// with a lease nobody renewed.
		writeFileSync(
			join(beads, LOCK),
			JSON.stringify({ host: HOST, pid: process.pid, toolCallId: "stranded", taken: Date.now() - 600_000, expires: Date.now() - 300_000 }),
		);
		expect((await hold(beads, "next", 2_000)).kind).toBe("held");
		release(beads, "next");
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});
});

/**
 * The accepted shape, and everything else.
 *
 * There is no shell model to test row by row any more. One shape is allowed -- a whole
 * command that is a single direct `bd` call -- and every other command that mentions
 * `bd` is refused on an embedded store. The matrix is therefore short on purpose: the
 * accepted forms, the forms that must stay free, and a sample of compound shapes that
 * must fail closed WITHOUT anyone having modelled them.
 */
describe("only a direct bd invocation is accepted", () => {
	/** Whole commands that are one direct bd write. */
	const ACCEPTED: Record<string, string> = {
		"a plain write": "bd close x",
		"a write with flags": "bd update x --add-label done --json",
		"bd reached by path": "/usr/local/bin/bd close x",
		"an assignment prefix": "BEADS_ACTOR=me bd close x",
		"two assignment prefixes": "BEADS_ACTOR=me BD_NO_PAGER=1 bd close x",
		"a dynamic issue id": "bd close $ID",
		"a quoted argument": 'bd comment x "a note with spaces"',
		// Quoted OPERANDS carrying punctuation. These are ordinary standalone writes, and
		// refusing them made the remediation impossible to follow.
		"parentheses in a quoted title": 'bd create "foo(bar)" -t task',
		"a quoted note containing &&": 'bd note x "build A && run B"',
		"a quoted reason containing a semicolon": 'bd comment x "first; then second"',
		"a quoted pipe": 'bd comment x "a | b"',
		"a quoted redirection": 'bd comment x "write > here"',
		"a quoted backslash": 'bd comment x "path\\\\to\\\\thing"',
		"a multiline quoted comment": 'bd comment x "line one\nline two"',
		"a quoted hash": 'bd comment x "see #12"',
		// The forms this plugin's own migration prose now tells a human to run. If any
		// of these were refused, the guard would be blocking its own instructions.
		"the documented backup init": "bd backup init /tmp/beads-backup",
		"the documented backup sync": "bd backup sync",
		"the documented backup restore": "bd backup restore --force /tmp/beads-backup",
		"the documented re-init": "bd init --init-if-missing --skip-hooks --skip-agents --prefix rp",
		"the documented dolt push": "bd dolt push",
		"the documented bootstrap": "bd bootstrap --yes",
		"a command word spelled with quotes": 'b"d" close x',
	};

	for (const [name, command] of Object.entries(ACCEPTED)) {
		test(`locks the resolved store for ${name}`, () => {
			const beads = store();
			expect(embeddedWriteTargets(command, "/repo", { BEADS_DIR: beads })).toEqual({ kind: "stores", stores: [beads] });
		});
	}

	/** Commands that need no lock: no bd at all, or a bd call that writes nothing. */
	const FREE: Record<string, string> = {
		// Controls against the guard regressing into refusing everything: these have
		// nothing to do with bd and must never reach the refusal path.
		"a command with no bd in it": "git status --short",
		"a bare listing": "ls -la",
		"a compound command with no bd in it": "cd src && bun test && echo done",
		"a word merely containing bd": "echo abduction",
		"the documented count check": "bd count",
		// `bd export` is a read, so the documented export needs no lock at all -- but it
		// must still be the accepted SHAPE, which is why `-o` replaced a redirection.
		"the documented export": "bd export -o issues.jsonl",
		"a read": "bd list --all --json",
		"a read with flags": "bd show x --json",
		"bd --version": "bd --version",
		"bd --help": "bd --help",
		"bare bd": "bd",
			};

	for (const [name, command] of Object.entries(FREE)) {
	}

	/**
	 * Compound shapes. None of these is modelled; each fails closed BECAUSE it is not
	 * the accepted shape, which is what makes the next unlisted shape safe too.
	 */
	const REFUSED: Record<string, string> = {
		"a wrapper": "timeout 60 bd close x",
		"a nested shell string": "bash -c 'bd close x'",
		"an unquoted nested payload": "eval bd close x",
		"an ANSI-C nested payload": "bash -c $'bd close x'",
		"an escaped nested payload": "bash -c bd\\ close\\ x",
		"a pipeline": "echo x | xargs bd close",
		"a find -exec": "find . -exec bd close {} +",
		"a parallel invocation": "parallel bd close ::: a b",
		"a flock wrapper": "flock /tmp/l bd close x",
		"a leading cd": "cd other && bd close x",
		// Command substitution RUNS something, and it runs inside double quotes too, so a
		// quoted token carrying it is refused rather than trusted as an operand.
		"a quoted command substitution": 'bd comment x "$(cat note.txt)"',
		"a quoted backtick substitution": 'bd comment x "`cat note.txt`"',
		"a substitution that writes another store": 'bd comment x "$(bd -C /other close y)"',
		"a backtick that writes another store": "bd comment x \"`bd -C /other close y`\"",
		"a substitution in a quoted store flag": 'bd -C "$(cat dir)" close x',
		"a leading cd with a semicolon": "cd other; bd close x",
		"a loop": "for i in $ids; do bd close $i; done",
		"a conditional": "if true; then bd close x; fi",
		"a subshell": "(bd close x)",
		"a brace group": "{ bd close x; }",
		// No literal `bd` anywhere in this text, yet it runs bd. Detection strips quotes
		// and backslashes for exactly this reason.
		"a nested payload spelled with quotes": "bash -c 'b\"d\" close x'",
		"a backslashed command word": "b\\d close x",
		"a sequence after a read": "bd list && bd close x",
		"a redirection": "bd export > out.jsonl",
		"a substitution in a store flag": "bd -C $DIR close x",
		"a glob in a store flag": "bd --db /tmp/*/. close x",
		"a here-doc": "bd create -f - <<EOF\ntitle\nEOF",
		"a comment mentioning bd": "# bd close x",
		"prose mentioning bd": 'git commit -m "run bd close x later"',
		"an unmodelled runner": "myrunner bd close x",
		// Quoting decides operator recognition, never command identity, so a quoted
		// command word is refused rather than trusted to be bd.
		"a quoted command word": "'bd' close x",
	};

	for (const [name, command] of Object.entries(REFUSED)) {
		test(`refuses ${name}`, () => {
			const beads = store();
			const targets = embeddedWriteTargets(command, "/repo", { BEADS_DIR: beads });
			expect(targets.kind).toBe("refused");
		});

		test(`allows ${name} where no embedded store is in reach`, () => {
			const beads = store();
			expect(embeddedWriteTargets(command, "/repo", { BEADS_DIR: beads })).toEqual({ kind: "stores", stores: [] });
		});
	}

	test("the refusal names the shape that clears it, and that shape is accepted", () => {
		const beads = store();
		const refused = embeddedWriteTargets("cd other && bd close x", "/repo", { BEADS_DIR: beads });
		expect(refused.kind).toBe("refused");
		const reason = refused.kind === "refused" ? refused.reason : "";
		expect(reason).toContain("single direct `bd` invocation");
		expect(reason).toContain("its own tool call");
		// The remediation the message asks for must itself pass, or the block cannot be cleared.
		expect(embeddedWriteTargets("bd close x", join(beads, ".."), {})).toEqual({ kind: "stores", stores: [beads] });
	});

	test("a direct write to an explicit store is locked with no ambient store at all", () => {
		const beads = store();
		// No BEADS_DIR and a cwd with no `.beads`: the explicit target is the only
		// thing naming a store, and it still has to be locked.
		expect(embeddedWriteTargets(`bd -C ${join(beads, "..")} close x`, "/nowhere", {})).toEqual({ kind: "stores", stores: [beads] });
	});

	test("a compound command naming an explicit embedded store is refused with no ambient store", () => {
		const beads = store();
		const targets = embeddedWriteTargets(`cd /tmp && bd -C ${join(beads, "..")} close x`, "/nowhere", {});
		expect(targets.kind).toBe("refused");
		expect(targets.kind === "refused" && targets.reason).toContain(beads);
	});


	test("a nested payload naming an explicit embedded store is refused with no ambient store", () => {
		const beads = store();
		const targets = embeddedWriteTargets(`bash -c 'bd -C ${join(beads, "..")} close x'`, "/nowhere", {});
		expect(targets.kind).toBe("refused");
		expect(targets.kind === "refused" && targets.reason).toContain(beads);
	});

	test("a nested payload naming an explicit store is refused, never locked as direct", () => {
		const beads = store();
		// The distinction matters: locking it would report the write as serialised while
		// the shell ran something this gate never read.
		expect(embeddedWriteTargets(`bash -c 'bd --db ${beads} close x'`, "/nowhere", {}).kind).toBe("refused");
	});


	test("a compound command naming no store at all is allowed when nothing is in reach", () => {
		expect(embeddedWriteTargets("cd /tmp && bd close x", "/nowhere", {})).toEqual({ kind: "stores", stores: [] });
	});
});

describe("jurisdiction does not depend on the session's own store", () => {


});

describe("the gate refuses what it cannot place", () => {
	test("a compound command is blocked, with the remediation the agent needs", async () => {
		const beads = store();
		const { lockCall } = wire();
		const blocked = (await lockCall(bashCall("compound", "cd other && bd close x", beads))) as { block?: boolean; reason?: string };
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("its own tool call");
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});

});

/** A `.beads` directory carrying the mode carriers bd writes. */
function store(): string {
	// Canonical, because the lock canonicalises every store path so two spellings of
	// one database cannot become two lock domains; on macOS `/var` is a symlink.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "beads-write-lock-")));
	roots.push(root);
	const beads = join(root, ".beads");
	mkdirSync(beads);
	writeFileSync(join(beads, "metadata.json"), JSON.stringify({}));
	return beads;
}

afterEach(() => {
	setBdRunForTests(null);
	setBdSpawnForTests(null);
	setBdStreamForTests(null);
	setLeaseTimingForTests();
	for (const root of roots.splice(0)) {
		try {
			chmodSync(join(root, ".beads"), 0o700);
		} catch {
			// Only the permission test tightens it.
		}
		rmSync(root, { recursive: true, force: true });
	}
});

describe("a deep formula pour shares the store's lock domain", () => {
	/** A pour that reports a root, then a `mol show` the assertion can read. */
	function pourSpawn(seen: string[]): (cmd: string[]) => Promise<SpawnResult> {
		return async (cmd: string[]) => {
			seen.push(cmd.join(" "));
			if (cmd[1] === "pour") return { ok: true, exitCode: 0, stdout: "Root issue: rp-1\n", stderr: "" };
			return { ok: true, exitCode: 0, stdout: JSON.stringify({ issues: [{ id: "rp-1", title: "root" }], dependencies: [] }), stderr: "" };
		};
	}

	test("a real pour waits for the bash mutation holding the store", async () => {
		const beads = store();
		const checkout = join(beads, "..");
		const seen: string[] = [];
		setBdSpawnForTests(pourSpawn(seen));
		const { lockCall, lockResult } = wire();

		await lockCall(bashCall("writer", "bd create a -t task", beads));
		const poured = deepAssert("formula", [], "pour-call", checkout, { BEADS_DIR: beads });

		await tick();
		expect(seen).toEqual([]);

		lockResult({ toolName: "bash", toolCallId: "writer", input: {}, content: [] });
		expect(await poured).toEqual([]);
		expect(seen).toEqual(["mol pour formula", "mol show rp-1 --json"]);
	});

	test("a pour that cannot take the lock never runs bd at all", async () => {
		const beads = store();
		const seen: string[] = [];
		setBdSpawnForTests(pourSpawn(seen));
		chmodSync(beads, 0o500);
		const failures = await deepAssert("formula", [], "pour-call", join(beads, ".."), { BEADS_DIR: beads });
		expect(seen).toEqual([]);
		expect(failures[0]).toContain("real pour was not attempted");
	});

	test("the pour's own read-back joins its hold instead of queueing behind it", async () => {
		const beads = store();
		const seen: string[] = [];
		setBdSpawnForTests(pourSpawn(seen));
		// A nested run that took a second hold would never be reached, so arriving
		// here at all is the proof; the lock is released once, not twice.
		expect(await deepAssert("formula", [], "pour-call", join(beads, ".."), { BEADS_DIR: beads })).toEqual([]);
		expect(seen).toEqual(["mol pour formula", "mol show rp-1 --json"]);
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});

	test("a cook check is serialised too, because this repository classifies cook as a write", async () => {
		const beads = store();
		const seen: string[] = [];
		setBdSpawnForTests(pourSpawn(seen));
		const { lockCall, lockResult } = wire();

		await lockCall(bashCall("writer", "bd create a -t task", beads));
		const cooked = cookCheck("formula", [], join(beads, ".."), { BEADS_DIR: beads });

		await tick();
		expect(seen).toEqual([]);

		lockResult({ toolName: "bash", toolCallId: "writer", input: {}, content: [] });
		expect(await cooked).toEqual([]);
		expect(seen).toEqual(["cook formula --dry-run"]);
	});
});

describe("a session-boundary gate check shares the store's lock domain", () => {
	/** Record the argv each internal run reaches bd with, in order. */
	function streamSeam(seen: string[]): (cwd: string, args: string[]) => Promise<string | undefined> {
		return async (_cwd: string, args: string[]) => {
			seen.push(args.join(" "));
			return "{}";
		};
	}

	test("a mutating gate check waits for the bash mutation holding the store", async () => {
		const beads = store();
		const seen: string[] = [];
		setBdStreamForTests(streamSeam(seen));
		const { lockCall, lockResult } = wire();

		await lockCall(bashCall("writer", "bd create a -t task", beads));
		const checked = runBd(join(beads, ".."), ["gate", "check", "--json"], Date.now() + 5_000, { BEADS_DIR: beads });

		await tick();
		expect(seen).toEqual([]);

		lockResult({ toolName: "bash", toolCallId: "writer", input: {}, content: [] });
		expect(await checked).toBe("{}");
		expect(seen).toEqual(["gate check --json"]);
	});

	test("a read-only gate list is never delayed by a held store", async () => {
		const beads = store();
		const seen: string[] = [];
		setBdStreamForTests(streamSeam(seen));
		const { lockCall } = wire();
		await lockCall(bashCall("writer", "bd create a -t task", beads));
		expect(await runBd(join(beads, ".."), ["gate", "list", "--json"], Date.now() + 5_000, { BEADS_DIR: beads })).toBe("{}");
		expect(seen).toEqual(["gate list --json"]);
	});


	test("a gate check that cannot take the lock never runs bd at all", async () => {
		const beads = store();
		const seen: string[] = [];
		setBdStreamForTests(streamSeam(seen));
		chmodSync(beads, 0o500);
		expect(await runBd(join(beads, ".."), ["gate", "check", "--json"], Date.now() + 5_000, { BEADS_DIR: beads })).toBeUndefined();
		expect(seen).toEqual([]);
	});
});

type Handler = (event: unknown, context?: unknown) => unknown;

/** The two extensions that write one store, wired as the host wires them. */
function wire(): { lockCall: Handler; lockResult: Handler; leaseCall: Handler; leaseResult: Handler } {
	const lock: Record<string, Handler[]> = {};
	const lease: Record<string, Handler[]> = {};
	const collect = (into: Record<string, Handler[]>) => ({
		on: (event: string, handler: Handler) => {
			const registered = into[event] ?? [];
			registered.push(handler);
			into[event] = registered;
		},
		logger: { error: () => {}, info: () => {} },
	});
	bdEmbeddedWriteLock(collect(lock) as never);
	bdLeaseGate(collect(lease) as never);
	const lockCall = lock.tool_call?.[0];
	const lockResult = lock.tool_result?.[0];
	const leaseCall = lease.tool_call?.[0];
	const leaseResult = lease.tool_result?.[0];
	if (!lockCall || !lockResult || !leaseCall || !leaseResult) throw new Error("handlers were not registered");
	return { lockCall, lockResult, leaseCall, leaseResult };
}

function bashCall(toolCallId: string, command: string, beads: string, cwd = "/repo"): unknown {
	return { toolName: "bash", toolCallId, input: { command, cwd, env: { BEADS_DIR: beads } } };
}

/**
 * Yield the event loop once.
 *
 * A zero-delay macrotask, not a wall-clock wait: the question is only "did the
 * waiter run without its turn?", and the answer is decided by scheduling. It also
 * gives a lossy read-modify-write its interleaving point without guessing at one.
 */
async function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	await promise;
}

describe("embeddedStores", () => {
	test("names the store a mutating bd command writes", () => {
		const beads = store();
		expect(embeddedStores("bd create x -t task", "/repo", { BEADS_DIR: beads })).toEqual([beads]);
	});

	test("leaves a read alone", () => {
		const beads = store();
		expect(embeddedStores("bd list --all --json", "/repo", { BEADS_DIR: beads })).toEqual([]);
	});

	test("follows a global -C to the store that command really writes", () => {
		const beads = store();
		const checkout = join(beads, "..");
		expect(embeddedStores(`bd -C ${checkout} close omp-1`, "/elsewhere", {})).toEqual([beads]);
	});

	test("a command line naming two stores is refused, not partially locked", () => {
		const first = store();
		const second = store();
		const command = `bd -C ${join(first, "..")} create a -t task && bd -C ${join(second, "..")} create b -t task`;
		// Two invocations are not the accepted shape, and locking only one of the two
		// stores would be exactly the confident wrong answer this design removes.
		expect(embeddedWriteTargets(command, "/repo", { BEADS_DIR: first }).kind).toBe("refused");
	});
});

describe("cross-process hold", () => {
	test("a live hold from another process makes a waiter fail closed rather than write", async () => {
		const beads = store();
		writeFileSync(join(beads, LOCK), JSON.stringify({ host: HOST, pid: process.pid, toolCallId: "other", taken: Date.now() }));
		const got = await hold(beads, "mine", 60);
		expect(got.kind).toBe("failed");
		expect(got.kind === "failed" && got.reason).toContain("was refused");
	});

	test("a hold left by a dead process is taken over", async () => {
		const beads = store();
		writeFileSync(join(beads, LOCK), JSON.stringify({ host: HOST, pid: DEAD_PID, toolCallId: "crashed", taken: Date.now() }));
		const got = await hold(beads, "mine", 2_000);
		expect(got.kind).toBe("held");
		release(beads, "mine");
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});

	test("a nested writer joins the hold it is already inside, and the lock outlives it", async () => {
		const beads = store();
		expect((await hold(beads, "call-1")).kind).toBe("held");
		expect((await hold(beads, "call-1", 60)).kind).toBe("held");
		release(beads, "call-1");
		expect(existsSync(join(beads, LOCK))).toBe(true);
		release(beads, "call-1");
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});
});

describe("bdEmbeddedWriteLock", () => {
	test("a second bash mutation waits for the first to report its result", async () => {
		const beads = store();
		const { lockCall, lockResult } = wire();

		expect(await lockCall(bashCall("a", "bd create a -t task", beads))).toBeUndefined();
		let secondEntered = false;
		const second = Promise.resolve(lockCall(bashCall("b", "bd create b -t task", beads))).then(() => {
			secondEntered = true;
		});

		await tick();
		expect(secondEntered).toBe(false);

		lockResult({ toolName: "bash", toolCallId: "a", input: {}, content: [] });
		await second;
		expect(secondEntered).toBe(true);
		lockResult({ toolName: "bash", toolCallId: "b", input: {}, content: [] });
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});
	});

	test("a lock the process cannot create refuses the write instead of running it", async () => {
		const beads = store();
		chmodSync(beads, 0o500);
		const { lockCall } = wire();
		const blocked = (await lockCall(bashCall("a", "bd create a -t task", beads))) as { block?: boolean; reason?: string };
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("could not be taken");
	});
});

describe("the lease stamp shares the store's lock domain", () => {
	test("a stamp for another call waits for the bash mutation holding the store", async () => {
		const beads = store();
		const order: string[] = [];
		setBdRunForTests(() => {
			order.push("stamp");
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const { lockCall, lockResult, leaseCall, leaseResult } = wire();

		await lockCall(bashCall("writer", "bd create a -t task", beads));

		leaseCall(bashCall("claimer", "bd update omp-1 --claim", beads, join(beads, "..")));
		const stamped = Promise.resolve(
			leaseResult({ toolName: "bash", toolCallId: "claimer", input: {}, content: [{ type: "text", text: '{"id":"omp-1"}' }], details: { exitCode: 0 } }),
		);

		await tick();
		expect(order).toEqual([]);

		order.push("bash-write-done");
		lockResult({ toolName: "bash", toolCallId: "writer", input: {}, content: [] });
		await stamped;
		expect(order).toEqual(["bash-write-done", "stamp"]);
	});

	test("a stamp inside the claim's own hold runs without waiting on itself", async () => {
		const beads = store();
		const stamps: string[][] = [];
		setBdRunForTests(argv => {
			stamps.push(argv);
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const { lockCall, lockResult, leaseCall, leaseResult } = wire();

		const claim = bashCall("claim", "bd update omp-1 --claim", beads, join(beads, ".."));
		await lockCall(claim);
		leaseCall(claim);
		await leaseResult({ toolName: "bash", toolCallId: "claim", input: {}, content: [{ type: "text", text: '{"id":"omp-1"}' }], details: { exitCode: 0 } });

		expect(stamps).toHaveLength(1);
		// The claim's own hold is still open; the stamp joined it rather than ending it.
		expect(existsSync(join(beads, LOCK))).toBe(true);
		lockResult({ toolName: "bash", toolCallId: "claim", input: {}, content: [] });
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});
});

/**
 * Parity under concurrent writers.
 *
 * The store stands in for the embedded journal with the property that matters: a
 * write is a read, then work, then a write back, so two writers whose windows
 * overlap lose one of the two edits. The control arm runs the same writers with no
 * lock and MUST lose writes -- without it, a serialisation bug and a store too
 * forgiving to notice look identical.
 */
interface Store {
	issues: string[];
	labels: Record<string, string[]>;
	deps: string[];
	comments: string[];
}

function emptyStore(path: string): void {
	writeFileSync(path, JSON.stringify({ issues: [], labels: {}, deps: [], comments: [] } satisfies Store));
}

async function applyWrite(path: string, kind: string, issue: string, value: string): Promise<void> {
	const state = JSON.parse(readFileSync(path, "utf8")) as Store;
	await tick();
	if (kind === "issue") state.issues.push(issue);
	if (kind === "label") state.labels[issue] = [...(state.labels[issue] ?? []), value];
	if (kind === "dep") state.deps.push(`${issue}->${value}`);
	if (kind === "comment") state.comments.push(value);
	writeFileSync(path, JSON.stringify(state));
}

async function runAgents(beads: string, serialized: boolean): Promise<{ gaps: string[] }> {
	const path = join(beads, "state.json");
	emptyStore(path);
	const wired = serialized ? wire() : undefined;
	const agents = 4;
	const rounds = 3;
	const expected = { issues: [] as string[], labels: [] as string[], deps: [] as string[], comments: [] as string[] };

	const work = Array.from({ length: agents }, async (_unused, agent) => {
		let previous: string | undefined;
		for (let round = 1; round <= rounds; round++) {
			const issue = `a${agent}-r${round}`;
			const writes: Array<[string, string]> = [
				["issue", issue],
				["label", `lab-${issue}`],
				["comment", `note-${issue}`],
			];
			if (previous !== undefined) writes.push(["dep", previous]);
			for (const [kind, value] of writes) {
				const id = `${kind}-${issue}`;
				const event = bashCall(id, `bd ${kind === "issue" ? "create" : "update"} ${issue} --json`, beads);
				if (wired !== undefined) await wired.lockCall(event);
				await applyWrite(path, kind, issue, value);
				if (wired !== undefined) wired.lockResult({ toolName: "bash", toolCallId: id, input: {}, content: [] });
			}
			expected.issues.push(issue);
			expected.labels.push(`lab-${issue}`);
			expected.comments.push(`note-${issue}`);
			if (previous !== undefined) expected.deps.push(`${issue}->${previous}`);
			previous = issue;
		}
	});
	await Promise.all(work);

	const final = JSON.parse(readFileSync(path, "utf8")) as Store;
	const flatLabels = Object.values(final.labels).flat();
	const gaps: string[] = [];
	for (const issue of expected.issues) if (!final.issues.includes(issue)) gaps.push(`issue ${issue}`);
	for (const label of expected.labels) if (!flatLabels.includes(label)) gaps.push(`label ${label}`);
	for (const dep of expected.deps) if (!final.deps.includes(dep)) gaps.push(`dep ${dep}`);
	for (const comment of expected.comments) if (!final.comments.includes(comment)) gaps.push(`comment ${comment}`);
	return { gaps };
}

describe("concurrent isolated writers keep parity", () => {
	test("unserialised writers lose issues, labels, dependencies and comments", async () => {
		const { gaps } = await runAgents(store(), false);
		expect(gaps.length).toBeGreaterThan(0);
	});

	test("the lock preserves every issue, label, dependency and comment", async () => {
		const { gaps } = await runAgents(store(), true);
		expect(gaps).toEqual([]);
	});
});

describe("the hold covers an async write, not just its launch", () => {
	test("another writer cannot enter until the async bd run has finished", async () => {
		const beads = store();
		const order: string[] = [];
		const running = Promise.withResolvers<string>();

		const internal = withEmbeddedWriteLock(join(beads, ".."), "internal", async () => {
			order.push("bd started");
			const out = await running.promise;
			order.push("bd exited");
			return out;
		}, { BEADS_DIR: beads });

		// Let the internal writer take the hold and enter its async body.
		await tick();
		expect(order).toEqual(["bd started"]);

		let entered = false;
		const rival = hold(beads, "rival", 5_000).then(got => {
			entered = got.kind === "held";
			order.push("rival entered");
		});

		await tick();
		expect(entered).toBe(false);
		expect(order).toEqual(["bd started"]);

		running.resolve("done");
		const finished = await internal;
		expect(finished).toEqual({ kind: "done", value: "done" });
		await rival;
		expect(order).toEqual(["bd started", "bd exited", "rival entered"]);
		expect(entered).toBe(true);
		release(beads, "rival");
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});

	test("a rejected write gives the hold back instead of stranding the store", async () => {
		const beads = store();
		const failed = withEmbeddedWriteLock(join(beads, ".."), "internal", async () => {
			throw new Error("bd died");
		}, { BEADS_DIR: beads });
		await expect(failed).rejects.toThrow("bd died");
		expect(existsSync(join(beads, LOCK))).toBe(false);
		expect((await hold(beads, "next", 60)).kind).toBe("held");
		release(beads, "next");
	});
});

describe("a writer that outlasts its lease keeps its turn", () => {
	/**
	 * Real timers, deliberately: the contract is that an event-loop heartbeat renews a
	 * lease while an ASYNC writer runs, so faking the clock would remove the mechanism
	 * under test. Nothing here waits a guessed duration though -- each step waits for
	 * the condition it is about, so a loaded machine makes the test slower rather than
	 * red.
	 */
	async function until(condition: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 5);
			await promise;
		}
	}

	/** The lease another process would read off the file. */
	function expiryOf(beads: string): number {
		return (JSON.parse(readFileSync(join(beads, LOCK), "utf8")) as { expires: number }).expires;
	}

	test("an async write longer than the lease keeps renewing what other processes read", async () => {
		const beads = store();
		setLeaseTimingForTests(200, 10);
		const done = Promise.withResolvers<string>();
		const writing = withEmbeddedWriteLock(join(beads, ".."), "slow", () => done.promise, { BEADS_DIR: beads });
		await until(() => existsSync(join(beads, LOCK)), "the hold to be taken");

		// Another process judges this hold by the file, so the file is what has to stay
		// live past the original lease.
		const first = expiryOf(beads);
		await until(() => expiryOf(beads) > first, "the lease to be renewed");
		expect(expiryOf(beads)).toBeGreaterThan(Date.now());
		// And in-process, a rival still queues rather than joining.
		expect((await hold(beads, "rival", 60)).kind).toBe("failed");

		done.resolve("written");
		expect(await writing).toEqual({ kind: "done", value: "written" });
		expect(existsSync(join(beads, LOCK))).toBe(false);
	});

	test("a release does not delete a lock this process no longer owns", async () => {
		const beads = store();
		// A renewal interval longer than the test, so no heartbeat runs: this isolates
		// the release path from the heartbeat's own ownership check.
		setLeaseTimingForTests(120, 60_000);
		expect((await hold(beads, "stalled")).kind).toBe("held");
		const foreign = { host: "other-host", pid: 4242, toolCallId: "rival", token: "rival-token", taken: Date.now(), expires: Date.now() + 60_000 };
		writeFileSync(join(beads, LOCK), JSON.stringify(foreign));

		release(beads, "stalled");
		expect(JSON.parse(readFileSync(join(beads, LOCK), "utf8"))).toEqual(foreign);
	});

	test("a heartbeat that wakes after a takeover does not overwrite the new owner", async () => {
		const beads = store();
		setLeaseTimingForTests(200, 10);
		expect((await hold(beads, "stalled")).kind).toBe("held");

		// What a takeover leaves behind: the lock file is now another writer's record.
		const foreign = { host: "other-host", pid: 4242, toolCallId: "rival", token: "rival-token", taken: Date.now(), expires: Date.now() + 60_000 };
		writeFileSync(join(beads, LOCK), JSON.stringify(foreign));

		// A fixed wait is safe in the red direction here: a heartbeat that has not
		// fired yet leaves the record untouched, and one that has fired must have left
		// it untouched, so lateness cannot turn this green when CAS is broken.
		const settled = Promise.withResolvers<void>();
		setTimeout(settled.resolve, 120);
		await settled.promise;
		expect(JSON.parse(readFileSync(join(beads, LOCK), "utf8"))).toEqual(foreign);

		// And the stalled holder's own release must not delete a lock it no longer owns.
		release(beads, "stalled");
		expect(JSON.parse(readFileSync(join(beads, LOCK), "utf8"))).toEqual(foreign);
	});
});
