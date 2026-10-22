// @bun
// extensions/bd-embedded-write-lock.ts
import { spawnSync as spawnSync2 } from "child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { basename, dirname as dirname2, isAbsolute as isAbsolute2, join, resolve as resolve2 } from "path";

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
          const source = command.slice(bodyStart, body.bodyEnd);
          if (options.hereDocumentSubstitutionsOnly)
            out.push(...substitutions(source, options));
          else
            out.push(...tokenizeShell(source, options));
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
function substitutions(body, options) {
  const out = [];
  for (let i = 0;i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    let inner;
    if (ch === "$" && body[i + 1] === "(") {
      const end = substitutionEnd(body, i + 2);
      inner = body.slice(i + 2, end);
      i = end;
      if (inner.startsWith("("))
        continue;
    } else if (ch === "`") {
      let end = i + 1;
      while (end < body.length && body[end] !== "`")
        end += body[end] === "\\" ? 2 : 1;
      inner = body.slice(i + 1, end);
      i = end;
    } else {
      continue;
    }
    out.push(token("$("), ...tokenizeShell(inner, options), token(")"));
  }
  return out;
}
function substitutionEnd(body, from) {
  let depth = 1;
  let quote = null;
  for (let i = from;i < body.length; i++) {
    const ch = body[i];
    if (quote !== null) {
      if (ch === quote)
        quote = null;
      else if (ch === "\\" && quote === '"')
        i++;
      continue;
    }
    if (ch === "\\")
      i++;
    else if (ch === '"' || ch === "'")
      quote = ch;
    else if (ch === "(")
      depth++;
    else if (ch === ")" && --depth === 0)
      return i;
  }
  return body.length;
}

