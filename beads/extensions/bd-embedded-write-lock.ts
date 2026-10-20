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
 * So the hold moves into the writing process. Each validated `bd` write in a command
 * is rewritten in place to run under `bd-embedded-write-runner`, a process this
 * package owns which acquires the store's lock, spawns the real `bd`, awaits its exit,
 * and releases in `finally` and on its own death. The runner IS bd's parent, so the
 * hold begins immediately before the mutation and ends when it settles, whatever
 * Bash does with the foreground: an explicitly async or auto-backgrounded call keeps
 * its lock because the runner outlives the tool result, and a killed call releases
 * because the runner dies with it. Reads, and everything around each write, run as
 * written.
 *
 * Nothing about a Bash-originated write is recorded in this process, so there is no
 * session bookkeeping to leak. What stays process-global is the lock domain itself:
 * the descriptors this process owns and the queue of callers waiting on them, both
 * on {@link Registry}, because a plugin reachable through two load paths is
 * instantiated twice and the copies must share one coordinator.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
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
import { type ParsedCommand, type ShellScan, type ShellWord, type SimpleCommand, scanShell, tokenize } from "./shell-command.ts";

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
 * Verbs proven NOT to write, read from each verb's own `bd <verb> --help` on 1.3.1.
 * Everything absent from this table is treated as a write.
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
 * subactions write. Only subcommands the parent's help lists are here: `bd dep
 * show -b X` is the parent `bd dep <id> --blocks` form, which adds a dependency,
 * and `bd comment <id> [text...]` has no `list` subcommand at all, so `bd comment
 * list` adds a comment to an issue named `list`. Comment grammar is handled
 * separately: only `bd comments <bead-id>`, optionally with its `--json` and
 * `--local-time` display flags, is a read. Every other comment form writes.
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
	// `bd stats --help` prints the `bd status` help: the same read under its alias.
	stats: true,
	state: true,
	status: true,
	statuses: true,
	types: true,
	version: true,
	where: true,
	config: { get: true, list: true },
	dep: { list: true, tree: true },
	dolt: { status: true },
	formula: { list: true, show: true },
	gate: { list: true, show: true },
	kv: { get: true, list: true },
	mol: { show: true },
	swarm: { list: true },
};

/**
 * Flags that turn one of the reads above back into a write, read from each verb's
 * own `--help` on bd 1.3.1. `bd orphans --fix` closes issues and `bd preflight
 * --fix` writes too, so a verb being a read is a statement about its bare form.
 */
const WRITE_FLAGS: Record<string, string[]> = {
	orphans: ["--fix", "-f"],
	preflight: ["--fix"],
	ready: ["--claim"],
};

/** A bead id accepted by the plural comment-listing form. */
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;

/** The display-only flags `bd comments <bead-id>` accepts. */
const COMMENT_LISTING_FLAGS: Record<string, true> = { "--json": true, "--local-time": true };

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
	if (verb === "comment") return true;
	if (verb === "comments") {
		const positional = args.filter(arg => COMMENT_LISTING_FLAGS[arg] !== true);
		return positional.length !== 1 || !BEAD_ID.test(positional[0] ?? "");
	}
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

/** A store-selecting value the shell would resolve later, so this gate cannot. */
const DEFERRED_VALUE = /[$`~*?[\]]/;

/**
 * The store-selecting globals. A value for one of these decides which database the
 * write lands in, so it must be a literal this gate can resolve now.
 */
const STORE_FLAGS = ["-C", "--directory", "--db", "--database"];

/** `bd` as a whole word: not part of an id such as `bd-12` or a name such as `.bd` or `bd.log`. */
const BD_WORD = /(?<![\w.-])bd(?![\w-]|\.\w)/;

/** A `NAME=` or `NAME+=` assignment, matched on the word's source so the name is unquoted. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** A `BEADS_DIR` assignment's value, matched on the word after quote removal. */
const BEADS_DIR_ASSIGNMENT = /^BEADS_DIR(\+?)=/;

/**
 * Reserved words that open a command list without changing what the command after
 * them runs. A `bd` call behind one is in command position, read or write.
 */
const LIST_PREFIXES = new Set(["then", "else", "do"]);

/**
 * Prefixes that put the command after them in a condition, negate it, or time it. A
 * read there is still a read. A write there stays refused: the runner exits 120 when it
 * could not serialise the write, and in a condition that status steers control flow
 * as if `bd` had answered -- `!` even turns a refused write into success -- and `time`
 * is not a keyword in POSIX `sh`, where it would run the runner's leading assignment as
 * a program.
 */
const CONDITION_PREFIXES: Record<string, true> = { "!": true, if: true, elif: true, while: true, until: true, time: true };

