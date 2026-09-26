/**
 * Runs one `bd` mutation as the embedded store's single writer.
 *
 * This is not an extension. It is a process the Bash gate rewrites a validated
 * `bd` command into, because the lock has to be held by something whose lifetime
 * is the mutation's lifetime, and nothing inside the agent process qualifies: the
 * only pre-execution seam fires before the approval prompt, and the only
 * settlement signal fires as soon as native Bash BACKGROUNDS a long command
 * rather than when it finishes. Both ends of that interval are wrong, and the
 * second one is unsafe -- it hands the store to the next writer while `bd` is
 * still writing.
 *
 * Here the interval is exact. The lock is taken immediately before `bd` is
 * spawned and given up in `finally` once it has exited, and this process is
 * `bd`'s parent, so there is no way for one to outlive the other. Everything Bash
 * can do to the call follows from that: an explicitly async or auto-backgrounded
 * call keeps its lock, because the tool result says nothing about this process;
 * and a call the host kills releases it, because the signal handlers and the exit
 * handler in the lock registry both run, with the lease and the pid check as the
 * backstop for a kill that runs nothing at all.
 *
 * `bd` inherits this process's stdio and environment, and its exit status becomes
 * this process's exit status, so the agent sees the real result of its own
 * mutation and nothing is reported before it happened.
 *
 * Usage, which the gate generates rather than a human writing it:
 *
 *     bun bd-embedded-write-runner.js --beads-store <dir> [--beads-wait-ms <n>] -- bd <args...>
 */

import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Subprocess } from "bun";

import { attachWriter, hold, RUNNER_STORE_FLAG, RUNNER_WAIT_FLAG, release } from "./bd-embedded-write-lock.ts";

/** Exit status for a runner that could not serialise the write, so never ran it. */
const NOT_RUN = 120;

const COMMAND_TIMEOUT_KEY = Symbol.for("com.srobroek.beads.embedded-write-runner.command-timeout-ms.v1");

/** Override the child deadline in tests; production always uses the finite default. */
export function setCommandTimeoutForTests(timeoutMs?: number): void {
	if (timeoutMs === undefined) Reflect.deleteProperty(globalThis, COMMAND_TIMEOUT_KEY);
	else Reflect.set(globalThis, COMMAND_TIMEOUT_KEY, timeoutMs);
}

function commandTimeoutMs(): number {
	const configured = Reflect.get(globalThis, COMMAND_TIMEOUT_KEY);
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : COMMAND_TIMEOUT_MS;
}

/** A child write cannot hold an embedded store indefinitely. */
const COMMAND_TIMEOUT_MS = 120_000;

interface Request {
	store: string;
	waitMs: number | undefined;
	argv: string[];
}

/**
 * The runner's own flags up to `--`, and the command after it.
 *
 * Strict: an unknown flag, a missing value, a missing `--`, and an empty command
 * are all refusals rather than defaults, because every invocation is generated and
 * a malformed one means the gate and the runner disagree about the write.
 */
export function parseRunnerArgs(args: string[]): Request | { error: string } {
	let store: string | undefined;
	let waitMs: number | undefined;
	let i = 0;
	for (; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--") {
			i++;
			break;
		}
		const value = args[i + 1];
		if (flag === RUNNER_STORE_FLAG) {
			if (value === undefined) return { error: `${RUNNER_STORE_FLAG} needs a store directory` };
			store = value;
			i++;
			continue;
		}
		if (flag === RUNNER_WAIT_FLAG) {
			const parsed = value === undefined ? Number.NaN : Number(value);
			if (!Number.isFinite(parsed) || parsed < 0) return { error: `${RUNNER_WAIT_FLAG} needs a non-negative number of milliseconds` };
			waitMs = parsed;
			i++;
			continue;
		}
		return { error: `unknown option ${flag}` };
	}
	if (store === undefined) return { error: `${RUNNER_STORE_FLAG} is required` };
	const argv = args.slice(i);
	if (argv.length === 0) return { error: "no command after --" };
	return { store, waitMs, argv };
}

