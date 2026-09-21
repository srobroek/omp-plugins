/**
 * One writer at a time for an embedded Beads store.
 *
 * Embedded Dolt resolves a PATH, not a host and port, so every process that walks
 * up to the same `.beads` opens the same journal files with its own engine. An
 *
 * Both writers this plugin can see share that one domain: the bash calls an agent
 * makes, held here from `tool_call` to `tool_result`, and the lease stamp
 * `bd-lease-gate` runs itself. The stamp fires in a `tool_result` for the same call
 * whose hold may still be open, so holds are counted per tool call and a nested
 * writer joins the hold it is already inside rather than waiting on itself.
 */

import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import {
	type BdInvocation,
	environmentForInput,
	flagEnabled,
	globalValue,
	invocationFromArgv,
} from "./bd-actor-gate.ts";
import { sessionPinFor } from "./beads-store.ts";
import { commandSegments, invocation, type ParsedCommand, tokenize } from "./shell-command.ts";

/** The hold itself. */
const LOCK_NAME = "omp-embedded-write.lock";
/** Mutual exclusion between waiters that both judged one hold abandoned. */
const STEAL_NAME = "omp-embedded-write-steal.lock";

/**
 * A hold's lease, renewed while its writer is still running.
 *
 * A long fixed age was the wrong instrument. A live pid reports only that the
 * PROCESS exists, so a hold whose release path never ran --
 * a bash call the host timed out, blocked, denied approval for, or aborted after
 * this extension had already acquired -- advertised a live holder and stalled every
 * other writer. A lease that must be renewed inverts that: a hold nobody is
 * refreshing expires on its own, while `bd gc` taking ten minutes keeps its turn
 * because its heartbeat keeps saying so.
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
 * How long a writer waits for its turn before failing closed.
 *
 * It MUST stay under the 30s the harness allows a tool_call handler: a longer wait is killed
 * mid-wait, so the caller reads "handler timed out" instead of the refusal this writes, and the
 * lock this call may already hold elsewhere keeps being renewed until the lease surrenders it.
 */
const WAIT_MS = 20_000;

const POLL_MS = 20;

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

/** What a hold records, for the next waiter to judge. */
interface Holder {
	host: string;
	pid: number;
	toolCallId: string;
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
}

/**
 * Holds this OS process owns, keyed by lock path.
 *
 * Process-global, for the same reason the sibling extensions key their state on
 * `globalThis`: a plugin reachable through two load paths is instantiated twice,
 * and two instances handling ONE tool call must share one hold rather than have
 * the second wait forever on the first.
 *
 * `holders` counts per tool call, which is what separates the two things that look
 * alike. A second acquisition under the SAME tool call is a nested writer -- the
 * lease stamp inside a claim's own `tool_result`, or a second plugin instance -- and
 * joins the hold. A different tool call is a concurrent writer and waits.
 */
interface Registry {
	owned: Map<string, OwnedLock>;
}

const REGISTRY_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.v1");

