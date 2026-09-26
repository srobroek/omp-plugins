/**
 * One writer at a time for an embedded Beads store.
 *
 * Embedded Dolt resolves a PATH, not a host and port, so every process that walks
 * up to the same `.beads` opens the same journal files with its own engine. Two of
 * them writing at once corrupts the journal, so every writer in reach has to take
 * one turn on one file.
 *
 * Two writers are in reach, and they take their turns in DIFFERENT processes.
 *
 * A plugin-internal `bd` run is this process's own, so `withEmbeddedWriteLock`
 * wraps it directly: acquire, await the run, release in `finally`.
 *
 * A `bd` mutation an agent issues through Bash is not. The only pre-execution seam
 * an extension has is `tool_call`, which fires at arg-prep time -- before
 * concurrency scheduling and before the approval prompt -- and the only settlement
 * signal is `tool_result`, which native Bash reports as soon as it BACKGROUNDS a
 * long command rather than when the command finishes. A hold taken at `tool_call`
 * and dropped at `tool_result` therefore covers the wrong interval at both ends: it
 * starts while the agent is still waiting for approval, and it can end while bd is
 * still writing.
 *
 * So the hold moves into the writing process. The validated command is rewritten to
 * run `bd` under `bd-embedded-write-runner`, a process this package owns which
 * acquires the store's lock, spawns the real `bd`, awaits its exit, and releases in
 * `finally` and on its own death. The runner IS bd's parent, so the hold begins
 * immediately before the mutation and ends when it settles, whatever Bash does with
 * the foreground: an explicitly async or auto-backgrounded call keeps its lock
 * because the runner outlives the tool result, and a killed call releases because
 * the runner dies with it.
 *
 * Nothing about a Bash-originated write is recorded in this process, so there is no
 * session bookkeeping to leak. What stays process-global is the lock domain itself:
 * the descriptors this process owns and the queue of callers waiting on them, both
 * on {@link Registry}, because a plugin reachable through two load paths is
 * instantiated twice and the copies must share one coordinator.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

import {
	type BdInvocation,
	environmentForInput,
	flagEnabled,
	globalValue,
	invocationFromArgv,
} from "./bd-actor-gate.ts";
import { sessionPinFor } from "./beads-store.ts";
import { commandSegments, invocation, leadingCdCwd, type ParsedCommand, tokenize } from "./shell-command.ts";

/** The hold itself. */
const LOCK_NAME = "omp-embedded-write.lock";
/** Mutual exclusion between waiters that both judged one hold abandoned. */
const STEAL_NAME = "omp-embedded-write-steal.lock";

/**
 * A hold's lease, renewed while its writer is still running.
 *
 * A long fixed age was the wrong instrument. A live pid reports only that the
 * PROCESS exists, so a hold whose release path never ran advertised a live holder
 * and stalled every other writer. A lease that must be renewed inverts that: a hold
 * nobody is refreshing expires on its own, while `bd gc` taking ten minutes keeps
 * its turn because its heartbeat keeps saying so.
 *
 * The lease is several renewals wide on purpose. The heartbeat is an event-loop
 * timer, so it cannot fire while something blocks the loop; every writer this
 * plugin owns therefore spawns bd ASYNCHRONOUSLY, and the margin absorbs whatever
 * brief blocking remains. Three consecutive missed renewals are needed to lapse.
 */
const LEASE_MS = 120_000;

/** Renewal cadence, a fraction of the lease so missing one tick cannot expire it. */
const RENEW_MS = 20_000;

/**
 * Default wait for a caller acquiring one store outside a bounded dispatch.
 *
 * A Bash mutation gets a short preflight at tool_call and a separately bounded
 * runner wait. Internal callers keep their own deadline or this default.
 */
const WAIT_MS = 120_000;

/** Maximum tool_call time spent proving that a Bash mutation's store is available. */
const PREFLIGHT_WAIT_MS = 500;

/**
 * How long the runner may wait if contention begins after the preflight.
 *
 * This remains finite, but gives ordinary parallel orchestration enough room for
 * ten short Beads writes to pass through one embedded store without surfacing the
 * lock refusal to the model. A genuinely long hold still gets a diagnostic.
 */
const RUNNER_WAIT_MS = 120_000;

const POLL_MS = 20;

/** Shared test seam so source and the loaded generated bundle use one preflight condition. */
const PREFLIGHT_WAIT_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.preflight-wait-ms.v1");

function preflightWaitMs(): number {
	const configured = Reflect.get(globalThis, PREFLIGHT_WAIT_KEY);
	return typeof configured === "number" ? configured : PREFLIGHT_WAIT_MS;
}

/** Override the preflight wait condition in tests; omit the value to restore production. */
export function setPreflightWaitForTests(waitMs?: number): void {
	if (waitMs === undefined) Reflect.deleteProperty(globalThis, PREFLIGHT_WAIT_KEY);
	else Reflect.set(globalThis, PREFLIGHT_WAIT_KEY, Math.max(0, waitMs));
}

let leaseMs = LEASE_MS;
let renewMs = RENEW_MS;
let nextToken = 0;

/**
 * Shorten the lease so a test can outlast it without waiting two minutes.
 * Pass no argument to restore the shipped timing.
 */
export function setLeaseTimingForTests(lease?: number, renew?: number): void {
	leaseMs = lease ?? LEASE_MS;
	renewMs = renew ?? RENEW_MS;
}

const HOST = hostname().split(".")[0] ?? "localhost";

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Return the operating system's start identity for a process. A PID can be
 * reused after a writer exits, so liveness alone is not enough to protect an
 * expired lock. `ps` is available on the supported Unix hosts; an unavailable
 * identity is deliberately treated as unknown by callers.
 */
export function parseLinuxStatStartIdentity(stat: string): string | undefined {
	const close = stat.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = stat.slice(close + 2).trim().split(/\s+/u);
	const start = fields[19];
	return start !== undefined && start !== "" ? start : undefined;
}

export function processStartIdentity(pid: number): string | undefined {
	try {
		if (process.platform === "linux") {
			// Linux exposes a monotonic process start tick in field 22 of stat.
			// Read after the final ')' because comm may itself contain ')'.
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const identity = parseLinuxStatStartIdentity(stat);
			if (identity !== undefined) return identity;
		}
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 100,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.error || result.status !== 0) return undefined;
		const identity = String(result.stdout ?? "").trim();
		return identity === "" ? undefined : identity;
	} catch {
		return undefined;
	}
}