/** Commands that only print, test, search or look up their arguments, so a `bd` word there is a name. */
const NAME_ONLY: Record<string, true> = {
	":": true,
	"[": true,
	"[[": true,
	cat: true,
	echo: true,
	egrep: true,
	false: true,
	fgrep: true,
	grep: true,
	hash: true,
	head: true,
	help: true,
	ls: true,
	man: true,
	printf: true,
	rg: true,
	tail: true,
	test: true,
	true: true,
	type: true,
	wc: true,
	whereis: true,
	which: true,
};

/** Shell interpreters, which run a `-c` string or their stdin as source wherever they appear. */
const SHELL_INTERPRETERS: Record<string, true> = { bash: true, dash: true, fish: true, ksh: true, mksh: true, sh: true, zsh: true };

/** Commands that run a string or a file as shell source when they are the command word. */
const SOURCE_RUNNERS: Record<string, true> = { ".": true, eval: true, parallel: true, screen: true, script: true, source: true, su: true, tmux: true, watch: true };

/** Builtins that can assign a variable named by one of their arguments. */
const ASSIGNING: Record<string, true> = { declare: true, getopts: true, local: true, mapfile: true, printf: true, read: true, readarray: true, readonly: true, typeset: true };

/** Operators after which a `cd` earlier in the command may not have run. */
const UNCERTAIN_AFTER: Record<string, true> = { "\n": true, "&": true, ";": true, ";;": true, "||": true };

/** The runner script's file name, which identifies an already rewritten write. */
const RUNNER_SCRIPT = /^bd-embedded-write-runner\.(?:js|ts)$/;

/** The refusal for a write after a directory change whose target only the shell knows. */
const DYNAMIC_CWD = "This command changes directory dynamically; issue the `bd` command with the tool's cwd field instead.";

const SOURCE_FIX = "Write each `bd` command directly in this command line instead of inside a string, script or here-document.";

/** The shapes the lock does accept, appended to every refusal it explains. */
const ACCEPTED_SHAPES =
	"Accepted: `bd` reads anywhere in pipes, `;` / `&&` / `||` lists, `( )` / `{ }` groups, loops and redirections; and each `bd` write written as its own simple command, `[VAR=literal ...] bd ...`, anywhere in such a command, which the lock runs under its serialising runner with a hold of its own.";

/** One `bd` write the rewrite runs under the runner. */
export type EmbeddedWrite = {
	/** The canonical embedded store the write lands in. */
	store: string;
	/** Offset of the write's `bd` word in the command, where the runner form is inserted. */
	offset: number;
};

export type WritePlan = { kind: "writes"; writes: EmbeddedWrite[] } | { kind: "refused"; reason: string };

export type WriteTargets =
	| { kind: "stores"; stores: string[] }
	| { kind: "refused"; reason: string };

/** The part of a command the lock cannot place, and the shape that works instead. */
type Problem = { part: string; fix: string } | { exact: string };

type CwdState = { kind: "known"; cwd: string; certain: boolean; changed: boolean } | { kind: "dynamic"; problem: Problem };
type BeadsDirState = { kind: "known"; value: string | undefined } | { kind: "unknown"; cause: string };
/** What the shell has done to the working directory and `BEADS_DIR` by this point. */
type ShellState = { cwd: CwdState; beadsDir: BeadsDirState };

type OtherShape = { kind: "other"; assignments: ShellWord[]; head: ShellWord | undefined; args: ShellWord[] };
type CommandShape =
	| { kind: "bd"; condition: string | undefined; assignments: ShellWord[]; head: ShellWord; args: ShellWord[] }
	| { kind: "runner"; assignments: ShellWord[]; store: string; child: ShellWord[] }
	| OtherShape;

/**
 * Every embedded-store write this bash call makes, or why it cannot be allowed to run.
 *
 * The command is scanned once, positionally, and every simple command in it is judged
 * on its own. A `bd` read passes wherever it is: in a pipe, a `;` / `&&` / `||` list,
 * a group, a loop body or under redirections. A `bd` write in command position --
 * optionally behind literal `VAR=value` assignments -- is returned with its offset, so
 * the gate can run exactly that simple command under the runner and leave every other
 * byte alone. Each write gets its own runner and therefore its own hold, so two writes
 * in one command are serialised like two tool calls.
 *
 * A write's store is resolved with the runtime's `cwd` and `env`, then with what the
 * command itself does before the write: a literal `export BEADS_DIR=...`,
 * `BEADS_DIR=...` or `unset BEADS_DIR`, the write's own command-local assignments,
 * and a literal `cd`. Subshells scope those effects. Anything the shell decides later
 * -- an expanded value, a `source`, a dynamic `cd` -- leaves the store unknown, and the
 * write is refused rather than locked on a guess.
 *
 * What the scan cannot place is refused too, whenever an embedded store is in reach:
 * `bd` inside a command substitution, a here-document or a shell string, `bd` behind a
 * launcher such as `xargs`, `env` or `timeout`, and an expanded command word in a
 * command that mentions `bd`. Those are where reading shell semantics out of a string
 * gives confident wrong answers, so they fail closed instead of being modelled.
 */
