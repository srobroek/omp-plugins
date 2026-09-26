// @bun
// extensions/bd-embedded-write-runner.ts
import { randomUUID } from "crypto";
import { unlinkSync as unlinkSync2, writeFileSync } from "fs";
import { join as join2 } from "path";

// extensions/bd-embedded-write-lock.ts
import { spawnSync } from "child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";

// extensions/shell-tokenizer.ts
var SEPARATORS = new Set([";", "&", "|", "(", ")", `
`]);

// extensions/shell-command.ts
var settingsCache = new Map;
// extensions/bd-actor-gate.ts
var ACTOR_NOTICE_ARBITER = Symbol.for("com.srobroek.beads.actor-notice-arbiter.v1");
var VALUE_FLAGS = new Set([
  "--actor",
  "--database",
  "--db",
  "-C",
  "--directory",
  "--dolt-auto-commit",
  "--mem-profile"
]);
var pendingAdvisory = new Map;

// extensions/bd-embedded-write-lock.ts
var LOCK_NAME = "omp-embedded-write.lock";
var STEAL_NAME = "omp-embedded-write-steal.lock";
var LEASE_MS = 120000;
var RENEW_MS = 20000;
var WAIT_MS = 120000;
var POLL_MS = 20;
var PREFLIGHT_WAIT_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.preflight-wait-ms.v1");
var leaseMs = LEASE_MS;
var renewMs = RENEW_MS;
var nextToken = 0;
var HOST = hostname().split(".")[0] ?? "localhost";
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function parseLinuxStatStartIdentity(stat) {
  const close = stat.lastIndexOf(")");
  if (close < 0)
    return;
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  const start = fields[19];
  return start !== undefined && start !== "" ? start : undefined;
}
function processStartIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const identity = parseLinuxStatStartIdentity(stat);
      if (identity !== undefined)
        return identity;
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 100,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.error || result.status !== 0)
      return;
    const identity = String(result.stdout ?? "").trim();
    return identity === "" ? undefined : identity;
  } catch {
    return;
  }
}
var REGISTRY_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.v1");
function registry() {
  const holder = globalThis;
  const existing = holder[REGISTRY_KEY];
  if (existing !== undefined)
    return existing;
  const created = { owned: new Map, queues: new Map };
  holder[REGISTRY_KEY] = created;
  process.on("exit", () => {
    for (const [lock, held] of created.owned) {
      clearInterval(held.renew);
      try {
        closeSync(held.fd);
      } catch {}
      try {
        withOwnership(lock, held.token, () => unlinkSync(lock));
      } catch {}
    }
    created.owned.clear();
  });
  return created;
}
function ageOf(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
function lockHolder(lock) {
  let ageMs = ageOf(lock);
  try {
    const parsed = JSON.parse(readFileSync(lock, "utf8"));
    if (typeof parsed.taken === "number")
      ageMs = Math.max(0, Date.now() - parsed.taken);
    const owner = typeof parsed.owner === "string" && parsed.owner.length > 0 ? parsed.owner : "unknown owner";
    const pid = typeof parsed.pid === "number" ? `pid ${parsed.pid}` : "pid unknown";
    const writer = typeof parsed.writer === "number" ? `, writer pid ${parsed.writer}` : "";
    const host = typeof parsed.host === "string" && parsed.host.length > 0 ? ` on ${parsed.host}` : "";
    return `holder ${owner} (${pid}${writer}${host}), age ${Math.round(ageMs / 1000)}s`;
  } catch {
    return `holder record unreadable, age ${Math.round(Math.max(0, ageMs) / 1000)}s`;
  }
}
function abandoned(lock) {
  let raw;
  try {
    raw = readFileSync(lock, "utf8");
  } catch {
    return false;
  }
  let holder;
  try {
    holder = JSON.parse(raw);
  } catch {
    return ageOf(lock) > leaseMs;
  }
  const local = holder.host === HOST;
  if (local && typeof holder.writer === "number") {
    const currentStart = processStartIdentity(holder.writer);
    const sameWriter = typeof holder.writerStart !== "string" || currentStart === undefined || currentStart === holder.writerStart;
    if (pidAlive(holder.writer) && sameWriter)
      return false;
  }
  if (local && typeof holder.pid === "number" && !pidAlive(holder.pid))
    return true;
  if (typeof holder.expires === "number")
    return Date.now() > holder.expires;
  return ageOf(lock) > leaseMs;
}
function takeOverIfAbandoned(lock, steal) {
  if (!abandoned(lock))
    return;
  let fd;
  try {
    fd = openSync(steal, "wx");
  } catch (error) {
    if (error.code !== "EEXIST")
      return;
    if (abandoned(steal)) {
      try {
        unlinkSync(steal);
      } catch {}
    }
    return;
  }
  try {
    writeSync(fd, JSON.stringify(holderNow(`steal-${process.pid}`, `steal-${(nextToken++).toString(36)}`, undefined)));
    if (abandoned(lock))
      unlinkSync(lock);
  } catch {} finally {
    closeSync(fd);
    try {
      unlinkSync(steal);
    } catch {}
  }
}
function holderNow(owner, token, writer, writerStart = writer === undefined ? undefined : processStartIdentity(writer)) {
  const taken = Date.now();
  return {
    host: HOST,
    pid: process.pid,
    owner,
    token,
    taken,
    expires: taken + leaseMs,
    ...writer === undefined ? {} : { writer, ...writerStart === undefined ? {} : { writerStart } }
  };
}
function stillOurs(lock, token) {
  try {
    const holder = JSON.parse(readFileSync(lock, "utf8"));
    return holder.token === token && holder.pid === process.pid && holder.host === HOST;
  } catch {
    return false;
  }
}
async function pause(ticket, ms, signal) {
  const { promise, resolve } = Promise.withResolvers();
  const done = () => resolve();
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
function wakeHead(lock) {
  registry().queues.get(lock)?.[0]?.wake?.();
}
async function hold(store, owner, waitMs = WAIT_MS, signal) {
  const lock = join(store, LOCK_NAME);
  const { owned, queues } = registry();
  const deadline = Date.now() + waitMs;
  const queue = queues.get(lock) ?? [];
  if (queue.length === 0)
    queues.set(lock, queue);
  const ticket = { wake: undefined };
  queue.push(ticket);
  try {
    while (true) {
      const held = owned.get(lock);
      if (held !== undefined) {
        const nested = held.holders.get(owner);
        if (nested !== undefined) {
          held.holders.set(owner, nested + 1);
          return { kind: "held" };
        }
      } else if (queue[0] === ticket) {
        try {
          const fd = openSync(lock, "wx");
          const token = `${process.pid}-${Date.now()}-${(nextToken++).toString(36)}`;
          writeSync(fd, JSON.stringify(holderNow(owner, token, undefined)));
          const renew = setInterval(() => {
            try {
              renewLease(lock, owner, token);
            } catch {}
          }, renewMs);
          renew.unref?.();
          owned.set(lock, { fd, holders: new Map([[owner, 1]]), renew, token, writer: undefined, writerStart: undefined });
          return { kind: "held" };
        } catch (error) {
          const code = error.code;
          if (code !== "EEXIST") {
            return {
              kind: "failed",
              reason: `Beads embedded write lock could not be taken at ${lock} (${code ?? "unknown error"}). The write was refused rather than risk a second writer on the embedded Dolt journal.`
            };
          }
          takeOverIfAbandoned(lock, join(store, STEAL_NAME));
        }
      }
      if (signal?.aborted === true) {
        return {
          kind: "failed",
          reason: `Waiting for the Beads embedded write lock at ${lock} was cancelled before this writer got its turn. Nothing was written.`
        };
      }
      if (Date.now() >= deadline) {
        const holder = lockHolder(lock);
        return {
          kind: "failed",
          reason: `Beads embedded write lock at ${lock} stayed held for ${Math.round(waitMs / 1000)}s; ${holder}. The write was refused rather than run concurrently. Read the lock file, then remove it once its holder is really gone.`
        };
      }
      await pause(ticket, Math.min(POLL_MS, deadline - Date.now()), signal);
    }
  } finally {
    const index = queue.indexOf(ticket);
    if (index >= 0)
      queue.splice(index, 1);
    if (queue.length === 0)
      queues.delete(lock);
    else if (index === 0)
      queue[0]?.wake?.();
  }
}
function withOwnership(storeLock, token, change) {
  const steal = join(dirname(storeLock), STEAL_NAME);
  let fd;
  try {
    fd = openSync(steal, "wx");
  } catch (error) {
    if (error.code === "EEXIST")
      return "busy";
    throw error;
  }
  try {
    if (!stillOurs(storeLock, token))
      return "lost";
    change();
    return "done";
  } finally {
    closeSync(fd);
    try {
      unlinkSync(steal);
    } catch {}
  }
}
function release(store, owner) {
  const lock = join(store, LOCK_NAME);
  const owned = registry().owned;
  const held = owned.get(lock);
  if (held === undefined)
    return;
  const shares = held.holders.get(owner);
  if (shares === undefined)
    return;
  if (shares > 1) {
    held.holders.set(owner, shares - 1);
    return;
  }
  held.holders.delete(owner);
  if (held.holders.size > 0)
    return;
  owned.delete(lock);
  clearInterval(held.renew);
  try {
    closeSync(held.fd);
  } catch {}
  try {
    withOwnership(lock, held.token, () => unlinkSync(lock));
  } catch {}
  wakeHead(lock);
}
function renewLease(lock, owner, token) {
  const owned = registry().owned;
  const held = owned.get(lock);
  if (held === undefined || held.token !== token)
    return;
  const result = withOwnership(lock, token, () => {
    const fd = openSync(lock, "w");
    try {
      writeSync(fd, JSON.stringify(holderNow(owner, token, held.writer, held.writerStart)));
    } finally {
      closeSync(fd);
    }
  });
  if (result !== "lost")
    return;
  clearInterval(held.renew);
  owned.delete(lock);
  try {
    closeSync(held.fd);
  } catch {}
}
function attachWriter(store, owner, pid) {
  const lock = join(store, LOCK_NAME);
  const held = registry().owned.get(lock);
  if (held === undefined || !held.holders.has(owner))
    return false;
  const writerStart = processStartIdentity(pid);
  const result = withOwnership(lock, held.token, () => {
    const fd = openSync(lock, "w");
    try {
      writeSync(fd, JSON.stringify(holderNow(owner, held.token, pid, writerStart)));
    } finally {
      closeSync(fd);
    }
  });
  if (result !== "done")
    return false;
  held.writer = pid;
  held.writerStart = writerStart;
  return true;
}
var RUNNER_STORE_FLAG = "--beads-store";
var RUNNER_WAIT_FLAG = "--beads-wait-ms";

// extensions/bd-embedded-write-runner.ts
var NOT_RUN = 120;
var COMMAND_TIMEOUT_KEY = Symbol.for("com.srobroek.beads.embedded-write-runner.command-timeout-ms.v1");
function setCommandTimeoutForTests(timeoutMs) {
  if (timeoutMs === undefined)
    Reflect.deleteProperty(globalThis, COMMAND_TIMEOUT_KEY);
  else
    Reflect.set(globalThis, COMMAND_TIMEOUT_KEY, timeoutMs);
}
function commandTimeoutMs() {
  const configured = Reflect.get(globalThis, COMMAND_TIMEOUT_KEY);
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : COMMAND_TIMEOUT_MS;
}
var COMMAND_TIMEOUT_MS = 120000;
function parseRunnerArgs(args) {
  let store;
  let waitMs;
  let i = 0;
  for (;i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") {
      i++;
      break;
    }
    const value = args[i + 1];
    if (flag === RUNNER_STORE_FLAG) {
      if (value === undefined)
        return { error: `${RUNNER_STORE_FLAG} needs a store directory` };
      store = value;
      i++;
      continue;
    }
    if (flag === RUNNER_WAIT_FLAG) {
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(parsed) || parsed < 0)
        return { error: `${RUNNER_WAIT_FLAG} needs a non-negative number of milliseconds` };
      waitMs = parsed;
      i++;
      continue;
    }
    return { error: `unknown option ${flag}` };
  }
  if (store === undefined)
    return { error: `${RUNNER_STORE_FLAG} is required` };
  const argv = args.slice(i);
  if (argv.length === 0)
    return { error: "no command after --" };
  return { store, waitMs, argv };
}
async function run(request) {
  const owner = `runner-${process.pid}`;
  const abort = new AbortController;
  let child;
  let killedBy;
  const stop = (signal) => {
    killedBy ??= signal;
    abort.abort();
    try {
      child?.kill(signal);
    } catch {}
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals)
    process.on(signal, () => stop(signal));
  try {
    const got = await hold(request.store, owner, request.waitMs, abort.signal);
    if (got.kind === "failed") {
      process.stderr.write(`${got.reason}
`);
      return NOT_RUN;
    }
    try {
      if (killedBy !== undefined)
        return 128 + (SIGNAL_NUMBER[killedBy] ?? 0);
      const startGate = join2(request.store, `.omp-embedded-write-start-${process.pid}-${randomUUID()}`);
      const launch = 'while [ ! -e "$1" ]; do kill -0 "$2" 2>/dev/null || exit 120; sleep 0.02; done; shift 2; exec "$@"';
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
        try {
          child?.kill("SIGKILL");
        } catch {}
      }, commandTimeoutMs());
      const code = await child.exited;
      clearTimeout(timeout);
      try {
        unlinkSync2(startGate);
      } catch {}
      if (timedOut) {
        process.stderr.write(`embedded write child exceeded ${commandTimeoutMs() / 1000}s and was terminated
`);
        return 124;
      }
      return child.signalCode === null ? code : 128 + (SIGNAL_NUMBER[child.signalCode] ?? 0);
    } finally {
      release(request.store, owner);
    }
  } finally {
    for (const signal of signals)
      process.removeAllListeners(signal);
  }
}
var SIGNAL_NUMBER = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
async function main(args) {
  const request = parseRunnerArgs(args);
  if ("error" in request) {
    process.stderr.write(`bd-embedded-write-runner: ${request.error}
`);
    return NOT_RUN;
  }
  try {
    return await run(request);
  } catch (error) {
    process.stderr.write(`bd-embedded-write-runner: ${error instanceof Error ? error.message : String(error)}
`);
    return NOT_RUN;
  }
}
if (import.meta.main)
  process.exitCode = await main(process.argv.slice(2));
export {
  main,
  parseRunnerArgs,
  setCommandTimeoutForTests
};
