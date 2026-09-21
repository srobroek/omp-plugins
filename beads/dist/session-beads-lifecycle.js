// @bun
// extensions/session-beads-lifecycle.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, rmSync, statSync as statSync3 } from "fs";
import { isAbsolute as isAbsolute3, join as join2, resolve as resolve3 } from "path";

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
var MUTATING_VERBS = {
  assign: true,
  batch: true,
  claim: true,
  close: true,
  comment: true,
  cook: true,
  create: true,
  "create-form": true,
  defer: true,
  delete: true,
  duplicate: true,
  edit: true,
  forget: true,
  import: true,
  link: true,
  new: true,
  note: true,
  priority: true,
  promote: true,
  q: true,
  remember: true,
  rename: true,
  reopen: true,
  "set-state": true,
  ship: true,
  supersede: true,
  tag: true,
  undefer: true,
  update: true
};
var GROUP_WRITES = {
  audit: { label: true, record: true },
  comments: { add: true },
  dep: { add: true, relate: true, remove: true, unrelate: true },
  epic: { "close-eligible": true },
  gate: { "add-waiter": true, check: true, create: true, resolve: true },
  kv: { append: true, delete: true, rm: true, set: true, update: true },
  label: { add: true, propagate: true, remove: true },
  "merge-slot": { acquire: true, create: true, release: true },
  swarm: { create: true },
  todo: { add: true, done: true }
};
var MOL_WRITES = {
  bond: true,
  burn: true,
  distill: true,
  pour: true,
  squash: true
};
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
function invocationActor(invocation, env) {
  const resolve = (variable) => {
    const assignment = invocation.prefix.findLast((token) => token.startsWith(`${variable}=`));
    const value = assignment !== undefined ? assignment.slice(variable.length + 1) : invocation.exported[variable] ?? env[variable];
    if (!value?.trim() || /[$`]/.test(value))
      return null;
    return value.trim();
  };
  return resolve("BD_ACTOR") ?? resolve("BEADS_ACTOR");
}
function actorValues(command, env = process.env) {
  const actors = bdInvocations(command).filter(isMutatingInvocation).map((invocation) => invocationActor(invocation, env)).filter((actor) => actor !== null);
  return [...new Set(actors)];
}
function invocationFromArgv(args) {
  const scanned = scanGlobals(args, 0);
  const verb = args[scanned.next];
  if (verb === undefined)
    return;
  return { verb: verb.toLowerCase(), args: args.slice(scanned.next + 1), globals: scanned.globals, prefix: [], exported: {} };
}
function isMutatingInvocation({ verb, args }) {
  if (args.includes("--help") || args.includes("-h"))
    return false;
  if (verb === "duplicates")
    return args.includes("--auto-merge") && !args.includes("--dry-run");
  if (MUTATING_VERBS[verb] === true)
    return true;
  if (verb === "ready")
    return args.includes("--claim");
  if (verb === "dep" && args.includes("--blocks"))
    return true;
  if (verb === "mol") {
    if (args.includes("--dry-run"))
      return false;
    const action = args[0] ?? "";
    if (MOL_WRITES[action] === true)
      return true;
    if (action !== "wisp")
      return false;
    const wispAction = args[1];
    return wispAction === "create" || wispAction === "gc" || wispAction !== undefined && wispAction !== "list";
  }
  const action = args[0] ?? "";
  return GROUP_WRITES[verb]?.[action] === true;
}
function isMutatingBdCommand(command) {
  return bdInvocations(command).some(isMutatingInvocation);
}

// extensions/bd-embedded-write-lock.ts
import { closeSync, existsSync, openSync, readFileSync, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { isAbsolute as isAbsolute2, join, resolve as resolve2 } from "path";

// extensions/beads-store.ts
import { spawnSync } from "child_process";
import { lstatSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
function repoIdentity(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.signal !== null)
    return;
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "");
    if (/not a git repository/i.test(stderr) && repositoryState(cwd) === "absent")
      return cwd;
    return;
  }
  const out = String(result.stdout ?? "").trim();
  try {
    return realpathSync(isAbsolute(out) ? out : resolve(cwd, out));
  } catch {
    return;
  }
}
function repositoryState(cwd) {
  let current;
  try {
    current = realpathSync(cwd);
  } catch {
    return "unknown";
  }
  for (;; ) {
    try {
      lstatSync(resolve(current, ".git"));
      return "present";
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
        return "unknown";
    }
    const parent = dirname(current);
    if (parent === current)
      return "absent";
    current = parent;
  }
}
function sessionPinFor(cwd) {
  const local = resolve(cwd, ".beads");
  const common = repoIdentity(cwd);
  if (common === undefined)
    return;
  if (common !== cwd && common.endsWith("/.git")) {
    const primaryRoot = resolve(common, "..");
    try {
      if (realpathSync(cwd) === primaryRoot && isDir(local))
        return local;
    } catch {
      return;
    }
    const primary = resolve(primaryRoot, ".beads");
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
var READS = {
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
  swarm: { list: true, show: true }
};
var WRITE_FLAGS = {
  orphans: ["--fix", "-f"],
  preflight: ["--fix"],
  ready: ["--claim"]
};
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
function writesStore(invocation) {
  if (invocation === undefined)
    return true;
  const { verb, args, globals } = invocation;
  if (flagEnabled(globals, ["--help", "-h"]) || flagEnabled(args, ["--help", "-h"]))
    return false;
  if (flagEnabled(globals, ["--readonly"]))
    return false;
  const rule = READS[verb];
  if (rule === undefined)
    return true;
  const writeFlags = WRITE_FLAGS[verb];
  if (writeFlags !== undefined && flagEnabled(args, writeFlags))
    return true;
  const subaction = args.find((arg) => !arg.startsWith("-"));
  if (rule === true)
    return false;
  if (rule === "idOnly")
    return subaction === undefined || !BEAD_ID.test(subaction);
  return subaction === undefined || rule[subaction] !== true;
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
  return isAbsolute2(path) ? path : resolve2(cwd, path);
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
    return resolve2(path);
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

// extensions/session-beads-lifecycle.ts
function lifecycleBdEnvironment(cwd, base = process.env) {
  const env = { ...base };
  delete env.BEADS_DIR;
  const resolved = sessionPinFor(cwd);
  if (resolved !== undefined)
    env.BEADS_DIR = resolved;
  env.BD_NO_PAGER = "1";
  env.BD_NON_INTERACTIVE = "1";
  env.BD_DOLT_AUTO_START = "false";
  env.NO_COLOR = "1";
  return env;
}
function bdStoreDir(cwd, env) {
  const dir = env.BEADS_DIR ?? join2(cwd, ".beads");
  try {
    return statSync3(dir).isDirectory() ? dir : undefined;
  } catch {
    return;
  }
}
function bdReadFailure(scope, reason) {
  const bounded = boundedFailure(reason);
  return scope === "start" ? `Beads gates could not be verified at session start: ${bounded}.` : `Beads claims could not be read at session close: ${bounded}. A mutating command was attempted; inspect assigned and touched work before stopping.`;
}
var TIMEOUT_MS = 8000;
var SESSION_EXIT_TIMEOUT_MS = 1200;
var MAX_LISTED = 8;
var AUTO_GATE_TYPES = {
  timer: true,
  "gh:run": true,
  "gh:pr": true,
  bead: true
};
function sessionPinAfter(result, cwd, env = process.env) {
  if (result.conflict !== undefined)
    return sessionPinFor(cwd);
  const current = env.BEADS_DIR;
  if (current !== undefined && current !== "")
    return current;
  return sessionPinFor(cwd);
}
function pinBashInput(input, pin) {
  if (pin === undefined || input === null || typeof input !== "object")
    return;
  const record = input;
  const env = record.env;
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env)))
    return;
  const current = env?.BEADS_DIR;
  if (typeof current === "string" && current !== "")
    return;
  return { ...record, env: { ...env ?? {}, BEADS_DIR: pin } };
}
function bashCallCwd(input, fallback) {
  if (input === null || typeof input !== "object")
    return fallback;
  const cwd = input.cwd;
  return typeof cwd === "string" && cwd !== "" ? resolve3(fallback, cwd) : fallback;
}
function sessionKey(ctx) {
  return ctx?.sessionManager?.getSessionId?.() ?? "default";
}
function autoPinBeadsDir(cwd, sessionId, liveSessions, env = process.env, state = autoPinState, identity = repoIdentity) {
  const current = env.BEADS_DIR;
  const ours = current !== undefined && current === state.pinned;
  if (current !== undefined && current !== "" && !ours)
    return {};
  if (ours && state.owner !== undefined && state.owner !== sessionId && liveSessions(state.owner)) {
    if (state.ownerRepo !== identity(cwd))
      return { conflict: current };
    const dependents = state.dependents ?? new Set;
    dependents.add(sessionId);
    state.dependents = dependents;
    return {};
  }
  const dir = sessionPinFor(cwd);
  if (dir === undefined) {
    if (ours)
      releaseAutoPin(env, state);
    return {};
  }
  if (state.owner !== sessionId || state.pinned !== dir)
    state.dependents = new Set;
  env.BEADS_DIR = dir;
  state.pinned = dir;
  state.owner = sessionId;
  state.ownerRepo = identity(cwd);
  return { pinned: dir };
}
function endAutoPinSession(sessionId, liveSessions, env = process.env, state = autoPinState) {
  state.dependents?.delete(sessionId);
  if (state.owner !== sessionId)
    return;
  const heir = [...state.dependents ?? []].find((id) => liveSessions(id));
  if (heir !== undefined) {
    state.owner = heir;
    state.dependents?.delete(heir);
    return;
  }
  releaseAutoPin(env, state);
}
function releaseAutoPin(env = process.env, state = autoPinState) {
  if (state.pinned !== undefined && env.BEADS_DIR === state.pinned)
    delete env.BEADS_DIR;
  state.pinned = undefined;
  state.owner = undefined;
  state.ownerRepo = undefined;
  state.dependents = undefined;
}
var autoPinState = {};
function beadsDir(cwd) {
  const pin = process.env.BEADS_DIR;
  const dir = pin ? isAbsolute3(pin) ? pin : resolve3(cwd, pin) : join2(cwd, ".beads");
  try {
    return statSync3(dir).isDirectory() ? dir : undefined;
  } catch {
    return;
  }
}
function parseTrailingJson(stdout) {
  const text = stdout.trim();
  if (!text)
    return;
  if (text === "null")
    return null;
  const starts = [];
  if (text[0] === "{" || text[0] === "[")
    starts.push(0);
  for (let i = 0;i < text.length - 1; i++) {
    if (text[i] === `
` && (text[i + 1] === "{" || text[i + 1] === "["))
      starts.push(i + 1);
  }
  for (let i = starts.length - 1;i >= 0; i--) {
    try {
      return JSON.parse(text.slice(starts[i]));
    } catch {}
  }
  return;
}
function envelopeData(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const record = value;
  if ("schema_version" in record && "data" in record)
    return record.data;
  return value;
}
function readGates(stdout) {
  const data = envelopeData(parseTrailingJson(stdout));
  if (!Array.isArray(data))
    return [];
  const gates = [];
  for (const row of data) {
    if (row === null || typeof row !== "object")
      continue;
    const record = row;
    if (typeof record.id !== "string")
      continue;
    if (typeof record.status === "string" && record.status !== "open")
      continue;
    const description = typeof record.description === "string" ? record.description : "";
    gates.push({
      id: record.id,
      awaitType: typeof record.await_type === "string" ? record.await_type : "unknown",
      blocks: description.match(/blocking\s+(\S+)/)?.[1],
      reason: description.match(/^Reason:\s*(.+)$/m)?.[1]
    });
  }
  return gates;
}
function readGateList(stdout) {
  const parsed = parseTrailingJson(stdout);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const error = parsed.error;
    if (error !== undefined && error !== null && error !== "")
      return;
  }
  const data = envelopeData(parsed);
  if (data === null)
    return [];
  if (!Array.isArray(data) || data.some((row) => !row || typeof row !== "object" || typeof row.id !== "string" || typeof row.await_type !== "string")) {
    return;
  }
  return readGates(stdout);
}
function gatesCanResolve(gates) {
  return gates.some((gate) => AUTO_GATE_TYPES[gate.awaitType] === true);
}
function readCheckOutcome(stdout) {
  const data = envelopeData(parseTrailingJson(stdout));
  const record = data !== null && typeof data === "object" ? data : {};
  const count = (key) => typeof record[key] === "number" ? record[key] : 0;
  return { resolved: count("resolved"), escalated: count("escalated"), errors: count("errors") };
}
function formatGateAdvisory(gates, outcome) {
  if (gates.length === 0)
    return;
  const lines = [`${gates.length} open beads gate(s) block work in this repository:`];
  for (const gate of gates.slice(0, MAX_LISTED)) {
    const blocks = gate.blocks ? ` blocks ${gate.blocks}` : "";
    const reason = gate.reason ? ` -- ${gate.reason}` : "";
    lines.push(`- ${gate.id} (${gate.awaitType})${blocks}${reason}`);
  }
  if (gates.length > MAX_LISTED)
    lines.push(`- ...and ${gates.length - MAX_LISTED} more`);
  if (outcome) {
    lines.push(`\`bd gate check\` ran at session start: ${outcome.resolved} resolved, ${outcome.escalated} escalated, ${outcome.errors} errors.`);
  }
  lines.push("A human gate resolves only through a recorded human decision (`bd gate resolve <id>`); never force-close a gated issue around one.");
  return lines.join(`
`);
}
function lastPushNotice(contents) {
  const lines = contents.split(`
`).filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (last.startsWith("failed:")) {
    return `The last session's beads push FAILED -- bead state is committed locally but not published: ${last}. Rerun the push once the cause is fixed.`;
  }
  if (last.startsWith("started:")) {
    return "The last session's beads push did not finish (no verdict recorded), so it may need rerunning.";
  }
  return;
}
function staleSkipNotice(output) {
  let stale;
  const data = envelopeData(parseTrailingJson(output));
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const ids = data.stale_skipped_ids;
    if (Array.isArray(ids) && ids.length > 0)
      stale = ids.map(String).join(", ");
  }
  if (stale === undefined) {
    const plain = output.match(/\((\d+) stale skipped/);
    if (plain && Number(plain[1]) > 0)
      stale = `${plain[1]} row(s)`;
  }
  if (stale === undefined)
    return;
  return [
    `\`bd import\` skipped stale rows (${stale}): the JSONL export is BEHIND this database and local state was kept.`,
    "Commit a fresh export (`bd export -o .beads/issues.jsonl`, then stage it) BEFORE pulling peer changes -- otherwise the next export overwrites what a peer committed."
  ].join(" ");
}
function bdVerbs(command) {
  return bdInvocations(command).map((invocation) => invocation.verb);
}
function isBdWrite(command) {
  return isMutatingBdCommand(command);
}
function beadIdCandidates(command) {
  const ids = [];
  for (const token of command.split(/[\s;&|(`'"]+/)) {
    if (token.startsWith("-"))
      continue;
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.\d+)?$/i.test(token))
      ids.push(token);
  }
  return ids;
}
var SAFE_RELEASE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function releaseClaimArgs(id, holder, env = process.env, releasedAt = new Date().toISOString(), casSupported = true) {
  const actor = env.BD_ACTOR?.trim() || env.BEADS_ACTOR?.trim() || "";
  if (!SAFE_RELEASE_IDENTIFIER.test(id) || !SAFE_RELEASE_IDENTIFIER.test(holder) || !SAFE_RELEASE_IDENTIFIER.test(actor))
    return;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(releasedAt))
    return;
  const args = [
    "update",
    id,
    "--assignee",
    "",
    "--status",
    "open",
    "--set-metadata",
    `release_actor=${actor}`,
    "--set-metadata",
    `released_at=${releasedAt}`,
    "--set-metadata",
    `released_from=${holder}`
  ];
  if (casSupported)
    args.push("--if-assignee", holder);
  return args;
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function releaseClaimCommand(id, holder, env = process.env, releasedAt = new Date().toISOString(), casSupported = true) {
  const args = releaseClaimArgs(id, holder, env, releasedAt, casSupported);
  if (args === undefined)
    return;
  const actor = env.BD_ACTOR?.trim() || env.BEADS_ACTOR?.trim() || "";
  return [`BEADS_ACTOR=${shellQuote(actor)}`, `BD_ACTOR=${shellQuote(actor)}`, "bd", ...args].map((value, index) => index < 2 ? value : shellQuote(value)).join(" ");
}
function readBeads(stdout) {
  const data = envelopeData(parseTrailingJson(stdout));
  if (!Array.isArray(data))
    return [];
  const beads = [];
  for (const row of data) {
    if (row === null || typeof row !== "object")
      continue;
    const record = row;
    if (typeof record.id !== "string")
      continue;
    const rawMetadata = record.metadata;
    const metadata = rawMetadata !== null && typeof rawMetadata === "object" ? Object.fromEntries(Object.entries(rawMetadata).filter((entry) => typeof entry[1] === "string")) : undefined;
    beads.push({
      id: record.id,
      title: typeof record.title === "string" ? record.title : "",
      status: typeof record.status === "string" ? record.status : "",
      labels: Array.isArray(record.labels) && record.labels.every((label) => typeof label === "string") ? record.labels : undefined,
      assignee: typeof record.assignee === "string" && record.assignee.trim() ? record.assignee : undefined,
      metadata: Object.keys(metadata ?? {}).length > 0 ? metadata : undefined
    });
  }
  return beads;
}
function claimAnchor(bead) {
  const host = bead.metadata?.lease_host?.trim();
  const pid = Number(bead.metadata?.lease_pid);
  return host && Number.isInteger(pid) && pid > 0 ? { host, pid } : undefined;
}
function heldClaims(beads, seen, actor) {
  const actors = typeof actor === "string" ? new Set(actor.trim() ? [actor.trim()] : []) : actor;
  return beads.filter((bead) => {
    if (bead.assignee === undefined && bead.labels?.includes("state:reported"))
      return false;
    if (!["open", "in_progress", "blocked", "deferred"].includes(bead.status))
      return false;
    if (bead.assignee !== undefined && actors?.has(bead.assignee))
      return true;
    return bead.status === "in_progress" && seen.has(bead.id);
  });
}
function formatSessionCloseAdvisory(beads, env = process.env, releasedAt = new Date().toISOString(), casSupported = true, actors) {
  const effectiveActors = actors ?? new Set([env.BD_ACTOR?.trim() || env.BEADS_ACTOR?.trim() || ""].filter(Boolean));
  const lines = ["Beads claims still held at session close (a mutating command was attempted):"];
  for (const bead of beads.slice(0, MAX_LISTED)) {
    const who = bead.assignee ? ` [${bead.assignee}]` : "";
    lines.push(`- ${bead.id}${who} ${bead.title}`);
    const anchor = claimAnchor(bead);
    if (anchor !== undefined)
      lines.push(`  Lease anchor: host=${anchor.host} pid=${anchor.pid}; check that process on that host before takeover.`);
    const actor = bead.assignee !== undefined && effectiveActors.has(bead.assignee) ? bead.assignee : undefined;
    const release = bead.assignee === undefined || actor === undefined ? undefined : releaseClaimCommand(bead.id, bead.assignee, { ...env, BD_ACTOR: actor }, releasedAt, casSupported);
    if (release === undefined) {
      lines.push("  Release unavailable: the effective actor is missing or ambiguous; verify the current assignee and actor before retrying.");
    } else {
      lines.push(`  Release with: ${release}`);
      if (!casSupported)
        lines.push("  Then verify: bd show <id> --json must show no assignee.");
    }
  }
  if (beads.length > MAX_LISTED)
    lines.push(`- ...and ${beads.length - MAX_LISTED} more`);
  lines.push("Close what is finished with a factual --reason, release only with the guarded command above, and write residual context onto any bead whose work continues elsewhere (bd comments add <id> -m ...). The bead is the handover, not a PR body. File remaining or discovered work as its own bead before stopping.");
  return lines.join(`
`);
}
function boundedFailure(reason) {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}
function handleSessionStop(event, listOutput, seen, actor = process.env.BEADS_ACTOR ?? process.env.BD_ACTOR, casSupported = true, listFailure) {
  if (event.stop_hook_active === true || event.stopHookActive === true)
    return;
  const data = listOutput === undefined ? undefined : envelopeData(parseTrailingJson(listOutput));
  if (!Array.isArray(data) || data.some((row) => !row || typeof row !== "object" || typeof row.id !== "string" || typeof row.status !== "string")) {
    const reason = listFailure === undefined ? "the command returned no readable result" : listFailure;
    return { continue: true, additionalContext: bdReadFailure("close", reason) };
  }
  const held = heldClaims(readBeads(listOutput), seen, actor);
  if (held.length === 0)
    return;
  const actors = typeof actor === "string" ? new Set(actor.trim() ? [actor.trim()] : []) : actor;
  return { continue: true, additionalContext: formatSessionCloseAdvisory(held, {}, new Date().toISOString(), casSupported, actors) };
}
async function releaseCasSupported(cwd, deadline, env) {
  const help = await runBd(cwd, ["update", "--help"], deadline, env);
  return help?.includes("--if-assignee") === true;
}
async function releaseClaimsAtExit(cwd, state) {
  if (state.claimsReleased || !state.bdWrote || state.actors.size === 0)
    return { released: [], incomplete: [] };
  const released = [];
  const incomplete = [];
  state.claimsReleased = true;
  const deadline = Date.now() + SESSION_EXIT_TIMEOUT_MS;
  const env = lifecycleBdEnvironment(cwd);
  const listed = await runBdResult(cwd, ["list", "--status", "open,in_progress,blocked,deferred", "--limit", "0", "--json"], deadline, env);
  if (!("output" in listed))
    return { released, incomplete: [`claim listing: ${listed.failure}`] };
  const claims = heldClaims(readBeads(listed.output), new Set, state.actors);
  const casSupported = await releaseCasSupported(cwd, deadline, env);
  for (const bead of claims) {
    if (bead.assignee === undefined)
      continue;
    const args = releaseClaimArgs(bead.id, bead.assignee, { BD_ACTOR: bead.assignee }, new Date().toISOString(), casSupported);
    if (args === undefined) {
      incomplete.push(`${bead.id}: release command could not be constructed`);
      continue;
    }
    const releasedResult = await runBdResult(cwd, args, deadline, { ...env, BEADS_ACTOR: bead.assignee, BD_ACTOR: bead.assignee });
    if ("output" in releasedResult)
      released.push(bead.id);
    else
      incomplete.push(`${bead.id}: ${releasedResult.failure}`);
  }
  return { released, incomplete };
}
var internalRuns = 0;
var injectedStream = null;
function setBdStreamForTests(fn) {
  injectedStream = fn;
}
async function runBdResult(cwd, args, deadline = Date.now() + TIMEOUT_MS, env = process.env) {
  const stream = injectedStream;
  const execute = async () => {
    if (stream === null)
      return spawnBd(cwd, args, deadline, env);
    const result = await stream(cwd, args, deadline, env);
    if (result === undefined)
      return { failure: "bd command could not be run" };
    return typeof result === "string" ? { output: result } : result;
  };
  let result;
  if (writesStore(invocationFromArgv(args))) {
    const locked = await withEmbeddedWriteLock(cwd, `beads-session-run-${process.pid}-${internalRuns++}`, execute, env, deadline);
    result = locked.kind === "failed" ? { failure: boundedFailure(locked.reason) } : locked.value;
  } else {
    result = await execute();
  }
  return Date.now() >= deadline ? { failure: "bd command timed out" } : result;
}
async function runBd(cwd, args, deadline = Date.now() + TIMEOUT_MS, env = process.env) {
  const result = await runBdResult(cwd, args, deadline, env);
  return "output" in result ? result.output : undefined;
}
async function spawnBd(cwd, args, deadline, env) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return { failure: "bd command timed out" };
  const started = Date.now();
  try {
    const proc = Bun.spawn(["bd", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_JSON_ENVELOPE: "1" },
      timeout: Math.min(TIMEOUT_MS, remaining),
      killSignal: "SIGKILL"
    });
    const [out, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    const code = await proc.exited;
    if (code === 0)
      return { output: out };
    if (Date.now() >= deadline || Date.now() - started >= remaining)
      return { failure: "bd command timed out" };
    const detail = stderr.replace(/\s+/g, " ").trim();
    return { failure: boundedFailure(`bd exited with code ${code}${detail ? `: ${detail}` : ""}`) };
  } catch (error) {
    if (Date.now() >= deadline || Date.now() - started >= remaining)
      return { failure: "bd command timed out" };
    return { failure: boundedFailure(`bd could not run: ${error instanceof Error ? error.message : String(error)}`) };
  }
}
function consumeLastPush(dir) {
  const log = join2(dir, "last-push.log");
  if (!existsSync2(log))
    return;
  let notice;
  try {
    notice = lastPushNotice(readFileSync2(log, "utf8"));
  } catch {
    notice = undefined;
  }
  try {
    rmSync(log, { force: true });
  } catch {}
  return notice;
}
async function gateAdvisory(cwd, deadline, env) {
  const listed = await runBdResult(cwd, ["gate", "list", "--json"], deadline, env);
  if (!("output" in listed))
    return bdReadFailure("start", listed.failure);
  let gates = readGateList(listed.output);
  if (gates === undefined)
    return "Beads gate list returned malformed data; unresolved gates remain unverified.";
  if (gates.length === 0)
    return;
  let outcome;
  if (gatesCanResolve(gates)) {
    const checked = await runBdResult(cwd, ["gate", "check", "--json"], deadline, env);
    if (!("output" in checked))
      return bdReadFailure("start", checked.failure);
    outcome = readCheckOutcome(checked.output);
    if (outcome.resolved > 0) {
      const relisted = await runBdResult(cwd, ["gate", "list", "--json"], deadline, env);
      if (!("output" in relisted))
        return bdReadFailure("start", relisted.failure);
      const relistedGates = readGateList(relisted.output);
      if (relistedGates === undefined)
        return "Beads gate list returned malformed data; unresolved gates remain unverified.";
      gates = relistedGates;
    }
  }
  return formatGateAdvisory(gates, outcome);
}
function resultText(event) {
  let text = "";
  for (const block of event.content ?? []) {
    if (block !== null && typeof block === "object" && block.type === "text") {
      text += block.text ?? "";
    }
  }
  return text;
}
var sessionPinGetter;
function pinnedBeadsDir(cwd, ctx) {
  const pin = ctx === undefined ? undefined : sessionPinGetter?.(cwd, ctx);
  return pin ?? (ctx === undefined ? sessionPinFor(cwd) : undefined);
}
function rewriteBashInput(input, ctx) {
  const cwd = bashCallCwd(input, ctx?.cwd ?? process.cwd());
  const pin = pinnedBeadsDir(cwd, ctx);
  return pinBashInput(input, pin === "" ? undefined : pin);
}
function sessionBeadsLifecycle(pi) {
  const sessions = new Map;
  function stateFor(ctx) {
    const key = sessionKey(ctx);
    let state = sessions.get(key);
    if (!state) {
      state = { actors: new Set, bdWrote: false, repos: new Map, staleAdvised: false, stopFired: false, touched: new Set, claimsReleased: false };
      sessions.set(key, state);
    }
    return state;
  }
  function identityFor(state, cwd) {
    const key = resolve3(cwd);
    const cached = state.repos.get(key);
    if (cached !== undefined)
      return cached;
    const identity = repoIdentity(key);
    state.repos.set(key, identity);
    return identity;
  }
  sessionPinGetter = (cwd, ctx) => {
    const state = sessions.get(sessionKey(ctx));
    if (state?.repo !== undefined && identityFor(state, cwd) !== state.repo)
      return;
    return state?.pin ?? process.env.BEADS_DIR ?? sessionPinFor(cwd);
  };
  pi.on("session_start", async (_event, ctx) => {
    const key = sessionKey(ctx);
    sessions.delete(key);
    const state = stateFor(ctx);
    try {
      const cwd = ctx?.cwd ?? process.cwd();
      const pin = autoPinBeadsDir(cwd, key, (id) => sessions.has(id));
      state.repo = identityFor(state, cwd);
      state.pin = sessionPinAfter(pin, cwd);
      if (pin.conflict !== undefined) {
        pi.sendMessage({
          customType: "com.srobroek.beads.session-lifecycle",
          content: `This process is pinned to another repository's beads database (\`BEADS_DIR=${pin.conflict}\`) by a live session. ` + "Bash calls in this checkout use its own `.beads`; calls in other repositories remain unpinned unless they provide `BEADS_DIR`.",
          display: true,
          attribution: "user"
        }, { triggerTurn: false });
        return;
      }
      const bdEnv = lifecycleBdEnvironment(cwd);
      const dir = bdStoreDir(cwd, bdEnv);
      if (dir === undefined)
        return;
      const deadline = Date.now() + TIMEOUT_MS;
      const notices = [consumeLastPush(dir), await gateAdvisory(cwd, deadline, bdEnv)].filter((notice) => notice !== undefined);
      if (sessions.get(key) !== state || notices.length === 0)
        return;
      pi.sendMessage({
        customType: "com.srobroek.beads.session-lifecycle",
        content: notices.join(`

`),
        display: true,
        attribution: "user"
      }, { triggerTurn: false });
    } catch (error) {
      pi.logger.error("beads session-start check failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const key = sessionKey(ctx);
    const state = sessions.get(key);
    sessions.delete(key);
    endAutoPinSession(key, (id) => sessions.has(id));
    if (state === undefined)
      return;
    try {
      const outcome = await releaseClaimsAtExit(ctx?.cwd ?? process.cwd(), state);
      if (outcome.incomplete.length === 0)
        return;
      const summary = [
        "Beads claim release at session shutdown reached its 1,200 ms budget.",
        outcome.released.length > 0 ? `Released: ${outcome.released.join(", ")}.` : "Released: none.",
        `Remaining: ${outcome.incomplete.join("; ")}`
      ].join(" ");
      pi.logger.error("beads claim release incomplete at session exit", outcome);
      pi.sendMessage({ customType: "com.srobroek.beads.session-lifecycle", content: summary, display: true, attribution: "user" }, { triggerTurn: false });
    } catch (error) {
      pi.logger.error("beads claim release at session exit failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });
  pi.on("turn_start", (_event, ctx) => {
    stateFor(ctx).stopFired = false;
  });
  pi.on("tool_result", (event, ctx) => {
    try {
      if (event.toolName !== "bash")
        return;
      const input = event.input ?? {};
      const command = commandFromInput(input);
      if (!command || !/\bbd\s+/.test(command))
        return;
      const state = stateFor(ctx);
      if (isBdWrite(command)) {
        state.bdWrote = true;
        for (const actor of actorValues(command, environmentForInput(input)))
          state.actors.add(actor);
        for (const id of beadIdCandidates(command))
          state.touched.add(id);
      }
      if (state.staleAdvised)
        return;
      const notice = staleSkipNotice(resultText(event));
      if (notice === undefined)
        return;
      state.staleAdvised = true;
      return { content: [{ type: "text", text: `${notice}

` }, ...event.content ?? []] };
    } catch {
      return;
    }
  });
  pi.on("session_stop", async (event, ctx) => {
    try {
      const key = sessionKey(ctx);
      const state = sessions.get(key);
      const cwd = ctx?.cwd ?? process.cwd();
      const bdEnv = lifecycleBdEnvironment(cwd);
      if (!state?.bdWrote || state.stopFired || event.stop_hook_active === true || event.stopHookActive === true || bdStoreDir(cwd, bdEnv) === undefined)
        return;
      const deadline = Date.now() + SESSION_EXIT_TIMEOUT_MS;
      const casSupported = await releaseCasSupported(cwd, deadline, bdEnv);
      const listed = await runBdResult(cwd, ["list", "--status", "open,in_progress,blocked,deferred", "--limit", "0", "--json"], deadline, bdEnv);
      if (sessions.get(key) !== state || state.stopFired)
        return;
      const advisory = "output" in listed ? handleSessionStop(event, listed.output, state.touched, state.actors, casSupported) : handleSessionStop(event, undefined, state.touched, state.actors, casSupported, listed.failure);
      if (advisory)
        state.stopFired = true;
      return advisory;
    } catch (error) {
      pi.logger.error("beads session-close check failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  });
}
export {
  AUTO_GATE_TYPES,
  autoPinBeadsDir,
  bdVerbs,
  beadIdCandidates,
  beadsDir,
  claimAnchor,
  sessionBeadsLifecycle as default,
  endAutoPinSession,
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
  pinnedBeadsDir,
  readBeads,
  readCheckOutcome,
  readGateList,
  readGates,
  releaseAutoPin,
  releaseClaimArgs,
  releaseClaimCommand,
  repoIdentity,
  rewriteBashInput,
  runBd,
  runBdResult,
  sessionPinAfter,
  sessionPinFor,
  setBdStreamForTests,
  staleSkipNotice
};