export function planEmbeddedWrites(command: string, cwd: string, env: NodeJS.ProcessEnv): WritePlan {
	if (!BD_WORD.test(command)) return { kind: "writes", writes: [] };
	const scan = scanShell(command);
	const writes: EmbeddedWrite[] = [];
	let problem: Problem | undefined;
	let problemStore: string | undefined;
	const refuse = (found: Problem, store?: string): void => {
		problem ??= found;
		problemStore ??= store;
	};
	if (!scan.complete) refuse({ part: "it leaves a quote, command substitution or here-document open, so its `bd` invocations cannot be located", fix: "Close it and retry." });
	if (scan.substitutions.some(runsBd)) {
		refuse({
			part: "`bd` runs inside a command substitution (`$(...)`, backticks or `<(...)`), which the lock cannot rewrite",
			fix: "Run that `bd` at the top level of the command instead: pipe its output on (`bd show X --json | jq ...`), or redirect it to a file and read the file.",
		});
	}
	const scopes: ShellState[] = [{ cwd: { kind: "known", cwd, certain: true, changed: false }, beadsDir: { kind: "known", value: env.BEADS_DIR } }];
	const { items } = scan;
	for (const [index, item] of items.entries()) {
		const state = scopes[scopes.length - 1] as ShellState;
		if (item.kind === "operator") {
			if (item.operator === "(") scopes.push(structuredClone(state));
			else if (item.operator === ")" && scopes.length > 1) scopes.pop();
			else if (UNCERTAIN_AFTER[item.operator] === true && state.cwd.kind === "known" && state.cwd.changed) state.cwd.certain = false;
			continue;
		}
		const shape = shapeOf(item, command);
		if (shape.kind !== "bd" && item.hereDocuments.some(document => BD_WORD.test(document.body))) {
			const runner = pipelineSourceRunner(items, index, command);
			if (runner !== undefined) refuse({ part: `a here-document fed to \`${runner}\` mentions \`bd\``, fix: SOURCE_FIX });
		}
		if (shape.kind === "other") {
			const launch = launchOf(shape, item, command);
			if (launch !== undefined) refuse(launch);
			const before = operatorAt(items, index - 1);
			const after = operatorAt(items, index + 1);
			applyEffects(shape, state, command, {
				leading: index === 0 && after === "&&",
				// A pipeline element or a background job runs in a subshell of its own.
				scoped: before === "|" || before === "|&" || after === "|" || after === "|&" || after === "&",
			});
			continue;
		}
		if (shape.kind === "runner") {
			const argv = shape.child.slice(1);
			const child = invocationFromArgv(argv.map(word => word.value));
			if (child === undefined || !isWrite(child, argv)) continue;
			const resolved = resolveWrite(child, shape.assignments, state, env, command);
			if ("problem" in resolved) refuse(resolved.problem);
			else if (resolved.store !== undefined && embedded(resolved.store) && resolved.store !== canonical(shape.store)) {
				refuse({ part: `a runner command holds \`${shape.store}\` while its \`bd ${child.verb}\` writes \`${resolved.store}\``, fix: "Write the plain `bd` command and let the lock generate the runner form." }, resolved.store);
			}
			continue;
		}
		const invocation = invocationFromArgv(shape.args.map(word => word.value));
		// `bd`, `bd --version` and `bd --help` carry no verb: recognised, and no write.
		if (invocation === undefined || !isWrite(invocation, shape.args)) continue;
		const resolved = resolveWrite(invocation, shape.assignments, state, env, command);
		if ("problem" in resolved) {
			refuse(resolved.problem);
			continue;
		}
		const store = resolved.store;
		if (store === undefined || !embedded(store)) continue;
		if (shape.condition !== undefined) {
			refuse({
				part: `the write \`bd ${invocation.verb}\` follows \`${shape.condition}\`, and the lock does not run a write in a condition, behind \`!\` or under \`time\``,
				fix: `Make the write its own simple command, for example \`bd ${invocation.verb} ... && next\` or \`check && bd ${invocation.verb} ...\`.`,
			}, store);
			continue;
		}
		writes.push({ store, offset: shape.head.start });
	}
	if (problem === undefined) return { kind: "writes", writes };
	// An embedded store in reach is what gives this gate jurisdiction: the session's own,
	// one the command writes, or one it names with `-C` / `--db` / `BEADS_DIR=`.
	const at = writes[0]?.store ?? problemStore ?? embeddedStoreFor(cwd, env) ?? namedStore(command, cwd, env);
	if (at === undefined) return { kind: "writes", writes };
	return { kind: "refused", reason: refusal(problem, at) };
}