/** What a hold records, for the next waiter to judge. */
interface Holder {
	host: string;
	pid: number;
	/** Whoever took the hold: a runner process, or a named internal writer. */
	owner: string;
	/**
	 * The `bd` process this hold exists for, once one is running.
	 *
	 * A hold is judged by whether anyone is still writing, and the holder's own pid
	 * does not answer that on its own. A runner killed outright leaves `bd` orphaned
	 * and still writing while nothing renews the lease, so a waiter that looked only
	 * at the dead holder would take the store from a live mutation. Recording the
	 * writer keeps the turn with the process that is actually using it.
	 */
	writer?: number;
	/** OS start identity paired with {@link writer}; protects against PID reuse. */
	writerStart?: string;
	/**
	 * Identifies THIS acquisition, not just the process.
	 *
	 * A renewal has to prove the file is still the hold it took, because a lease can
	 * lapse and be taken over legitimately while its owner is stalled. Without a
	 * token, a late heartbeat from the old owner would overwrite the new owner's
	 * record and two writers would each believe they held the store.
	 */
	token: string;
	taken: number;
	expires: number;
}


/** One lock this process owns: the open descriptor, its sharers, its heartbeat. */
interface OwnedLock {
	fd: number;
	holders: Map<string, number>;
	renew: Timer;
	/** The token written into the file, so a renewal can prove the hold is still ours. */
	token: string;
	/** The `bd` process this hold is for, once {@link attachWriter} has named it. */
	writer: number | undefined;
	/** OS start identity paired with {@link writer}; protects against PID reuse. */
	writerStart: string | undefined;
}

/**
 * One caller's place in the line for a lock.
 *
 * Only the ticket at the head of its queue attempts the exclusive create. Without
 * that, every waiter raced every poll and the winner was whoever the scheduler
 * happened to wake, so a caller could be passed over indefinitely while later
 * arrivals took turn after turn.
 */
interface Ticket {
	/** Ends this ticket's current sleep early, when the lock or the queue moved. */
	wake: (() => void) | undefined;
}

/**
 * Everything about the lock domain that this OS process mutates.
 *
 * Process-global, for the same reason the sibling extensions key their state on
 * `globalThis`: a plugin reachable through two load paths is instantiated twice, and
 * the copies have to share one coordinator. Every mutable field of the protocol
 * lives here rather than in module scope, because a module-scoped map is per copy:
 * the copy that released would not be the copy that had acquired.
 *
 * `owned` holds the descriptors this process owns, keyed by lock path. Its
 * `holders` count is per owner id, which is what separates the two things that look
 * alike. A second acquisition under the SAME id is a nested writer -- a second
 * plugin copy, or an inner mutation inside an outer one -- and joins the hold. A
 * different id is a concurrent writer and waits.
 *
 * `queues` holds those waiters, in arrival order, keyed by the same lock path.
 */
interface Registry {
	owned: Map<string, OwnedLock>;
	queues: Map<string, Ticket[]>;
}

const REGISTRY_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.v1");

function registry(): Registry {
	const holder = globalThis as { [REGISTRY_KEY]?: Registry };
	const existing = holder[REGISTRY_KEY];
	if (existing !== undefined) return existing;
	const created: Registry = { owned: new Map(), queues: new Map() };
	holder[REGISTRY_KEY] = created;
	// A normal exit while a hold is open would otherwise leave the file behind. An
	// abrupt death is covered instead by the lease and the pid check in `abandoned`.
	// Nothing here can throw out of the handler; each step is guarded.
	process.on("exit", () => {
		for (const [lock, held] of created.owned) {
			clearInterval(held.renew);
			try {
				closeSync(held.fd);
			} catch {
				// The fd is gone; the file is what other processes see.
			}
			try {
				withOwnership(lock, held.token, () => unlinkSync(lock));
			} catch {
				// Already taken over or otherwise unavailable; lease recovery remains.
			}
		}
		created.owned.clear();
	});
	return created;
}

/**
 * Verbs proven NOT to write, read from `bd --help` on 1.3.0. Everything absent
 * from this table is treated as a write.
 *
 * The direction is deliberate. A write list has to name every writing verb, and
 * the ones it forgets -- `flatten`, `purge`, `prune`, `compact`, `gc`, `sql`,
 * `dolt push`, `heartbeat`, `unclaim`, `reclaim`, `sync`, `recompute-blocked`,
 * `rename-prefix`, `restore`, `bootstrap`, `doctor`, `events`, `provenance`,
 * `admin`, `migrate`, `conflicts`, `branch`, `vc` -- reach the journal
 * unserialised, which is exactly the failure this lock exists to stop. Forgetting
 * an entry here costs a needless wait instead.
 *
 * A record value means only those subactions are reads; the parent verb's other
 * subactions write. Comment grammar is handled separately and conservatively:
 * only exact `bd comment list` and exact `bd comments <bead-id>` calls are reads.
 * Every other comment form takes the write path.
 */
const READS: Record<string, true | Record<string, true>> = {
	blocked: true,
	children: true,
	completion: true,
	context: true,
	count: true,
	diff: true,
	export: true,
	"find-duplicates": true,
	graph: true,
	help: true,
	history: true,
	human: true,
	info: true,
	"init-safety": true,
	lint: true,
	list: true,
	memories: true,
	onboard: true,
	orphans: true,
	ping: true,
	preflight: true,
	prime: true,
	query: true,
	quickstart: true,
	ready: true,
	recall: true,
	schema: true,
	search: true,
	show: true,
	stale: true,
	state: true,
	status: true,
	statuses: true,
	types: true,
	version: true,
	where: true,
	config: { get: true, list: true },
	dep: { list: true, show: true, tree: true },
	dolt: { diff: true, log: true, status: true },
	epic: { list: true, show: true },
	formula: { list: true, show: true },
	gate: { list: true, show: true },
	kv: { get: true, list: true },
	mol: { list: true, show: true },
	swarm: { list: true, show: true },
};

/**
 * Flags that turn one of the reads above back into a write, read from each verb's
 * own `--help` on bd 1.3.0. `bd orphans --fix` closes issues and `bd preflight
 * --fix` writes too, so a verb being a read is a statement about its bare form.
 */
const WRITE_FLAGS: Record<string, string[]> = {
	orphans: ["--fix", "-f"],
	preflight: ["--fix"],
	ready: ["--claim"],
};

