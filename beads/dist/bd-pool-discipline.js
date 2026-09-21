// @bun
// extensions/shell-tokenizer.ts
var SEPARATORS = new Set([";", "&", "|", "(", ")", `
`]);
function token(value, startsQuoted = false, sawQuote = false) {
  return { value, startsQuoted, sawQuote };
}
function tokenizeShell(command, options = {}) {
  const out = [];
  let current = "";
  let started = false;
  let startsQuoted = false;
  let sawQuote = false;
  let quote = null;
  const pending = [];
  const flush = () => {
    if (!started)
      return;
    out.push(token(current, startsQuoted, sawQuote));
    current = "";
    started = false;
    startsQuoted = false;
    sawQuote = false;
  };
  for (let i = 0;i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!started)
        startsQuoted = true;
      started = true;
      sawQuote = true;
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (options.preserveBackslashes)
        current += ch;
      current += command[++i];
      started = true;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      flush();
      out.push(token("$("));
      i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
      flush();
      out.push(token("<<<"));
      i += 2;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      const operator = hereDocumentOperator(command, i);
      if (operator !== null) {
        flush();
        pending.push(operator);
        i = operator.end - 1;
        continue;
      }
    }
    if (ch === `
`) {
      flush();
      out.push(token(ch));
      let bodyStart = i + 1;
      while (pending.length > 0) {
        const document = pending.shift();
        if (document === undefined)
          break;
        const body = hereDocumentBody(command, bodyStart, document);
        if (!document.quoted) {
          out.push(...tokenizeShell(command.slice(bodyStart, body.bodyEnd), options));
        }
        i = body.terminatorEnd;
        bodyStart = i + 1;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (SEPARATORS.has(ch)) {
      flush();
      out.push(token(ch));
      continue;
    }
    current += ch;
    started = true;
  }
  flush();
  return out;
}
function hereDocumentOperator(command, start) {
  let i = start + 2;
  const stripTabs = command[i] === "-";
  if (stripTabs)
    i++;
  while (command[i] === " " || command[i] === "\t")
    i++;
  let delimiter = "";
  let quoted = false;
  let quote = null;
  while (i < command.length) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      delimiter += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoted = true;
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      quoted = true;
      delimiter += command[i + 1];
      i += 2;
      continue;
    }
    if (/\s|[;&|<>()]/.test(ch))
      break;
    delimiter += ch;
    i++;
  }
  if (quote !== null || delimiter.length === 0)
    return null;
  return { delimiter, stripTabs, quoted, end: i };
}
function hereDocumentBody(command, from, document) {
  let cursor = from;
  while (cursor < command.length) {
    let next = command.indexOf(`
`, cursor);
    if (next === -1)
      next = command.length;
    let line = command.slice(cursor, next);
    if (document.stripTabs)
      line = line.replace(/^\t+/, "");
    if (line === document.delimiter)
      return { bodyEnd: cursor, terminatorEnd: next };
    if (next === command.length)
      break;
    cursor = next + 1;
  }
  return { bodyEnd: command.length, terminatorEnd: command.length };
}