/** What this bash call may write, or why it cannot run: the stores of {@link planEmbeddedWrites}. */
export function embeddedWriteTargets(command: string, cwd: string, env: NodeJS.ProcessEnv): WriteTargets {
	const plan = planEmbeddedWrites(command, cwd, env);
	return plan.kind === "refused" ? plan : { kind: "stores", stores: [...new Set(plan.writes.map(write => write.store))] };
}

function refusal(problem: Problem, store: string): string {
	if ("exact" in problem) return problem.exact;
	return `The Beads write lock cannot run this command: ${problem.part}. ${store} is an embedded store, where two concurrent writers corrupt the Dolt journal, so every \`bd\` write to it runs under the lock's serialising runner. ${problem.fix} ${ACCEPTED_SHAPES}`;
}

function commandName(word: ShellWord): string {
	return word.value.split("/").pop() ?? word.value;
}

function operatorAt(items: ShellScan["items"], index: number): string | undefined {
	const item = items[index];
	return item?.kind === "operator" ? item.operator : undefined;
}

/** What one simple command is: a `bd` call, an already rewritten write, or anything else. */
function shapeOf(command: SimpleCommand, source: string): CommandShape {
	const { words } = command;
	let i = 0;
	let condition: string | undefined;
	for (let word = words[0]; word !== undefined && !word.quoted && !word.expands; word = words[i]) {
		if (CONDITION_PREFIXES[word.value] === true) condition ??= word.value;
		else if (!LIST_PREFIXES.has(word.value)) break;
		i += word.value === "time" && words[i + 1]?.value === "-p" ? 2 : 1;
	}
	const first = i;
	while (words[i] !== undefined && ASSIGNMENT.test(source.slice(words[i]?.start, words[i]?.end))) i++;
	const assignments = words.slice(first, i);
	const head = words[i];
	const args = words.slice(i + 1);
	if (head !== undefined && !head.expands && commandName(head) === "bd") return { kind: "bd", condition, assignments, head, args };
	const runner = head === undefined || head.expands || condition !== undefined ? undefined : runnerShape(args);
	if (runner !== undefined) return { kind: "runner", assignments, ...runner };
	return { kind: "other", assignments, head, args };
}

/** The store and `bd` argv of a command this gate already rewrote, else `undefined`. */
function runnerShape(args: ShellWord[]): { store: string; child: ShellWord[] } | undefined {
	const script = args[0];
	if (script === undefined || script.expands || !RUNNER_SCRIPT.test(commandName(script))) return undefined;
	let store: string | undefined;
	let i = 1;
	for (; i < args.length && args[i]?.value !== "--"; i += 2) {
		const value = args[i + 1];
		if (value === undefined || value.expands) return undefined;
		if (args[i]?.value === RUNNER_STORE_FLAG) store = value.value;
		else if (args[i]?.value !== RUNNER_WAIT_FLAG) return undefined;
	}
	const child = args.slice(i + 1);
	const bd = child[0];
	if (store === undefined || bd === undefined || bd.expands || commandName(bd) !== "bd") return undefined;
	return { store, child };
}

/**
 * Whether this invocation can write, counting a word the shell expands later as a
 * possible flag: `bd orphans $FLAGS` may well be `bd orphans --fix`.
 */
function isWrite(invocation: BdInvocation, args: ShellWord[]): boolean {
	return writesStore(invocation) || (WRITE_FLAGS[invocation.verb] !== undefined && args.some(word => word.expands));
}

/** Shell source a substitution runs: does it run `bd` anywhere the scan can see? */
function runsBd(source: string): boolean {
	if (!BD_WORD.test(source)) return false;
	const scan = scanShell(source);
	if (!scan.complete || scan.substitutions.some(runsBd)) return true;
	return scan.items.some((item, index) => {
		if (item.kind !== "command") return false;
		const shape = shapeOf(item, source);
		if (shape.kind !== "other" || launchOf(shape, item, source) !== undefined) return true;
		return item.hereDocuments.some(document => BD_WORD.test(document.body)) && pipelineSourceRunner(scan.items, index, source) !== undefined;
	});
}

