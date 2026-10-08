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

// extensions/command-words.ts
var NONE = new Set;
var WRAPPERS = new Map([
  ["sudo", {
    valued: new Set([
      "-C",
      "-D",
      "-g",
      "-h",
      "-p",
      "-R",
      "-r",
      "-T",
      "-t",
      "-U",
      "-u",
      "--chdir",
      "--chroot",
      "--close-from",
      "--command-timeout",
      "--group",
      "--host",
      "--other-user",
      "--prompt",
      "--role",
      "--type",
      "--user"
    ]),
    chdir: new Set(["-D", "--chdir"])
  }],
  ["doas", { valued: new Set(["-C", "-u"]) }],
  ["env", {
    valued: new Set(["-C", "-L", "-P", "-S", "-U", "-u", "--chdir", "--split-string", "--unset"]),
    chdir: new Set(["-C", "--chdir"]),
    split: new Set(["-S", "--split-string"]),
    assignments: true
  }],
  ["nice", { valued: new Set(["-n", "--adjustment"]) }],
  ["timeout", { valued: new Set(["-k", "-s", "--kill-after", "--signal"]), operands: 1 }],
  ["stdbuf", { valued: new Set(["-e", "-i", "-o", "--error", "--input", "--output"]) }],
  ["exec", { valued: new Set(["-a"]) }],
  ["command", { valued: NONE, lookup: new Set(["-V", "-v"]) }],
  ["time", { valued: new Set(["-f", "-o", "--format", "--output"]) }],
  ["nohup", { valued: NONE }]
]);
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
function readOption(words, at, wrapper) {
  const word = words[at];
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    const name = eq === -1 ? word : word.slice(0, eq);
    if (!wrapper.valued.has(name))
      return null;
    return eq === -1 ? { name, value: words[at + 1], span: 2 } : { name, value: word.slice(eq + 1), span: 1 };
  }
  for (let j = 1;j < word.length; j++) {
    const name = `-${word[j]}`;
    if (wrapper.lookup?.has(name))
      return "lookup";
    if (!wrapper.valued.has(name))
      continue;
    const attached = word.slice(j + 1);
    return attached ? { name, value: attached, span: 1 } : { name, value: words[at + 1], span: 2 };
  }
  return null;
}
function commandWords(input) {
  const words = [...input];
  const directories = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (ASSIGNMENT.test(word) || word === "--") {
      i++;
      continue;
    }
    const wrapper = WRAPPERS.get(word.slice(word.lastIndexOf("/") + 1));
    if (wrapper === undefined)
      break;
    i++;
    while (i < words.length) {
      const option = words[i];
      if (option === "--") {
        i++;
        break;
      }
      if (wrapper.assignments && ASSIGNMENT.test(option)) {
        i++;
        continue;
      }
      if (!option.startsWith("-"))
        break;
      const read = readOption(words, i, wrapper);
      if (read === "lookup")
        return { argv: [], directories };
      if (read === null) {
        i++;
        continue;
      }
      if (read.value === undefined)
        return { argv: [], directories };
      if (wrapper.split?.has(read.name)) {
        words.splice(i, read.span, ...tokenizeShell(read.value).map((token) => token.value));
        continue;
      }
      if (wrapper.chdir?.has(read.name))
        directories.push(read.value);
      i += read.span;
    }
    i += Math.min(wrapper.operands ?? 0, words.length - i);
  }
  return { argv: words.slice(i), directories };
}

