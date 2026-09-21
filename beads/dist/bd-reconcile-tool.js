// @bun
// extensions/bd-reconcile-tool.ts
import { createHash } from "crypto";
import { existsSync as existsSync2, mkdtempSync, readdirSync, readFileSync as readFileSync2, realpathSync as realpathSync3, rmSync } from "fs";
import { homedir, hostname as hostname2, tmpdir } from "os";
import { basename, dirname as dirname2, isAbsolute as isAbsolute3, join as join2, resolve as resolve3, sep } from "path";

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
function invocationFromArgv(args) {
  const scanned = scanGlobals(args, 0);
  const verb = args[scanned.next];
  if (verb === undefined)
    return;
  return { verb: verb.toLowerCase(), args: args.slice(scanned.next + 1), globals: scanned.globals, prefix: [], exported: {} };
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
function claimAnchor(bead) {
  const host = bead.metadata?.lease_host?.trim();
  const pid = Number(bead.metadata?.lease_pid);
  return host && Number.isInteger(pid) && pid > 0 ? { host, pid } : undefined;
}

// extensions/bd-reconcile-tool.ts
var RECEIPT_SCHEMA = "omp.receipt.landing";
var RECEIPT_VERSION = 1;
var TOOL_TIMEOUT_MS = 25000;
var COMMAND_TIMEOUT_MS = 5000;
var REPO_KEY = /^[0-9a-f]{16}$/;
var RECEIPT_ID = /^(\d+)-(?:[0-9a-f]{12}|nomerge)$/;
var ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
var GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var BEAD_ID2 = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.[A-Za-z0-9]+)*$/;
var RECONCILE_ARBITER = Symbol.for("com.srobroek.beads.bd-reconcile-tool.v1");
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function string(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function nullableString(value) {
  return value === null ? null : string(value);
}
function isoInstantMillis(value) {
  const match = ISO_INSTANT.exec(value);
  if (match === null)
    return;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0) || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}