/** The word that makes this command run shell source: an interpreter anywhere, or a source runner as its command word. */
function sourceRunner(shape: OtherShape): ShellWord | undefined {
	const { head, args } = shape;
	if (head === undefined) return undefined;
	if (!head.quoted && !head.expands && SOURCE_RUNNERS[commandName(head)] === true) return head;
	return [head, ...args].find(word => !word.quoted && !word.expands && SHELL_INTERPRETERS[commandName(word)] === true);
}

/** The source runner any command in this command's pipeline is, if one is. */
function pipelineSourceRunner(items: ShellScan["items"], index: number, source: string): string | undefined {
	const pipe = (at: number): boolean => {
		const operator = operatorAt(items, at);
		return operator === "|" || operator === "|&";
	};
	let first = index;
	while (pipe(first - 1) && items[first - 2]?.kind === "command") first -= 2;
	let last = index;
	while (pipe(last + 1) && items[last + 2]?.kind === "command") last += 2;
	for (let at = first; at <= last; at += 2) {
		const item = items[at];
		if (item?.kind !== "command") continue;
		const shape = shapeOf(item, source);
		const runner = shape.kind === "other" ? sourceRunner(shape) : undefined;
		if (runner !== undefined) return runner.value;
	}
	return undefined;
}

/** Why a non-`bd` command may still run `bd` where the lock cannot see it, if it may. */
function launchOf(shape: OtherShape, command: SimpleCommand, source: string): Problem | undefined {
	const { head, args } = shape;
	if (head === undefined) return undefined;
	if (head.expands) {
		if (!BD_WORD.test(source)) return undefined;
		return { part: `its command word \`${source.slice(head.start, head.end)}\` is expanded at run time, so whether it runs \`bd\` is unknown`, fix: "Spell `bd` literally as the command word." };
	}
	const runner = sourceRunner(shape);
	if (runner !== undefined && [head, ...args, ...command.redirects].some(word => BD_WORD.test(word.value))) {
		return { part: `\`bd\` is passed as shell source to \`${runner.value}\`, which runs it where the lock cannot see it`, fix: SOURCE_FIX };
	}
	const name = commandName(head);
	if (NAME_ONLY[name] === true || (name === "command" && /^-[vV]$/.test(args[0]?.value ?? ""))) return undefined;
	if (!args.some(word => !word.quoted && !word.expands && commandName(word) === "bd")) return undefined;
	return {
		part: `\`bd\` is launched through \`${head.value}\`, which hides the invocation from the lock`,
		fix: "Call `bd` directly as its own simple command instead of through a launcher such as `env`, `xargs`, `timeout` or `find -exec`; to act on a list of ids, pass them to one `bd` call or loop with `while read -r id; do bd ... \"$id\"; done`.",
	};
}

/**
 * Apply what a non-`bd` command does to the working directory and `BEADS_DIR`.
 *
 * Only literal effects are followed. Every other way of changing either one makes it
 * unknown, which refuses a later write that depends on it rather than locking a store
 * the write may not reach.
 */
function applyEffects(shape: OtherShape, state: ShellState, source: string, context: { leading: boolean; scoped: boolean }): void {
	const { head, args } = shape;
	if (head === undefined) {
		// A bare assignment updates an exported variable in place, so it is treated as
		// exported: if it was not, the rewrite exports the value it resolved anyway.
		for (const word of shape.assignments) assignBeadsDir(state, word, source, context.scoped);
		return;
	}
	const name = head.expands ? "" : commandName(head);
	if (name === "cd") {
		const operands = args.filter(word => word.value !== "--" && !/^-[LPe@]+$/.test(word.value));
		const target = operands[0];
		if (state.cwd.kind === "dynamic") return;
		if (target === undefined || target.value === "-" || target.expands || DEFERRED_VALUE.test(target.value) || context.scoped) {
			state.cwd = { kind: "dynamic", problem: { exact: DYNAMIC_CWD } };
			return;
		}
		state.cwd = { kind: "known", cwd: absolute(target.value, state.cwd.cwd), certain: context.leading && state.cwd.certain && !state.cwd.changed, changed: true };
		return;
	}
	if (name === "pushd" || name === "popd" || name === "source" || name === "." || name === "eval") {
		state.cwd = {
			kind: "dynamic",
			problem: { part: `\`${name}\` earlier in the command may change the working directory before a \`bd\` write`, fix: "Use a literal `cd DIR &&` prefix or the tool's cwd field, or run the write as its own tool call." },
		};
		if (name !== "pushd" && name !== "popd") state.beadsDir = { kind: "unknown", cause: name };
		return;
	}
	if (name === "export") {
		const unexports = args.some(word => /^-\w*[nf]/.test(word.value));
		for (const word of args) {
			if (word.value === "BEADS_DIR" && unexports) state.beadsDir = { kind: "unknown", cause: source.slice(head.start, word.end) };
			else assignBeadsDir(state, word, source, context.scoped);
		}
		return;
	}
	if (name === "unset") {
		if (args.some(word => word.value === "BEADS_DIR") && !args.some(word => word.value === "-f")) {
			state.beadsDir = context.scoped ? { kind: "unknown", cause: "unset BEADS_DIR" } : { kind: "known", value: undefined };
		}
		return;
	}
	if (ASSIGNING[name] === true && args.some(word => word.value === "BEADS_DIR" || BEADS_DIR_ASSIGNMENT.test(word.value))) {
		state.beadsDir = { kind: "unknown", cause: name };
	}
}