// extensions/shell-command.ts
import { resolve } from "path";
function leadingCdCwd(command, cwd) {
  const match = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command);
  if (!match)
    return cwd;
  const dir = match[1];
  if (!dir || /^[-~$]/.test(dir) || /[\\`"'*?\x5b\x5d{}]/.test(dir))
    return cwd;
  return dir.startsWith("/") ? dir : resolve(cwd, dir);
}
function commandFromInput(input) {
  if (!input || typeof input !== "object")
    return "";
  const value = input;
  if (typeof value.command === "string")
    return value.command;
  if (typeof value.cmd === "string")
    return value.cmd;
  return "";
}
var settingsCache = new Map;
// extensions/bd-close-gate.ts
function tokenize(command) {
  return tokenizeShell(command).map(({ value }) => value);
}

// extensions/bd-actor-gate.ts
var ACTOR_NOTICE_ARBITER = Symbol.for("com.srobroek.beads.actor-notice-arbiter.v1");
var ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"];
var VALUE_FLAGS = new Set([
  "--actor",
  "--database",
  "--db",
  "-C",
  "--directory",
  "--dolt-auto-commit",
  "--mem-profile"
]);
var TRANSPARENT_WRAPPERS = { command: true, env: true, sudo: true };
var WRAPPER_VALUE_FLAGS = {
  "-C": true,
  "--chdir": true,
  "--chroot": true,
  "--command-timeout": true,
  "-g": true,
  "--group": true,
  "-h": true,
  "--host": true,
  "-p": true,
  "--prompt": true,
  "-R": true,
  "-T": true,
  "-u": true,
  "--unset": true,
  "--user": true
};
function commandSegments(command) {
  const segments = [];
  let segment = [];
  for (const token of tokenize(command)) {
    if ([";", "&", "|", "(", ")", "$(", `
`].includes(token)) {
      if (segment.length)
        segments.push(segment);
      segment = [];
    } else
      segment.push(token);
  }
  if (segment.length)
    segments.push(segment);
  return segments;
}
function bdInvocations(command) {
  const out = [];
  let exported = {};
  for (const tokens of commandSegments(command)) {
    if (tokens[0] === "export") {
      for (const variable of ACTOR_VARS) {
        const assignment = tokens.findLast((token) => token.startsWith(`${variable}=`));
        if (assignment !== undefined) {
          exported = { ...exported, [variable]: assignment.slice(variable.length + 1) };
        }
      }
      continue;
    }
    let i = 0;
    const prefix = [];
    while (true) {
      while (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "")) {
        prefix.push(tokens[i]);
        i++;
      }
      const wrapper = (tokens[i] ?? "").split("/").pop() ?? "";
      if (TRANSPARENT_WRAPPERS[wrapper] !== true)
        break;
      i++;
      if (wrapper === "command")
        continue;
      while (tokens[i]?.startsWith("-")) {
        const flag = tokens[i];
        i++;
        if (WRAPPER_VALUE_FLAGS[flag] === true)
          i++;
      }
    }
    const word = tokens[i];
    if (word === undefined || (word.split("/").pop() ?? word) !== "bd")
      continue;
    i++;
    const scanned = scanGlobals(tokens, i);
    const verb = tokens[scanned.next];
    if (verb !== undefined) {
      out.push({ verb: verb.toLowerCase(), args: tokens.slice(scanned.next + 1), globals: scanned.globals, prefix, exported: { ...exported } });
    }
  }
  return out;
}
function scanGlobals(tokens, from) {
  const globals = [];
  let i = from;
  while (true) {
    const flag = tokens[i];
    if (flag === undefined || !flag.startsWith("-"))
      break;
    globals.push(flag);
    i++;
    if (flag.includes("="))
      continue;
    if (!VALUE_FLAGS.has(flag))
      continue;
    const value = tokens[i];
    if (value !== undefined)
      globals.push(value);
    i++;
  }
  return { globals, next: i };
}
function globalValue(globals, names) {
  for (const [index, token] of globals.entries()) {
    for (const name of names) {
      if (token === name)
        return globals[index + 1];
      if (token.startsWith(`${name}=`))
        return token.slice(name.length + 1);
    }
  }
  return;
}
function flagEnabled(tokens, names) {
  for (const token of tokens) {
    for (const name of names) {
      if (token === name)
        return true;
      if (token.startsWith(`${name}=`))
        return TRUTHY[token.slice(name.length + 1)] === true;
      if (name.length === 2 && name.startsWith("-") && /^-[A-Za-z]{2,}$/.test(token) && token.includes(name.slice(1))) {
        return true;
      }
    }
  }
  return false;
}
var TRUTHY = { "": true, "1": true, t: true, T: true, TRUE: true, true: true, True: true };
var pendingAdvisory = new Map;
function environmentForInput(input, base = process.env) {
  const env = { ...base };
  const supplied = "env" in input ? input.env : undefined;
  if (supplied !== null && typeof supplied === "object") {
    for (const [name, value] of Object.entries(supplied)) {
      if (typeof value === "string")
        env[name] = value;
    }
  }
  return env;
}

// extensions/bd-embedded-write-lock.ts
import { closeSync, existsSync, openSync, readFileSync, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { isAbsolute as isAbsolute2, join, resolve as resolve3 } from "path";

// extensions/beads-store.ts
import { execFileSync } from "child_process";
import { realpathSync, statSync } from "fs";
import { isAbsolute, resolve as resolve2 } from "path";
function repoIdentity(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return realpathSync(isAbsolute(out) ? out : resolve2(cwd, out));
  } catch {
    return cwd;
  }
}
function sessionPinFor(cwd) {
  const local = resolve2(cwd, ".beads");
  const common = repoIdentity(cwd);
  if (common !== cwd && common.endsWith("/.git")) {
    const primaryRoot = resolve2(common, "..");
    if (realpathSync(cwd) === primaryRoot && isDir(local))
      return local;
    const primary = resolve2(primaryRoot, ".beads");
    if (isDir(primary))
      return primary;
  }
  if (isDir(local))
    return local;
  return;
}
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// extensions/bd-embedded-write-lock.ts
var LOCK_NAME = "omp-embedded-write.lock";
var STEAL_NAME = "omp-embedded-write-steal.lock";
var LEASE_MS = 120000;
var RENEW_MS = 20000;
var WAIT_MS = 20000;
var POLL_MS = 20;
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
var REGISTRY_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.v1");
function registry() {
  const holder = globalThis;
  const existing = holder[REGISTRY_KEY];
  if (existing !== undefined)
    return existing;
  const created = { owned: new Map };
  holder[REGISTRY_KEY] = created;
  process.on("exit", () => {
    for (const [lock, held] of created.owned) {
      clearInterval(held.renew);
      try {
        closeSync(held.fd);
      } catch {}
      try {
        unlinkSync(lock);
      } catch {}
    }
    created.owned.clear();
  });
  return created;
}
function storeFor(globals, cwd, env) {
  if (flagEnabled(globals, ["--global"]))
    return;
  if (globalValue(globals, ["--database"]) !== undefined)
    return;
  const directory = globalValue(globals, ["-C", "--directory"]);
  const db = globalValue(globals, ["--db"]);
  const base = directory === undefined ? cwd : absolute(directory, cwd);
  if (db !== undefined) {
    const target = absolute(db, base);
    if (!existsSync(target))
      return;
    return canonical(isDirectory(target) ? target : join(target, ".."));
  }
  if (directory !== undefined)
    return canonicalStore(sessionPinFor(base));
  const pinned = env.BEADS_DIR;
  if (pinned !== undefined && pinned !== "")
    return canonical(absolute(pinned, cwd));
  return canonicalStore(sessionPinFor(cwd));
}
function absolute(path, cwd) {
  return isAbsolute2(path) ? path : resolve3(cwd, path);
}
function isDirectory(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function canonical(path) {
  try {
    return realpathSync2(path);
  } catch {
    return resolve3(path);
  }
}
function canonicalStore(store) {
  return store === undefined ? undefined : canonical(store);
}
function embedded(store) {
  let metadata = "";
  let config = "";
  try {
    metadata = readFileSync(join(store, "metadata.json"), "utf8");
  } catch {}
  try {
    config = readFileSync(join(store, "config.yaml"), "utf8");
  } catch {}
  return metadata !== "" || config !== "";
}
function embeddedStoreFor(cwd, env = process.env) {
  const store = storeFor([], cwd, env);
  return store !== undefined && embedded(store) ? store : undefined;
}
function ageOf(path) {
  try {
    return Date.now() - statSync2(path).mtimeMs;
  } catch {
    return 0;
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
  if (holder.host === HOST && typeof holder.pid === "number" && !pidAlive(holder.pid))
    return true;
  if (typeof holder.expires === "number")
    return Date.now() > holder.expires;
  return ageOf(lock) > leaseMs;
}
function takeOverIfAbandoned(lock, steal) {
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
    writeSync(fd, JSON.stringify(holderNow(`steal-${process.pid}`, `steal-${(nextToken++).toString(36)}`)));
    if (abandoned(lock))
      unlinkSync(lock);
  } catch {} finally {
    closeSync(fd);
    try {
      unlinkSync(steal);
    } catch {}
  }
}
function holderNow(toolCallId, token) {
  const taken = Date.now();
  return { host: HOST, pid: process.pid, toolCallId, token, taken, expires: taken + leaseMs };
}
function stillOurs(lock, token) {
  try {
    const holder = JSON.parse(readFileSync(lock, "utf8"));
    return holder.token === token && holder.pid === process.pid && holder.host === HOST;
  } catch {
    return false;
  }
}
async function hold(store, toolCallId, waitMs = WAIT_MS) {
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
        const fd = openSync(lock, "wx");
        const token = `${process.pid}-${Date.now()}-${(nextToken++).toString(36)}`;
        writeSync(fd, JSON.stringify(holderNow(toolCallId, token)));
        const renew = setInterval(() => {
          try {
            renewLease(lock, toolCallId, token);
          } catch {}
        }, renewMs);
        renew.unref?.();
        owned.set(lock, { fd, holders: new Map([[toolCallId, 1]]), renew, token });
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
    if (Date.now() >= deadline) {
      return {
        kind: "failed",
        reason: `Beads embedded write lock at ${lock} stayed held for ${Math.round(waitMs / 1000)}s. Another writer is still working, or a hold was left behind by a process on another host; the write was refused rather than run concurrently. Read the lock file, then remove it once its holder is really gone.`
      };
    }
    const { promise, resolve: wake } = Promise.withResolvers();
    setTimeout(wake, POLL_MS);
    await promise;
  }
}
function release(store, toolCallId) {
  const lock = join(store, LOCK_NAME);
  const owned = registry().owned;
  const owner = owned.get(lock);
  if (owner === undefined)
    return;
  const shares = owner.holders.get(toolCallId);
  if (shares === undefined)
    return;
  if (shares > 1) {
    owner.holders.set(toolCallId, shares - 1);
    return;
  }
  owner.holders.delete(toolCallId);
  if (owner.holders.size > 0)
    return;
  owned.delete(lock);
  clearInterval(owner.renew);
  try {
    closeSync(owner.fd);
  } catch {}
  if (stillOurs(lock, owner.token)) {
    try {
      unlinkSync(lock);
    } catch {}
  }
}
function renewLease(lock, toolCallId, token) {
  const owned = registry().owned;
  const owner = owned.get(lock);
  if (owner === undefined || owner.token !== token)
    return;
  if (!stillOurs(lock, token)) {
    clearInterval(owner.renew);
    owned.delete(lock);
    try {
      closeSync(owner.fd);
    } catch {}
    return;
  }
  const fd = openSync(lock, "w");
  try {
    writeSync(fd, JSON.stringify(holderNow(toolCallId, token)));
  } finally {
    closeSync(fd);
  }
}
async function withEmbeddedWriteLock(cwd, toolCallId, write, env = process.env, deadline) {
  const store = embeddedStoreFor(cwd, env);
  if (store === undefined)
    return { kind: "done", value: await write() };
  const waitMs = deadline === undefined ? WAIT_MS : Math.max(0, deadline - Date.now());
  const got = await hold(store, toolCallId, waitMs);
  if (got.kind === "failed")
    return got;
  try {
    return { kind: "done", value: await write() };
  } finally {
    release(store, toolCallId);
  }
}
var activeHolds = new Map;
var surrenderedCalls = new Set;

// extensions/bd-pool-discipline.ts
var CLAIM_POOLS_KEY = "claim.pools";
var PHASE_METADATA_KEY = "phase";
var INTEGRATION_OWNER_METADATA_KEY = "integration_owner";
var DECLARED_POOL_ALIASES = [
  "pool:orc-implementer",
  "pool:orc-implementer-deep",
  "pool:orc-implementer-max",
  "pool:orc-reviewer",
  "pool:orc-researcher",
  "pool:orc-shepherd",
  "pool:orc-merger",
  "pool:orc-lead"
];
var DECLARED_POOL_SET = DECLARED_POOL_ALIASES.join(",");
var TIMEOUT_MS = 25000;
var PREFILTER = /\bbd\b[\s\S]{0,400}?(?:--claim\b|\bclaim\b|\breclaim\b)/;
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
var POOLS_FAILURE = "bd pool discipline refused: cannot establish claim.pools in the client's database for this store";
var NO_PHASE_ADVISORY = (id) => `bd pool discipline advisory: reclaimed work bead ${id} has no recorded \`phase\` metadata; it remains unassigned and needs an explicit phase before it can re-enter a pool.`;
var NO_OWNER_ADVISORY = (id) => `bd pool discipline advisory: reclaimed merge slot ${id} has no recorded \`integration_owner\` metadata; it remains unassigned and needs an explicit owner before it can serialize a target.`;
var RESTAMP_FAILURE = (id, detail) => `bd pool discipline advisory: could not restore phase for reclaimed work bead ${id} (${detail}); it remains unassigned.`;
var OWNER_RESTORE_FAILURE = (id, detail) => `bd pool discipline advisory: could not restore integration owner for reclaimed merge slot ${id} (${detail}); it remains unassigned.`;
var injectedRun = null;
function setBdRunForTests(fn) {
  injectedRun = fn;
}
function parsePoolConfig(output) {
  try {
    const parsed = JSON.parse(output);
    const found = findPoolRecord(parsed);
    if (found !== undefined)
      return found;
  } catch {}
  const line = output.split(/\r?\n/).find((value) => value.includes(CLAIM_POOLS_KEY));
  if (line === undefined)
    return;
  const source = line.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ?? "unknown";
  const valuePart = line.replace(new RegExp(`^.*${CLAIM_POOLS_KEY}\\s*(?:=|:)\\s*`), "").replace(/\s*\([^)]*\)\s*$/, "").trim().replace(/^['"]|['"]$/g, "");
  return { value: valuePart, source };
}
function findPoolRecord(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPoolRecord(item);
      if (found !== undefined)
        return found;
    }
    return;
  }
  if (value === null || typeof value !== "object")
    return;
  const object = value;
  const direct = object[CLAIM_POOLS_KEY];
  if (typeof direct === "string")
    return { value: direct, source: stringField(object, "source", "provenance") ?? "unknown" };
  if (direct !== null && typeof direct === "object") {
    const record = direct;
    const directValue = stringField(record, "value", "effective", "raw");
    if (directValue !== undefined)
      return { value: directValue, source: stringField(record, "source", "provenance") ?? stringField(object, "source", "provenance") ?? "unknown" };
  }
  if (object.key === CLAIM_POOLS_KEY || object.name === CLAIM_POOLS_KEY) {
    const recordValue = stringField(object, "value", "effective", "raw");
    if (recordValue !== undefined)
      return { value: recordValue, source: stringField(object, "source", "provenance") ?? "unknown" };
  }
  for (const child of Object.values(object)) {
    const found = findPoolRecord(child);
    if (found !== undefined)
      return found;
  }
  return;
}
function stringField(object, ...names) {
  for (const name of names) {
    if (typeof object[name] === "string")
      return object[name];
  }
  return;
}
function isClaimOperation(invocation) {
  return invocation.verb === "claim" || (invocation.verb === "update" || invocation.verb === "ready") && invocation.args.includes("--claim");
}
function isReclaimOperation(invocation) {
  return invocation.verb === "reclaim";
}
function claimIds(invocation) {
  if (invocation.verb !== "claim" && invocation.verb !== "update")
    return [];
  return invocation.args.filter((argument) => BEAD_ID.test(argument));
}
function assigneeFromShow(output, id) {
  try {
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && ("data" in parsed) && Array.isArray(parsed.data) ? parsed.data : [parsed];
    const row = rows.find((item) => item !== null && typeof item === "object" && item.id === id);
    return typeof row?.assignee === "string" ? row.assignee : undefined;
  } catch {
    return;
  }
}
async function isPooledClaim(invocation, cwd, env, deadline) {
  const ids = claimIds(invocation);
  if (ids.length === 0)
    return false;
  const run = injectedRun ?? defaultRun;
  for (const id of ids) {
    const shown = await runWithDeadline(run, ["bd", ...invocation.globals, "show", id, "--json"], cwd, env, deadline);
    if (shown.exitCode !== 0)
      continue;
    const assignee = assigneeFromShow(shown.stdout, id);
    if (assignee !== undefined && DECLARED_POOL_ALIASES.includes(assignee))
      return true;
  }
  return false;
}
async function establishPool(invocation, cwd, env, deadline) {
  const run = injectedRun ?? defaultRun;
  const read = await runWithDeadline(run, ["bd", ...poolConfigArgs(invocation)], cwd, env, deadline);
  if (Date.now() >= deadline)
    return { ok: false, reason: `${POOLS_FAILURE}: handler deadline expired before the database pool set could be verified.` };
  const existing = read.exitCode === 0 ? parsePoolConfig(read.stdout) : undefined;
  if (existing?.source === "database" && existing.value.trim() !== "")
    return { ok: true };
  const store = storeName(cwd, env, invocation);
  const written = await withEmbeddedWriteLock(cwd, `pool-discipline-${Date.now()}`, () => runWithDeadline(run, ["bd", ...poolSetArgs(invocation)], cwd, env, deadline), env, deadline);
  if (written.kind === "failed" || written.value.exitCode !== 0) {
    const detail = written.kind === "failed" ? written.reason : written.value.stderr?.trim();
    return { ok: false, reason: `${POOLS_FAILURE}: key ${CLAIM_POOLS_KEY}, store ${store}${detail ? ` (${detail})` : ""}.` };
  }
  const verify = await runWithDeadline(run, ["bd", ...poolConfigArgs(invocation)], cwd, env, deadline);
  if (Date.now() >= deadline)
    return { ok: false, reason: `${POOLS_FAILURE}: handler deadline expired before the database pool set could be verified.` };
  const after = verify.exitCode === 0 ? parsePoolConfig(verify.stdout) : undefined;
  if (after?.source === "database" && after.value.trim() !== "")
    return { ok: true };
  return { ok: false, reason: `${POOLS_FAILURE}: key ${CLAIM_POOLS_KEY}, store ${store}. Readback did not show a database value.` };
}
function poolConfigArgs(invocation) {
  return [...invocation.globals, "config", "show", "--json"];
}
function poolSetArgs(invocation) {
  return [...invocation.globals, "config", "set", CLAIM_POOLS_KEY, DECLARED_POOL_SET];
}
function phaseArgs(invocation, id, phase) {
  return [...invocation.globals, "update", id, "--assignee", phase, "--json"];
}
function ownerArgs(invocation, id, owner) {
  return [...invocation.globals, "update", id, "--assignee", owner, "--json"];
}
function invocationIds(invocation) {
  if (invocation.verb !== "reclaim")
    return [];
  const ids = new Set;
  for (let i = 0;i < invocation.args.length; i++) {
    if (invocation.args[i] === "--id" || invocation.args[i] === "-i") {
      const id = invocation.args[++i];
      if (id !== undefined && BEAD_ID.test(id))
        ids.add(id);
    }
  }
  return [...ids];
}
function reclaimedIds(output, invocation) {
  const ids = new Set(invocation === undefined ? [] : invocationIds(invocation));
  for (const match of output.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
    if (BEAD_ID.test(match[1] ?? ""))
      ids.add(match[1]);
  }
  for (const match of output.matchAll(/\b(?:reclaimed|reclaiming|recovered)\s+(?:bead|issue)?\s*([A-Za-z][A-Za-z0-9-]+)/gi)) {
    if (BEAD_ID.test(match[1] ?? ""))
      ids.add(match[1]);
  }
  return [...ids];
}
function rowForId(output, id) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && ("data" in parsed) && Array.isArray(parsed.data) ? parsed.data : [parsed];
  return rows.find((row) => row !== null && typeof row === "object" && row.id === id);
}
function metadataString(output, id, key) {
  const row = rowForId(output, id);
  const metadata = row?.metadata;
  if (metadata !== null && typeof metadata === "object" && typeof metadata[key] === "string")
    return metadata[key];
  return;
}
function readPhase(output, id) {
  return metadataString(output, id, PHASE_METADATA_KEY);
}
function readIntegrationOwner(output, id) {
  return metadataString(output, id, INTEGRATION_OWNER_METADATA_KEY);
}
function isMergeSlot(output, id) {
  const row = rowForId(output, id);
  const labels = row?.labels;
  return Array.isArray(labels) && labels.includes("pr:merge");
}
function hasUnassignedAssignee(output, id) {
  try {
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && ("data" in parsed) && Array.isArray(parsed.data) ? parsed.data : [parsed];
    const row = rows.find((item) => item !== null && typeof item === "object" && item.id === id);
    return row !== undefined && (row.assignee === undefined || row.assignee === null || row.assignee === "");
  } catch {
    return false;
  }
}
function storeName(cwd, env, invocation) {
  const db = valueAfter(invocation.globals, ["--db", "--database"]);
  if (db !== undefined)
    return db;
  const directory = valueAfter(invocation.globals, ["-C", "--directory"]);
  if (directory !== undefined)
    return directory;
  return env.BEADS_DIR || `${cwd}/.beads`;
}
function valueAfter(args, flags) {
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const flag = flags.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag === undefined)
      continue;
    if (arg.startsWith(`${flag}=`))
      return arg.slice(flag.length + 1);
    return args[i + 1];
  }
  return;
}
async function defaultRun(argv, cwd, env, deadline = Date.now() + TIMEOUT_MS) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return { exitCode: 124, stdout: "", stderr: "bd command timed out" };
  const child = Bun.spawn(argv, { cwd, env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" }, stdout: "pipe", stderr: "pipe", timeout: remaining, killSignal: "SIGKILL" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (Date.now() >= deadline)
    return { exitCode: 124, stdout: "", stderr: "bd command timed out" };
  return { stdout, stderr, exitCode: exitCode ?? 1 };
}
async function runWithDeadline(run, argv, cwd, env, deadline) {
  if (Date.now() >= deadline)
    return { exitCode: 124, stdout: "", stderr: "bd command timed out" };
  const result = await run(argv, cwd, env, deadline);
  return Date.now() >= deadline ? { exitCode: 124, stdout: "", stderr: "bd command timed out" } : result;
}
function advisoryResult(event, text) {
  return { content: [{ type: "text", text: `${text}

` }, ...event.content ?? []] };
}
function bdPoolDiscipline(pi) {
  const pendingReclaims = new Map;
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (event.toolName !== "bash")
        return;
      const command = commandFromInput(event.input);
      if (!command || !PREFILTER.test(command))
        return;
      const deadline = Date.now() + TIMEOUT_MS;
      const invocations = bdInvocations(command);
      const input = event.input;
      const inputCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ctx?.cwd ?? process.cwd();
      const cwd = leadingCdCwd(command, inputCwd);
      const env = environmentForInput(event.input);
      const claims = invocations.filter(isClaimOperation);
      for (const invocation of claims) {
        if (!await isPooledClaim(invocation, cwd, env, deadline)) {
          if (Date.now() >= deadline)
            return { block: true, reason: `${POOLS_FAILURE}: handler deadline expired before the claim's pool could be verified.` };
          continue;
        }
        const decision = await establishPool(invocation, cwd, env, deadline);
        if (!decision.ok)
          return { block: true, reason: decision.reason };
      }
      const reclaims = invocations.filter(isReclaimOperation);
      if (reclaims.length > 0)
        pendingReclaims.set(event.toolCallId, { cwd, env, invocations: reclaims });
    } catch (error) {
      if (PREFILTER.test(commandFromInput(event.input)))
        return { block: true, reason: `${POOLS_FAILURE}: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  pi.on("tool_result", async (event) => {
    const reclaim = pendingReclaims.get(event.toolCallId);
    if (reclaim === undefined)
      return;
    pendingReclaims.delete(event.toolCallId);
    try {
      const output = (event.content ?? []).map((part) => ("text" in part) && typeof part.text === "string" ? part.text : "").join(`
`);
      const ids = [...new Set(reclaim.invocations.flatMap((invocation) => reclaimedIds(output, invocation)))];
      if (ids.length === 0)
        return;
      const deadline = Date.now() + TIMEOUT_MS;
      const run = injectedRun ?? defaultRun;
      const notices = [];
      for (const id of ids) {
        const invocation = reclaim.invocations[0];
        if (invocation === undefined)
          continue;
        if (Date.now() >= deadline) {
          notices.push(`bd pool discipline advisory: reclaim restoration deadline expired before reclaimed bead ${id} could be verified; it remains unassigned.`);
          continue;
        }
        const shown = await runWithDeadline(run, ["bd", ...invocation.globals, "show", id, "--json"], reclaim.cwd, reclaim.env, deadline);
        if (shown.exitCode === 124) {
          notices.push(`bd pool discipline advisory: reclaim restoration deadline expired before reclaimed bead ${id} could be verified; it remains unassigned.`);
          continue;
        }
        if (shown.exitCode !== 0 || !hasUnassignedAssignee(shown.stdout, id))
          continue;
        if (isMergeSlot(shown.stdout, id)) {
          const owner = readIntegrationOwner(shown.stdout, id);
          if (owner === undefined || owner.trim() === "") {
            notices.push(NO_OWNER_ADVISORY(id));
            continue;
          }
          const restored = await withEmbeddedWriteLock(reclaim.cwd, event.toolCallId, () => runWithDeadline(run, ["bd", ...ownerArgs(invocation, id, owner)], reclaim.cwd, reclaim.env, deadline), reclaim.env, deadline);
          if (restored.kind === "failed" || restored.value.exitCode !== 0)
            notices.push(OWNER_RESTORE_FAILURE(id, restored.kind === "failed" ? restored.reason : restored.value.stderr?.trim() ?? `bd exited ${restored.value.exitCode}`));
          continue;
        }
        const phase = readPhase(shown.stdout, id);
        if (phase === undefined || phase.trim() === "") {
          notices.push(NO_PHASE_ADVISORY(id));
          continue;
        }
        const restored = await withEmbeddedWriteLock(reclaim.cwd, event.toolCallId, () => runWithDeadline(run, ["bd", ...phaseArgs(invocation, id, phase)], reclaim.cwd, reclaim.env, deadline), reclaim.env, deadline);
        if (restored.kind === "failed" || restored.value.exitCode !== 0)
          notices.push(RESTAMP_FAILURE(id, restored.kind === "failed" ? restored.reason : restored.value.stderr?.trim() ?? `bd exited ${restored.value.exitCode}`));
      }
      if (notices.length > 0)
        return advisoryResult(event, notices.join(`
`));
    } catch (error) {
      return advisoryResult(event, `bd pool discipline advisory: reclaim restoration was not verified (${error instanceof Error ? error.message : String(error)}).`);
    }
  });
}
export {
  CLAIM_POOLS_KEY,
  DECLARED_POOL_ALIASES,
  DECLARED_POOL_SET,
  INTEGRATION_OWNER_METADATA_KEY,
  PHASE_METADATA_KEY,
  bdPoolDiscipline as default,
  isClaimOperation,
  isReclaimOperation,
  ownerArgs,
  parsePoolConfig,
  phaseArgs,
  poolConfigArgs,
  poolSetArgs,
  readIntegrationOwner,
  readPhase,
  reclaimedIds,
  setBdRunForTests
};
