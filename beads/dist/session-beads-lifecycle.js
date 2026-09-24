// @bun
// extensions/session-beads-lifecycle.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, rmSync, statSync as statSync3 } from "fs";
import { isAbsolute as isAbsolute3, join as join2, resolve as resolve4 } from "path";

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
function shellQuoteBalanced(command) {
  let quote = null;
  for (let i = 0;i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote)
        quote = null;
      continue;
    }
    if (ch === '"' || ch === "'")
      quote = ch;
    else if (ch === "\\")
      i++;
  }
  return quote === null;
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
var OPERATORS = { ";": true, "&&": true, "||": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "{": true, "}": true };
var WRAPPERS = {
  mise: true,
  env: true,
  command: true,
  exec: true,
  nohup: true,
  nice: true,
  sudo: true,
  xargs: true
};
function tokenize(segment) {
  return tokenizeShell(segment, { preserveBackslashes: true }).map(({ value, startsQuoted }) => ({ value, quoted: startsQuoted }));
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
function splitCommands(source) {
  const positions = [];
  let current = [];
  const flush = () => {
    if (current.length === 0)
      return;
    const words = [...current];
    const argv = words.map((word) => word.value);
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "") || words[index]?.value === "!"))
      index++;
    while (index < words.length && WRAPPERS[words[index]?.value.split("/").pop() ?? words[index]?.value ?? ""] === true) {
      const wrapper = words[index]?.value.split("/").pop() ?? words[index]?.value ?? "";
      index++;
      if (wrapper === "env")
        while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "") || words[index]?.value?.startsWith("-") === true))
          index++;
      if (wrapper === "xargs")
        while (index < words.length && words[index]?.value?.startsWith("-") === true)
          index++;
      if (wrapper === "sudo")
        while (index < words.length && words[index]?.value?.startsWith("-") === true) {
          index++;
          if (index < words.length && words[index]?.value?.startsWith("-") === false)
            index++;
        }
    }
    const executable = words[index] && !words[index]?.quoted ? words[index]?.value : undefined;
    const raw = words.map((word) => word.quoted ? `'${word.value.replaceAll("'", "'\\''")}'` : word.value).join(" ");
    positions.push({ raw, words, argv, executable });
    current = [];
  };
  for (const token of tokenize(source)) {
    if (OPERATORS[token.value] === true) {
      flush();
      continue;
    }
    current.push(token);
  }
  flush();
  return positions;
}
function nestedSources(source) {
  const sources = [];
  let unknown = false;
  let depth = 0;
  let start = -1;
  let quote = null;
  for (let i = 0;i < source.length; i++) {
    const ch = source[i];
    if (quote === "'") {
      if (ch === "'")
        quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\")
        i++;
      else if (ch === '"')
        quote = null;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      if (end < 0)
        return { sources, unknown: true };
      sources.push(source.slice(i + 1, end));
      i = end;
      continue;
    }
    if (source.startsWith("$(", i)) {
      if (depth++ === 0)
        start = i + 2;
      i++;
      continue;
    }
    if (depth > 0 && ch === ")") {
      if (--depth === 0)
        sources.push(source.slice(start, i));
    }
  }
  if (depth !== 0)
    unknown = true;
  for (const match of source.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    const body = match[1] ?? "";
    for (const substitution of body.matchAll(/\$\(([^()]*)\)/g))
      if (substitution[1] !== undefined)
        sources.push(substitution[1]);
    for (const substitution of body.matchAll(/`([^`]*)`/g))
      if (substitution[1] !== undefined)
        sources.push(substitution[1]);
  }
  for (const match of source.matchAll(/\b(?:bash|sh|zsh|dash|ksh)\s+-c\s+((?:'[^']*')|(?:"[^"]*")|[^\s;&|]+)/g)) {
    const value = match[1];
    if (!value || value.startsWith('"$') || value.startsWith("'$"))
      unknown = true;
    else
      sources.push(value.replace(/^['"]|['"]$/g, ""));
  }
  for (const match of source.matchAll(/\beval\s+((?:'[^']*')|(?:"[^"]*")|[^\s;&|]+)/g)) {
    const value = match[1];
    if (value?.startsWith("$"))
      unknown = true;
    else if (value)
      sources.push(value.replace(/^['"]|['"]$/g, ""));
  }
  for (const match of source.matchAll(/\bxargs(?:\s+-[^\s;&|]+)*\s+([^;&|]+?)(?=\s*(?:[;&|]|$))/g)) {
    const value = match[1]?.trim();
    if (value?.startsWith("$"))
      unknown = true;
    else if (value)
      sources.push(value.replace(/^['"]|['"]$/g, ""));
  }
  return { sources, unknown };
}
function staticParse(command) {
  if (command.length > 64000)
    return { kind: "parse-failure", reason: "input exceeds 64000 characters", command, segments: [], commands: [], unknown: true, nested: [] };
  if (!shellQuoteBalanced(command))
    return { kind: "parse-failure", reason: "unbalanced shell quote", command, segments: [], commands: [], unknown: true, nested: [] };
  const commands = splitCommands(command);
  const nested = nestedSources(command);
  const children = nested.sources.map(staticParse);
  const unknown = nested.unknown || children.some((child) => child.unknown);
  return {
    command,
    segments: commands.map((position) => position.argv),
    commands,
    unknown,
    nested: children
  };
}
function parse(command) {
  return staticParse(command);
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
function parsedInvocations(parsed, executable = "bd") {
  if (parsed.unknown)
    return [];
  const found = [];
  for (const position of parsed.commands) {
    const executableName = position.executable?.split("/").pop();
    if (executableName !== executable)
      continue;
    const index = position.argv.findIndex((word, i) => !position.words[i]?.quoted && (word.split("/").pop() ?? word) === executable);
    if (index < 0)
      continue;
    const args = position.argv.slice(index + 1);
    const globals = [];
    let verb;
    for (let i = 0;i < args.length; i++) {
      const word = args[i];
      if (word === undefined)
        continue;
      if (word.startsWith("-") && verb === undefined) {
        globals.push(word);
        const next = args[i + 1];
        if (!["--global", "--claim", "--force", "--json"].includes(word) && !word.includes("=") && next !== undefined && !next.startsWith("-")) {
          globals.push(next);
          i++;
        }
        continue;
      }
      if (verb === undefined && !word.startsWith("\x00"))
        verb = word;
    }
    found.push({ position, command: position.raw, args, verb, globals });
  }
  for (const child of parsed.nested)
    found.push(...parsedInvocations(child, executable));
  return found;
}
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;
var CLOSE_VERBS = { close: true, done: true };
var DB_VALUE_FLAGS = { "--db": true, "-C": true, "--directory": true };
var VALUE_FLAGS = { "--reason": true, "-r": true, "--message": true, "--session": true, "--assignee": true, "--status": true, "--type": true };
function closeInvocations(command) {
  const parsed = parse(command);
  if (parsed.unknown)
    return [];
  const out = [];
  for (const invocation of parsedInvocations(parsed)) {
    if (!invocation.verb || CLOSE_VERBS[invocation.verb.toLowerCase()] !== true)
      continue;
    const ids = [];
    const dbArgs = [];
    const args = invocation.args;
    let verbSeen = false;
    for (let i = 0;i < args.length; i++) {
      const token = args[i];
      if (token === undefined)
        continue;
      if (!verbSeen) {
        if (token.toLowerCase() === invocation.verb.toLowerCase())
          verbSeen = true;
        else if (token.startsWith("-")) {
          const flag = token.split("=", 1)[0] ?? "";
          if (DB_VALUE_FLAGS[flag] === true) {
            dbArgs.push(token);
            const next = args[i + 1];
            if (!token.includes("=") && next !== undefined) {
              dbArgs.push(next);
              i++;
            }
          } else if (token === "--global")
            dbArgs.push(token);
        }
        continue;
      }
      if (token.startsWith("-")) {
        const flag = token.split("=", 1)[0] ?? "";
        if (DB_VALUE_FLAGS[flag] === true) {
          dbArgs.push(token);
          const next = args[i + 1];
          if (!token.includes("=") && next !== undefined) {
            dbArgs.push(next);
            i++;
          }
        } else if (token === "--global")
          dbArgs.push(token);
        else if (VALUE_FLAGS[flag] === true && !token.includes("=") && args[i + 1] !== undefined)
          i++;
        continue;
      }
      if (BEAD_ID.test(token))
        ids.push(token);
    }
    out.push({ ids, dbArgs });
  }
  return out;
}
var settingsCache = new Map;
// extensions/bd-close-gate.ts
function tokenize2(command) {
  return tokenizeShell(command).map(({ value }) => value);
}

// extensions/bd-actor-gate.ts
var ACTOR_NOTICE_ARBITER = Symbol.for("com.srobroek.beads.actor-notice-arbiter.v1");
var ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"];
var VALUE_FLAGS2 = new Set([
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
  for (const token of tokenize2(command)) {
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
    if (!VALUE_FLAGS2.has(flag))
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
  done: true,
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
    return flagEnabled(args, ["--claim"]);
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
import { basename, dirname as dirname2, isAbsolute as isAbsolute2, join, resolve as resolve3 } from "path";

// extensions/beads-store.ts
import { spawnSync } from "child_process";
import { lstatSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, resolve as resolve2 } from "path";
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
var WAIT_MS = 20000;
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
var BEAD_ID2 = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;
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
    return args.length !== 1 || !BEAD_ID2.test(args[0] ?? "");
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
  const local = holder.host === HOST;
  if (local && typeof holder.writer === "number" && pidAlive(holder.writer))
    return false;
  if (local && typeof holder.pid === "number" && !pidAlive(holder.pid))
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
function holderNow(owner, token, writer) {
  const taken = Date.now();
  return { host: HOST, pid: process.pid, owner, token, taken, expires: taken + leaseMs, ...writer === undefined ? {} : { writer } };
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
          owned.set(lock, { fd, holders: new Map([[owner, 1]]), renew, token, writer: undefined });
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
        return {
          kind: "failed",
          reason: `Beads embedded write lock at ${lock} stayed held for ${Math.round(waitMs / 1000)}s. Another writer is still working, or a hold was left behind by a process on another host; the write was refused rather than run concurrently. Read the lock file, then remove it once its holder is really gone.`
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
function renewLease(lock, owner, token) {
  const owned = registry().owned;
  const held = owned.get(lock);
  if (held === undefined || held.token !== token)
    return;
  const result = withOwnership(lock, token, () => {
    const fd = openSync(lock, "w");
    try {
      writeSync(fd, JSON.stringify(holderNow(owner, token, held.writer)));
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

// extensions/bd-lease-gate.ts
var BD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;
function claimedIds(output) {
  const ids = new Set;
  for (const match of output.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
    const id = match[1];
    if (id && BD_ID.test(id))
      ids.add(id);
  }
  for (const id of claimedTextIds(output))
    ids.add(id);
  return [...ids];
}
function claimedTextIds(output) {
  const ids = new Set;
  for (const match of output.matchAll(/\bclaimed(?:\s+issue:)?\s+([A-Za-z][A-Za-z0-9-]+(?:\.\d+)*)\b/gi)) {
    const id = match[1];
    if (id && BD_ID.test(id))
      ids.add(id);
  }
  return [...ids];
}
function claimResultOutput(event) {
  const content = (event.content ?? []).map((part) => ("text" in part) && typeof part.text === "string" ? part.text : "").join(`
`);
  const details = event.details;
  const stdout = details !== null && typeof details === "object" && "stdout" in details && typeof details.stdout === "string" ? details.stdout : "";
  return [content, stdout].filter(Boolean).join(`
`);
}

// extensions/session-beads-lifecycle.ts
var EMBEDDED_PIN_ENV = { BEADS_DOLT_SHARED_SERVER: "" };
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
  Object.assign(env, EMBEDDED_PIN_ENV);
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
  return { ...record, env: { ...env ?? {}, ...EMBEDDED_PIN_ENV, BEADS_DIR: pin } };
}
function bashCallCwd(input, fallback) {
  if (input === null || typeof input !== "object")
    return fallback;
  const cwd = input.cwd;
  return typeof cwd === "string" && cwd !== "" ? resolve4(fallback, cwd) : fallback;
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
  const dir = pin ? isAbsolute3(pin) ? pin : resolve4(cwd, pin) : join2(cwd, ".beads");
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
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.\d+)*$/i.test(token))
      ids.push(token);
  }
  return ids;
}
function optionValue(args, names) {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0)
      return args[index + 1];
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline !== undefined)
      return inline.slice(name.length + 1);
  }
  return;
}
function mutationTargetIds(args) {
  const ids = [];
  for (let index = 0;index < args.length; index++) {
    const token = args[index] ?? "";
    if (["--assignee", "-a", "--status", "-s"].includes(token)) {
      index++;
      continue;
    }
    if (/^(?:--assignee|--status|-a|-s)=/u.test(token) || /^(?:--claim|--json)(?:=|$)/u.test(token))
      continue;
    if (token.startsWith("-"))
      break;
    const [id] = beadIdCandidates(token);
    if (id !== undefined)
      ids.push(id);
  }
  return ids;
}
function commandSucceeded(event) {
  if (event.isError === true)
    return false;
  const details = event.details;
  if (details !== null && typeof details === "object" && "exitCode" in details) {
    const exitCode = details.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0)
      return false;
  }
  return !/\bCommand exited with code -?[1-9]\d*\b/u.test(resultText(event));
}
function recordClaimTransitions(state, command, env, event) {
  const invocations = bdInvocations(command);
  const parsedCommand = parse(command);
  const commandTokens = tokenizeShell(command);
  const terminalToken = commandTokens.findLast((token) => token.value !== `
`)?.value;
  const executables = parsedCommand.commands.map((position) => position.executable?.split("/").pop());
  const directCommand = executables.length === 1 && executables[0] === "bd" || executables.length === 2 && executables[0] === "cd" && executables[1] === "bd" && leadingCdCwd(command, "") !== "";
  const mutationSucceededDirectly = !parsedCommand.unknown && parsedCommand.nested.length === 0 && directCommand && invocations.length === 1 && terminalToken !== "&";
  const output = claimResultOutput(event);
  const allOutputIds = new Set(claimedIds(output));
  const labeledOutputIds = new Set(claimedTextIds(output));
  const claimInvocations = invocations.flatMap((invocation) => {
    const enabled = invocation.verb === "claim" || (invocation.verb === "update" || invocation.verb === "ready") && flagEnabled(invocation.args, ["--claim"]);
    const actor = enabled ? invocationActor(invocation, env) : null;
    return actor === null ? [] : [{ actor, directIds: mutationTargetIds(invocation.args) }];
  });
  const actorsById = new Map;
  for (const { actor, directIds } of claimInvocations) {
    for (const id of directIds) {
      const actors = actorsById.get(id) ?? new Set;
      actors.add(actor);
      actorsById.set(id, actors);
    }
  }
  for (const { actor, directIds } of claimInvocations) {
    if (mutationSucceededDirectly) {
      for (const id of directIds.length > 0 ? directIds : allOutputIds)
        state.claims.set(id, actor);
      continue;
    }
    for (const id of directIds) {
      if (!labeledOutputIds.has(id))
        continue;
      const actors = actorsById.get(id);
      state.claims.set(id, actors?.size === 1 ? actor : undefined);
    }
  }
  if (!mutationSucceededDirectly)
    return;
  for (const close of closeInvocations(command)) {
    for (const id of close.ids)
      state.claims.delete(id);
  }
  const [invocation] = invocations;
  if (invocation?.verb === "assign") {
    const [idToken, assignee] = invocation.args;
    const [id] = idToken === undefined ? [] : beadIdCandidates(idToken);
    if (id !== undefined && assignee !== undefined) {
      if (state.actors.has(assignee))
        state.claims.set(id, assignee);
      else
        state.claims.delete(id);
    }
    return;
  }
  if (invocation?.verb !== "update")
    return;
  const status = optionValue(invocation.args, ["--status", "-s"]);
  const assignee = optionValue(invocation.args, ["--assignee", "-a"]);
  for (const id of mutationTargetIds(invocation.args)) {
    if (status === "closed" || assignee === "")
      state.claims.delete(id);
    else if (assignee !== undefined) {
      if (state.actors.has(assignee))
        state.claims.set(id, assignee);
      else
        state.claims.delete(id);
    }
  }
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
  lines.push('Close what is finished with a factual --reason, release only with the guarded command above, and write residual context onto any bead whose work continues elsewhere (bd comments add <id> "..."). The bead is the handover, not a PR body. File remaining or discovered work as its own bead before stopping.');
  return lines.join(`
`);
}
function trackedClaimAdvisory(state) {
  if (state.claims.size === 0)
    return;
  const claims = [...state.claims].map(([id, assignee]) => ({
    id,
    title: "claim recorded by this session",
    status: "in_progress",
    assignee
  }));
  return formatSessionCloseAdvisory(claims, {}, new Date().toISOString(), true, state.actors);
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
      state = { actors: new Set, bdWrote: false, claims: new Map, repos: new Map, staleAdvised: false, stopFired: false, touched: new Set };
      sessions.set(key, state);
    }
    return state;
  }
  function identityFor(state, cwd) {
    const key = resolve4(cwd);
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
  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    const state = sessions.get(key);
    sessions.delete(key);
    endAutoPinSession(key, (id) => sessions.has(id));
    if (state === undefined)
      return;
    const advisory = trackedClaimAdvisory(state);
    if (advisory === undefined)
      return;
    pi.logger.error("beads claims remained at session shutdown", { claims: [...state.claims.keys()] });
    pi.sendMessage({ customType: "com.srobroek.beads.session-lifecycle", content: advisory, display: true, attribution: "user" }, { triggerTurn: false });
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
        const env = environmentForInput(input);
        for (const actor of actorValues(command, env))
          state.actors.add(actor);
        for (const id of beadIdCandidates(command))
          state.touched.add(id);
        if (commandSucceeded(event))
          recordClaimTransitions(state, command, env, event);
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
  pi.on("session_stop", (event, ctx) => {
    const state = sessions.get(sessionKey(ctx));
    if (state === undefined || state.stopFired || event.stop_hook_active === true || event.stopHookActive === true)
      return;
    const additionalContext = trackedClaimAdvisory(state);
    if (additionalContext === undefined)
      return;
    state.stopFired = true;
    return { continue: true, additionalContext };
  });
}
export {
  AUTO_GATE_TYPES,
  autoPinBeadsDir,
  bdVerbs,
  beadIdCandidates,
  beadsDir,
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