function assignBeadsDir(state: ShellState, word: ShellWord, source: string, scoped: boolean): void {
	const match = BEADS_DIR_ASSIGNMENT.exec(word.value);
	if (match === null) return;
	const value = word.value.slice(match[0].length);
	const literal = !scoped && match[1] === "" && !word.expands && !DEFERRED_VALUE.test(value);
	state.beadsDir = literal ? { kind: "known", value } : { kind: "unknown", cause: source.slice(word.start, word.end) };
}

/** The store a `bd` write in this shell state lands in, or what keeps it unknown. */
function resolveWrite(invocation: BdInvocation, assignments: ShellWord[], state: ShellState, env: NodeJS.ProcessEnv, source: string): { store: string | undefined } | { problem: Problem } {
	const write = `\`bd ${invocation.verb}\``;
	for (const flag of STORE_FLAGS) {
		const value = globalValue(invocation.globals, [flag]);
		if (value !== undefined && DEFERRED_VALUE.test(value)) {
			return { problem: { part: `${write} selects its store with \`${flag} ${value}\`, which the shell expands at run time`, fix: `Give \`${flag}\` a literal path.` } };
		}
	}
	let beadsDir = state.beadsDir;
	for (const word of assignments) {
		const match = BEADS_DIR_ASSIGNMENT.exec(word.value);
		if (match === null) continue;
		const value = word.value.slice(match[0].length);
		beadsDir = match[1] === "" && !word.expands && !DEFERRED_VALUE.test(value) ? { kind: "known", value } : { kind: "unknown", cause: source.slice(word.start, word.end) };
	}
	const directory = globalValue(invocation.globals, ["-C", "--directory"]);
	const db = globalValue(invocation.globals, ["--db"]);
	if (directory === undefined && db === undefined && beadsDir.kind === "unknown") {
		return {
			problem: {
				part: `${write} runs with \`BEADS_DIR\` set by \`${beadsDir.cause}\`, which the shell resolves only at run time`,
				fix: "Set `BEADS_DIR` to a literal path, as `export BEADS_DIR=/path` earlier in the command or as `BEADS_DIR=/path bd ...`, or leave it unset to use the session's store.",
			},
		};
	}
	if (state.cwd.kind === "dynamic") return { problem: state.cwd.problem };
	const relative = db !== undefined ? !isAbsolute(db) && (directory === undefined || !isAbsolute(directory)) : directory !== undefined && !isAbsolute(directory);
	if (relative && !state.cwd.certain) {
		return {
			problem: {
				part: `${write} resolves a relative \`${db === undefined ? "-C" : "--db"}\` path after a \`cd\` the lock cannot confirm ran`,
				fix: "Give it an absolute path, or start the command with `cd DIR &&` joined to the write by `&&` alone.",
			},
		};
	}
	return { store: storeFor(invocation.globals, state.cwd.cwd, { ...env, BEADS_DIR: beadsDir.kind === "known" ? beadsDir.value : undefined }) };
}

/**
 * A store the command names explicitly, whatever else it does.
 *
 * Literal collection, not analysis: every `-C` / `--directory` / `--db` / `--database`
 * value and every `BEADS_DIR=` assignment in the text is resolved, and the first
 * embedded one is returned. Without this, a refused command naming an embedded store
 * escaped whenever the session's own store was not embedded.
 */