/**
 * Hold `store`, run `argv`, and report what `bd` reported.
 *
 * The hold is released in `finally`, which covers every way the run can end: a clean
 * exit, a non-zero one, a signal, and a spawn that never started at all.
 *
 * The signal handlers are installed BEFORE the hold is taken, not after. A host that
 * kills the runner gets one chance to hand the store on rather than leaving the next
 * writer to time the lease out, and installing them later leaves a window in which the
 * lock file exists while the default disposition still applies -- a kill landing there
 * takes the process out with the file behind it, which is the exact failure this design
 * exists to remove. They also end the wait for a turn, so a runner killed while queued
 * dies at once instead of acquiring a store nobody is waiting on any more.
 */
async function run(request: Request): Promise<number> {
	const owner = `runner-${process.pid}`;
	const abort = new AbortController();
	let child: Subprocess | undefined;
	let killedBy: NodeJS.Signals | undefined;
	const stop = (signal: NodeJS.Signals): void => {
		killedBy ??= signal;
		abort.abort();
		try {
			child?.kill(signal);
		} catch {
			// Already gone; the await below resolves on its own.
		}
	};
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) process.on(signal, () => stop(signal));
	try {
		const got = await hold(request.store, owner, request.waitMs, abort.signal);
		if (got.kind === "failed") {
			process.stderr.write(`${got.reason}\n`);
			return NOT_RUN;
		}
		try {
			// Acquiring and being told to die can both have happened: the turn is taken
			// before the abort is read, so that the file is always owned by someone who
			// will release it. The mutation itself must still not start.
			if (killedBy !== undefined) return 128 + (SIGNAL_NUMBER[killedBy] ?? 0);
			const startGate = join(request.store, `.omp-embedded-write-start-${process.pid}-${randomUUID()}`);
			const launch = "while [ ! -e \"$1\" ]; do kill -0 \"$2\" 2>/dev/null || exit 120; sleep 0.02; done; shift 2; exec \"$@\"";
			// The shell cannot start bd until its pid is durable in the lock. If this
			// runner dies before publication, the shell observes its dead parent and exits;
			// after publication, exec keeps the recorded pid for bd itself.
			child = Bun.spawn(["/bin/sh", "-c", launch, "bd-write-gate", startGate, String(process.pid), ...request.argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
			if (!attachWriter(request.store, owner, child.pid)) {
				child.kill("SIGTERM");
				await child.exited;
				return NOT_RUN;
			}
			writeFileSync(startGate, "");
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				try { child?.kill("SIGKILL"); } catch { /* The child already exited. */ }
			}, commandTimeoutMs());
			const code = await child.exited;
			clearTimeout(timeout);
			try { unlinkSync(startGate); } catch { /* The gate may already be absent. */ }
			if (timedOut) {
				process.stderr.write(`embedded write child exceeded ${commandTimeoutMs() / 1000}s and was terminated\n`);
				return 124;
			}
			// A child killed by a signal exits with no code; report it the way a shell
			// does, so a caller reading `$?` sees the same number bd's own shell would give.
			return child.signalCode === null ? code : 128 + (SIGNAL_NUMBER[child.signalCode] ?? 0);
		} finally {
			release(request.store, owner);
		}
	} finally {
		for (const signal of signals) process.removeAllListeners(signal);
	}
}

/**
 * The numbers behind the signal names, for the shell's `128 + n` convention, so a
 * caller reading `$?` sees what bd's own shell would have given it.
 */
const SIGNAL_NUMBER: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

export async function main(args: string[]): Promise<number> {
	const request = parseRunnerArgs(args);
	if ("error" in request) {
		process.stderr.write(`bd-embedded-write-runner: ${request.error}\n`);
		return NOT_RUN;
	}
	try {
		return await run(request);
	} catch (error) {
		process.stderr.write(`bd-embedded-write-runner: ${error instanceof Error ? error.message : String(error)}\n`);
		return NOT_RUN;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