function field(record, key) {
  return record?.[key];
}
function observed(value) {
  if (value === undefined || value === null || value === "")
    return "absent";
  return JSON.stringify(value);
}
function requirement(path, value, expected) {
  return `${path}: observed ${observed(value)}, expected ${expected}`;
}
function parseReceipt(value) {
  const root = object(value);
  if (root === undefined)
    return { reason: "receipt: observed a non-object, expected one JSON object" };
  if (root.schema !== RECEIPT_SCHEMA) {
    return {
      reason: requirement("schema", root.schema, JSON.stringify(RECEIPT_SCHEMA))
    };
  }
  if (typeof root.version === "number" && root.version > RECEIPT_VERSION) {
    return {
      reason: `version: observed ${root.version}, expected at most ${RECEIPT_VERSION}; forward receipt versions are refused`
    };
  }
  if (root.version !== RECEIPT_VERSION) {
    return { reason: requirement("version", root.version, String(RECEIPT_VERSION)) };
  }
  const emitter = object(root.emitter);
  const repo = object(root.repo);
  const pr = object(root.pr);
  const branch = object(root.branch);
  const worktree = object(root.worktree);
  const beads = object(root.beads);
  const proof = object(root.proof);
  const failures = [];
  const needString = (path, value) => {
    const parsed = string(value);
    if (parsed === undefined)
      failures.push(requirement(path, value, "a non-empty string"));
    return parsed ?? "";
  };
  const needNullable = (path, value) => {
    const parsed = nullableString(value);
    if (parsed === undefined)
      failures.push(requirement(path, value, "null or a non-empty string"));
    return parsed ?? null;
  };
  const needBoolean = (path, value) => {
    if (typeof value !== "boolean")
      failures.push(requirement(path, value, "a boolean"));
    return value === true;
  };
  const receiptId = needString("receiptId", root.receiptId);
  if (!RECEIPT_ID.test(receiptId))
    failures.push(requirement("receiptId", root.receiptId, "<epochMillis>-<12 lowercase merge hex> or <epochMillis>-nomerge"));
  const emittedAt = needString("emittedAt", root.emittedAt);
  const emittedAtMillis = isoInstantMillis(emittedAt);
  if (emittedAtMillis === undefined)
    failures.push(requirement("emittedAt", root.emittedAt, "a calendar-valid ISO 8601 instant"));
  const emitterPlugin = needString("emitter.plugin", field(emitter, "plugin"));
  const emitterVersion = needString("emitter.version", field(emitter, "version"));
  const emitterTool = needString("emitter.tool", field(emitter, "tool"));
  const repoKey = needString("repo.key", field(repo, "key"));
  if (!REPO_KEY.test(repoKey))
    failures.push(requirement("repo.key", field(repo, "key"), "16 lowercase hexadecimal characters"));
  const canonicalRoot = needString("repo.canonicalRoot", field(repo, "canonicalRoot"));
  const remote = needString("repo.remote", field(repo, "remote"));
  const forge = field(repo, "forge");
  if (forge !== "github" && forge !== "gitlab" && forge !== "unknown") {
    failures.push(requirement("repo.forge", forge, '"github", "gitlab", or "unknown"'));
  }
  const nameWithOwner = needString("repo.nameWithOwner", field(repo, "nameWithOwner"));
  const prNumber = field(pr, "number");
  if (!Number.isInteger(prNumber) || Number(prNumber) <= 0) {
    failures.push(requirement("pr.number", prNumber, "a positive integer"));
  }
  const prUrl = needString("pr.url", field(pr, "url"));
  const prState = needString("pr.state", field(pr, "state"));
  const baseRefName = needString("pr.baseRefName", field(pr, "baseRefName"));
  const headRefName = needString("pr.headRefName", field(pr, "headRefName"));
  const headRefOid = needString("pr.headRefOid", field(pr, "headRefOid"));
  if (!GIT_OID.test(headRefOid))
    failures.push(requirement("pr.headRefOid", field(pr, "headRefOid"), "a 40- or 64-character lowercase hexadecimal Git object id"));
  const mergeCommitOid = needNullable("pr.mergeCommitOid", field(pr, "mergeCommitOid"));
  const validMergeCommitOid = mergeCommitOid === null || GIT_OID.test(mergeCommitOid);
  if (!validMergeCommitOid)
    failures.push(requirement("pr.mergeCommitOid", field(pr, "mergeCommitOid"), "null or a 40- or 64-character lowercase hexadecimal Git object id"));
  const mergedAt = needNullable("pr.mergedAt", field(pr, "mergedAt"));
  if (emittedAtMillis !== undefined && validMergeCommitOid) {
    const expectedReceiptId = `${emittedAtMillis}-${mergeCommitOid === null ? "nomerge" : mergeCommitOid.slice(0, 12)}`;
    if (receiptId !== expectedReceiptId)
      failures.push(requirement("receiptId", receiptId, JSON.stringify(expectedReceiptId)));
  }
  const branchName = needString("branch.name", field(branch, "name"));
  const deletedRemote = needBoolean("branch.deletedRemote", field(branch, "deletedRemote"));
  const remoteAbsence = needNullable("branch.remoteAbsenceVerifiedAt", field(branch, "remoteAbsenceVerifiedAt"));
  const autoDelete = field(branch, "autoDeleteSetting");
  if (autoDelete !== "on" && autoDelete !== "off" && autoDelete !== "unknown") {
    failures.push(requirement("branch.autoDeleteSetting", autoDelete, '"on", "off", or "unknown"'));
  }
  const worktreePath = needNullable("worktree.path", field(worktree, "path"));
  const removed = needBoolean("worktree.removed", field(worktree, "removed"));
  const localRefDeleted = needBoolean("worktree.localRefDeleted", field(worktree, "localRefDeleted"));
  const absence = needNullable("worktree.absenceVerifiedAt", field(worktree, "absenceVerifiedAt"));
  const idsValue = field(beads, "ids");
  const ids = Array.isArray(idsValue) && idsValue.every((id) => typeof id === "string" && BEAD_ID2.test(id)) ? [...new Set(idsValue)] : [];
  if (ids.length === 0)
    failures.push(requirement("beads.ids", idsValue, "a non-empty array of bead ids"));
  const ledgerActive = needBoolean("beads.ledgerActive", field(beads, "ledgerActive"));
  const method = needString("proof.method", field(proof, "method"));
  const proofObservedAt = needString("proof.observedAt", field(proof, "observedAt"));
  const evidence = object(field(proof, "evidence"));
  if (evidence === undefined || Object.keys(evidence).length === 0) {
    failures.push(requirement("proof.evidence", field(proof, "evidence"), "a non-empty object naming independently observed forge evidence"));
  }
  const forgeMethod = forge === "github" ? /(?:^|\b)(?:gh|github|forge)(?:\b|$)/i : forge === "gitlab" ? /(?:^|\b)(?:glab|gitlab|forge)(?:\b|$)/i : /./;
  if (!forgeMethod.test(method) || /(?:^|\b)(?:assert(?:ed|ion)?|receipt|session|summary|local)(?:\b|$)/i.test(method)) {
    failures.push(requirement("proof.method", method, `an independently observed ${String(forge)} forge query method`));
  }
  const outcome = root.outcome;
  if (outcome !== "landed" && outcome !== "cleaned" && outcome !== "partial") {
    failures.push(requirement("outcome", outcome, '"landed", "cleaned", or "partial"'));
  }
  const notes = root.notes === undefined ? undefined : needString("notes", root.notes);
  const supersedes = needNullable("supersedes", root.supersedes);
  if (failures.length > 0)
    return { reason: failures.join("; ") };
  return {
    receipt: {
      ...root,
      schema: RECEIPT_SCHEMA,
      version: RECEIPT_VERSION,
      receiptId,
      emittedAt,
      emitter: { ...emitter, plugin: emitterPlugin, version: emitterVersion, tool: emitterTool },
      repo: {
        ...repo,
        key: repoKey,
        canonicalRoot,
        remote,
        forge,
        nameWithOwner
      },
      pr: {
        ...pr,
        number: Number(prNumber),
        url: prUrl,
        state: prState,
        baseRefName,
        headRefName,
        headRefOid,
        mergeCommitOid,
        mergedAt
      },
      branch: {
        ...branch,
        name: branchName,
        deletedRemote,
        remoteAbsenceVerifiedAt: remoteAbsence,
        autoDeleteSetting: autoDelete
      },
      worktree: {
        ...worktree,
        path: worktreePath,
        removed,
        localRefDeleted,
        absenceVerifiedAt: absence
      },
      beads: { ...beads, ids, ledgerActive },
      proof: { ...proof, method, observedAt: proofObservedAt, evidence: evidence ?? {} },
      outcome,
      supersedes,
      ...notes === undefined ? {} : { notes }
    }
  };
}
async function defaultRepoKey(cwd, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return;
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
      killSignal: "SIGKILL"
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text()
    ]);
    if (exitCode !== 0)
      return;
    const raw = stdout.trim();
    if (!raw)
      return;
    const common = realpathSync3(isAbsolute3(raw) ? raw : resolve3(cwd, raw));
    return createHash("sha256").update(common).digest("hex").slice(0, 16);
  } catch {
    return;
  }
}
function receiptRoot(env, deps) {
  return deps.receiptRoot ?? join2(env.PI_CODING_AGENT_DIR || join2(homedir(), ".omp"), "receipts");
}
function safeReceiptPath(root, repoKey, input) {
  const repository = resolve3(root, repoKey);
  let candidate;
  if (isAbsolute3(input))
    candidate = resolve3(input);
  else {
    const name = input.endsWith(".json") ? input : `${input}.json`;
    candidate = resolve3(repository, name);
  }
  if (dirname2(candidate) !== repository || !basename(candidate).endsWith(".json"))
    return;
  return candidate;
}
async function readReceiptSources(params, cwd, env, deadline, deps) {
  if (params.bead !== undefined && !BEAD_ID2.test(params.bead)) {
    return { sources: [], refusal: requirement("bead", params.bead, "a bead id") };
  }
  const currentKey = await (deps.repoKey ?? defaultRepoKey)(cwd, deadline);
  if (currentKey === undefined) {
    return { sources: [], refusal: "repoKey: observed absent, expected a key derived from the current git common directory" };
  }
  if (params.repoKey !== undefined && (!REPO_KEY.test(params.repoKey) || params.repoKey !== currentKey)) {
    return { sources: [], repoKey: currentKey, refusal: requirement("repoKey", params.repoKey, JSON.stringify(currentKey)) };
  }
  if (params.receipt?.trim().startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(params.receipt);
    } catch (error) {
      return { sources: [], refusal: `receipt result is unreadable JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    const result = parseReceipt(parsed);
    const key = currentKey;
    return {
      repoKey: key,
      sources: [{ path: `<tool-result:${result.receipt?.receiptId ?? "unknown"}>`, ...result }]
    };
  }
  const key = currentKey;
  const root = receiptRoot(env, deps);
  const repository = resolve3(root, key);
  let paths = [];
  if (params.receipt !== undefined) {
    const candidate = safeReceiptPath(root, key, params.receipt);
    if (candidate === undefined) {
      return { sources: [], repoKey: key, refusal: `receipt: observed ${JSON.stringify(params.receipt)}, expected a v1 JSON file directly under ${repository}${sep}` };
    }
    paths = [candidate];
  } else {
    try {
      paths = readdirSync(repository).filter((name) => name.endsWith(".json")).sort().map((name) => join2(repository, name));
    } catch (error) {
      return { sources: [], repoKey: key, refusal: `receipt directory ${repository} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (paths.length === 0) {
    return { sources: [], repoKey: key, refusal: `receipt directory ${repository} contains no receipt v1 JSON files` };
  }
  const sources = [];
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync2(path, "utf8"));
      sources.push({ path, ...parseReceipt(parsed) });
    } catch (error) {
      sources.push({ path, reason: `receipt file is unreadable JSON: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { sources, repoKey: key };
}
async function spawnExecutable(executable, argv, cwd, env, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: `${executable} command timed out` };
  }
  try {
    const proc = Bun.spawn([executable, ...argv], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
      killSignal: "SIGKILL"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return {
      ok: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      ...exitCode === null ? { error: `${executable} command timed out` } : {}
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function defaultSpawn(argv, cwd, env, deadline) {
  return spawnExecutable("bd", argv, cwd, env, deadline);
}
function commandObject(result, label) {
  if (!result.ok) {
    const detail = result.error ?? [result.stderr, result.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { failure: `${label} failed: ${detail || `exit ${result.exitCode}`}` };
  }
  const value = object(parseTrailingJson(result.stdout));
  return value === undefined ? { failure: `${label} returned malformed JSON` } : { value };
}
function githubObservation(repo, pr) {
  const nameWithOwner = string(repo.nameWithOwner);
  const number = pr.number;
  const merge = pr.mergeCommit;
  const mergeCommitOid = merge === null ? null : string(object(merge)?.oid);
  const mergedAt = nullableString(pr.mergedAt);
  const values = {
    url: string(pr.url),
    state: string(pr.state),
    baseRefName: string(pr.baseRefName),
    headRefName: string(pr.headRefName),
    headRefOid: string(pr.headRefOid)
  };
  if (nameWithOwner === undefined || !Number.isInteger(number) || Number(number) <= 0 || Object.values(values).some((value) => value === undefined) || mergeCommitOid === undefined || mergedAt === undefined) {
    return { failure: "gh returned incomplete repository or pull-request identity" };
  }
  return {
    observation: {
      repo: { nameWithOwner },
      pr: {
        number: Number(number),
        url: values.url,
        state: values.state,
        baseRefName: values.baseRefName,
        headRefName: values.headRefName,
        headRefOid: values.headRefOid,
        mergeCommitOid,
        mergedAt
      }
    }
  };
}
function gitlabObservation(repo, pr) {
  const nameWithOwner = string(repo.path_with_namespace) ?? string(repo.pathWithNamespace) ?? string(repo.fullPath) ?? string(repo.nameWithOwner);
  const number = pr.iid ?? pr.number;
  const mergeCommitOid = nullableString(pr.merge_commit_sha ?? pr.mergeCommitSha);
  const mergedAt = nullableString(pr.merged_at ?? pr.mergedAt);
  const values = {
    url: string(pr.web_url) ?? string(pr.webUrl) ?? string(pr.url),
    state: string(pr.state),
    baseRefName: string(pr.target_branch) ?? string(pr.targetBranch),
    headRefName: string(pr.source_branch) ?? string(pr.sourceBranch),
    headRefOid: string(pr.sha) ?? string(pr.headRefOid)
  };
  if (nameWithOwner === undefined || !Number.isInteger(number) || Number(number) <= 0 || Object.values(values).some((value) => value === undefined) || mergeCommitOid === undefined || mergedAt === undefined) {
    return { failure: "glab returned incomplete repository or merge-request identity" };
  }
  return {
    observation: {
      repo: { nameWithOwner },
      pr: {
        number: Number(number),
        url: values.url,
        state: values.state,
        baseRefName: values.baseRefName,
        headRefName: values.headRefName,
        headRefOid: values.headRefOid,
        mergeCommitOid,
        mergedAt
      }
    }
  };
}
async function defaultObserveProof(receipt, cwd, env, deadline) {
  if (receipt.repo.forge === "github") {
    const repoResult = commandObject(await spawnExecutable("gh", ["repo", "view", "--json", "nameWithOwner"], cwd, env, deadline), "gh repo view");
    if (repoResult.value === undefined)
      return { failure: repoResult.failure };
    const nameWithOwner = string(repoResult.value.nameWithOwner);
    if (nameWithOwner === undefined)
      return { failure: "gh repo view returned no nameWithOwner" };
    const prResult = commandObject(await spawnExecutable("gh", ["pr", "view", String(receipt.pr.number), "--repo", nameWithOwner, "--json", "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt"], cwd, env, deadline), "gh pr view");
    return prResult.value === undefined ? { failure: prResult.failure } : githubObservation(repoResult.value, prResult.value);
  }
  if (receipt.repo.forge === "gitlab") {
    const repoResult = commandObject(await spawnExecutable("glab", ["repo", "view", "--output", "json"], cwd, env, deadline), "glab repo view");
    if (repoResult.value === undefined)
      return { failure: repoResult.failure };
    const nameWithOwner = string(repoResult.value.path_with_namespace) ?? string(repoResult.value.pathWithNamespace) ?? string(repoResult.value.fullPath) ?? string(repoResult.value.nameWithOwner);
    if (nameWithOwner === undefined)
      return { failure: "glab repo view returned no repository path" };
    const prResult = commandObject(await spawnExecutable("glab", ["api", `projects/${encodeURIComponent(nameWithOwner)}/merge_requests/${receipt.pr.number}`], cwd, env, deadline), "glab api merge request");
    return prResult.value === undefined ? { failure: prResult.failure } : gitlabObservation(repoResult.value, prResult.value);
  }
  return { failure: `repo.forge ${JSON.stringify(receipt.repo.forge)} has no authoritative observer` };
}
function observationFailures(receipt, observation) {
  const failures = [];
  const expected = {
    "repo.nameWithOwner": receipt.repo.nameWithOwner,
    "pr.number": receipt.pr.number,
    "pr.url": receipt.pr.url,
    "pr.state": receipt.pr.state.toUpperCase(),
    "pr.baseRefName": receipt.pr.baseRefName,
    "pr.headRefName": receipt.pr.headRefName,
    "pr.headRefOid": receipt.pr.headRefOid,
    "pr.mergeCommitOid": receipt.pr.mergeCommitOid,
    "pr.mergedAt": receipt.pr.mergedAt
  };
  const actual = {
    "repo.nameWithOwner": observation.repo.nameWithOwner,
    "pr.number": observation.pr.number,
    "pr.url": observation.pr.url,
    "pr.state": observation.pr.state.toUpperCase(),
    "pr.baseRefName": observation.pr.baseRefName,
    "pr.headRefName": observation.pr.headRefName,
    "pr.headRefOid": observation.pr.headRefOid,
    "pr.mergeCommitOid": observation.pr.mergeCommitOid,
    "pr.mergedAt": observation.pr.mergedAt
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key])
      failures.push(requirement(`authoritative ${key}`, actual[key], JSON.stringify(expected[key])));
  }
  return failures;
}
function resolvedRemoteIdentity(value) {
  let host;
  let path;
  let transport;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.search !== "" || parsed.hash !== "")
        return;
      const protocol = parsed.protocol.slice(0, -1).toLowerCase();
      if (protocol !== "git" && protocol !== "http" && protocol !== "https" && protocol !== "ssh")
        return;
      transport = protocol;
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname;
    } catch {
      return;
    }
  } else {
    const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(value);
    if (scp === null)
      return;
    host = (scp[1] ?? "").toLowerCase();
    path = scp[2] ?? "";
    transport = "ssh";
  }
  const forge = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined;
  if (forge === undefined)
    return;
  const rawSegments = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (rawSegments.length < 2 || forge === "github" && rawSegments.length !== 2)
    return;
  const segments = [];
  for (const segment of rawSegments) {
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\"))
        return;
      segments.push(decoded);
    } catch {
      return;
    }
  }
  return { forge, nameWithOwner: segments.join("/"), transport };
}
function trustedRemoteGit(platform) {
  if (platform === "win32")
    return;
  try {
    const executable = realpathSync3("/usr/bin/git");
    return isAbsolute3(executable) ? executable : undefined;
  } catch {
    return;
  }
}
function isolatedRemoteEnvironment(base, cwd, transport, platform) {
  const isolated = {};
  for (const key of ["HOME", "LANG", "LC_ALL", "LOGNAME", "SSH_AUTH_SOCK", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USER"]) {
    const value = base[key];
    if (value !== undefined)
      isolated[key] = value;
  }
  isolated.GIT_CONFIG_NOSYSTEM = "1";
  isolated.GIT_CONFIG_GLOBAL = platform === "win32" ? "NUL" : "/dev/null";
  isolated.GIT_CEILING_DIRECTORIES = cwd;
  isolated.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";
  isolated.GIT_TERMINAL_PROMPT = "0";
  isolated.PATH = platform === "win32" ? "" : "/usr/bin:/bin";
  if (transport === "ssh" && platform !== "win32") {
    isolated.GIT_SSH_COMMAND = "/usr/bin/ssh -F /dev/null -o BatchMode=yes -o ClearAllForwardings=yes -o ProxyCommand=none -o ProxyJump=none -o PermitLocalCommand=no -o CanonicalizeHostname=no";
    isolated.GIT_SSH_VARIANT = "ssh";
  }
  return isolated;
}
async function defaultObserveCleanup(receipt, authoritativeNameWithOwner, cwd, env, deadline, command = spawnExecutable, platform = process.platform) {
  const trustedGit = trustedRemoteGit(platform);
  if (trustedGit === undefined) {
    return { failure: `trusted absolute Git executable unavailable for ${platform}; refusing cleanup proof` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(receipt.repo.remote)) {
    return { failure: requirement("repo.remote", receipt.repo.remote, "a safe configured git remote name") };
  }
  const configured = await command(trustedGit, ["remote", "get-url", receipt.repo.remote], cwd, env, deadline);
  if (!configured.ok) {
    const detail = configured.error ?? [configured.stderr, configured.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { failure: `git remote get-url could not resolve configured remote ${JSON.stringify(receipt.repo.remote)}: ${detail || `exit ${configured.exitCode}`}` };
  }
  const configuredUrls = configured.stdout.split(`
`).map((line) => line.trim()).filter(Boolean);
  if (configuredUrls.length !== 1) {
    return { failure: `git remote get-url returned ${configuredUrls.length} URLs for ${JSON.stringify(receipt.repo.remote)}, expected exactly one` };
  }
  const remoteUrl = configuredUrls[0];
  const remoteIdentity = resolvedRemoteIdentity(remoteUrl);
  if (remoteIdentity === undefined) {
    return { failure: requirement("configured remote URL", remoteUrl, "a parseable github.com or gitlab.com repository URL") };
  }
  if (remoteIdentity.forge !== receipt.repo.forge) {
    return { failure: requirement("configured remote forge", remoteIdentity.forge, JSON.stringify(receipt.repo.forge)) };
  }
  if (remoteIdentity.nameWithOwner !== authoritativeNameWithOwner) {
    return { failure: requirement("configured remote nameWithOwner", remoteIdentity.nameWithOwner, JSON.stringify(authoritativeNameWithOwner)) };
  }
  const branchRef = `refs/heads/${receipt.branch.name}`;
  let remoteCwd;
  try {
    remoteCwd = mkdtempSync(join2(tmpdir(), "bd-reconcile-remote-"));
  } catch (error) {
    return { failure: `could not create isolated remote probe directory: ${error instanceof Error ? error.message : String(error)}` };
  }
  const remoteEnv = isolatedRemoteEnvironment(env, remoteCwd, remoteIdentity.transport, platform);
  let results;
  try {
    results = await Promise.all([
      command(trustedGit, [
        "-c",
        "protocol.allow=never",
        "-c",
        `protocol.${remoteIdentity.transport}.allow=always`,
        "ls-remote",
        "--exit-code",
        "--heads",
        "--",
        remoteUrl,
        branchRef
      ], remoteCwd, remoteEnv, deadline),
      command(trustedGit, ["show-ref", "--verify", "--quiet", branchRef], cwd, env, deadline),
      command(trustedGit, ["worktree", "list", "--porcelain"], cwd, env, deadline)
    ]);
  } finally {
    try {
      rmSync(remoteCwd, { recursive: true, force: true });
    } catch {}
  }
  if (results === undefined)
    return { failure: "isolated remote probe returned no command results" };
  const [remote, local, worktrees] = results;
  const remoteAbsent = remote.exitCode === 2 && remote.stdout.trim() === "";
  if (!remoteAbsent && remote.exitCode !== 0) {
    const detail = remote.error ?? [remote.stderr, remote.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { failure: `git ls-remote could not prove branch presence or absence: ${detail || `exit ${remote.exitCode}`}` };
  }
  const localAbsent = local.exitCode === 1 && local.stdout.trim() === "";
  if (!localAbsent && local.exitCode !== 0) {
    const detail = local.error ?? [local.stderr, local.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { failure: `git show-ref could not prove local ref presence or absence: ${detail || `exit ${local.exitCode}`}` };
  }
  if (!worktrees.ok) {
    const detail = worktrees.error ?? [worktrees.stderr, worktrees.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { failure: `git worktree list failed: ${detail || `exit ${worktrees.exitCode}`}` };
  }
  const records = worktrees.stdout.trim().split(/\n\s*\n/).filter(Boolean);
  if (records.length === 0 || records.some((record) => !record.startsWith("worktree "))) {
    return { failure: "git worktree list returned malformed porcelain output" };
  }
  const receiptPath = receipt.worktree.path === null ? undefined : resolve3(receipt.worktree.path);
  const worktreeAbsent = records.every((record) => {
    const lines = record.split(`
`);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    return branch !== branchRef && (receiptPath === undefined || path === undefined || resolve3(path) !== receiptPath);
  });
  return {
    observation: {
      remoteBranchAbsent: remoteAbsent,
      localRefAbsent: localAbsent,
      worktreeAbsent
    }
  };
}
function cleanupObservationFailures(observation, failure) {
  if (observation === undefined)
    return [`current cleanup observation: ${failure ?? "observer returned no state"}`];
  const failures = [];
  if (!observation.remoteBranchAbsent)
    failures.push(requirement("current remote branch", "present", "absent"));
  if (!observation.localRefAbsent)
    failures.push(requirement("current local ref", "present", "absent"));
  if (!observation.worktreeAbsent)
    failures.push(requirement("current worktree", "present", "absent"));
  return failures;
}
var internalRuns = 0;
async function runBd(argv, cwd, env, deadline, toolCallId, deps = {}) {
  const execute = () => (deps.spawn ?? defaultSpawn)(argv, cwd, env, deadline);
  if (!writesStore(invocationFromArgv(argv)))
    return execute();
  const locked = await (deps.lock ?? withEmbeddedWriteLock)(cwd, `${toolCallId}-bd-reconcile-${internalRuns++}`, execute, env, deadline);
  if (locked.kind === "failed") {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: locked.reason };
  }
  return locked.value;
}
function parseRows(result, label) {
  if (!result.ok) {
    const detail = result.error ?? [result.stderr, result.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { failure: `${label} failed: ${detail || `exit ${result.exitCode}`}` };
  }
  const data = envelopeData(parseTrailingJson(result.stdout));
  if (!Array.isArray(data))
    return { failure: `${label} returned malformed JSON` };
  const rows = data.map(object);
  if (rows.some((row) => row === undefined))
    return { failure: `${label} returned malformed rows` };
  return { rows };
}
function dependency(row) {
  const value = object(row);
  if (value === undefined)
    return;
  const dependencyType = string(value.dependency_type) ?? string(value.type);
  return {
    id: string(value.id),
    issueId: string(value.issue_id),
    dependsOnId: string(value.depends_on_id),
    type: dependencyType,
    status: string(value.status)
  };
}
function comments(row) {
  if (!Array.isArray(row.comments))
    return [];
  return row.comments.map((entry) => object(entry)).map((entry) => string(entry?.text)).filter((entry) => entry !== undefined);
}
function beadFromRow(row) {
  const id = string(row.id);
  const status = string(row.status);
  if (id === undefined || status === undefined)
    return;
  return {
    id,
    status,
    assignee: string(row.assignee),
    metadata: object(row.metadata) ?? {},
    dependencies: Array.isArray(row.dependencies) ? row.dependencies.map(dependency).filter((item) => item !== undefined) : [],
    comments: comments(row),
    parent: string(row.parent)
  };
}
function gatesFromOutput(output) {
  const parsed = readGateList(output);
  if (parsed === undefined)
    return;
  const data = envelopeData(parseTrailingJson(output));
  if (data === null)
    return [];
  if (!Array.isArray(data))
    return;
  const gates = [];
  for (const item of data) {
    const row = object(item);
    const id = string(row?.id);
    if (row === undefined || id === undefined)
      return;
    const description = string(row.description);
    gates.push({
      id,
      blocks: string(row.blocks) ?? description?.match(/blocking\s+(\S+)/)?.[1],
      reason: string(row.reason) ?? description?.match(/Reason:\s*(.+)$/m)?.[1],
      description
    });
  }
  return gates;
}
function metadataValue(bead, key) {
  const value = bead.metadata[key];
  if (typeof value === "number" && Number.isFinite(value))
    return String(value);
  return string(value);
}
function prMatches(value, receipt) {
  if (value === undefined)
    return false;
  const expectedNumber = String(receipt.pr.number);
  return value.split(",").map((item) => item.trim()).some((item) => item === expectedNumber || item === receipt.pr.url);
}
function isPidAlive(pid, probe) {
  try {
    if (probe === undefined)
      process.kill(pid, 0);
    else
      probe(pid);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
function exactMergeIdentityFailures(bead, receipt) {
  const failures = [];
  if (receipt.emitter.tool !== "delivery_land" && receipt.emitter.tool !== "delivery_cleanup") {
    failures.push(requirement("emitter.tool", receipt.emitter.tool, '"delivery_land" or "delivery_cleanup"'));
  }
  if (receipt.repo.forge === "unknown") {
    failures.push(requirement("repo.forge", receipt.repo.forge, '"github" or "gitlab"'));
  }
  if (receipt.pr.state !== "MERGED")
    failures.push(requirement("pr.state", receipt.pr.state, '"MERGED"'));
  if (!receipt.pr.headRefOid)
    failures.push(requirement("pr.headRefOid", receipt.pr.headRefOid, "a non-empty string"));
  if (receipt.pr.mergeCommitOid === null)
    failures.push(requirement("pr.mergeCommitOid", null, "a non-empty string"));
  if (receipt.pr.mergedAt === null)
    failures.push(requirement("pr.mergedAt", null, "a non-empty string"));
  const base = metadataValue(bead, "base");
  if (base !== receipt.pr.baseRefName)
    failures.push(requirement("metadata.base", base, JSON.stringify(receipt.pr.baseRefName)));
  const branch = metadataValue(bead, "branch");
  if (branch !== receipt.pr.headRefName)
    failures.push(requirement("metadata.branch", branch, JSON.stringify(receipt.pr.headRefName)));
  if (receipt.branch.name !== receipt.pr.headRefName)
    failures.push(requirement("branch.name", receipt.branch.name, JSON.stringify(receipt.pr.headRefName)));
  const head = metadataValue(bead, "head_sha");
  if (head !== receipt.pr.headRefOid)
    failures.push(requirement("metadata.head_sha", head, JSON.stringify(receipt.pr.headRefOid)));
  return failures;
}
function exactProofFailures(bead, receipt) {
  const failures = exactMergeIdentityFailures(bead, receipt);
  if (receipt.outcome !== "landed") {
    failures.push(requirement("outcome", receipt.outcome, '"landed" for automatic close'));
  }
  if (receipt.branch.autoDeleteSetting === "unknown") {
    failures.push(requirement("branch.autoDeleteSetting", "unknown", '"on" or "off"'));
  }
  if (!receipt.branch.deletedRemote)
    failures.push(requirement("branch.deletedRemote", false, "true"));
  if (receipt.branch.remoteAbsenceVerifiedAt === null)
    failures.push(requirement("branch.remoteAbsenceVerifiedAt", null, "a non-empty string"));
  if (!receipt.worktree.removed)
    failures.push(requirement("worktree.removed", false, "true"));
  if (!receipt.worktree.localRefDeleted)
    failures.push(requirement("worktree.localRefDeleted", false, "true"));
  if (receipt.worktree.absenceVerifiedAt === null)
    failures.push(requirement("worktree.absenceVerifiedAt", null, "a non-empty string"));
  if (!receipt.beads.ledgerActive)
    failures.push(requirement("beads.ledgerActive", false, "true"));
  return failures;
}
function auditResponses(store) {
  if (store === undefined)
    return { failure: "audit history store is unavailable" };
  const path = join2(store, "interactions.jsonl");
  if (!existsSync2(path))
    return { entries: [] };
  try {
    const content = readFileSync2(path, "utf8");
    if (content !== "" && !content.endsWith(`
`)) {
      return { failure: `audit history ${path} is truncated: final JSONL record has no newline` };
    }
    const entries = [];
    for (const [index, line] of content.split(`
`).entries()) {
      if (line === "")
        continue;
      const entry = object(JSON.parse(line));
      if (entry === undefined)
        return { failure: `audit history ${path} line ${index + 1} is not an object` };
      entries.push(entry);
    }
    return { entries };
  } catch (error) {
    return { failure: `audit history ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function hasMergeAudit(entries, bead, mergeOid) {
  for (const entry of entries) {
    if (entry.kind !== "semantic_event" || entry.issue_id !== bead)
      continue;
    let response = entry.response;
    if (typeof response === "string") {
      try {
        response = JSON.parse(response);
      } catch {
        continue;
      }
    }
    const record = object(response);
    if (record?.event !== "merge_outcome" || record.outcome !== "merged")
      continue;
    if (record.mergeCommitOid === mergeOid)
      return true;
    const artifact = string(record.artifact);
    if (artifact === undefined || !existsSync2(artifact))
      continue;
    try {
      const parsed = parseReceipt(JSON.parse(readFileSync2(artifact, "utf8"))).receipt;
      if (parsed?.pr.mergeCommitOid === mergeOid)
        return true;
    } catch {}
  }
  return false;
}
function existingDiscoveredSource(bead, source) {
  return bead.dependencies.some((edge) => edge.type === "discovered-from" && (edge.id === source || edge.dependsOnId === source));
}
function operation(kind, bead, receipt, description, argv) {
  return { kind, bead, receipt, description, argv };
}
function depthOf(id, beads, seen = new Set) {
  if (seen.has(id))
    return 0;
  seen.add(id);
  const bead = beads.get(id);
  return bead?.parent ? 1 + depthOf(bead.parent, beads, seen) : 0;
}
function formatReport(report) {
  const lines = [
    `bd_reconcile ${report.apply ? "apply" : "scan"}: ${report.receipts.length} receipt(s), ${report.operations.length} planned ledger write(s).`
  ];
  for (const refusal of report.refusals) {
    lines.push(`REFUSE ${refusal.bead ? `${refusal.bead} ` : ""}${refusal.receipt}: ${refusal.reason}`);
  }
  for (const item of report.operations)
    lines.push(`PLAN ${item.bead}: ${item.description}`);
  for (const item of report.applied)
    lines.push(`APPLIED ${item.bead}: ${item.description}`);
  for (const failure of report.failures)
    lines.push(`FAIL ${failure}`);
  if (report.operations.length === 0 && report.failures.length === 0 && report.refusals.length === 0) {
    lines.push("No ledger writes are needed; receipt-derived state is converged.");
  } else if (report.operations.length === 0 && report.failures.length === 0 && report.refusals.length > 0) {
    lines.push("No ledger writes were planned; resolve the refusals above before treating receipt-derived state as converged.");
  } else if (!report.apply && report.operations.length > 0) {
    lines.push("Scan mode wrote nothing. Re-run with apply=true to request exec approval and apply this plan.");
  }
  return lines.join(`
`);
}
async function reconcileReceiptsUnlocked(params, toolCallId, cwd, env, deps, deadline) {
  const bdEnv = lifecycleBdEnvironment(cwd, env);
  bdEnv.BD_JSON_ENVELOPE = "1";
  const loaded = await readReceiptSources(params, cwd, bdEnv, deadline, deps);
  const refusals = [];
  if (loaded.refusal !== undefined)
    refusals.push({ receipt: params.receipt ?? "(scan)", reason: loaded.refusal });
  const validSources = [];
  for (const source of loaded.sources) {
    if (source.reason !== undefined || source.receipt === undefined) {
      refusals.push({ receipt: source.path, reason: source.reason ?? "receipt v1 was not recognized" });
      continue;
    }
    if (loaded.repoKey !== source.receipt.repo.key) {
      refusals.push({ receipt: source.path, reason: requirement("repo.key", source.receipt.repo.key, JSON.stringify(loaded.repoKey)) });
      continue;
    }
    if (!source.path.startsWith("<tool-result:")) {
      const expectedPath = resolve3(receiptRoot(bdEnv, deps), source.receipt.repo.key, `${source.receipt.receiptId}.json`);
      if (resolve3(source.path) !== expectedPath) {
        refusals.push({ receipt: source.path, reason: requirement("receipt path", source.path, JSON.stringify(expectedPath)) });
        continue;
      }
    }
    if (params.bead !== undefined && !source.receipt.beads.ids.includes(params.bead)) {
      refusals.push({ receipt: source.path, reason: `beads.ids: observed ${JSON.stringify(source.receipt.beads.ids)}, expected to include ${JSON.stringify(params.bead)}` });
      continue;
    }
    validSources.push(source);
  }
  if (validSources.length === 0) {
    const base = { ok: refusals.length === 0, apply: Boolean(params.apply), receipts: loaded.sources.map((source) => source.path), operations: [], applied: [], refusals, failures: [] };
    return { ...base, text: formatReport(base) };
  }
  const authoritativeSources = [];
  const cleanupFailuresByReceipt = new Map;
  for (const source of validSources) {
    const receipt = source.receipt;
    const observedProof = await (deps.observeProof ?? defaultObserveProof)(receipt, cwd, bdEnv, deadline);
    if (observedProof.observation === undefined) {
      refusals.push({ receipt: source.path, reason: `authoritative forge proof unavailable: ${observedProof.failure ?? "observer returned no identity"}` });
      continue;
    }
    const mismatches = observationFailures(receipt, observedProof.observation);
    if (mismatches.length > 0) {
      refusals.push({ receipt: source.path, reason: `receipt does not match current repository and PR: ${mismatches.join("; ")}` });
      continue;
    }
    if (receipt.outcome === "landed") {
      const cleanup = deps.observeCleanup === undefined ? await defaultObserveCleanup(receipt, observedProof.observation.repo.nameWithOwner, cwd, bdEnv, deadline, deps.cleanupCommand, deps.remotePlatform) : await deps.observeCleanup(receipt, cwd, bdEnv, deadline);
      cleanupFailuresByReceipt.set(source.path, cleanupObservationFailures(cleanup.observation, cleanup.failure));
    }
    authoritativeSources.push(source);
  }
  if (authoritativeSources.length === 0) {
    const base = { ok: false, apply: Boolean(params.apply), receipts: validSources.map((source) => source.path), operations: [], applied: [], refusals, failures: [] };
    return { ...base, text: formatReport(base) };
  }
  const targets = new Map;
  const receiptConflicts = new Map;
  for (const source of authoritativeSources) {
    const receipt = source.receipt;
    const ids = params.bead === undefined ? receipt.beads.ids : [params.bead];
    for (const id of ids) {
      const prior = targets.get(id)?.receipt;
      if (prior !== undefined && (prior.pr.number !== receipt.pr.number || prior.pr.mergeCommitOid !== receipt.pr.mergeCommitOid)) {
        const conflict = `ambiguous receipts: observed PR #${prior.pr.number}/${prior.pr.mergeCommitOid ?? "absent"} and PR #${receipt.pr.number}/${receipt.pr.mergeCommitOid ?? "absent"}, expected one exact PR identity`;
        const existing = receiptConflicts.get(id) ?? [];
        existing.push(conflict);
        receiptConflicts.set(id, existing);
        refusals.push({ bead: id, receipt: source.path, reason: conflict });
        continue;
      }
      if (prior === undefined || Date.parse(prior.emittedAt) < Date.parse(receipt.emittedAt) || Date.parse(prior.emittedAt) === Date.parse(receipt.emittedAt) && prior.receiptId < receipt.receiptId) {
        targets.set(id, source);
      }
    }
  }
  const ids = [...targets.keys()];
  if (ids.length === 0) {
    const base = { ok: false, apply: Boolean(params.apply), receipts: authoritativeSources.map((source) => source.path), operations: [], applied: [], refusals, failures: [] };
    return { ...base, text: formatReport(base) };
  }
  const [shown, listed, gateResult] = await Promise.all([
    runBd(["show", ...ids, "--include-comments", "--json"], cwd, bdEnv, deadline, toolCallId, deps),
    runBd(["list", "--all", "--include-gates", "--flat", "--brief", "--limit", "0", "--json"], cwd, bdEnv, deadline, toolCallId, deps),
    runBd(["gate", "list", "--json"], cwd, bdEnv, deadline, toolCallId, deps)
  ]);
  const showRows = parseRows(shown, "bd show");
  const listRows = parseRows(listed, "bd list --all");
  const gates = gateResult.ok ? gatesFromOutput(gateResult.stdout) : undefined;
  const failures = [showRows.failure, listRows.failure, gates === undefined ? "bd gate list returned unreadable state" : undefined].filter((failure) => failure !== undefined);
  if (failures.length > 0) {
    const base = { ok: false, apply: Boolean(params.apply), receipts: authoritativeSources.map((source) => source.path), operations: [], applied: [], refusals, failures };
    return { ...base, text: formatReport(base) };
  }
  const allBeads = new Map;
  for (const row of listRows.rows ?? []) {
    const bead = beadFromRow(row);
    if (bead !== undefined)
      allBeads.set(bead.id, bead);
  }
  for (const row of showRows.rows ?? []) {
    const bead = beadFromRow(row);
    if (bead !== undefined)
      allBeads.set(bead.id, bead);
  }
  const sorted = ids.sort((left, right) => depthOf(right, allBeads) - depthOf(left, allBeads) || left.localeCompare(right));
  const operations = [];
  const plannedClosed = new Set;
  const audit = auditResponses(embeddedStoreFor(cwd, bdEnv));
  const localHost = deps.host ?? hostname2().split(".")[0] ?? hostname2();
  for (const id of sorted) {
    const source = targets.get(id);
    const receipt = source?.receipt;
    const bead = allBeads.get(id);
    if (source === undefined || receipt === undefined)
      continue;
    if (bead === undefined) {
      refusals.push({ bead: id, receipt: source.path, reason: `bead: observed missing ${id}, expected an existing ledger bead` });
      continue;
    }
    const conflicts = [...receiptConflicts.get(id) ?? []];
    const currentPr = metadataValue(bead, "pr");
    if (currentPr !== undefined && !prMatches(currentPr, receipt))
      conflicts.push(requirement("metadata.pr", currentPr, String(receipt.pr.number)));
    const currentMerge = metadataValue(bead, "merge_sha");
    if (currentMerge !== undefined && currentMerge !== receipt.pr.mergeCommitOid)
      conflicts.push(requirement("metadata.merge_sha", currentMerge, JSON.stringify(receipt.pr.mergeCommitOid)));
    if (conflicts.length > 0) {
      const marker = `bd_reconcile ambiguity ${receipt.receiptId}`;
      const reason = `${marker}: ${conflicts.join("; ")}; receipt ${source.path}`;
      refusals.push({ bead: id, receipt: source.path, reason });
      if (bead.status !== "closed") {
        if (!bead.comments.some((comment) => comment.includes(marker))) {
          operations.push(operation("comment-ambiguity", id, source.path, "record the close-out ambiguity", ["comments", "add", id, reason]));
        }
        if (!(gates ?? []).some((gate) => gate.blocks === id && `${gate.reason ?? ""} ${gate.description ?? ""}`.includes(marker))) {
          operations.push(operation("gate-ambiguity", id, source.path, "create a human gate for the close-out ambiguity", ["gate", "create", "--type", "human", "--blocks", id, "--title", "Gate: bd_reconcile ambiguity", "--reason", reason, "--json"]));
        }
      }
    }
    const leaseHost = metadataValue(bead, "lease_host");
    const leasePid = metadataValue(bead, "lease_pid");
    const anchor = claimAnchor({
      id: bead.id,
      title: "",
      status: bead.status,
      assignee: bead.assignee,
      metadata: leaseHost !== undefined && leasePid !== undefined ? { lease_host: leaseHost, lease_pid: leasePid } : undefined
    });
    const localAnchor = anchor !== undefined && anchor.host.split(".")[0] === localHost.split(".")[0];
    const anchorAlive = anchor === undefined ? true : deps.pidAlive?.(anchor.pid) ?? isPidAlive(anchor.pid, deps.pidProbe);
    const deadLocalClaim = bead.status !== "closed" && bead.assignee !== undefined && anchor !== undefined && localAnchor && !anchorAlive;
    let guardedReleasePlanned = false;
    if (deadLocalClaim && bead.assignee !== undefined) {
      const release = releaseClaimArgs(id, bead.assignee, bdEnv);
      if (release === undefined) {
        refusals.push({ bead: id, receipt: source.path, reason: "dead claim release: observed no safe actor-bound CAS argv, expected BD_ACTOR or BEADS_ACTOR and a valid assignee" });
      } else {
        operations.push(operation("release-dead-claim", id, source.path, `release dead claim ${bead.assignee} with --if-assignee`, [...release, "--json"]));
        guardedReleasePlanned = true;
      }
    }
    if (conflicts.length === 0 && receipt.pr.mergeCommitOid !== null) {
      const anchors = [];
      if (currentPr === undefined)
        anchors.push("--set-metadata", `pr=${receipt.pr.number}`);
      if (currentMerge === undefined)
        anchors.push("--set-metadata", `merge_sha=${receipt.pr.mergeCommitOid}`);
      if (anchors.length > 0) {
        operations.push(operation("set-merge-anchors", id, source.path, "set exact receipt-derived pr and merge_sha anchors", ["update", id, ...anchors, "--json"]));
      }
    }
    const authoritativeSource = deps.authoritativeSource?.(bead, allBeads);
    if (authoritativeSource !== undefined && (!BEAD_ID2.test(authoritativeSource) || !allBeads.has(authoritativeSource))) {
      refusals.push({ bead: id, receipt: source.path, reason: requirement("authoritative discovered-from source", authoritativeSource, "an existing bead id") });
    } else if (authoritativeSource !== undefined && !existingDiscoveredSource(bead, authoritativeSource)) {
      operations.push(operation("add-discovered-from", id, source.path, `add authoritative discovered-from edge to ${authoritativeSource}`, ["dep", "add", id, authoritativeSource, "--type", "discovered-from", "--json"]));
    }
    const exactMerge = conflicts.length === 0 && exactMergeIdentityFailures(bead, receipt).length === 0;
    if (exactMerge && receipt.pr.mergeCommitOid !== null && audit.failure === undefined && !hasMergeAudit(audit.entries ?? [], id, receipt.pr.mergeCommitOid)) {
      const response = JSON.stringify({ event: "merge_outcome", outcome: "merged", artifact: source.path, mergeCommitOid: receipt.pr.mergeCommitOid });
      operations.push(operation("record-merge-audit", id, source.path, "record the missing merge audit event", ["audit", "record", "--kind", "semantic_event", "--issue-id", id, "--response", response, "--json"]));
    }
    if (audit.failure !== undefined) {
      refusals.push({ bead: id, receipt: source.path, reason: audit.failure });
      continue;
    }
    if (bead.status === "closed" || conflicts.length > 0)
      continue;
    const closeFailures = exactProofFailures(bead, receipt);
    closeFailures.push(...cleanupFailuresByReceipt.get(source.path) ?? []);
    const effectivePr = currentPr ?? String(receipt.pr.number);
    const effectiveMerge = currentMerge ?? receipt.pr.mergeCommitOid ?? undefined;
    if (!prMatches(effectivePr, receipt))
      closeFailures.push(requirement("metadata.pr", effectivePr, String(receipt.pr.number)));
    if (effectiveMerge !== receipt.pr.mergeCommitOid)
      closeFailures.push(requirement("metadata.merge_sha", effectiveMerge, JSON.stringify(receipt.pr.mergeCommitOid)));
    if (bead.assignee !== undefined && !guardedReleasePlanned) {
      const lease = anchor === undefined ? "absent" : `${anchor.host}:${anchor.pid}`;
      closeFailures.push(requirement("live assignment/lease", `${bead.assignee} (${lease})`, "absent or a locally proven dead lease with a planned --if-assignee release"));
    }
    const openGates = (gates ?? []).filter((gate) => gate.blocks === id);
    if (openGates.length > 0)
      closeFailures.push(requirement("open gates", openGates.map((gate) => gate.id), "[]"));
    const blockers = bead.dependencies.filter((edge) => edge.type === "blocks" && edge.status !== "closed");
    if (blockers.length > 0)
      closeFailures.push(requirement("live blockers", blockers.map((edge) => edge.id), "[]"));
    const openChildren = [...allBeads.values()].filter((candidate) => candidate.parent === id && candidate.status !== "closed" && !plannedClosed.has(candidate.id));
    if (openChildren.length > 0)
      closeFailures.push(requirement("open children", openChildren.map((child) => child.id), "[]"));
    if (closeFailures.length > 0) {
      for (const reason of closeFailures)
        refusals.push({ bead: id, receipt: source.path, reason });
      continue;
    }
    const reason = `PR #${receipt.pr.number} merged as ${receipt.pr.mergeCommitOid}; exact receipt ${receipt.receiptId} reconciled.`;
    operations.push(operation("close", id, source.path, `close with PR #${receipt.pr.number} and merge ${receipt.pr.mergeCommitOid}`, ["close", id, "--reason", reason, "--json"]));
    plannedClosed.add(id);
  }
  const applied = [];
  if (params.apply) {
    for (const item of operations) {
      const result = await (deps.spawn ?? defaultSpawn)(item.argv, cwd, bdEnv, deadline);
      if (!result.ok) {
        const detail = result.error ?? [result.stderr, result.stdout].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        failures.push(`${item.bead} ${item.kind} failed: ${detail || `exit ${result.exitCode}`}; applied work remains convergent and a retry will resume from ledger state`);
        break;
      }
      applied.push(item);
    }
  }
  const base = {
    ok: failures.length === 0 && refusals.length === 0,
    apply: Boolean(params.apply),
    receipts: authoritativeSources.map((source) => source.path),
    operations,
    applied,
    refusals,
    failures
  };
  return { ...base, text: formatReport(base) };
}
async function reconcileReceipts(params, toolCallId, cwd, env = process.env, deps = {}) {
  const deadline = Date.now() + TOOL_TIMEOUT_MS;
  if (!params.apply)
    return reconcileReceiptsUnlocked(params, toolCallId, cwd, env, deps, deadline);
  const bdEnv = lifecycleBdEnvironment(cwd, env);
  bdEnv.BD_JSON_ENVELOPE = "1";
  const locked = await (deps.lock ?? withEmbeddedWriteLock)(cwd, `${toolCallId}-bd-reconcile-transaction-${internalRuns++}`, () => reconcileReceiptsUnlocked(params, toolCallId, cwd, bdEnv, deps, deadline), bdEnv, deadline);
  if (locked.kind === "done")
    return locked.value;
  const base = {
    ok: false,
    apply: true,
    receipts: [],
    operations: [],
    applied: [],
    refusals: [],
    failures: [`apply refused before ledger reads: ${locked.reason}`]
  };
  return { ...base, text: formatReport(base) };
}
function resetReconcileArbiterForTests() {
  Reflect.deleteProperty(globalThis, RECONCILE_ARBITER);
}
function registrationArbiter() {
  const existing = Reflect.get(globalThis, RECONCILE_ARBITER);
  if (existing instanceof WeakSet)
    return existing;
  const arbiter = new WeakSet;
  Reflect.set(globalThis, RECONCILE_ARBITER, arbiter);
  return arbiter;
}
function takeRegistration(pi) {
  const arbiter = registrationArbiter();
  if (arbiter.has(pi))
    return false;
  arbiter.add(pi);
  return true;
}
function releaseRegistration(pi) {
  registrationArbiter().delete(pi);
}
function reconcileApproval(toolCall) {
  const input = object(object(toolCall)?.input);
  return input?.apply === true ? "exec" : "read";
}
function bdReconcileTool(pi) {
  if (!takeRegistration(pi))
    return;
  const z = pi.zod;
  try {
    pi.registerTool({
      name: "bd_reconcile",
      label: "Reconcile landing receipts into Beads",
      description: "Scan landing receipt v1 files and plan convergent Beads ledger repairs. Default apply=false is read-only. " + "apply=true requires exec approval and is the only receipt-derived ledger writer; it never force-closes, reopens, supersedes, prunes, purges, flattens, compacts, runs gc, or deletes beads.",
      parameters: z.object({
        receipt: z.string().optional().describe("Receipt id, exact receipt path, or receipt JSON returned by a delivery tool"),
        bead: z.string().optional().describe("Limit reconciliation to this receipt-named bead"),
        repoKey: z.string().optional().describe("16-character repository key; defaults to the current git common directory"),
        apply: z.boolean().optional().describe("Apply the planned ledger repairs (exec approval); defaults to false")
      }),
      approval: reconcileApproval,
      execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = await reconcileReceipts(params, toolCallId, ctx?.cwd ?? process.cwd());
        return {
          content: [{ type: "text", text: result.text }],
          details: result
        };
      }
    });
  } catch (error) {
    releaseRegistration(pi);
    throw error;
  }
}
export {
  bdReconcileTool as default,
  parseReceipt,
  reconcileApproval,
  reconcileReceipts,
  resetReconcileArbiterForTests,
  runBd
};