function namedStore(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	// One extra level: a quoted argument is tokenized too, because
	// `bash -c 'bd -C /embedded close x'` keeps its `-C` inside a single token and the
	// store it names would otherwise go unseen. This can only add a refusal; a payload
	// is never treated as a direct call.
	const words = tokenize(command).flatMap(token => (token.quoted ? tokenize(token.value).map(inner => inner.value) : [token.value]));
	for (const [index, word] of words.entries()) {
		const assigned = BEADS_DIR_ASSIGNMENT.test(word) ? word.slice(word.indexOf("=") + 1) : undefined;
		if (assigned !== undefined && !DEFERRED_VALUE.test(assigned)) {
			const store = storeFor([], cwd, { ...env, BEADS_DIR: assigned });
			if (store !== undefined && embedded(store)) return store;
		}
		for (const flag of STORE_FLAGS) {
			const value = word === flag ? words[index + 1] : word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : undefined;
			if (value === undefined || DEFERRED_VALUE.test(value)) continue;
			const store = storeFor([flag, value], cwd, env);
			if (store !== undefined && embedded(store)) return store;
		}
	}
	return undefined;
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
export async function attachWriter(store: string, owner: string, pid: number, waitMs = RUNNER_WAIT_MS): Promise<boolean> {
	const lock = join(store, LOCK_NAME);
	const held = registry().owned.get(lock);
	if (held === undefined || !held.holders.has(owner)) return false;
	const writerStart = processStartIdentity(pid);
	const deadline = Date.now() + Math.max(0, waitMs);
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

export type BunDiscovery = {
	execPath?: string;
	which?: (name: string) => string | undefined | null;
	environment?: NodeJS.ProcessEnv;
	miseWhich?: (mise: string) => string | undefined;
};

/** The Bun binary and runner script a rewritten write runs under. */
export type EmbeddedWriteRunner = { interpreter: string; script: string };

/** A runner, or the clause explaining why none can be used. */
export type EmbeddedWriteRunnerLookup = EmbeddedWriteRunner | { unavailable: string };

/** An installed plugin directory in OMP's cache, `<marketplace>___beads___<version>`, capturing everything before the version. */
const INSTALLED_PLUGIN_DIR = /^(.+___beads___).+$/;

/** A version `Bun.semver.order` accepts; it throws on anything else. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The runner script, resolved on every call, or the clause naming what is missing.
 *
 * The script normally sits beside this module: next to the bundle in `dist/` when the
 * package ships built, and next to the source in `extensions/` when OMP imports the
 * TypeScript directly. A session keeps the module it loaded, though, and
 * `omp plugin upgrade` deletes the old version's cache directory, so after an upgrade
 * the path derived from `import.meta.dir` no longer exists. The installed plugin is
 * then found among the module's siblings by the cache's naming scheme, preferring the
 * highest version.
 */
function embeddedWriteRunnerScript(here: string): { script: string } | { unavailable: string } {
	const local = [
		join(here, `${RUNNER_STEM}.js`),
		join(here, `${RUNNER_STEM}.ts`),
		join(here, "..", "dist", `${RUNNER_STEM}.js`),
		join(here, "..", "extensions", `${RUNNER_STEM}.ts`),
	].find(candidate => existsSync(candidate));
	if (local !== undefined) return { script: resolve(local) };
	const root = resolve(here, "..");
	const missing = `${join(here, RUNNER_STEM)}.js`;
	const prefix = INSTALLED_PLUGIN_DIR.exec(basename(root))?.[1];
	let searched = "";
	if (prefix !== undefined) {
		const cache = dirname(root);
		searched = ` or in any ${prefix}<version> directory under ${cache}`;
		let entries: string[];
		try {
			entries = readdirSync(cache);
		} catch {
			entries = [];
		}
		const newestFirst = entries
			.filter(entry => entry.startsWith(prefix) && SEMVER.test(entry.slice(prefix.length)))
			.sort((left, right) => Bun.semver.order(right.slice(prefix.length), left.slice(prefix.length)));
		for (const entry of newestFirst) {
			const script = [join(cache, entry, "dist", `${RUNNER_STEM}.js`), join(cache, entry, "extensions", `${RUNNER_STEM}.ts`)].find(candidate => existsSync(candidate));
			if (script !== undefined) return { script: resolve(script) };
		}
	}
	return {
		unavailable: `the runner script ${missing} is missing, and no runner was found beside it${searched}. If the @srobroek/beads plugin was just upgraded, restart the session so it loads the new version; otherwise reinstall the plugin.`,
	};
}

/**
 * The Bun binary and the runner script, or the clause naming whichever is unreachable.
 *
 * The interpreter cannot be assumed from `process.execPath`. OMP ships as a compiled
 * single-file executable, so that path is the `omp` binary, which cannot run a
 * script; on a source install it IS Bun, which can. Both are handled, and PATH,
 * `BUN_INSTALL`, and mise's resolved tool path cover the compiled case.
 */
export function embeddedWriteRunner(here: string = import.meta.dir, interpreterLookup: () => string | undefined = bunBinary): EmbeddedWriteRunnerLookup {
	const located = embeddedWriteRunnerScript(here);
	if ("unavailable" in located) return located;
	const interpreter = interpreterLookup();
	if (interpreter === undefined) {
		return { unavailable: "no `bun` binary was found on PATH, in BUN_INSTALL, through mise, or as this process's own interpreter. Install `bun`." };
	}
	return { interpreter, script: located.script };
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

/**
 * The command with every planned write run under the runner, every other byte kept.
 *
 * The runner form is inserted immediately before each write's `bd` word, after the
 * write's own `VAR=value` assignments, so the shell still expands the write's operands
 * -- `bd close $ID` reaches the runner as the id, not as `$ID` -- and every pipe,
 * redirection, separator and quote around it stays exactly as written. The runner's
 * command-local `BEADS_DIR` comes after the caller's, so the write lands in the very
 * store the runner holds.
 */
function withRunner(command: string, writes: EmbeddedWrite[], runner: EmbeddedWriteRunner): string {
	let out = "";
	let cursor = 0;
	for (const write of [...writes].sort((left, right) => left.offset - right.offset)) {
		const store = quote(write.store);
		out += `${command.slice(cursor, write.offset)}BEADS_DOLT_SHARED_SERVER= BEADS_DIR=${store} ${quote(runner.interpreter)} ${quote(runner.script)} ${RUNNER_STORE_FLAG} ${store} ${RUNNER_WAIT_FLAG} ${RUNNER_WAIT_MS} -- `;
		cursor = write.offset;
	}
	return out + command.slice(cursor);
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
 * Instead each `bd` write in the command is rewritten to run under its own runner,
 * which holds the store for exactly as long as the `bd` process it is the parent of.
 * Reads and everything else in the command run as written.
 *
 * Fails closed throughout. A refusal from {@link planEmbeddedWrites}, an unreachable
 * runner, a store whose preflight fails, and any thrown error all block the call: an
 * unserialised write risks the database rather than the one command.
 */
export async function decideEmbeddedWrite(
	parsed: ParsedCommand,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	deadline = Date.now() + 25_000,
	runnerLookup: () => EmbeddedWriteRunnerLookup = embeddedWriteRunner,
): Promise<EmbeddedWriteDecision | undefined> {
	try {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown; cmd?: unknown; cwd?: unknown };
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : (ctx?.cwd ?? process.cwd());
		const plan = planEmbeddedWrites(parsed.command, cwd, environmentForInput(event.input));
		if (plan.kind === "refused") return { kind: "block", reason: plan.reason };
		if (plan.writes.length === 0) return;
		const stores = [...new Set(plan.writes.map(write => write.store))];
		const runner = runnerLookup();
		if ("unavailable" in runner) {
			return {
				kind: "block",
				reason: `${stores.join(", ")} ${stores.length > 1 ? "are embedded stores" : "is an embedded store"}, where two concurrent writers corrupt the Dolt journal, and the Beads write-lock runner that serialises writers could not be located: ${runner.unavailable} The write was refused rather than run unserialised.`,
			};
		}
		// Prove each store is takeable before the call runs, so a stuck holder surfaces
		// as a refusal now rather than as a runner waiting out its own deadline.
		const preflightOwner = `tool-call-preflight:${event.toolCallId}`;
		const preflightDeadline = Math.min(deadline, Date.now() + preflightWaitMs());
		for (const store of stores) {
			const preflight = await hold(store, preflightOwner, Math.max(0, preflightDeadline - Date.now()));
			if (preflight.kind === "failed") return { kind: "block", reason: preflight.reason };
			const released = await releasePreflight(store, preflightOwner, preflightDeadline);
			if (released.kind === "failed") return { kind: "block", reason: released.reason };
		}
		const rewritten = withRunner(parsed.command, plan.writes, runner);
		const next: Record<string, unknown> = { ...(event.input as Record<string, unknown>) };
		// Each runner inherits its store from command-local assignments. An unnamed Bash
		// call cannot carry host env/pty/ready options, so do not pass those fields along
		// after rewriting the command around the runner.
		if (typeof next.name !== "string" || next.name === "") {
			delete next.env;
			delete next.ready;
			delete next.pty;
		}
		next.cwd = cwd;
		// `cmd` is the alias some hosts send; whichever one carried the command carries
		// the rewrite, so the runner is what actually runs.
		if (typeof input.command === "string") next.command = rewritten;
		else next.cmd = rewritten;
		return { kind: "rewrite", input: next };
	} catch {
		return { kind: "block", reason: "embedded write target could not be resolved" };
	}
}