/** A bead id accepted by the exact plural comment-listing form. */
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;

/**
 * Whether this invocation can write the database.
 *
 * Fails closed on every uncertainty: an argv that produced no invocation at all,
 * an unknown verb, and an unknown subaction of a partly-read verb all count as
 * writes. `--help` and bd's own `--readonly` are the only blanket exemptions, and
 * both are decided by bd rather than guessed at here.
 */
export function writesStore(invocation: BdInvocation | undefined): boolean {
	if (invocation === undefined) return true;
	const { verb, args, globals } = invocation;
	if (flagEnabled(globals, ["--help", "-h"]) || flagEnabled(args, ["--help", "-h"])) return false;
	// `--readonly` makes bd itself block writes, so nothing can reach the journal.
	if (flagEnabled(globals, ["--readonly"])) return false;
	if (verb === "comment") return args.length !== 1 || args[0] !== "list";
	if (verb === "comments") return args.length !== 1 || !BEAD_ID.test(args[0] ?? "");
	const rule = READS[verb];
	if (rule === undefined) return true;
	const writeFlags = WRITE_FLAGS[verb];
	if (writeFlags !== undefined && flagEnabled(args, writeFlags)) return true;
	const subaction = args.find(arg => !arg.startsWith("-"));
	if (rule === true) return false;
	return subaction === undefined || rule[subaction] !== true;
}

/**
 * The `.beads` a `bd` run would resolve, given its global flags, directory and
 * environment. `undefined` means the write cannot land in an embedded store here.
 *
 * Every path is canonicalised, so two spellings of one store are one lock domain.
 */
function storeFor(globals: string[], cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	if (flagEnabled(globals, ["--global"])) return undefined;
	if (globalValue(globals, ["--database"]) !== undefined) return undefined;
	const directory = globalValue(globals, ["-C", "--directory"]);
	// `--db` is documented as a database PATH, and only a value that is not an
	// the store this write lands in, and ignoring it let those writes escape.
	const db = globalValue(globals, ["--db"]);
	const base = directory === undefined ? cwd : absolute(directory, cwd);
	if (db !== undefined) {
		const target = absolute(db, base);
		if (!existsSync(target)) return undefined;
		// The value may be the store directory, or a database file inside it.
		return canonical(isDirectory(target) ? target : join(target, ".."));
	}
	if (directory !== undefined) return canonicalStore(sessionPinFor(base));
	const pinned = env.BEADS_DIR;
	// The sibling lifecycle extension pins this onto every bash call and onto the
	// process, so it is the usual answer, and it already names a `.beads` directory
	// rather than a checkout.
	if (pinned !== undefined && pinned !== "") return canonical(absolute(pinned, cwd));
	return canonicalStore(sessionPinFor(cwd));
}

