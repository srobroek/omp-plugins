// @bun
// extensions/bd-embedded-write-lock.ts
import { spawnSync as spawnSync2 } from "child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { basename, dirname as dirname2, isAbsolute as isAbsolute2, join, resolve as resolve3 } from "path";

// extensions/shell-tokenizer.ts
var SEPARATORS = new Set([";", "&", "|", "(", ")", `
`]);
function token(value, startsQuoted = false, sawQuote = false) {
  return { value, startsQuoted, sawQuote };
}
function tokenizeShell(command, options = {}) {
  if (typeof command !== "string")
    return [];
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
var WRAPPERS = {
  mise: true,
  env: true,
  command: true,
  exec: true,
  nohup: true,
  nice: true,
  sudo: true,
  xargs: true,
  time: true,
  "!": true,
  if: true,
  elif: true,
  else: true,
  while: true,
  until: true,
  do: true
};
function commandSegments(command) {
  const out = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0;i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'")
        quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\")
        escaped = true;
      else if (ch === '"')
        quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(command.slice(start, i), two);
      i++;
      start = i + 1;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === `
` || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      out.push(command.slice(start, i), ch);
      start = i + 1;
    }
  }
  out.push(command.slice(start));
  return out;
}
function tokenize(segment) {
  return tokenizeShell(segment, { preserveBackslashes: true }).map(({ value, startsQuoted }) => ({ value, quoted: startsQuoted }));
}
function invocation(segment, argv) {
  const tokens = tokenize(segment);
  const head = argv[0];
  if (!head)
    return null;
  let start = 0;
  while (start < tokens.length) {
    const token = tokens[start];
    if (!token || token.quoted)
      return null;
    const basename = token.value.split("/").pop() ?? token.value;
    if (basename === head)
      break;
    if (basename === "env") {
      start++;
      while (start < tokens.length) {
        const option = tokens[start];
        if (!option || option.quoted)
          return null;
        const value = option.value;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
          start++;
          continue;
        }
        if (value === "--") {
          start++;
          break;
        }
        if (value === "-i" || value === "--ignore-environment") {
          start++;
          continue;
        }
        if (value === "-u" || value === "--unset") {
          start++;
          if (start >= tokens.length || tokens[start]?.quoted)
            return null;
          start++;
          continue;
        }
        if (value.startsWith("--unset=") || value.startsWith("-u") && value.length > 2) {
          start++;
          continue;
        }
        if (value.startsWith("-")) {
          start++;
          continue;
        }
        break;
      }
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) && !token.value.startsWith("-") && WRAPPERS[basename] !== true)
      return null;
    start++;
  }
  for (const [offset, word] of argv.entries()) {
    const token = tokens[start + offset];
    if (!token || token.quoted)
      return null;
    const value = offset === 0 ? token.value.split("/").pop() ?? token.value : token.value;
    if (value !== word)
      return null;
  }
  return tokens.slice(start);
}
function leadingCdCwd(command, cwd) {
  const match = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command);
  if (!match)
    return cwd;
  const dir = match[1];
  if (!dir || /^[-~$]/.test(dir) || /[\\`"'*?\x5b\x5d{}]/.test(dir))
    return cwd;
  return dir.startsWith("/") ? dir : resolve(cwd, dir);
}
var settingsCache = new Map;
// extensions/bd-actor-gate.ts
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
function invocationFromArgv(args) {
  const scanned = scanGlobals(args, 0);
  const verb = args[scanned.next];
  if (verb === undefined)
    return;
  return { verb: verb.toLowerCase(), args: args.slice(scanned.next + 1), globals: scanned.globals, prefix: [], exported: {}, unset: {} };
}

// extensions/beads-store.ts
import { spawnSync } from "child_process";
import { lstatSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, resolve as resolve2 } from "path";
function repoIdentity(cwd) {
  if (cwd.includes("\x00"))
    return;
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
    return realpathSync(isAbsolute(out) ? out : resolve2(cwd, out));
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
      lstatSync(resolve2(current, ".git"));
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
  const local = resolve2(cwd, ".beads");
  const common = repoIdentity(cwd);
  if (common === undefined)
    return;
  if (common !== cwd && common.endsWith("/.git")) {
    const primaryRoot = resolve2(common, "..");
    try {
      if (realpathSync(cwd) === primaryRoot && isDir(local))
        return local;
    } catch {
      return;
    }
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
var WAIT_MS = 120000;
var PREFLIGHT_WAIT_MS = 500;
var RUNNER_WAIT_MS = 120000;
var POLL_MS = 20;
var PREFLIGHT_WAIT_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.preflight-wait-ms.v1");
function preflightWaitMs() {
  const configured = Reflect.get(globalThis, PREFLIGHT_WAIT_KEY);
  return typeof configured === "number" ? configured : PREFLIGHT_WAIT_MS;
}
function setPreflightWaitForTests(waitMs) {
  if (waitMs === undefined)
    Reflect.deleteProperty(globalThis, PREFLIGHT_WAIT_KEY);
  else
    Reflect.set(globalThis, PREFLIGHT_WAIT_KEY, Math.max(0, waitMs));
}
var leaseMs = LEASE_MS;
var renewMs = RENEW_MS;
var nextToken = 0;
function setLeaseTimingForTests(lease, renew) {
  leaseMs = lease ?? LEASE_MS;
  renewMs = renew ?? RENEW_MS;
}
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
    const result = spawnSync2("ps", ["-o", "lstart=", "-p", String(pid)], {
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
var READS = {
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
  swarm: { list: true, show: true }
};
var WRITE_FLAGS = {
  orphans: ["--fix", "-f"],
  preflight: ["--fix"],
  ready: ["--claim"]
};
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;
function writesStore(invocation) {
  if (invocation === undefined)
    return true;
  const { verb, args, globals } = invocation;
  if (flagEnabled(globals, ["--help", "-h"]) || flagEnabled(args, ["--help", "-h"]))
    return false;
  if (flagEnabled(globals, ["--readonly"]))
    return false;
  if (verb === "comment")
    return args.length !== 1 || args[0] !== "list";
  if (verb === "comments")
    return args.length !== 1 || !BEAD_ID.test(args[0] ?? "");
  const rule = READS[verb];
  if (rule === undefined)
    return true;
  const writeFlags = WRITE_FLAGS[verb];
  if (writeFlags !== undefined && flagEnabled(args, writeFlags))
    return true;
  const subaction = args.find((arg) => !arg.startsWith("-"));
  if (rule === true)
    return false;
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
var OPERATOR = /[;&|<>(){}\\\n]/;
var SUBSTITUTION = /\$\(|`/;
var DEFERRED_VALUE = /[$`~*?[\]]/;
var STORE_FLAGS = ["-C", "--directory", "--db", "--database"];
function embeddedWriteTargets(command, cwd, env) {
  const hasBd = commandSegments(command).some((segment) => invocation(segment, ["bd"]) !== null);
  if (!hasBd)
    return { kind: "stores", stores: [] };
  const direct = directInvocation(command);
  if (direct !== undefined) {
    if (direct === "no-write" || !writesStore(direct))
      return { kind: "stores", stores: [] };
    const store = storeFor(direct.globals, cwd, env);
    return { kind: "stores", stores: store !== undefined && embedded(store) ? [store] : [] };
  }
  const ambient = storeFor([], cwd, env);
  const at = ambient !== undefined && embedded(ambient) ? ambient : namedStore(command, cwd, env);
  if (at === undefined)
    return { kind: "stores", stores: [] };
  return {
    kind: "refused",
    reason: [
      `This command mentions \`bd\` in a form the Beads write lock cannot resolve, and ${at} is an embedded store, where two concurrent writers corrupt the Dolt journal.`,
      "The lock accepts exactly one shape: a bash call whose whole command is a single direct `bd` invocation, optionally preceded by literal `VAR=value` assignments, with no separators, pipes, redirections, grouping, command substitutions, escapes or newlines, and with a literal value for `-C` / `--directory` / `--db` / `--database`.",
      "Issue the `bd` command as its own tool call in that form, and run the surrounding work as a separate call. `bd export -o issues.jsonl` rather than a redirection, and one call each rather than `&&`, are accepted."
    ].join(" ")
  };
}
function namedStore(command, cwd, env) {
  const words = tokenize(command).flatMap((token) => token.quoted ? tokenize(token.value).map((inner) => inner.value) : [token.value]);
  for (const [index, word] of words.entries()) {
    for (const flag of STORE_FLAGS) {
      const value = word === flag ? words[index + 1] : word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : undefined;
      if (value === undefined || DEFERRED_VALUE.test(value))
        continue;
      const store = storeFor([flag, value], cwd, env);
      if (store !== undefined && embedded(store))
        return store;
    }
  }
  return;
}
function directInvocation(command) {
  const tokens = tokenize(command);
  if (tokens.some((token) => SUBSTITUTION.test(token.value)))
    return;
  if (tokens.some((token) => !token.quoted && OPERATOR.test(token.value)))
    return;
  let i = 0;
  while (tokens[i] !== undefined && tokens[i]?.quoted === false && /^[A-Za-z_]\w*=/.test(tokens[i]?.value ?? ""))
    i++;
  const head = tokens[i];
  if (head === undefined || head.quoted)
    return;
  const base = head.value.split("/").pop() ?? head.value;
  if (base !== "bd")
    return;
  const invocation = invocationFromArgv(tokens.slice(i + 1).map((token) => token.value));
  if (invocation === undefined)
    return "no-write";
  for (const flag of STORE_FLAGS) {
    const value = globalValue(invocation.globals, [flag]);
    if (value !== undefined && DEFERRED_VALUE.test(value))
      return;
  }
  return invocation;
}
function embeddedStores(command, cwd, env) {
  const targets = embeddedWriteTargets(command, cwd, env);
  return targets.kind === "stores" ? targets.stores : [];
}
function ageOf(path) {
  try {
    return Date.now() - statSync2(path).mtimeMs;
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
  const steal = join(dirname2(storeLock), STEAL_NAME);
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
async function releasePreflight(store, owner, deadline) {
  const lock = join(store, LOCK_NAME);
  const token = registry().owned.get(lock)?.token;
  if (token === undefined) {
    return { kind: "failed", reason: `Beads embedded write lock at ${lock} lost its preflight ownership record. The write was refused before the serialising runner started.` };
  }
  release(store, owner);
  const ticket = { wake: undefined };
  while (stillOurs(lock, token)) {
    try {
      const result = withOwnership(lock, token, () => unlinkSync(lock));
      if (result !== "busy")
        break;
    } catch (error) {
      const code = error.code;
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
async function attachWriter(store, owner, pid, waitMs = RUNNER_WAIT_MS) {
  const lock = join(store, LOCK_NAME);
  const held = registry().owned.get(lock);
  if (held === undefined || !held.holders.has(owner))
    return false;
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
    if (result === "lost" || Date.now() >= deadline)
      return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, deadline - Date.now())));
  }
}
async function withEmbeddedWriteLock(cwd, owner, write, env = process.env, deadline, signal) {
  const store = embeddedStoreFor(cwd, env);
  if (store === undefined)
    return { kind: "done", value: await write() };
  const waitMs = deadline === undefined ? WAIT_MS : Math.max(0, deadline - Date.now());
  const got = await hold(store, owner, waitMs, signal);
  if (got.kind === "failed")
    return got;
  try {
    return { kind: "done", value: await write() };
  } finally {
    release(store, owner);
  }
}
var RUNNER_STEM = "bd-embedded-write-runner";
var RUNNER_STORE_FLAG = "--beads-store";
var RUNNER_WAIT_FLAG = "--beads-wait-ms";
function embeddedWriteRunner() {
  const here = import.meta.dir;
  const script = [
    join(here, `${RUNNER_STEM}.js`),
    join(here, `${RUNNER_STEM}.ts`),
    join(here, "..", "dist", `${RUNNER_STEM}.js`),
    join(here, "..", "extensions", `${RUNNER_STEM}.ts`)
  ].find((candidate) => existsSync(candidate));
  if (script === undefined)
    return;
  const interpreter = bunBinary();
  return interpreter === undefined ? undefined : { interpreter, script: resolve3(script) };
}
function bunBinary() {
  return resolveBunBinary({
    execPath: process.execPath,
    which: (name) => typeof Bun === "undefined" ? undefined : Bun.which(name),
    environment: process.env,
    miseWhich: (mise) => {
      try {
        const result = Bun.spawnSync({ cmd: [mise, "which", "bun"], stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0)
          return;
        return new TextDecoder().decode(result.stdout).trim();
      } catch {
        return;
      }
    }
  });
}
function resolveBunBinary(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const own = basename(execPath);
  if (own === "bun" || own === "bun.exe")
    return execPath;
  const onPath = options.which?.("bun");
  if (onPath !== null && onPath !== undefined)
    return onPath;
  const install = options.environment?.BUN_INSTALL;
  if (install !== undefined && install !== "") {
    const guess = join(install, "bin", "bun");
    if (existsSync(guess))
      return guess;
  }
  const mise = options.which?.("mise");
  if (mise === null || mise === undefined || options.miseWhich === undefined)
    return;
  const resolved = options.miseWhich(mise);
  return resolved !== undefined && basename(resolved).startsWith("bun") && existsSync(resolved) ? resolved : undefined;
}
function quote(word) {
  return `'${word.replaceAll("'", "'\\''")}'`;
}
function normalizeDirectCommand(command, cwd) {
  const match = /^\s*cd\s+([^\s;&|]+)\s*&&\s*([\s\S]+?)\s*$/.exec(command);
  if (match === null)
    return { command, cwd };
  const dir = match[1] ?? "";
  if (!dir || /^[-~$]/.test(dir) || /[\\`"'*?\x5b\x5d{}]/.test(dir))
    return;
  return { command: match[2] ?? "", cwd: leadingCdCwd(command, cwd) };
}
function directShell(command) {
  const tokens = tokenize(command);
  if (tokens.some((token) => SUBSTITUTION.test(token.value)))
    return;
  if (tokens.some((token) => !token.quoted && OPERATOR.test(token.value)))
    return;
  let assignments = 0;
  while (tokens[assignments] !== undefined && tokens[assignments]?.quoted === false && /^[A-Za-z_]\w*=/.test(tokens[assignments]?.value ?? ""))
    assignments++;
  const head = tokens[assignments];
  if (head === undefined || head.quoted || (head.value.split("/").pop() ?? head.value) !== "bd")
    return;
  const match = /^\s*((?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|[^\s]+)\s+)*)((?:[^\s]+\/)?bd(?:\s[\s\S]*)?)\s*$/.exec(command);
  if (match === null || tokenize(match[1] ?? "").length !== assignments)
    return;
  return { assignments: match[1] ?? "", call: match[2] ?? "" };
}
async function decideEmbeddedWrite(parsed, event, ctx, deadline = Date.now() + 25000, runnerLookup = embeddedWriteRunner) {
  try {
    if (event.toolName !== "bash")
      return;
    const input = event.input;
    const whole = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ctx?.cwd ?? process.cwd();
    const env = environmentForInput(event.input);
    const normalized = normalizeDirectCommand(whole, cwd);
    if (normalized === undefined)
      return { kind: "block", reason: "This command changes directory dynamically; issue the `bd` command with the tool's cwd field instead." };
    const commandCwd = normalized.cwd;
    const sources = [...parsed.commands.map((position) => position.raw)];
    const visit = (child) => {
      sources.push(...child.commands.map((position) => position.raw));
      for (const nested of child.nested)
        visit(nested);
    };
    for (const nested of parsed.nested)
      visit(nested);
    const targets = [];
    for (const source of sources) {
      const result = embeddedWriteTargets(source, commandCwd, env);
      if (result.kind === "refused")
        return { kind: "block", reason: result.reason };
      targets.push(...result.stores);
    }
    const unique = [...new Set(targets)];
    if (unique.length === 0)
      return;
    const store = unique[0];
    const direct = directShell(normalized.command);
    if (store === undefined || unique.length > 1 || direct === undefined) {
      return {
        kind: "block",
        reason: `This command reaches the embedded store${unique.length > 1 ? "s" : ""} ${unique.join(", ")} in a form the Beads write lock cannot run under its serialising runner. Issue the \`bd\` command as its own tool call, as a single direct invocation.`
      };
    }
    const runner = runnerLookup();
    if (runner === undefined) {
      return {
        kind: "block",
        reason: `${store} is an embedded store, where two concurrent writers corrupt the Dolt journal, and the Beads write-lock runner that serialises writers could not be located: no \`bun\` binary was found on PATH, in BUN_INSTALL, through mise, or as this process's own interpreter, or the runner script is missing from the installed plugin. Install \`bun\` or reinstall the @srobroek/beads plugin; the write was refused rather than run unserialised.`
      };
    }
    const preflightOwner = `tool-call-preflight:${event.toolCallId}`;
    const preflightDeadline = Math.min(deadline, Date.now() + preflightWaitMs());
    const preflight = await hold(store, preflightOwner, Math.max(0, preflightDeadline - Date.now()));
    if (preflight.kind === "failed")
      return { kind: "block", reason: preflight.reason };
    const released = await releasePreflight(store, preflightOwner, preflightDeadline);
    if (released.kind === "failed")
      return { kind: "block", reason: released.reason };
    const runnerPrefix = `BEADS_DOLT_SHARED_SERVER= BEADS_DIR=${quote(store)} `;
    const rewritten = `${direct.assignments}${runnerPrefix}${quote(runner.interpreter)} ${quote(runner.script)} ${RUNNER_STORE_FLAG} ${quote(store)} ${RUNNER_WAIT_FLAG} ${RUNNER_WAIT_MS} -- ${direct.call}`;
    const next = { ...event.input };
    if (typeof next.name !== "string" || next.name === "") {
      delete next.env;
      delete next.ready;
      delete next.pty;
    }
    next.cwd = commandCwd;
    if (typeof input.command === "string")
      next.command = rewritten;
    else
      next.cmd = rewritten;
    return { kind: "rewrite", input: next };
  } catch {
    return { kind: "block", reason: "embedded write target could not be resolved" };
  }
}
export {
  RUNNER_STORE_FLAG,
  RUNNER_WAIT_FLAG,
  attachWriter,
  decideEmbeddedWrite,
  embeddedStoreFor,
  embeddedStores,
  embeddedWriteRunner,
  embeddedWriteTargets,
  hold,
  parseLinuxStatStartIdentity,
  processStartIdentity,
  release,
  resolveBunBinary,
  setLeaseTimingForTests,
  setPreflightWaitForTests,
  withEmbeddedWriteLock,
  writesStore
};
