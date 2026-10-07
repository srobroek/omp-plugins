// @bun
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

// extensions/report-only-gate.ts
var EDIT_TOOLS = { edit: true, write: true, ast_edit: true };
var MANIFESTS = {
  "package.json": true,
  "cargo.toml": true,
  "pyproject.toml": true,
  "go.mod": true,
  "go.sum": true,
  "requirements.txt": true,
  "composer.json": true,
  gemfile: true,
  pipfile: true,
  "package-lock.json": true,
  "npm-shrinkwrap.json": true,
  "pnpm-lock.yaml": true
};
var LOCKFILE = /\.lock$|^bun\.lock/;
var SEPARATORS2 = { ";": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "$(": true };
var PASSTHROUGH = {
  sudo: true,
  env: true,
  time: true,
  nohup: true,
  nice: true,
  command: true,
  exec: true,
  "--": true,
  npx: true,
  bunx: true
};
var PASSTHROUGH_VALUE_FLAGS = { "-u": true, "-g": true, "-n": true, "-C": true };
var SHELLS = { bash: true, sh: true, zsh: true, dash: true, ksh: true };
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var PM_VALUE_FLAGS = {
  "--prefix": true,
  "-C": true,
  "--dir": true,
  "--cwd": true,
  "--filter": true,
  "-F": true,
  "-w": true,
  "--workspace": true,
  "--registry": true,
  "--cache": true,
  "--userconfig": true,
  "--directory": true,
  "--project": true,
  "--config-file": true,
  "--cache-dir": true
};
var NPM_INSTALL = {
  i: true,
  in: true,
  ins: true,
  inst: true,
  insta: true,
  instal: true,
  install: true,
  isnt: true,
  isnta: true,
  isntal: true,
  isntall: true,
  add: true,
  ci: true,
  "clean-install": true,
  ic: true,
  "install-clean": true,
  it: true,
  "install-test": true,
  cit: true,
  "install-ci-test": true,
  update: true,
  up: true,
  upgrade: true,
  udpate: true
};
var MUTATING = {
  npm: NPM_INSTALL,
  pnpm: { i: true, install: true, add: true, update: true, up: true, upgrade: true, it: true, "install-test": true },
  bun: { i: true, install: true, add: true, update: true, up: true, upgrade: true },
  yarn: { install: true, add: true, up: true, upgrade: true, "upgrade-interactive": true, update: true },
  pip: { install: true },
  uv: { add: true, sync: true },
  poetry: { add: true, update: true, install: true },
  cargo: { add: true, install: true, update: true },
  go: { get: true },
  bundle: { install: true, update: true, add: true },
  bundler: { install: true, update: true, add: true },
  gem: { install: true, update: true },
  composer: { require: true, update: true, upgrade: true, install: true }
};
var RUNNERS = {
  npm: { exec: true, x: true },
  pnpm: { dlx: true, exec: true },
  yarn: { dlx: true, exec: true },
  bun: { x: true }
};
var MAX_DEPTH = 8;
function subcommand(args) {
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-"))
      return [arg, i];
    if (Object.hasOwn(PM_VALUE_FLAGS, arg))
      i++;
  }
  return [undefined, args.length];
}
function simpleCommandMutates(words, depth) {
  if (depth > MAX_DEPTH)
    return true;
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (ASSIGNMENT.test(word)) {
      i++;
      continue;
    }
    if (!Object.hasOwn(PASSTHROUGH, word.slice(word.lastIndexOf("/") + 1)))
      break;
    if (word === "command" && (words[i + 1] === "-v" || words[i + 1] === "-V"))
      return false;
    i++;
    while (words[i]?.startsWith("-") && words[i] !== "--") {
      if (Object.hasOwn(PASSTHROUGH_VALUE_FLAGS, words[i]))
        i++;
      i++;
    }
  }
  const first = words[i];
  if (first === undefined)
    return false;
  const name = first.slice(first.lastIndexOf("/") + 1).toLowerCase();
  const rest = words.slice(i + 1);
  if (Object.hasOwn(SHELLS, name)) {
    const flag = rest.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = flag === -1 ? undefined : rest[flag + 1];
    return script !== undefined && commandMutates(script, depth + 1);
  }
  if (rest.some((arg) => arg === "--help" || arg === "-h"))
    return false;
  if (name === "ncu" || name === "npm-check-updates")
    return rest.some((arg) => arg === "-u" || arg === "--upgrade");
  if (/^python\d*(?:\.\d+)*$/.test(name)) {
    const module = rest.indexOf("-m");
    return module !== -1 && rest[module + 1] === "pip" && subcommand(rest.slice(module + 2))[0] === "install";
  }
  const pm = /^pip\d*(?:\.\d+)*$/.test(name) ? "pip" : name;
  const table = MUTATING[pm];
  if (!table)
    return false;
  const [sub, at] = subcommand(rest);
  const after = rest.slice(at + 1);
  if (sub === undefined)
    return pm === "yarn" && !rest.some((arg) => arg === "--version" || arg === "-v");
  if (RUNNERS[pm]?.[sub])
    return simpleCommandMutates(after, depth + 1);
  if (pm === "uv" && sub === "pip") {
    const [inner] = subcommand(after);
    return inner === "install" || inner === "sync";
  }
  if (pm === "uv" && sub === "lock") {
    return after.some((arg) => arg === "-U" || arg === "--upgrade" || arg === "-P" || arg.startsWith("--upgrade-package"));
  }
  return Object.hasOwn(table, sub);
}
function commandMutates(command, depth = 0) {
  if (depth > MAX_DEPTH)
    return true;
  let words = [];
  for (const token of tokenizeShell(command, { hereDocumentSubstitutionsOnly: true })) {
    if (token.sawQuote || !Object.hasOwn(SEPARATORS2, token.value)) {
      words.push(token.value);
      continue;
    }
    if (simpleCommandMutates(words, depth))
      return true;
    words = [];
  }
  if (simpleCommandMutates(words, depth))
    return true;
  for (const match of command.matchAll(/`([^`]*)`|\$\(([^()]*)\)/g)) {
    if (commandMutates(match[1] ?? match[2] ?? "", depth + 1))
      return true;
  }
  return false;
}
var SKILL_READ = /^skill:\/\/whats-new(?:\/|$)|whats-new\/SKILL\.md/i;
var HANDOVER_READ = /^skill:\/\/dep-update(?:\/|$)|dep-update\/SKILL\.md/i;
var DENY_REASON = "blocked by whats-new (research-only): this session loaded the whats-new skill, which reports what changed " + "between two versions and changes nothing itself. Do not edit dependency manifests or lockfiles and do not " + "run installers or upgrade commands while researching -- the finding belongs in the report. If the user " + "actually wants the upgrade applied, that is dep-update's job: read `skill://dep-update` and run its " + "dep_scan/dep_apply confirm loop (reading it releases this gate, not the per-bump approval).";
function createState() {
  return { armed: false };
}
function targetPaths(input) {
  const out = [];
  if ("path" in input && typeof input.path === "string" && input.path.length > 0) {
    out.push(input.path);
  }
  if ("file_path" in input && typeof input.file_path === "string" && input.file_path.length > 0) {
    out.push(input.file_path);
  }
  if ("paths" in input && Array.isArray(input.paths)) {
    for (const p of input.paths)
      if (typeof p === "string" && p.length > 0)
        out.push(p);
  }
  return out;
}
function armsGate(raw) {
  return SKILL_READ.test(raw.replaceAll("\\", "/").trim());
}
function decideInput(state, text) {
  const command = text.trimStart().split(/\s/, 1)[0];
  if (command === "/skill:dep-update")
    state.armed = false;
  else if (command === "/skill:whats-new")
    state.armed = true;
}
function disarmsGate(raw) {
  return HANDOVER_READ.test(raw.replaceAll("\\", "/").trim());
}
function isDependencyFile(raw) {
  const path = raw.replaceAll("\\", "/").trim();
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return Object.hasOwn(MANIFESTS, name) || LOCKFILE.test(name);
}
function decideToolCall(state, toolName, input) {
  if (toolName === "read") {
    for (const path of targetPaths(input)) {
      if (disarmsGate(path))
        state.armed = false;
      else if (armsGate(path))
        state.armed = true;
    }
    return;
  }
  if (!state.armed)
    return;
  if (toolName === "dep_apply")
    return { block: true, reason: DENY_REASON };
  if (Object.hasOwn(EDIT_TOOLS, toolName)) {
    if (targetPaths(input).some(isDependencyFile))
      return { block: true, reason: DENY_REASON };
    return;
  }
  if (toolName === "bash") {
    const command = "command" in input ? input.command : undefined;
    if (typeof command === "string" && commandMutates(command)) {
      return { block: true, reason: DENY_REASON };
    }
  }
  return;
}
function reportOnlyGate(pi) {
  const state = createState();
  pi.on("session_start", () => {
    state.armed = false;
  });
  pi.on("input", (event) => {
    decideInput(state, event.text);
  });
  pi.on("tool_call", (event) => {
    try {
      return decideToolCall(state, event.toolName, event.input);
    } catch {
      return;
    }
  });
}
export {
  DENY_REASON,
  armsGate,
  commandMutates,
  createState,
  decideInput,
  decideToolCall,
  reportOnlyGate as default,
  disarmsGate,
  isDependencyFile,
  targetPaths
};