function absolute(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The canonical spelling of a store path.
 *
 * A symlinked or `..`-laden path names the same database as its resolved form, so
 * without this two spellings would take two locks on one journal.
 */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function canonicalStore(store: string | undefined): string | undefined {
	return store === undefined ? undefined : canonical(store);
}

function embedded(store: string): boolean {
	let metadata = "";
	let config = "";
	try {
		metadata = readFileSync(join(store, "metadata.json"), "utf8");
	} catch {
		// An absent carrier proves nothing; the classifier reads both.
	}
	try {
		config = readFileSync(join(store, "config.yaml"), "utf8");
	} catch {
		// Same.
	}
	return metadata !== "" || config !== "";
}

/**
 * The embedded store a plugin-internal `bd` run in `cwd` writes, when there is one.
 *
 * The same resolution the bash boundary uses, so an internal writer joins the
 * store's one lock domain instead of guarding a second file.
 */
export function embeddedStoreFor(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const store = storeFor([], cwd, env);
	return store !== undefined && embedded(store) ? store : undefined;
}


/**
 * Characters that make a command line something other than one simple invocation:
 * separators, pipes, redirections, grouping, escapes, newlines, and command
 * substitution. A bare `$` is absent on purpose -- an expanded ARGUMENT cannot change
 * which store a write reaches, and any store-selecting value is checked separately --
 * so `bd close $ID` stays a direct call.
 *
 * Tested against UNQUOTED tokens only. Applying it to the raw text refused ordinary
 * standalone writes whose OPERANDS contain punctuation, such as
 * `bd create t -d "foo(bar)"` or a note reading `A && B`, and a guard whose
 * remediation is itself refused cannot be cleared. Quoting decides operator
 * recognition, which is exactly what the shell does with it.
 */
const OPERATOR = /[;&|<>(){}\\\n]/;

/**
 * Command substitution, which RUNS something. It disqualifies a token whether or not
 * the token began quoted: `"$(...)"` and `` "`...`" `` both execute inside double
 * quotes, and this tokenizer records only that a token started quoted, never which
 * quote it was. Single quotes would be safe, so this over-refuses them; that is the
 * direction to be wrong in.
 */
const SUBSTITUTION = /\$\(|`/;

/** A store-selecting value the shell would resolve later, so this gate cannot. */
const DEFERRED_VALUE = /[$`~*?[\]]/;

/**
 * The store-selecting globals. A value for one of these decides which database the
 * write lands in, so it must be a literal this gate can resolve now.
 */
const STORE_FLAGS = ["-C", "--directory", "--db", "--database"];

export type WriteTargets =
	| { kind: "stores"; stores: string[] }
	| { kind: "refused"; reason: string };

/**
 * What this bash call may write, or why it cannot be allowed to run.
 *
 * ONE shape is accepted: a whole command that is a single direct `bd` invocation,
 * optionally behind literal `VAR=value` assignments. Its store comes from the
 * runtime's own `cwd` and `env` plus that invocation's explicit `-C` / `--db` /
 * `--directory` / `--database`, which is sound because none of it is inferred from
 * the command text.
 *
 * Everything else that mentions `bd` is refused on an embedded store. That is the
 * whole point of the shape: three rounds of counter-examples -- `timeout 60 bd`,
 * `bash -c 'set -e; bd close x'`, `eval bd close x`, `echo x | xargs bd close`,
 * `find . -exec bd close {} +`, `cd other && bd close x` -- each showed that reading
 * shell semantics out of a string produces confident wrong answers in BOTH
 * directions. An unmodelled form now fails closed by construction, so there is no
 * next hole to find. Over-refusal is expected, immediately visible, and cleared by
 * issuing the `bd` command as its own tool call.
 *
 * Only one store is ever locked for a bash call, because the accepted shape is a
 * single invocation; the array shape is kept for the internal writers that can hold
 * more than one.
 */
export function embeddedWriteTargets(command: string, cwd: string, env: NodeJS.ProcessEnv): WriteTargets {
	const hasBd = commandSegments(command).some(segment => invocation(segment, ["bd"]) !== null);
	if (!hasBd) return { kind: "stores", stores: [] };
	const direct = directInvocation(command);
	if (direct !== undefined) {
		if (direct === "no-write" || !writesStore(direct)) return { kind: "stores", stores: [] };
		const store = storeFor(direct.globals, cwd, env);
		return { kind: "stores", stores: store !== undefined && embedded(store) ? [store] : [] };
	}
	// An embedded store in reach is what gives this gate jurisdiction. The session's own
	// here short-circuited, and an explicit `-C <embedded store>` in the command went
	// unseen. `namedStore` already returns embedded stores only.
	const ambient = storeFor([], cwd, env);
	const at = ambient !== undefined && embedded(ambient) ? ambient : namedStore(command, cwd, env);
	if (at === undefined) return { kind: "stores", stores: [] };
	return {
		kind: "refused",
		reason: [
			`This command mentions \`bd\` in a form the Beads write lock cannot resolve, and ${at} is an embedded store, where two concurrent writers corrupt the Dolt journal.`,
			"The lock accepts exactly one shape: a bash call whose whole command is a single direct `bd` invocation, optionally preceded by literal `VAR=value` assignments, with no separators, pipes, redirections, grouping, command substitutions, escapes or newlines, and with a literal value for `-C` / `--directory` / `--db` / `--database`.",
			"Issue the `bd` command as its own tool call in that form, and run the surrounding work as a separate call. `bd export -o issues.jsonl` rather than a redirection, and one call each rather than `&&`, are accepted.",
		].join(" "),
	};
}

/**
 * A store the command names explicitly, whatever else it does.
 *
 * Literal collection, not analysis: every `-C` / `--directory` / `--db` / `--database`
 * value in the text is resolved, and the first embedded one is returned. Without this,
 * a compound command carrying `-C <embedded store>` escaped whenever the session's own
 */
function namedStore(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	// One extra level: a quoted argument is tokenized too, because
	// `bash -c 'bd -C /embedded close x'` keeps its `-C` inside a single token and the
	// store it names would otherwise go unseen. This can only add a refusal; a payload
	// is never treated as a direct call.
	const words = tokenize(command).flatMap(token => (token.quoted ? tokenize(token.value).map(inner => inner.value) : [token.value]));
	for (const [index, word] of words.entries()) {
		for (const flag of STORE_FLAGS) {
			const value = word === flag ? words[index + 1] : word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : undefined;
			if (value === undefined || DEFERRED_VALUE.test(value)) continue;
			const store = storeFor([flag, value], cwd, env);
			if (store !== undefined && embedded(store)) return store;
		}
	}
	return undefined;
}

/**
 * The invocation when the WHOLE command is one direct `bd` call, else `undefined`.
 *
 * Trivially checkable on purpose. Every test here is a property of the text or of one
 * token; none of them asks what the shell would do.
 */
function directInvocation(command: string): BdInvocation | "no-write" | undefined {
	const tokens = tokenize(command);
	// Substitution disqualifies a token whatever its quoting; operators only unquoted.
	if (tokens.some(token => SUBSTITUTION.test(token.value))) return undefined;
	if (tokens.some(token => !token.quoted && OPERATOR.test(token.value))) return undefined;
	let i = 0;
	// A real assignment token, not a regex over the raw command.
	while (tokens[i] !== undefined && tokens[i]?.quoted === false && /^[A-Za-z_]\w*=/.test(tokens[i]?.value ?? "")) i++;
	const head = tokens[i];
	if (head === undefined || head.quoted) return undefined;
	const base = head.value.split("/").pop() ?? head.value;
	if (base !== "bd") return undefined;
	const invocation = invocationFromArgv(tokens.slice(i + 1).map(token => token.value));
	// `bd`, `bd --version` and `bd --help` carry no verb: recognised, and no write.
	if (invocation === undefined) return "no-write";
	// The store must be resolvable now; a value the shell expands later is not.
	for (const flag of STORE_FLAGS) {
		const value = globalValue(invocation.globals, [flag]);
		if (value !== undefined && DEFERRED_VALUE.test(value)) return undefined;
	}
	return invocation;
}

/** Every embedded store this bash call will write; empty when nothing does. */
export function embeddedStores(command: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
	const targets = embeddedWriteTargets(command, cwd, env);
	return targets.kind === "stores" ? targets.stores : [];
}

function ageOf(path: string): number {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function lockHolder(lock: string): string {
	let ageMs = ageOf(lock);
	try {
		const parsed = JSON.parse(readFileSync(lock, "utf8")) as Partial<Holder>;
		if (typeof parsed.taken === "number") ageMs = Math.max(0, Date.now() - parsed.taken);
		const owner = typeof parsed.owner === "string" && parsed.owner.length > 0 ? parsed.owner : "unknown owner";
		const pid = typeof parsed.pid === "number" ? `pid ${parsed.pid}` : "pid unknown";
		const writer = typeof parsed.writer === "number" ? `, writer pid ${parsed.writer}` : "";
		const host = typeof parsed.host === "string" && parsed.host.length > 0 ? ` on ${parsed.host}` : "";
		return `holder ${owner} (${pid}${writer}${host}), age ${Math.round(ageMs / 1000)}s`;
	} catch {
		return `holder record unreadable, age ${Math.round(Math.max(0, ageMs) / 1000)}s`;
	}
}

/**
 * Whether an existing hold may be taken over.
 *
 * Three grounds, in the order a waiter can trust them.
 * A live writer whose recorded start identity still matches settles it outright;
 * a reused PID does not. Otherwise a dead holder pid on this host is the fast
 * answer for a process that went away, and an expired lease is the general one:
 * nobody renewed it, so nobody is waiting on the write it guarded. An unreadable
 * or unparseable file, and a hold from a version that recorded no lease, are
 * judged by the lease length alone.
 */
function abandoned(lock: string): boolean {
	let raw: string;
	try {
		raw = readFileSync(lock, "utf8");
	} catch {
		// Released while we were reading it; the next create attempt settles it.
		return false;
	}
	let holder: Partial<Holder>;
	try {
		holder = JSON.parse(raw) as Partial<Holder>;
	} catch {
		return ageOf(lock) > leaseMs;
	}
	const local = holder.host === HOST;
	if (local && typeof holder.writer === "number") {
		const currentStart = processStartIdentity(holder.writer);
		const sameWriter = typeof holder.writerStart !== "string" || currentStart === undefined || currentStart === holder.writerStart;
		if (pidAlive(holder.writer) && sameWriter) return false;
	}
	if (local && typeof holder.pid === "number" && !pidAlive(holder.pid)) return true;
	if (typeof holder.expires === "number") return Date.now() > holder.expires;
	// A hold from a version that recorded no lease still has to be recoverable.
	return ageOf(lock) > leaseMs;
}

/**
 * Take over a hold whose owner is gone.
 *
 * Under a second lock, and re-reading the hold while under it: two waiters that
 * both judged one hold abandoned would otherwise each unlink it, and the second
 * unlink would delete the FRESH hold the first one had just created.
 *
 * The steal lock is judged the same way as the hold it guards rather than by a
 * fixed few seconds. A stealer slowed past a short deadline is still working, and
 * clearing its turn on age alone reopened the race this lock exists to close.
 */
function takeOverIfAbandoned(lock: string, steal: string): void {
	if (!abandoned(lock)) return;
	let fd: number;
	try {
		fd = openSync(steal, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
		if (abandoned(steal)) {
			try {
				unlinkSync(steal);
			} catch {
				// Another waiter cleared it first.
			}
		}
		return;
	}
	try {
		writeSync(fd, JSON.stringify(holderNow(`steal-${process.pid}`, `steal-${(nextToken++).toString(36)}`, undefined)));
		if (abandoned(lock)) unlinkSync(lock);
	} catch {
		// The hold went away on its own.
	} finally {
		closeSync(fd);
		try {
			unlinkSync(steal);
		} catch {
			// Cleared as stale by a waiter; harmless.
		}
	}
}

function holderNow(owner: string, token: string, writer: number | undefined, writerStart = writer === undefined ? undefined : processStartIdentity(writer)): Holder {
	const taken = Date.now();
	return {
		host: HOST,
		pid: process.pid,
		owner,
		token,
		taken,
		expires: taken + leaseMs,
		...(writer === undefined ? {} : { writer, ...(writerStart === undefined ? {} : { writerStart }) }),
	};
}

/** Whether the file at `lock` still records the hold this process took. */
function stillOurs(lock: string, token: string): boolean {
	try {
		const holder = JSON.parse(readFileSync(lock, "utf8")) as Partial<Holder>;
		return holder.token === token && holder.pid === process.pid && holder.host === HOST;
	} catch {
		return false;
	}
}

export type Hold = { kind: "held" } | { kind: "failed"; reason: string };

/**
 * Sleep up to `ms`, ending early when this ticket is woken or `signal` aborts.
 *
 * A raw timer with no `ctx` in scope: every callback here is a resolver, so none of
 * them can throw and none can reach `uncaughtException`.
 */
async function pause(ticket: Ticket, ms: number, signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = (): void => resolve();
	ticket.wake = done;
	const timer = setTimeout(done, ms);
	signal?.addEventListener("abort", done, { once: true });
	try {
		await promise;
	} finally {
		ticket.wake = undefined;
		clearTimeout(timer);
		signal?.removeEventListener("abort", done);
	}
}

/** Let the caller at the head of `lock`'s queue try again now. */
function wakeHead(lock: string): void {
	registry().queues.get(lock)?.[0]?.wake?.();
}

/**
 * Hold `store` for `owner`, waiting in line for whoever has it.
 *
 * `owner` names the writer, and two acquisitions under one name are one writer
 * nested inside itself rather than two competing for the store.
 *
 * Fails closed. A lock error that is not a live hold, a wait that runs out, and an
 * aborted caller all return `failed`: a write that could not be serialised must not
 * proceed, because the damage it risks is the database rather than the one command.
 *
 * `signal` is what makes a wait abandonable. A caller whose work has been cancelled
 * -- its command killed, its session shutting down -- stops waiting at once, leaves
 * the queue, and never acquires afterwards, so the turn it gave up goes to the next
 * caller instead of being taken by a caller nobody is waiting on.
 */
export async function hold(
	store: string,
	owner: string,
	waitMs: number = WAIT_MS,
	signal?: AbortSignal,
): Promise<Hold> {
	const lock = join(store, LOCK_NAME);
	const { owned, queues } = registry();
	const deadline = Date.now() + waitMs;
	const queue = queues.get(lock) ?? [];
	if (queue.length === 0) queues.set(lock, queue);
	const ticket: Ticket = { wake: undefined };
	queue.push(ticket);
	try {
		while (true) {
			const held = owned.get(lock);
			if (held !== undefined) {
				const nested = held.holders.get(owner);
				// A nested writer joins its own hold rather than queueing behind itself,
				// whichever place in the line its ticket happens to hold.
				if (nested !== undefined) {
					held.holders.set(owner, nested + 1);
					return { kind: "held" };
				}
			} else if (queue[0] === ticket) {
				try {
					// Exclusive create is the whole cross-process guarantee, and nothing
					// between it and the registry write awaits, so it also settles two
					// writers racing inside this process.
					const fd = openSync(lock, "wx");
					const token = `${process.pid}-${Date.now()}-${(nextToken++).toString(36)}`;
					writeSync(fd, JSON.stringify(holderNow(owner, token, undefined)));
					// A raw interval in a helper with no `ctx`: the body is fully guarded, so
					// no renewal failure can escape as an uncaughtException, and `release`
					// and the exit handler both clear it.
					const renew = setInterval(() => {
						try {
							renewLease(lock, owner, token);
						} catch {
							// A lease that cannot be renewed simply expires, which is the
							// safe direction: another writer takes over rather than stalls.
						}
					}, renewMs);
					// The heartbeat must not be a reason the process stays alive.
					renew.unref?.();
					owned.set(lock, { fd, holders: new Map([[owner, 1]]), renew, token, writer: undefined, writerStart: undefined });
					return { kind: "held" };
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "EEXIST") {
						return {
							kind: "failed",
							reason: `Beads embedded write lock could not be taken at ${lock} (${code ?? "unknown error"}). The write was refused rather than risk a second writer on the embedded Dolt journal.`,
						};
					}
					takeOverIfAbandoned(lock, join(store, STEAL_NAME));
				}
			}
			// Checked after the attempt, so a caller aborted while its turn was already
			// available still gets the hold it can release, rather than leaving the file
			// created and unowned.
			if (signal?.aborted === true) {
				return {
					kind: "failed",
					reason: `Waiting for the Beads embedded write lock at ${lock} was cancelled before this writer got its turn. Nothing was written.`,
				};
			}
			if (Date.now() >= deadline) {
				const holder = lockHolder(lock);
				return {
					kind: "failed",
					reason: `Beads embedded write lock at ${lock} stayed held for ${Math.round(waitMs / 1000)}s; ${holder}. The write was refused rather than run concurrently. Read the lock file, then remove it once its holder is really gone.`,
				};
			}
			await pause(ticket, Math.min(POLL_MS, deadline - Date.now()), signal);
		}
	} finally {
		const index = queue.indexOf(ticket);
		if (index >= 0) queue.splice(index, 1);
		if (queue.length === 0) queues.delete(lock);
		// A ticket that left the head -- acquired, timed out, or abandoned -- promotes
		// the next one, which is still asleep on its poll timer.
		else if (index === 0) queue[0]?.wake?.();
	}
}

type OwnershipResult = "done" | "busy" | "lost";

/** Serialize record replacement and deletion with stale-holder takeover. */
function withOwnership(storeLock: string, token: string, change: () => void): OwnershipResult {
	const steal = join(dirname(storeLock), STEAL_NAME);
	let fd: number;
	try {
		fd = openSync(steal, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "busy";
		throw error;
	}
	try {
		if (!stillOurs(storeLock, token)) return "lost";
		change();
		return "done";
	} finally {
		closeSync(fd);
		try { unlinkSync(steal); } catch { /* A competing cleanup already removed it. */ }
	}
}

/**
 * Give up one share of `store`, releasing the lock when it was the last.
 *
 * The next caller in line is woken rather than left to find out on its own poll, so
 * a released store changes hands in arrival order and within one tick.
 */
export function release(store: string, owner: string): void {
	const lock = join(store, LOCK_NAME);
	const owned = registry().owned;
	const held = owned.get(lock);
	if (held === undefined) return;
	const shares = held.holders.get(owner);
	if (shares === undefined) return;
	if (shares > 1) {
		held.holders.set(owner, shares - 1);
		return;
	}
	held.holders.delete(owner);
	if (held.holders.size > 0) return;
	owned.delete(lock);
	clearInterval(held.renew);
	try {
		closeSync(held.fd);
	} catch {
		// Nothing to do; the file is what other processes see.
	}
	// Serialize the token check and unlink with stale-holder takeover. Without the
	// steal lock, a stalled release could unlink a successor's newly-created hold.
	try {
		withOwnership(lock, held.token, () => unlinkSync(lock));
	} catch {
		// The lease makes a failed cleanup recoverable without risking another owner.
	}
	wakeHead(lock);
}

/**
 * Release a short Bash preflight and prove its token is gone before dispatch.
 *
 * `release` deliberately stays synchronous for existing callers. If its token-checked
 * unlink races another process holding the steal lock, it can leave the main lock for
 * lease recovery. A preflight cannot accept that: rewriting while its own live token
 * remains would make the runner wait behind the gate that launched it.
 */
async function releasePreflight(store: string, owner: string, deadline: number): Promise<Hold> {
	const lock = join(store, LOCK_NAME);
	const token = registry().owned.get(lock)?.token;
	if (token === undefined) {
		return { kind: "failed", reason: `Beads embedded write lock at ${lock} lost its preflight ownership record. The write was refused before the serialising runner started.` };
	}
	release(store, owner);
	const ticket: Ticket = { wake: undefined };
	while (stillOurs(lock, token)) {
		try {
			const result = withOwnership(lock, token, () => unlinkSync(lock));
			if (result !== "busy") break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return { kind: "failed", reason: `Beads embedded write lock at ${lock} could not release its preflight token (${code ?? "unknown error"}). The write was refused before the serialising runner started.` };
		}
		if (Date.now() >= deadline) {
			return { kind: "failed", reason: `Beads embedded write lock at ${lock} could not release its preflight token because ${join(store, STEAL_NAME)} stayed held. The write was refused before the serialising runner started.` };
		}
		await pause(ticket, Math.min(POLL_MS, deadline - Date.now()), undefined);
	}
	if (existsSync(lock)) {
		return { kind: "failed", reason: `Beads embedded write lock at ${lock} changed ownership before preflight release completed. The write was refused before the serialising runner started.` };
	}
	return { kind: "held" };
}

/**
 * Push this hold's expiry out, so a lease only lapses when nobody is renewing it.
 *
 * Compare-and-set, never a blind write. If this hold's lease lapsed while its
 * writer was stalled, another writer may already own the file legitimately; a
 * blind rewrite would stamp our record over theirs and leave two writers each
 * believing they held the store. Losing the token means we no longer hold it, so
 * the heartbeat stops and the registry entry goes with it.
 */
function renewLease(lock: string, owner: string, token: string): void {
	const owned = registry().owned;
	const held = owned.get(lock);
	if (held === undefined || held.token !== token) return;
	const result = withOwnership(lock, token, () => {
		const fd = openSync(lock, "w");
		try {
			writeSync(fd, JSON.stringify(holderNow(owner, token, held.writer, held.writerStart)));
		} finally {
			closeSync(fd);
		}
	});
	if (result !== "lost") return;
	clearInterval(held.renew);
	owned.delete(lock);
	try { closeSync(held.fd); } catch { /* The descriptor is already gone. */ }
}

/**
 * Publish the gated child before allowing it to exec `bd`.
 *
 * A short-lived steal lock can transiently occupy the ownership side lock while
 * another writer is releasing or renewing its lease. Retrying that contention is
 * safe while this process still owns the main lock; a lost token remains a refusal.
 */
export async function attachWriter(store: string, owner: string, pid: number): Promise<boolean> {
	const lock = join(store, LOCK_NAME);
	const held = registry().owned.get(lock);
	if (held === undefined || !held.holders.has(owner)) return false;
	const writerStart = processStartIdentity(pid);
	const deadline = Date.now() + POLL_MS;
	while (true) {
		const result = withOwnership(lock, held.token, () => {
			const fd = openSync(lock, "w");
			try {
				writeSync(fd, JSON.stringify(holderNow(owner, held.token, pid, writerStart)));
			} finally {
				closeSync(fd);
			}
		});
		if (result === "done") {
			held.writer = pid;
			held.writerStart = writerStart;
			return true;
		}
		if (result === "lost" || Date.now() >= deadline) return false;
		await new Promise<void>(resolve => setTimeout(resolve, Math.min(POLL_MS, deadline - Date.now())));
	}
}

/**
 * Run `write`, a plugin-internal `bd` mutation, inside the store's lock.
 *
 * `cwd` is the directory the mutation runs in; a store that is not embedded needs no
 * turn and the mutation runs straight away.
 *
 * `write` is AWAITED before the hold is given up. Returning the promise instead
 * would release while the bd process it represents was still running -- the hold
 * would cover spawning the writer rather than the write -- and every internal caller
 * here spawns asynchronously. A synchronous `write` is unaffected: `await` on a plain
 * value resolves immediately, and `value` reaches the caller settled either way. A
 * `write` that rejects releases too, and its rejection propagates.
 *
 * `signal` abandons the wait for a turn; it does not interrupt a `write` that has
 * already started, because a half-applied mutation is worse than a slow one.
 */
export async function withEmbeddedWriteLock<T>(
	cwd: string,
	owner: string,
	write: () => T | PromiseLike<T>,
	env: NodeJS.ProcessEnv = process.env,
	deadline?: number,
	signal?: AbortSignal,
): Promise<{ kind: "done"; value: T } | { kind: "failed"; reason: string }> {
	const store = embeddedStoreFor(cwd, env);
	if (store === undefined) return { kind: "done", value: await write() };
	const waitMs = deadline === undefined ? WAIT_MS : Math.max(0, deadline - Date.now());
	const got = await hold(store, owner, waitMs, signal);
	if (got.kind === "failed") return got;
	try {
		return { kind: "done", value: await write() };
	} finally {
		release(store, owner);
	}
}

/** The runner's own file name, without the extension its build gives it. */
const RUNNER_STEM = "bd-embedded-write-runner";

/** The runner's store flag, which is also how a rewritten command is recognised. */
export const RUNNER_STORE_FLAG = "--beads-store";

/** The runner's wait flag, in milliseconds. */
export const RUNNER_WAIT_FLAG = "--beads-wait-ms";

/**
 * The Bun binary and the runner script, or `undefined` when either is unreachable.
 *
 * The interpreter cannot be assumed from `process.execPath`. OMP ships as a compiled
 * single-file executable, so that path is the `omp` binary, which cannot run a
 * script; on a source install it IS Bun, which can. Both are handled, and PATH,
 * `BUN_INSTALL`, and mise's resolved tool path cover the compiled case.
 *
 * The script sits beside this module whichever way the plugin was loaded: next to the
 * bundle in `dist/` when the package ships built, and next to the source in
 * `extensions/` when OMP imports the TypeScript directly.
 */
export type BunDiscovery = {
	execPath?: string;
	which?: (name: string) => string | undefined | null;
	environment?: NodeJS.ProcessEnv;
	miseWhich?: (mise: string) => string | undefined;
};

export function embeddedWriteRunner(): { interpreter: string; script: string } | undefined {
	const here = import.meta.dir;
	const script = [
		join(here, `${RUNNER_STEM}.js`),
		join(here, `${RUNNER_STEM}.ts`),
		join(here, "..", "dist", `${RUNNER_STEM}.js`),
		join(here, "..", "extensions", `${RUNNER_STEM}.ts`),
	].find(candidate => existsSync(candidate));
	if (script === undefined) return undefined;
	const interpreter = bunBinary();
	return interpreter === undefined ? undefined : { interpreter, script: resolve(script) };
}

function bunBinary(): string | undefined {
	return resolveBunBinary({
		execPath: process.execPath,
		which: name => (typeof Bun === "undefined" ? undefined : Bun.which(name)),
		environment: process.env,
		miseWhich: mise => {
			try {
				const result = Bun.spawnSync({ cmd: [mise, "which", "bun"], stdout: "pipe", stderr: "pipe" });
				if (result.exitCode !== 0) return undefined;
				return new TextDecoder().decode(result.stdout).trim();
			} catch {
				return undefined;
			}
		},
	});
}

/** Resolve Bun without trusting the compiled OMP executable as an interpreter. */
export function resolveBunBinary(options: BunDiscovery = {}): string | undefined {
	const execPath = options.execPath ?? process.execPath;
	const own = basename(execPath);
	if (own === "bun" || own === "bun.exe") return execPath;
	const onPath = options.which?.("bun");
	if (onPath !== null && onPath !== undefined) return onPath;
	const install = options.environment?.BUN_INSTALL;
	if (install !== undefined && install !== "") {
		const guess = join(install, "bin", "bun");
		if (existsSync(guess)) return guess;
	}
	const mise = options.which?.("mise");
	if (mise === null || mise === undefined || options.miseWhich === undefined) return undefined;
	const resolved = options.miseWhich(mise);
	return resolved !== undefined && basename(resolved).startsWith("bun") && existsSync(resolved) ? resolved : undefined;
}

/**
 * One shell word, quoted so the shell hands it back unchanged.
 *
 * Single quotes suspend every expansion the shell would otherwise perform, and an
 * embedded single quote is closed, escaped and reopened. The rewritten command is
 * built entirely from words that went through here, so nothing in a bead id, a note,
 * or a store path can be read as syntax.
 */
function quote(word: string): string {
	return `'${word.replaceAll("'", "'\\''")}'`;
}

type NormalizedDirectCommand = { command: string; cwd: string };

/** Accept only a literal `cd DIR &&` prefix; shell expansion remains refused. */
function normalizeDirectCommand(command: string, cwd: string): NormalizedDirectCommand | undefined {
	const match = /^\s*cd\s+([^\s;&|]+)\s*&&\s*([\s\S]+?)\s*$/.exec(command);
	if (match === null) return { command, cwd };
	const dir = match[1] ?? "";
	if (!dir || /^[-~$]/.test(dir) || /[\\`"'*?\x5b\x5d{}]/.test(dir)) return undefined;
	return { command: match[2] ?? "", cwd: leadingCdCwd(command, cwd) };
}

/**
 * Split a validated direct call into its assignment prefix and original command text.
 *
 * The outer shell must expand operands before the runner receives argv. Rebuilding every
 * token as a quoted word would turn `bd close $ID` into a request for the literal `$ID`.
 * Keeping the validated call text after `--` preserves expansion without asking the
 * runner to evaluate shell syntax. Assignment spelling is preserved for the same reason.
 */
function directShell(command: string): { assignments: string; call: string } | undefined {
	const tokens = tokenize(command);
	if (tokens.some(token => SUBSTITUTION.test(token.value))) return undefined;
	if (tokens.some(token => !token.quoted && OPERATOR.test(token.value))) return undefined;
	let assignments = 0;
	while (tokens[assignments] !== undefined && tokens[assignments]?.quoted === false && /^[A-Za-z_]\w*=/.test(tokens[assignments]?.value ?? "")) assignments++;
	const head = tokens[assignments];
	if (head === undefined || head.quoted || (head.value.split("/").pop() ?? head.value) !== "bd") return undefined;
	const match = /^\s*((?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|[^\s]+)\s+)*)((?:[^\s]+\/)?bd(?:\s[\s\S]*)?)\s*$/.exec(command);
	if (match === null || tokenize(match[1] ?? "").length !== assignments) return undefined;
	return { assignments: match[1] ?? "", call: match[2] ?? "" };
}

/** What the Bash gate does with a call: nothing, refuse it, or run it under the runner. */
export type EmbeddedWriteDecision =
	| { kind: "block"; reason: string }
	| { kind: "rewrite"; input: Record<string, unknown> };

/**
 * Shared Bash dispatcher called by bash-gates.ts after the command is parsed.
 *
 * Takes no hold of its own. A hold taken here would start before the approval prompt
 * and would have to be given up on a `tool_result` that native Bash reports as soon as
 * it backgrounds the command, so it would guard the wrong interval at both ends.
 * Instead the command is rewritten to run under the runner, which holds the store for
 * exactly as long as the `bd` process it is the parent of.
 *
 * Fails closed throughout. A refusal from the target classifier, a command that
 * resolved a store without being the single direct invocation the classifier accepts,
 * an unreachable runner, and any thrown error all block the call: an unserialised
 * write risks the database rather than the one command.
 */
export async function decideEmbeddedWrite(
	parsed: ParsedCommand,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	deadline = Date.now() + 25_000,
	runnerLookup: () => { interpreter: string; script: string } | undefined = embeddedWriteRunner,
): Promise<EmbeddedWriteDecision | undefined> {
	try {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown; cmd?: unknown; cwd?: unknown };
		const whole = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd());
		const env = environmentForInput(event.input);
		const normalized = normalizeDirectCommand(whole, cwd);
		if (normalized === undefined) return { kind: "block", reason: "This command changes directory dynamically; issue the `bd` command with the tool's cwd field instead." };
		const commandCwd = normalized.cwd;
		const sources = [...parsed.commands.map(position => position.raw)];
		const visit = (child: ParsedCommand): void => {
			sources.push(...child.commands.map(position => position.raw));
			for (const nested of child.nested) visit(nested);
		};
		for (const nested of parsed.nested) visit(nested);
		const targets: string[] = [];
		for (const source of sources) {
			const result = embeddedWriteTargets(source, commandCwd, env);
			if (result.kind === "refused") return { kind: "block", reason: result.reason };
			targets.push(...result.stores);
		}
		const unique = [...new Set(targets)];
		if (unique.length === 0) return;
		const store = unique[0];
		const direct = directShell(normalized.command);
		// The classifier only returns a store for a whole-command direct invocation, so
		// disagreement here means the two no longer read the same shape. Refuse rather
		// than run the mutation with no hold at all.
		if (store === undefined || unique.length > 1 || direct === undefined) {
			return {
				kind: "block",
				reason: `This command reaches the embedded store${unique.length > 1 ? "s" : ""} ${unique.join(", ")} in a form the Beads write lock cannot run under its serialising runner. Issue the \`bd\` command as its own tool call, as a single direct invocation.`,
			};
		}
		const runner = runnerLookup();
		if (runner === undefined) {
			return {
				kind: "block",
				reason: `${store} is an embedded store, where two concurrent writers corrupt the Dolt journal, and the Beads write-lock runner that serialises writers could not be located: no \`bun\` binary was found on PATH, in BUN_INSTALL, through mise, or as this process's own interpreter, or the runner script is missing from the installed plugin. Install \`bun\` or reinstall the @srobroek/beads plugin; the write was refused rather than run unserialised.`,
			};
		}
		const preflightOwner = `tool-call-preflight:${event.toolCallId}`;
		const preflightDeadline = Math.min(deadline, Date.now() + preflightWaitMs());
		const preflight = await hold(store, preflightOwner, Math.max(0, preflightDeadline - Date.now()));
		if (preflight.kind === "failed") return { kind: "block", reason: preflight.reason };
		const released = await releasePreflight(store, preflightOwner, preflightDeadline);
		if (released.kind === "failed") return { kind: "block", reason: released.reason };
		const runnerPrefix = `BEADS_DOLT_SHARED_SERVER= BEADS_DIR=${quote(store)} `;
		const rewritten = `${direct.assignments}${runnerPrefix}${quote(runner.interpreter)} ${quote(runner.script)} ${RUNNER_STORE_FLAG} ${quote(store)} ${RUNNER_WAIT_FLAG} ${RUNNER_WAIT_MS} -- ${direct.call}`;
		const next: Record<string, unknown> = { ...(event.input as Record<string, unknown>) };
		// The runner inherits its store from command-local assignments. An unnamed Bash
		// call cannot carry host env/pty/ready options, so do not pass those fields along
		// after replacing the command with the runner process.
		if (typeof next.name !== "string" || next.name === "") {
			delete next.env;
			delete next.ready;
			delete next.pty;
		}
		next.cwd = commandCwd;
		// `cmd` is the alias some hosts send; whichever one carried the command carries
		// the rewrite, so the runner is what actually runs.
		if (typeof input.command === "string") next.command = rewritten;
		else next.cmd = rewritten;
		return { kind: "rewrite", input: next };
	} catch {
		return { kind: "block", reason: "embedded write target could not be resolved" };
	}
}