// extensions/tool-targets.ts
var EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);
var HASHLINE_HEADER = /^\s*\[(?<path>[^#\r\n]+)#[0-9a-fA-F]{4}\]\s*$/;
var HASHLINE_MOVE = /^\s*MV\s+(?<path>.+?)\s*$/;
var PATCH_HEADER = /^\*\*\* (?:(?:Add|Update|Delete|Edit) File|Move to):\s*(?<path>.+?)\s*$/;
function unquote(path) {
  const first = path[0];
  if (path.length > 1 && (first === '"' || first === "'") && path.endsWith(first))
    return path.slice(1, -1);
  return path;
}
function patchPaths(payload) {
  const out = [];
  let inHashline = false;
  for (const raw of payload.split(`
`)) {
    const line = raw.replace(/\r$/, "");
    const header = HASHLINE_HEADER.exec(line)?.groups?.path;
    if (header !== undefined) {
      inHashline = true;
      out.push(unquote(header.trim()));
      continue;
    }
    const patch = PATCH_HEADER.exec(line)?.groups?.path;
    if (patch !== undefined) {
      inHashline = false;
      out.push(unquote(patch));
      continue;
    }
    if (!inHashline || line.startsWith("+"))
      continue;
    const move = HASHLINE_MOVE.exec(line)?.groups?.path;
    if (move !== undefined)
      out.push(unquote(move));
  }
  return out.filter((path) => path.length > 0);
}
function targetPaths(input) {
  const fields = input;
  const out = [];
  for (const key of ["path", "file_path", "_path"]) {
    const value = fields[key];
    if (typeof value === "string" && value)
      out.push(value);
  }
  if (Array.isArray(fields.paths)) {
    for (const value of fields.paths)
      if (typeof value === "string" && value)
        out.push(value);
  }
  if (Array.isArray(fields.edits)) {
    for (const entry of fields.edits) {
      const rename = entry?.rename;
      if (typeof rename === "string" && rename)
        out.push(rename);
    }
  }
  for (const key of ["input", "_input"]) {
    const value = fields[key];
    if (typeof value === "string" && value)
      out.push(...patchPaths(value));
  }
  return [...new Set(out)];
}

// extensions/report-only-gate.ts
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
var SHELLS = { bash: true, sh: true, zsh: true, dash: true, ksh: true };
var PACKAGE_RUNNERS = new Set(["npx", "bunx"]);
var PACKAGE_RUNNER_VALUE_FLAGS = new Set(["-p", "--package"]);
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
var NPM_INSTALL = new Set([
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "install",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "it",
  "install-test",
  "cit",
  "install-ci-test",
  "update",
  "up",
  "upgrade",
  "udpate"
]);
var MUTATING = new Map([
  ["npm", NPM_INSTALL],
  ["pnpm", new Set(["i", "install", "add", "update", "up", "upgrade", "it", "install-test"])],
  ["bun", new Set(["i", "install", "add", "update", "up", "upgrade"])],
  ["yarn", new Set(["install", "add", "up", "upgrade", "upgrade-interactive", "update"])],
  ["pip", new Set(["install"])],
  ["uv", new Set(["add", "sync"])],
  ["poetry", new Set(["add", "update", "install"])],
  ["cargo", new Set(["add", "install", "update"])],
  ["go", new Set(["get"])],
  ["bundle", new Set(["install", "update", "add"])],
  ["bundler", new Set(["install", "update", "add"])],
  ["gem", new Set(["install", "update"])],
  ["composer", new Set(["require", "update", "upgrade", "install"])]
]);
var RUNNERS = new Map([
  ["npm", new Set(["exec", "x"])],
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx", "exec"])],
  ["bun", new Set(["x"])]
]);
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
function packageRunnerCommand(args) {
  let i = 0;
  while (args[i]?.startsWith("-"))
    i += PACKAGE_RUNNER_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  return args.slice(i);
}
function simpleCommandMutates(words, depth) {
  if (depth > MAX_DEPTH)
    return true;
  const [first, ...rest] = commandWords(words).argv;
  if (first === undefined)
    return false;
  const name = first.slice(first.lastIndexOf("/") + 1).toLowerCase();
  if (PACKAGE_RUNNERS.has(name))
    return simpleCommandMutates(packageRunnerCommand(rest), depth + 1);
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
  const table = MUTATING.get(pm);
  if (table === undefined)
    return false;
  const [sub, at] = subcommand(rest);
  const after = rest.slice(at + 1);
  if (sub === undefined)
    return pm === "yarn" && !rest.some((arg) => arg === "--version" || arg === "-v");
  if (RUNNERS.get(pm)?.has(sub))
    return simpleCommandMutates(after, depth + 1);
  if (pm === "uv" && sub === "pip") {
    const [inner] = subcommand(after);
    return inner === "install" || inner === "sync";
  }
  if (pm === "uv" && sub === "lock") {
    return after.some((arg) => arg === "-U" || arg === "--upgrade" || arg === "-P" || arg.startsWith("--upgrade-package"));
  }
  return table.has(sub);
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
  if (EDIT_TOOLS.has(toolName)) {
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
  isDependencyFile
};