// extensions/shell-command.ts
function tokenize(segment) {
  return tokenizeShell(segment, { preserveBackslashes: true }).map(({ value, startsQuoted }) => ({ value, quoted: startsQuoted }));
}
function scanShell(source) {
  const items = [];
  const substitutions = [];
  let complete = true;
  let command = { kind: "command", words: [], redirects: [], hereDocuments: [] };
  let word;
  let target;
  const pending = [];
  const append = (at, text, quoted = false, expands = false) => {
    word ??= { start: at, value: "", quoted: false, expands: false };
    word.value += text;
    word.quoted ||= quoted;
    word.expands ||= expands;
  };
  const endCommand = () => {
    if (command.words.length > 0 || command.redirects.length > 0)
      items.push(command);
    command = { kind: "command", words: [], redirects: [], hereDocuments: [] };
  };
  const flush = (end) => {
    if (word === undefined)
      return;
    const done = { start: word.start, end, value: word.value, quoted: word.quoted, expands: word.expands };
    word = undefined;
    if (target !== undefined) {
      command.redirects.push(done);
      if (target !== "redirect")
        pending.push({ delimiter: done.value, stripTabs: target === "here-document-tabs", quoted: done.quoted, owner: command });
      target = undefined;
      return;
    }
    if (command.words.length === 0 && !done.quoted && (done.value === "{" || done.value === "}")) {
      endCommand();
      items.push({ kind: "operator", operator: done.value });
      return;
    }
    command.words.push(done);
  };
  const operator = (at, value) => {
    flush(at);
    target = undefined;
    endCommand();
    items.push({ kind: "operator", operator: value });
  };
  const substitution = (expansion) => {
    if (expansion.inner !== undefined)
      substitutions.push(expansion.inner);
    if (!expansion.closed)
      complete = false;
  };
  const hereDocuments = (from) => {
    let at = from;
    while (pending.length > 0) {
      const document = pending.shift();
      if (document === undefined)
        break;
      const bodyStart = at;
      let bodyEnd = -1;
      while (at <= source.length) {
        const newline = source.indexOf(`
`, at);
        const lineEnd = newline < 0 ? source.length : newline;
        const line = source.slice(at, lineEnd);
        if ((document.stripTabs ? line.replace(/^\t+/, "") : line) === document.delimiter) {
          bodyEnd = at;
          at = newline < 0 ? source.length : newline + 1;
          break;
        }
        at = lineEnd + 1;
      }
      const body = source.slice(bodyStart, bodyEnd < 0 ? source.length : bodyEnd);
      document.owner.hereDocuments.push({ body, quoted: document.quoted });
      if (!document.quoted)
        for (const found of bodySubstitutions(body))
          substitution(found);
      if (bodyEnd < 0) {
        complete = false;
        return source.length;
      }
    }
    return at;
  };
  for (let i = 0;i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\\") {
      if (next === `
`)
        i++;
      else if (next === undefined)
        append(i, ch);
      else
        append(i++, next, true);
      continue;
    }
    if (ch === "'") {
      const close = source.indexOf("'", i + 1);
      if (close < 0)
        complete = false;
      append(i, source.slice(i + 1, close < 0 ? source.length : close), true);
      i = close < 0 ? source.length : close;
      continue;
    }
    if (ch === "$" && next === "'") {
      let j = i + 2;
      while (j < source.length && source[j] !== "'")
        j += source[j] === "\\" ? 2 : 1;
      if (j >= source.length)
        complete = false;
      append(i, source.slice(i + 2, Math.min(j, source.length)), true);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "$" && next === '"') {
      const open = ch === '"' ? i : i + 1;
      let j = open + 1;
      let text = "";
      let expands = false;
      while (j < source.length && source[j] !== '"') {
        const c = source[j];
        const escaped = source[j + 1];
        if (c === "\\" && escaped !== undefined) {
          if (escaped !== `
`)
            text += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
          j += 2;
          continue;
        }
        if (c === "$" || c === "`") {
          const expansion = expansionAt(source, j);
          substitution(expansion);
          text += source.slice(j, expansion.end);
          expands ||= expansion.expands;
          j = expansion.end;
          continue;
        }
        text += c;
        j++;
      }
      if (j >= source.length)
        complete = false;
      append(i, text, true, expands);
      i = j;
      continue;
    }
    if (ch === "$" || ch === "`") {
      const expansion = expansionAt(source, i);
      substitution(expansion);
      append(i, source.slice(i, expansion.end), false, expansion.expands);
      i = expansion.end - 1;
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      const close = closingIndex(source, i + 2, "(", ")");
      const end = close < 0 ? source.length : close;
      substitutions.push(source.slice(i + 2, end));
      if (close < 0)
        complete = false;
      append(i, source.slice(i, close < 0 ? end : end + 1), false, true);
      i = end;
      continue;
    }
    if (ch === "#" && word === undefined) {
      const newline = source.indexOf(`
`, i);
      i = (newline < 0 ? source.length : newline) - 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush(i);
      continue;
    }
    if (ch === `
`) {
      operator(i, `
`);
      i = hereDocuments(i + 1) - 1;
      continue;
    }
    if (ch === ";") {
      const length = next === ";" ? source[i + 2] === "&" ? 3 : 2 : next === "&" ? 2 : 1;
      operator(i, length === 1 ? ";" : ";;");
      i += length - 1;
      continue;
    }
    if (ch === "&" && next === ">") {
      flush(i);
      target = "redirect";
      i += source[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (ch === "&" || ch === "|") {
      const value = next === ch ? `${ch}${ch}` : ch === "|" && next === "&" ? "|&" : ch;
      operator(i, value);
      i += value.length - 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      operator(i, ch);
      continue;
    }
    if (ch === "<" || ch === ">") {
      if (word !== undefined && !word.quoted && !word.expands && /^(?:\d+|\{[A-Za-z_]\w*\})$/.test(word.value))
        word = undefined;
      else
        flush(i);
      if (source.startsWith("<<<", i)) {
        target = "redirect";
        i += 2;
      } else if (source.startsWith("<<-", i)) {
        target = "here-document-tabs";
        i += 2;
      } else if (source.startsWith("<<", i)) {
        target = "here-document";
        i += 1;
      } else {
        target = "redirect";
        if (next === ">" || next === "&" || next === "|" || ch === "<" && next === ">")
          i += 1;
      }
      continue;
    }
    append(i, ch, false, "*?[{}".includes(ch) || ch === "~" && word === undefined);
  }
  flush(source.length);
  endCommand();
  if (pending.length > 0)
    complete = false;
  return { items, substitutions, complete };
}
function expansionAt(text, at) {
  if (text[at] === "`") {
    let j = at + 1;
    while (j < text.length && text[j] !== "`")
      j += text[j] === "\\" ? 2 : 1;
    const closed = j < text.length;
    return { end: closed ? j + 1 : text.length, inner: text.slice(at + 1, Math.min(j, text.length)), expands: true, closed };
  }
  const next = text[at + 1];
  if (next === "(" || next === "{") {
    const close = closingIndex(text, at + 2, next, next === "(" ? ")" : "}");
    const closed = close >= 0;
    return { end: closed ? close + 1 : text.length, inner: text.slice(at + 2, closed ? close : text.length), expands: true, closed };
  }
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let j = at + 2;
    while (j < text.length && /\w/.test(text[j]))
      j++;
    return { end: j, expands: true, closed: true };
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next))
    return { end: at + 2, expands: true, closed: true };
  return { end: at + 1, expands: false, closed: true };
}
function closingIndex(text, from, open, close) {
  let depth = 1;
  for (let j = from;j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let k = j + 1;
      while (k < text.length && text[k] !== c)
        k += c !== "'" && text[k] === "\\" ? 2 : 1;
      if (k >= text.length)
        return -1;
      j = k;
      continue;
    }
    if (c === open)
      depth++;
    else if (c === close && --depth === 0)
      return j;
  }
  return -1;
}
function bodySubstitutions(body) {
  const found = [];
  for (let j = 0;j < body.length; j++) {
    const c = body[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c !== "$" && c !== "`")
      continue;
    const expansion = expansionAt(body, j);
    found.push(expansion);
    j = expansion.end - 1;
  }
  return found;
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
import { dirname, isAbsolute, resolve } from "path";
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
  swarm: { list: true }
};
var WRITE_FLAGS = {
  orphans: ["--fix", "-f"],
  preflight: ["--fix"],
  ready: ["--claim"]
};
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;
var COMMENT_LISTING_FLAGS = { "--json": true, "--local-time": true };
function writesStore(invocation) {
  if (invocation === undefined)
    return true;
  const { verb, args, globals } = invocation;
  if (flagEnabled(globals, ["--help", "-h"]) || flagEnabled(args, ["--help", "-h"]))
    return false;
  if (flagEnabled(globals, ["--readonly"]))
    return false;
  if (verb === "comment")
    return true;
  if (verb === "comments") {
    const positional = args.filter((arg) => COMMENT_LISTING_FLAGS[arg] !== true);
    return positional.length !== 1 || !BEAD_ID.test(positional[0] ?? "");
  }
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
var DEFERRED_VALUE = /[$`~*?[\]]/;
var STORE_FLAGS = ["-C", "--directory", "--db", "--database"];
var BD_WORD = /(?<![\w.-])bd(?![\w-]|\.\w)/;
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
var BEADS_DIR_ASSIGNMENT = /^BEADS_DIR(\+?)=/;
var LIST_PREFIXES = new Set(["then", "else", "do"]);
var CONDITION_PREFIXES = { "!": true, if: true, elif: true, while: true, until: true, time: true };
var NAME_ONLY = {
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
  which: true
};
var SHELL_INTERPRETERS = { bash: true, dash: true, fish: true, ksh: true, mksh: true, sh: true, zsh: true };
var SOURCE_RUNNERS = { ".": true, eval: true, parallel: true, screen: true, script: true, source: true, su: true, tmux: true, watch: true };
var ASSIGNING = { declare: true, getopts: true, local: true, mapfile: true, printf: true, read: true, readarray: true, readonly: true, typeset: true };
var UNCERTAIN_AFTER = { "\n": true, "&": true, ";": true, ";;": true, "||": true };
var RUNNER_SCRIPT = /^bd-embedded-write-runner\.(?:js|ts)$/;
var DYNAMIC_CWD = "This command changes directory dynamically; issue the `bd` command with the tool's cwd field instead.";
var SOURCE_FIX = "Write each `bd` command directly in this command line instead of inside a string, script or here-document.";
var ACCEPTED_SHAPES = "Accepted: `bd` reads anywhere in pipes, `;` / `&&` / `||` lists, `( )` / `{ }` groups, loops and redirections; and each `bd` write written as its own simple command, `[VAR=literal ...] bd ...`, anywhere in such a command, which the lock runs under its serialising runner with a hold of its own.";
function planEmbeddedWrites(command, cwd, env) {
  if (!BD_WORD.test(command))
    return { kind: "writes", writes: [] };
  const scan = scanShell(command);
  const writes = [];
  let problem;
  let problemStore;
  const refuse = (found, store) => {
    problem ??= found;
    problemStore ??= store;
  };
  if (!scan.complete)
    refuse({ part: "it leaves a quote, command substitution or here-document open, so its `bd` invocations cannot be located", fix: "Close it and retry." });
  if (scan.substitutions.some(runsBd)) {
    refuse({
      part: "`bd` runs inside a command substitution (`$(...)`, backticks or `<(...)`), which the lock cannot rewrite",
      fix: "Run that `bd` at the top level of the command instead: pipe its output on (`bd show X --json | jq ...`), or redirect it to a file and read the file."
    });
  }
  const scopes = [{ cwd: { kind: "known", cwd, certain: true, changed: false }, beadsDir: { kind: "known", value: env.BEADS_DIR } }];
  const { items } = scan;
  for (const [index, item] of items.entries()) {
    const state = scopes[scopes.length - 1];
    if (item.kind === "operator") {
      if (item.operator === "(")
        scopes.push(structuredClone(state));
      else if (item.operator === ")" && scopes.length > 1)
        scopes.pop();
      else if (UNCERTAIN_AFTER[item.operator] === true && state.cwd.kind === "known" && state.cwd.changed)
        state.cwd.certain = false;
      continue;
    }
    const shape = shapeOf(item, command);
    if (shape.kind !== "bd" && item.hereDocuments.some((document) => BD_WORD.test(document.body))) {
      const runner = pipelineSourceRunner(items, index, command);
      if (runner !== undefined)
        refuse({ part: `a here-document fed to \`${runner}\` mentions \`bd\``, fix: SOURCE_FIX });
    }
    if (shape.kind === "other") {
      const launch = launchOf(shape, item, command);
      if (launch !== undefined)
        refuse(launch);
      const before = operatorAt(items, index - 1);
      const after = operatorAt(items, index + 1);
      applyEffects(shape, state, command, {
        leading: index === 0 && after === "&&",
        scoped: before === "|" || before === "|&" || after === "|" || after === "|&" || after === "&"
      });
      continue;
    }
    if (shape.kind === "runner") {
      const argv = shape.child.slice(1);
      const child = invocationFromArgv(argv.map((word) => word.value));
      if (child === undefined || !isWrite(child, argv))
        continue;
      const resolved = resolveWrite(child, shape.assignments, state, env, command);
      if ("problem" in resolved)
        refuse(resolved.problem);
      else if (resolved.store !== undefined && embedded(resolved.store) && resolved.store !== canonical(shape.store)) {
        refuse({ part: `a runner command holds \`${shape.store}\` while its \`bd ${child.verb}\` writes \`${resolved.store}\``, fix: "Write the plain `bd` command and let the lock generate the runner form." }, resolved.store);
      }
      continue;
    }
    const invocation = invocationFromArgv(shape.args.map((word) => word.value));
    if (invocation === undefined || !isWrite(invocation, shape.args))
      continue;
    const resolved = resolveWrite(invocation, shape.assignments, state, env, command);
    if ("problem" in resolved) {
      refuse(resolved.problem);
      continue;
    }
    const store = resolved.store;
    if (store === undefined || !embedded(store))
      continue;
    if (shape.condition !== undefined) {
      refuse({
        part: `the write \`bd ${invocation.verb}\` follows \`${shape.condition}\`, and the lock does not run a write in a condition, behind \`!\` or under \`time\``,
        fix: `Make the write its own simple command, for example \`bd ${invocation.verb} ... && next\` or \`check && bd ${invocation.verb} ...\`.`
      }, store);
      continue;
    }
    writes.push({ store, offset: shape.head.start });
  }
  if (problem === undefined)
    return { kind: "writes", writes };
  const at = writes[0]?.store ?? problemStore ?? embeddedStoreFor(cwd, env) ?? namedStore(command, cwd, env);
  if (at === undefined)
    return { kind: "writes", writes };
  return { kind: "refused", reason: refusal(problem, at) };
}
function embeddedWriteTargets(command, cwd, env) {
  const plan = planEmbeddedWrites(command, cwd, env);
  return plan.kind === "refused" ? plan : { kind: "stores", stores: [...new Set(plan.writes.map((write) => write.store))] };
}
function refusal(problem, store) {
  if ("exact" in problem)
    return problem.exact;
  return `The Beads write lock cannot run this command: ${problem.part}. ${store} is an embedded store, where two concurrent \`bd\` writes corrupt the Dolt journal, so every \`bd\` write to it runs under the lock's serialising runner. ${problem.fix} ${ACCEPTED_SHAPES}`;
}
function commandName(word) {
  return word.value.split("/").pop() ?? word.value;
}
function operatorAt(items, index) {
  const item = items[index];
  return item?.kind === "operator" ? item.operator : undefined;
}
function shapeOf(command, source) {
  const { words } = command;
  let i = 0;
  let condition;
  for (let word = words[0];word !== undefined && !word.quoted && !word.expands; word = words[i]) {
    if (CONDITION_PREFIXES[word.value] === true)
      condition ??= word.value;
    else if (!LIST_PREFIXES.has(word.value))
      break;
    i += word.value === "time" && words[i + 1]?.value === "-p" ? 2 : 1;
  }
  const first = i;
  while (words[i] !== undefined && ASSIGNMENT.test(source.slice(words[i]?.start, words[i]?.end)))
    i++;
  const assignments = words.slice(first, i);
  const head = words[i];
  const args = words.slice(i + 1);
  if (head !== undefined && !head.expands && commandName(head) === "bd")
    return { kind: "bd", condition, assignments, head, args };
  const runner = head === undefined || head.expands || condition !== undefined ? undefined : runnerShape(args);
  if (runner !== undefined)
    return { kind: "runner", assignments, ...runner };
  return { kind: "other", assignments, head, args };
}
function runnerShape(args) {
  const script = args[0];
  if (script === undefined || script.expands || !RUNNER_SCRIPT.test(commandName(script)))
    return;
  let store;
  let i = 1;
  for (;i < args.length && args[i]?.value !== "--"; i += 2) {
    const value = args[i + 1];
    if (value === undefined || value.expands)
      return;
    if (args[i]?.value === RUNNER_STORE_FLAG)
      store = value.value;
    else if (args[i]?.value !== RUNNER_WAIT_FLAG)
      return;
  }
  const child = args.slice(i + 1);
  const bd = child[0];
  if (store === undefined || bd === undefined || bd.expands || commandName(bd) !== "bd")
    return;
  return { store, child };
}
function isWrite(invocation, args) {
  return writesStore(invocation) || WRITE_FLAGS[invocation.verb] !== undefined && args.some((word) => word.expands);
}
function runsBd(source) {
  if (!BD_WORD.test(source))
    return false;
  const scan = scanShell(source);
  if (!scan.complete || scan.substitutions.some(runsBd))
    return true;
  return scan.items.some((item, index) => {
    if (item.kind !== "command")
      return false;
    const shape = shapeOf(item, source);
    if (shape.kind !== "other" || launchOf(shape, item, source) !== undefined)
      return true;
    return item.hereDocuments.some((document) => BD_WORD.test(document.body)) && pipelineSourceRunner(scan.items, index, source) !== undefined;
  });
}
function sourceRunner(shape) {
  const { head, args } = shape;
  if (head === undefined)
    return;
  if (!head.quoted && !head.expands && SOURCE_RUNNERS[commandName(head)] === true)
    return head;
  return [head, ...args].find((word) => !word.quoted && !word.expands && SHELL_INTERPRETERS[commandName(word)] === true);
}
function pipelineSourceRunner(items, index, source) {
  const pipe = (at) => {
    const operator = operatorAt(items, at);
    return operator === "|" || operator === "|&";
  };
  let first = index;
  while (pipe(first - 1) && items[first - 2]?.kind === "command")
    first -= 2;
  let last = index;
  while (pipe(last + 1) && items[last + 2]?.kind === "command")
    last += 2;
  for (let at = first;at <= last; at += 2) {
    const item = items[at];
    if (item?.kind !== "command")
      continue;
    const shape = shapeOf(item, source);
    const runner = shape.kind === "other" ? sourceRunner(shape) : undefined;
    if (runner !== undefined)
      return runner.value;
  }
  return;
}
function launchOf(shape, command, source) {
  const { head, args } = shape;
  if (head === undefined)
    return;
  if (head.expands) {
    if (!BD_WORD.test(source))
      return;
    return { part: `its command word \`${source.slice(head.start, head.end)}\` is expanded at run time, so whether it runs \`bd\` is unknown`, fix: "Spell `bd` literally as the command word." };
  }
  const runner = sourceRunner(shape);
  if (runner !== undefined && [head, ...args, ...command.redirects].some((word) => BD_WORD.test(word.value))) {
    return { part: `\`bd\` is passed as shell source to \`${runner.value}\`, which runs it where the lock cannot see it`, fix: SOURCE_FIX };
  }
  const name = commandName(head);
  if (NAME_ONLY[name] === true || name === "command" && /^-[vV]$/.test(args[0]?.value ?? ""))
    return;
  if (!args.some((word) => !word.quoted && !word.expands && commandName(word) === "bd"))
    return;
  return {
    part: `\`bd\` is launched through \`${head.value}\`, which hides the invocation from the lock`,
    fix: 'Call `bd` directly as its own simple command instead of through a launcher such as `env`, `xargs`, `timeout` or `find -exec`; to act on a list of ids, pass them to one `bd` call or loop with `while read -r id; do bd ... "$id"; done`.'
  };
}
function applyEffects(shape, state, source, context) {
  const { head, args } = shape;
  if (head === undefined) {
    for (const word of shape.assignments)
      assignBeadsDir(state, word, source, context.scoped);
    return;
  }
  const name = head.expands ? "" : commandName(head);
  if (name === "cd") {
    const operands = args.filter((word) => word.value !== "--" && !/^-[LPe@]+$/.test(word.value));
    const target = operands[0];
    if (state.cwd.kind === "dynamic")
      return;
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
      problem: { part: `\`${name}\` earlier in the command may change the working directory before a \`bd\` write`, fix: "Use a literal `cd DIR &&` prefix or the tool's cwd field, or run the write as its own tool call." }
    };
    if (name !== "pushd" && name !== "popd")
      state.beadsDir = { kind: "unknown", cause: name };
    return;
  }
  if (name === "export") {
    const unexports = args.some((word) => /^-\w*[nf]/.test(word.value));
    for (const word of args) {
      if (word.value === "BEADS_DIR" && unexports)
        state.beadsDir = { kind: "unknown", cause: source.slice(head.start, word.end) };
      else
        assignBeadsDir(state, word, source, context.scoped);
    }
    return;
  }
  if (name === "unset") {
    if (args.some((word) => word.value === "BEADS_DIR") && !args.some((word) => word.value === "-f")) {
      state.beadsDir = context.scoped ? { kind: "unknown", cause: "unset BEADS_DIR" } : { kind: "known", value: undefined };
    }
    return;
  }
  if (ASSIGNING[name] === true && args.some((word) => word.value === "BEADS_DIR" || BEADS_DIR_ASSIGNMENT.test(word.value))) {
    state.beadsDir = { kind: "unknown", cause: name };
  }
}
function assignBeadsDir(state, word, source, scoped) {
  const match = BEADS_DIR_ASSIGNMENT.exec(word.value);
  if (match === null)
    return;
  const value = word.value.slice(match[0].length);
  const literal = !scoped && match[1] === "" && !word.expands && !DEFERRED_VALUE.test(value);
  state.beadsDir = literal ? { kind: "known", value } : { kind: "unknown", cause: source.slice(word.start, word.end) };
}
function resolveWrite(invocation, assignments, state, env, source) {
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
    if (match === null)
      continue;
    const value = word.value.slice(match[0].length);
    beadsDir = match[1] === "" && !word.expands && !DEFERRED_VALUE.test(value) ? { kind: "known", value } : { kind: "unknown", cause: source.slice(word.start, word.end) };
  }
  const directory = globalValue(invocation.globals, ["-C", "--directory"]);
  const db = globalValue(invocation.globals, ["--db"]);
  if (directory === undefined && db === undefined && beadsDir.kind === "unknown") {
    return {
      problem: {
        part: `${write} runs with \`BEADS_DIR\` set by \`${beadsDir.cause}\`, which the shell resolves only at run time`,
        fix: "Set `BEADS_DIR` to a literal path, as `export BEADS_DIR=/path` earlier in the command or as `BEADS_DIR=/path bd ...`, or leave it unset to use the session's store."
      }
    };
  }
  if (state.cwd.kind === "dynamic")
    return { problem: state.cwd.problem };
  const relative = db !== undefined ? !isAbsolute2(db) && (directory === undefined || !isAbsolute2(directory)) : directory !== undefined && !isAbsolute2(directory);
  if (relative && !state.cwd.certain) {
    return {
      problem: {
        part: `${write} resolves a relative \`${db === undefined ? "-C" : "--db"}\` path after a \`cd\` the lock cannot confirm ran`,
        fix: "Give it an absolute path, or start the command with `cd DIR &&` joined to the write by `&&` alone."
      }
    };
  }
  return { store: storeFor(invocation.globals, state.cwd.cwd, { ...env, BEADS_DIR: beadsDir.kind === "known" ? beadsDir.value : undefined }) };
}
function namedStore(command, cwd, env) {
  const words = tokenize(command).flatMap((token) => token.quoted ? tokenize(token.value).map((inner) => inner.value) : [token.value]);
  for (const [index, word] of words.entries()) {
    const assigned = BEADS_DIR_ASSIGNMENT.test(word) ? word.slice(word.indexOf("=") + 1) : undefined;
    if (assigned !== undefined && !DEFERRED_VALUE.test(assigned)) {
      const store = storeFor([], cwd, { ...env, BEADS_DIR: assigned });
      if (store !== undefined && embedded(store))
        return store;
    }
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
var INSTALLED_PLUGIN_DIR = /^(.+___beads___).+$/;
var SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function embeddedWriteRunnerScript(here) {
  const local = [
    join(here, `${RUNNER_STEM}.js`),
    join(here, `${RUNNER_STEM}.ts`),
    join(here, "..", "dist", `${RUNNER_STEM}.js`),
    join(here, "..", "extensions", `${RUNNER_STEM}.ts`)
  ].find((candidate) => existsSync(candidate));
  if (local !== undefined)
    return { script: resolve2(local) };
  const root = resolve2(here, "..");
  const missing = `${join(here, RUNNER_STEM)}.js`;
  const prefix = INSTALLED_PLUGIN_DIR.exec(basename(root))?.[1];
  let searched = "";
  if (prefix !== undefined) {
    const cache = dirname2(root);
    searched = ` or in any ${prefix}<version> directory under ${cache}`;
    let entries;
    try {
      entries = readdirSync(cache);
    } catch {
      entries = [];
    }
    const newestFirst = entries.filter((entry) => entry.startsWith(prefix) && SEMVER.test(entry.slice(prefix.length))).sort((left, right) => Bun.semver.order(right.slice(prefix.length), left.slice(prefix.length)));
    for (const entry of newestFirst) {
      const script = [join(cache, entry, "dist", `${RUNNER_STEM}.js`), join(cache, entry, "extensions", `${RUNNER_STEM}.ts`)].find((candidate) => existsSync(candidate));
      if (script !== undefined)
        return { script: resolve2(script) };
    }
  }
  return {
    unavailable: `the runner script ${missing} is missing, and no runner was found beside it${searched}. If the @srobroek/beads plugin was just upgraded, restart the session so it loads the new version; otherwise reinstall the plugin.`
  };
}
function embeddedWriteRunner(here = import.meta.dir, interpreterLookup = bunBinary) {
  const located = embeddedWriteRunnerScript(here);
  if ("unavailable" in located)
    return located;
  const interpreter = interpreterLookup();
  if (interpreter === undefined) {
    return { unavailable: "no `bun` binary was found on PATH, in BUN_INSTALL, through mise, or as this process's own interpreter. Install `bun`." };
  }
  return { interpreter, script: located.script };
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
function withRunner(command, writes, runner) {
  let out = "";
  let cursor = 0;
  for (const write of [...writes].sort((left, right) => left.offset - right.offset)) {
    const store = quote(write.store);
    out += `${command.slice(cursor, write.offset)}BEADS_DOLT_SHARED_SERVER= BEADS_DIR=${store} ${quote(runner.interpreter)} ${quote(runner.script)} ${RUNNER_STORE_FLAG} ${store} ${RUNNER_WAIT_FLAG} ${RUNNER_WAIT_MS} -- `;
    cursor = write.offset;
  }
  return out + command.slice(cursor);
}
async function decideEmbeddedWrite(parsed, event, ctx, deadline = Date.now() + 25000, runnerLookup = embeddedWriteRunner) {
  try {
    if (event.toolName !== "bash")
      return;
    const input = event.input;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ctx?.cwd ?? process.cwd();
    const plan = planEmbeddedWrites(parsed.command, cwd, environmentForInput(event.input));
    if (plan.kind === "refused")
      return { kind: "block", reason: plan.reason };
    if (plan.writes.length === 0)
      return;
    const stores = [...new Set(plan.writes.map((write) => write.store))];
    const runner = runnerLookup();
    if ("unavailable" in runner) {
      return {
        kind: "block",
        reason: `${stores.join(", ")} ${stores.length > 1 ? "are embedded stores" : "is an embedded store"}, where two concurrent \`bd\` writes corrupt the Dolt journal, and the Beads write-lock runner that serialises writers could not be located: ${runner.unavailable} The write was refused rather than run unserialised.`
      };
    }
    const preflightOwner = `tool-call-preflight:${event.toolCallId}`;
    const preflightDeadline = Math.min(deadline, Date.now() + preflightWaitMs());
    for (const store of stores) {
      const preflight = await hold(store, preflightOwner, Math.max(0, preflightDeadline - Date.now()));
      if (preflight.kind === "failed")
        return { kind: "block", reason: preflight.reason };
      const released = await releasePreflight(store, preflightOwner, preflightDeadline);
      if (released.kind === "failed")
        return { kind: "block", reason: released.reason };
    }
    const rewritten = withRunner(parsed.command, plan.writes, runner);
    const next = { ...event.input };
    if (typeof next.name !== "string" || next.name === "") {
      delete next.env;
      delete next.ready;
      delete next.pty;
    }
    next.cwd = cwd;
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
  planEmbeddedWrites,
  processStartIdentity,
  release,
  resolveBunBinary,
  setLeaseTimingForTests,
  setPreflightWaitForTests,
  withEmbeddedWriteLock,
  writesStore
};