function registry(): Registry {
	const holder = globalThis as { [REGISTRY_KEY]?: Registry };
	const existing = holder[REGISTRY_KEY];
	if (existing !== undefined) return existing;
	const created: Registry = { owned: new Map() };
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
				unlinkSync(lock);
			} catch {
				// Already taken over.
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
 * subactions write. `idOnly` is for a verb whose read form takes an issue id where
 * a subaction would otherwise sit -- `bd comments <id>` lists, `bd comments add <id>`
 * writes, and there is no `bd comments list` -- so the read is recognised by the
 * argument being bead-shaped. A subcommand word there, including one bd adds later,
 * is a write.
 */
const READS: Record<string, true | "idOnly" | Record<string, true>> = {
	blocked: true,
	children: true,
	comments: "idOnly",
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

/** A bead id, which is what stands where a subaction would for an `idOnly` read. */
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

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
	const rule = READS[verb];
	if (rule === undefined) return true;
	const writeFlags = WRITE_FLAGS[verb];
	if (writeFlags !== undefined && flagEnabled(args, writeFlags)) return true;
	const subaction = args.find(arg => !arg.startsWith("-"));
	if (rule === true) return false;
	if (rule === "idOnly") return subaction === undefined || !BEAD_ID.test(subaction);
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

/**
 * Whether an existing hold may be taken over.
 *
 * Two independent grounds, and the lease is the one that matters for a hold whose
 * owner is still running: an expired lease means nobody renewed it, so nobody is
 * waiting on the write it guarded. A dead pid on THIS host is the faster answer
 * when the whole process went away. An unreadable or unparseable file is judged by
 * the lease length alone.
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
	if (holder.host === HOST && typeof holder.pid === "number" && !pidAlive(holder.pid)) return true;
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
		writeSync(fd, JSON.stringify(holderNow(`steal-${process.pid}`, `steal-${(nextToken++).toString(36)}`)));
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

function holderNow(toolCallId: string, token: string): Holder {
	const taken = Date.now();
	return { host: HOST, pid: process.pid, toolCallId, token, taken, expires: taken + leaseMs };
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
 * Hold `store` for `toolCallId`, waiting for whoever has it.
 *
 * Fails closed. A lock error that is not a live hold, and a wait that runs out,
 * both return `failed`: a write that could not be serialised must not proceed,
 * because the damage it risks is the database rather than the one command.
 */
export async function hold(store: string, toolCallId: string, waitMs: number = WAIT_MS): Promise<Hold> {
	const lock = join(store, LOCK_NAME);
	const owned = registry().owned;
	const deadline = Date.now() + waitMs;
	while (true) {
		const owner = owned.get(lock);
		if (owner !== undefined) {
			const nested = owner.holders.get(toolCallId);
			if (nested !== undefined) {
				owner.holders.set(toolCallId, nested + 1);
				return { kind: "held" };
			}
		} else {
			try {
				// Exclusive create is the whole cross-process guarantee, and nothing
				// between it and the registry write awaits, so it also settles two
				// writers racing inside this process.
				const fd = openSync(lock, "wx");
				const token = `${process.pid}-${Date.now()}-${(nextToken++).toString(36)}`;
				writeSync(fd, JSON.stringify(holderNow(toolCallId, token)));
				// A raw interval in a helper with no `ctx`: the body is fully guarded, so
				// no renewal failure can escape as an uncaughtException, and `release`
				// and the exit handler both clear it.
				const renew = setInterval(() => {
					try {
						renewLease(lock, toolCallId, token);
					} catch {
						// A lease that cannot be renewed simply expires, which is the
						// safe direction: another writer takes over rather than stalls.
					}
				}, renewMs);
				// The heartbeat must not be a reason the process stays alive.
				renew.unref?.();
				owned.set(lock, { fd, holders: new Map([[toolCallId, 1]]), renew, token });
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
		if (Date.now() >= deadline) {
			return {
				kind: "failed",
				reason: `Beads embedded write lock at ${lock} stayed held for ${Math.round(waitMs / 1000)}s. Another writer is still working, or a hold was left behind by a process on another host; the write was refused rather than run concurrently. Read the lock file, then remove it once its holder is really gone.`,
			};
		}
		const { promise, resolve: wake } = Promise.withResolvers<void>();
		// A raw timer with no `ctx` in scope: the callback is a resolver, so it cannot
		// throw and cannot reach `uncaughtException`.
		setTimeout(wake, POLL_MS);
		await promise;
	}
}

/** Give up one share of `store`, releasing the lock when it was the last. */
export function release(store: string, toolCallId: string): void {
	const lock = join(store, LOCK_NAME);
	const owned = registry().owned;
	const owner = owned.get(lock);
	if (owner === undefined) return;
	const shares = owner.holders.get(toolCallId);
	if (shares === undefined) return;
	if (shares > 1) {
		owner.holders.set(toolCallId, shares - 1);
		return;
	}
	owner.holders.delete(toolCallId);
	if (owner.holders.size > 0) return;
	owned.delete(lock);
	clearInterval(owner.renew);
	try {
		closeSync(owner.fd);
	} catch {
		// Nothing to do; the file is what other processes see.
	}
	// Only unlink a file that is still THIS hold. A lease that lapsed while its
	// writer was stalled may already have been taken over legitimately, and
	// unlinking then would hand the store to a third writer.
	if (stillOurs(lock, owner.token)) {
		try {
			unlinkSync(lock);
		} catch {
			// Taken over between the check and the unlink; the next acquisition settles it.
		}
	}
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
function renewLease(lock: string, toolCallId: string, token: string): void {
	const owned = registry().owned;
	const owner = owned.get(lock);
	if (owner === undefined || owner.token !== token) return;
	if (!stillOurs(lock, token)) {
		clearInterval(owner.renew);
		owned.delete(lock);
		try {
			closeSync(owner.fd);
		} catch {
			// The descriptor is already gone.
		}
		return;
	}
	const fd = openSync(lock, "w");
	try {
		writeSync(fd, JSON.stringify(holderNow(toolCallId, token)));
	} finally {
		closeSync(fd);
	}
}

/**
 * Run `write`, a plugin-internal `bd` mutation, inside the store's lock.
 *
 * `cwd` is the directory the mutation runs in. A store that is not embedded, or a
 * `write` is AWAITED before the hold is given up. Returning the promise instead
 * would release while the bd process it represents was still running -- the hold
 * would cover spawning the writer rather than the write -- and every internal
 * caller here spawns asynchronously. A synchronous `write` is unaffected: `await`
 * on a plain value resolves immediately, and `value` reaches the caller settled
 * either way. A `write` that rejects releases too, and its rejection propagates.
 */
export async function withEmbeddedWriteLock<T>(
	cwd: string,
	toolCallId: string,
	write: () => T | PromiseLike<T>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ kind: "done"; value: T } | { kind: "failed"; reason: string }> {
	const store = embeddedStoreFor(cwd, env);
	if (store === undefined) return { kind: "done", value: await write() };
	const got = await hold(store, toolCallId);
	if (got.kind === "failed") return got;
	try {
		return { kind: "done", value: await write() };
	} finally {
		release(store, toolCallId);
	}
}

interface ActiveHold {
	store: string;
	held: boolean;
	released: boolean;
}

const activeHolds = new Map<string, ActiveHold[]>();
const surrenderedCalls = new Set<string>();

export function beginEmbeddedWrite(toolCallId: string): void {
	surrenderedCalls.delete(toolCallId);
}

function surrender(toolCallId: string): void {
	surrenderedCalls.add(toolCallId);
	const holds = activeHolds.get(toolCallId);
	if (holds === undefined) return;
	activeHolds.delete(toolCallId);
	for (const hold of holds) {
		hold.released = true;
		if (hold.held) {
			release(hold.store, toolCallId);
			hold.held = false;
		}
	}
}

/** Shared Bash dispatcher called by bash-gates.ts after the command is parsed. */
export async function decideEmbeddedWrite(parsed: ParsedCommand, event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
	try {
		if (event.toolName !== "bash") return;
		if (surrenderedCalls.delete(event.toolCallId)) return;
		const input = event.input as { cwd?: unknown };
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd());
		const env = environmentForInput(event.input);
		const sources = [...parsed.commands.map(position => position.raw)];
		const visit = (child: ParsedCommand): void => {
			sources.push(...child.commands.map(position => position.raw));
			for (const nested of child.nested) visit(nested);
		};
		for (const nested of parsed.nested) visit(nested);
		const targets: string[] = [];
		for (const source of sources) {
			const result = embeddedWriteTargets(source, cwd, env);
			if (result.kind === "refused") return { block: true, reason: result.reason };
			targets.push(...result.stores);
		}
		const unique = [...new Set(targets)];
		if (unique.length === 0) return;
		const pending = unique.map(store => ({ store, held: false, released: false }));
		const existing = activeHolds.get(event.toolCallId);
		activeHolds.set(event.toolCallId, existing === undefined ? pending : [...existing, ...pending]);
		for (const current of pending) {
			const got = await hold(current.store, event.toolCallId);
			if (got.kind === "failed") {
				for (const pendingHold of pending) {
					pendingHold.released = true;
					if (pendingHold.held) {
						release(pendingHold.store, event.toolCallId);
						pendingHold.held = false;
					}
				}
				const active = activeHolds.get(event.toolCallId);
				if (active !== undefined) {
					const remaining = active.filter(activeHold => !pending.includes(activeHold));
					if (remaining.length === 0) activeHolds.delete(event.toolCallId);
					else activeHolds.set(event.toolCallId, remaining);
				}
				return { block: true, reason: got.reason };
			}
			current.held = true;
			if (current.released) {
				release(current.store, event.toolCallId);
				current.held = false;
			}
		}
		ctx?.setTimeout?.(() => surrender(event.toolCallId), LEASE_MS);
	} catch {
		return { block: true, reason: "embedded write target could not be resolved" };
	}
	return;
}

export default function bdEmbeddedWriteLock(pi: ExtensionAPI): void {
	pi.on("tool_result", (event: ToolResultEvent) => surrender(event.toolCallId));
	pi.on("tool_approval_resolved", (event: { toolCallId?: string; approved?: boolean }) => {
		if (event.approved === false && typeof event.toolCallId === "string") surrender(event.toolCallId);
	});
	const drain = () => { for (const id of [...activeHolds.keys()]) surrender(id); };
	pi.on("turn_end", drain);
	pi.on("agent_end", drain);
	pi.on("session_shutdown", drain);
}
