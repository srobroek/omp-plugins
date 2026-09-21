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
import { readFileSync } from "fs";
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
  for (;start < tokens.length; start++) {
    const token = tokens[start];
    if (!token || token.quoted)
      return null;
    const basename = token.value.split("/").pop() ?? token.value;
    if (basename === head)
      break;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) && !token.value.startsWith("-") && WRAPPERS[basename] !== true)
      return null;
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
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
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
function settingValue(root, plugin, gate) {
  const plugins = root.plugins;
  if (!plugins || typeof plugins !== "object")
    return;
  const config = plugins[plugin];
  if (!config || typeof config !== "object")
    return;
  const gates = config.gates;
  if (!gates || typeof gates !== "object")
    return;
  const selected = gates[gate];
  return selected && typeof selected === "object" ? selected.enabled : undefined;
}
function settingsEnabled(plugin, gate, cwd = process.cwd()) {
  const now = Date.now();
  const cached = settingsCache.get(cwd);
  let merged = {};
  if (cached && now - cached.at < 500)
    merged = cached.value;
  else {
    const files = [resolve(cwd, ".omp/config.yml"), resolve(cwd, ".omp/settings.json"), resolve(process.env.HOME ?? "~", ".omp/agent/settings.json")];
    for (const file of files) {
      try {
        const text = readFileSync(file, "utf8");
        const parsed = file.endsWith(".json") ? JSON.parse(text) : Bun.YAML?.parse(text);
        if (parsed && typeof parsed === "object")
          merged = { ...merged, ...parsed };
      } catch {}
    }
    settingsCache.set(cwd, { at: now, value: merged });
  }
  return settingValue(merged, plugin, gate) !== false;
}
function blockReason(input) {
  const plugin = input.plugin ?? "beads";
  return `${input.cause}; ${input.resolution}. Disable locally: set plugins.${plugin}.gates.${input.gate}.enabled=false`;
}
// extensions/bd-close-gate.ts
var TIMEOUT_MS = 1e4;
var injectedRun = null;
function tokenize2(command) {
  return tokenizeShell(command).map(({ value }) => value);
}
function denyReason(gateIds) {
  return `blocked by beads (a gate bead is resolved, never closed): ${gateIds.join(", ")} ` + "is a gate. `bd close` on it flips status to closed and does unblock the waiting " + "bead, so nothing fails loudly -- but no gate resolution happens. A `human` gate " + "loses the decision it stood for, and a `timer`/`gh:run`/`gh:pr`/`bead` gate is " + "asserted satisfied without anything evaluating it. Run `bd gate check` to have the " + "conditions evaluated, or `bd gate resolve <gate-id>` for the manual human answer; " + "then `bd close <step-id> --reason ...` on the step the gate blocked. `--force` does " + "not lift this guard: it forces the same unrecorded close.";
}
async function asyncShowRun(argv, cwd) {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BD_JSON_ENVELOPE: "1", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" }
  });
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`bd show lookup timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });
    const result = await Promise.race([
      Promise.all([proc.exited, new Response(proc.stdout).text()]),
      timeout
    ]);
    return { exitCode: result[0], stdout: result[1] };
  } finally {
    if (timer !== undefined)
      clearTimeout(timer);
  }
}
async function gateIdsAmongAsync(ids, dbArgs, cwd) {
  if (ids.length === 0)
    return [];
  const run = injectedRun === null ? asyncShowRun : async (argv, dir) => injectedRun?.(argv, dir) ?? asyncShowRun(argv, dir);
  const result = await run(["bd", ...dbArgs, "show", ...ids, "--json"], cwd);
  if (result.exitCode !== 0)
    return [];
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("bd show returned unreadable JSON; gate types remain unverified");
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "schema_version" in parsed && "data" in parsed)
    parsed = parsed.data;
  if (!Array.isArray(parsed))
    throw new Error("bd show returned no issue array; gate types remain unverified");
  const gates = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object")
      throw new Error("bd show returned malformed issues; gate types remain unverified");
    const issue = row;
    if (typeof issue.id !== "string" || typeof issue.issue_type !== "string")
      throw new Error("bd show omitted issue identity or type; gate types remain unverified");
    if (issue.issue_type === "gate")
      gates.push(issue.id);
  }
  return gates;
}
async function decideBdCloseParsed(parsed, cwd = process.cwd()) {
  for (const position of parsed.commands) {
    const invocations = closeInvocations(position.raw);
    if (invocations.length === 0)
      continue;
    const gates = new Set;
    for (const invocation of invocations) {
      for (const id of await gateIdsAmongAsync(invocation.ids, invocation.dbArgs, cwd))
        gates.add(id);
    }
    if (gates.size > 0)
      return { block: true, reason: denyReason([...gates]) };
  }
  for (const child of parsed.nested) {
    const decision = await decideBdCloseParsed(child, cwd);
    if (decision)
      return decision;
  }
  return;
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
function commandSegments2(command) {
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
  for (const tokens of commandSegments2(command)) {
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
var CLAIM_REASON = "bd claim / `bd update <id> --claim` without BEADS_ACTOR or BD_ACTOR creates undistinguishable dead claims. Set either variable to <harness>/<agent-name>/<session-id> and retry.";
var CREATING_VERBS = {
  create: true,
  "create-form": true,
  new: true
};
var CREATE_REASON = "bd create / `bd new` / `bd create-form` without BEADS_ACTOR or BD_ACTOR silently sets Owner to the invoking human's git identity. There is no --owner flag, and --assignee sets a different field, so the mis-attribution is permanent. Set either variable to <harness>/<agent-name>/<session-id> and retry.";
var ADVISORY_TEXT = "BEADS_ACTOR and BD_ACTOR are unset on this mutating `bd` command. Subagents must set either variable so writes and claims are attributable. Export one before mutating work.";
function decideActorParsed(parsed, env = process.env) {
  let advisory = false;
  for (const segment of parsed.segments) {
    const decision = decideActorGate(segment.join(" "), env);
    if (decision.kind === "block")
      return decision;
    if (decision.kind === "advisory")
      advisory = true;
  }
  for (const child of parsed.nested) {
    const decision = decideActorParsed(child, env);
    if (decision.kind === "block")
      return decision;
    if (decision.kind === "advisory")
      advisory = true;
  }
  return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" };
}
function decideActorGate(command, env = process.env) {
  let advisory = false;
  for (const invocation of bdInvocations(command)) {
    if (!isMutatingInvocation(invocation) || invocationActor(invocation, env) !== null) {
      continue;
    }
    const { verb, args } = invocation;
    const claim = verb === "claim" || (verb === "update" || verb === "ready") && args.includes("--claim");
    if (claim)
      return { kind: "block", reason: CLAIM_REASON };
    if (CREATING_VERBS[verb] === true)
      return { kind: "block", reason: CREATE_REASON };
    advisory = true;
  }
  return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" };
}

// extensions/bd-embedded-write-lock.ts
import { closeSync, existsSync, openSync, readFileSync as readFileSync2, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
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
var BEAD_ID2 = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
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
    return subaction === undefined || !BEAD_ID2.test(subaction);
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
    metadata = readFileSync2(join(store, "metadata.json"), "utf8");
  } catch {}
  try {
    config = readFileSync2(join(store, "config.yaml"), "utf8");
  } catch {}
  return metadata !== "" || config !== "";
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
    raw = readFileSync2(lock, "utf8");
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
    const holder = JSON.parse(readFileSync2(lock, "utf8"));
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
var activeHolds = new Map;
var surrenderedCalls = new Set;
function beginEmbeddedWrite(toolCallId) {
  surrenderedCalls.delete(toolCallId);
}
function surrender(toolCallId) {
  surrenderedCalls.add(toolCallId);
  const holds = activeHolds.get(toolCallId);
  if (holds === undefined)
    return;
  activeHolds.delete(toolCallId);
  for (const hold of holds) {
    hold.released = true;
    if (hold.held) {
      release(hold.store, toolCallId);
      hold.held = false;
    }
  }
}
async function decideEmbeddedWrite(parsed, event, ctx) {
  try {
    if (event.toolName !== "bash")
      return;
    if (surrenderedCalls.delete(event.toolCallId))
      return;
    const input = event.input;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ctx?.cwd ?? process.cwd();
    const env = environmentForInput(event.input);
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
      const result = embeddedWriteTargets(source, cwd, env);
      if (result.kind === "refused")
        return { block: true, reason: result.reason };
      targets.push(...result.stores);
    }
    const unique = [...new Set(targets)];
    if (unique.length === 0)
      return;
    const pending = unique.map((store) => ({ store, held: false, released: false }));
    const existing = activeHolds.get(event.toolCallId);
    activeHolds.set(event.toolCallId, existing === undefined ? pending : [...existing, ...pending]);
    for (const current of pending) {
      const got = await hold(current.store, event.toolCallId);
      if (got.kind === "failed") {
        for (const pendingHold of pending) {
          pendingHold.released = true;
          if (pendingHold.held) {
            release(pendingHold.store, event.toolCallId);
            pendingHold.held = false;
          }
        }
        const active = activeHolds.get(event.toolCallId);
        if (active !== undefined) {
          const remaining = active.filter((activeHold) => !pending.includes(activeHold));
          if (remaining.length === 0)
            activeHolds.delete(event.toolCallId);
          else
            activeHolds.set(event.toolCallId, remaining);
        }
        return { block: true, reason: got.reason };
      }
      current.held = true;
      if (current.released) {
        release(current.store, event.toolCallId);
        current.held = false;
      }
    }
    ctx?.setTimeout?.(() => surrender(event.toolCallId), LEASE_MS);
  } catch {
    return { block: true, reason: "embedded write target could not be resolved" };
  }
  return;
}

// extensions/bd-init-advisory.ts
import path from "path";
var PRE_VERB_VALUE_FLAGS = {
  "-C": true,
  "--db": true,
  "--directory": true
};
var VALUE_FLAGS3 = { "--prefix": true };
var ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
var HELP_FLAGS = { "--help": true, "-h": true };
var SEPARATOR = { ";": true, "&": true, "|": true, "(": true, ")": true, "$(": true, "\n": true };
var WRAPPERS2 = {
  command: {},
  exec: { "-a": true },
  nohup: {},
  chronic: {},
  unbuffer: {},
  caffeinate: { "-t": true, "-w": true },
  stdbuf: { "-i": true, "-o": true, "-e": true },
  nice: { "-n": true, "--adjustment": true },
  time: { "-f": true, "--format": true, "-o": true, "--output": true },
  timeout: { "-k": true, "--kill-after": true, "-s": true, "--signal": true },
  doas: { "-u": true, "-C": true },
  sudo: { "-u": true, "-g": true, "-C": true, "-D": true, "-h": true, "-p": true, "-r": true, "-t": true, "-T": true, "-U": true },
  env: { "-u": true, "--unset": true, "-C": true, "--chdir": true, "-S": true, "--split-string": true },
  mise: {}
};
var POSITIONAL_BEFORE_COMMAND = { timeout: 1 };
var SHELLS = { sh: true, bash: true, zsh: true, dash: true, ksh: true };
var PREFILTER = /\bbd\b/;
function followCd(current, target) {
  if (target === undefined || target === "~")
    return process.env.HOME;
  if (target === "-" || target.includes("$") || target.startsWith("~"))
    return;
  if (path.isAbsolute(target))
    return path.normalize(target);
  if (current === undefined)
    return;
  return path.resolve(current, target);
}
function findInitInvocations(command, cwd = undefined) {
  const out = [];
  const tokens = tokenize2(command);
  let shellCwd = cwd;
  let i = 0;
  while (i < tokens.length) {
    while (i < tokens.length && SEPARATOR[tokens[i]] === true)
      i++;
    if (i >= tokens.length)
      break;
    const segmentEnd = (() => {
      let k = i;
      while (k < tokens.length && SEPARATOR[tokens[k]] !== true)
        k++;
      return k;
    })();
    const segment = tokens.slice(i, segmentEnd);
    i = segmentEnd;
    const env = {};
    let cleared = false;
    let segmentCwd = shellCwd;
    let unresolved;
    let k = 0;
    while (k < segment.length) {
      const word = segment[k];
      const assignment = ENV_ASSIGNMENT.exec(word);
      if (assignment !== null) {
        env[assignment[1]] = assignment[2];
        k++;
        continue;
      }
      const basename = word.split("/").pop() ?? word;
      if (basename === "cd") {
        shellCwd = followCd(shellCwd, segment[k + 1]);
        k = segment.length;
        break;
      }
      if (SHELLS[basename] === true) {
        let m = k + 1;
        while (m < segment.length && segment[m].startsWith("-") && !/^-[A-Za-z]*c$/.test(segment[m]))
          m++;
        if (m < segment.length && /^-[A-Za-z]*c$/.test(segment[m]) && typeof segment[m + 1] === "string") {
          const inner = segment[m + 1];
          if (inner.includes("$"))
            unresolved = true;
          for (const nested of findInitInvocations(inner, segmentCwd)) {
            nested.env = { ...env, ...nested.env };
            nested.cleared = cleared || nested.cleared;
            if (unresolved)
              nested.unresolved = true;
            out.push(nested);
          }
        }
        k = segment.length;
        break;
      }
      const valueFlags = WRAPPERS2[basename];
      if (valueFlags === undefined)
        break;
      if (basename === "mise") {
        const dash = segment.indexOf("--", k);
        if (dash === -1) {
          unresolved = true;
          k = segment.length;
          break;
        }
        k = dash + 1;
        continue;
      }
      k++;
      let positionals = POSITIONAL_BEFORE_COMMAND[basename] ?? 0;
      while (k < segment.length) {
        const opt = segment[k];
        if (opt === "--") {
          k++;
          break;
        }
        if (opt.startsWith("-") && opt.length > 1) {
          const eq = opt.indexOf("=");
          const name = eq === -1 ? opt : opt.slice(0, eq);
          const value = eq === -1 ? valueFlags[name] === true ? segment[++k] : undefined : opt.slice(eq + 1);
          if (basename === "env") {
            if (name === "-i")
              cleared = true;
            if ((name === "-u" || name === "--unset") && value !== undefined)
              env[value] = undefined;
            if ((name === "-C" || name === "--chdir") && value !== undefined)
              segmentCwd = followCd(segmentCwd, value);
            if (name === "-S" || name === "--split-string")
              unresolved = true;
          }
          if (basename === "sudo" && name === "-D" && value !== undefined)
            segmentCwd = followCd(segmentCwd, value);
          k++;
          continue;
        }
        const assign = ENV_ASSIGNMENT.exec(opt);
        if (assign !== null && (basename === "env" || basename === "sudo")) {
          env[assign[1]] = assign[2];
          k++;
          continue;
        }
        if (positionals > 0) {
          positionals--;
          k++;
          continue;
        }
        break;
      }
    }
    const word = segment[k];
    if (word === undefined || (word.split("/").pop() ?? word) !== "bd") {
      const mentionsInit = segment.some((token) => (token.split("/").pop() ?? token) === "bd" || /\bbd\b/.test(token)) && segment.some((token) => /\binit\b/.test(token));
      if (unresolved && mentionsInit)
        out.push({ flags: [], env, cleared, unresolved: true });
      continue;
    }
    const flags = [];
    let verb = null;
    let prefix;
    let dir;
    for (let j = k + 1;j < segment.length; j++) {
      const arg = segment[j];
      if (arg.startsWith("-") && arg !== "-") {
        const eq = arg.indexOf("=");
        const name = eq === -1 ? arg : arg.slice(0, eq);
        flags.push(name);
        const takesValue = VALUE_FLAGS3[name] === true || verb === null && PRE_VERB_VALUE_FLAGS[name] === true;
        let value;
        if (eq !== -1)
          value = arg.slice(eq + 1);
        else if (takesValue && j + 1 < segment.length)
          value = segment[++j];
        if (name === "--prefix")
          prefix = value;
        if (name === "-C" || name === "--directory")
          dir = value;
        continue;
      }
      if (verb === null)
        verb = arg.toLowerCase();
    }
    if (verb !== "init")
      continue;
    const invocation = { flags, env, cleared };
    if (prefix !== undefined)
      invocation.prefix = prefix;
    if (dir !== undefined)
      invocation.dir = dir;
    if (segmentCwd !== undefined)
      invocation.cwd = segmentCwd;
    if (unresolved)
      invocation.unresolved = true;
    out.push(invocation);
  }
  return out;
}
function missingInitFlags(flags) {
  if (flags.some((flag) => HELP_FLAGS[flag] === true))
    return;
  if (flags.includes("--skip-hooks"))
    return;
  return { skipHooks: true };
}
var BEADS_DIR_ADVICE = "The beads plugin pins `BEADS_DIR` for this session: the checkout's `.beads` " + "(a linked worktree resolves to the primary checkout's) is placed on Bash " + "calls in the same repository family. Calls whose working directory belongs " + "to another repository remain unpinned. A `BEADS_DIR` exported before omp " + "started is kept within the session repository. Verify with `printenv " + "BEADS_DIR`; an absolute path means the pin is in place. Do not ask the human " + "to export it or restart omp, and do not pass it on calls yourself. Unpinned, " + "a read from a directory with no `.beads/` reports `No active beads workspace " + "found`, and a copied checkout can resolve a personal database instead " + "(`$HOME/.beads` exists on this machine).";
var SKIP_HOOKS_ADVICE = "`--skip-hooks` wherever hooks are already managed: plain `bd init` repoints " + "`core.hooksPath` and copies ~349MB of hooks, which is broken on arm64.";
function initAdvisory(_missing) {
  return `bd init advisory \u2014 nothing was blocked, and this speaks once per session. ` + `This \`bd init\` omits \`--skip-hooks\`. ${SKIP_HOOKS_ADVICE} ${BEADS_DIR_ADVICE} ` + `The full form is \`bd init --init-if-missing --skip-hooks\` ` + `(rule://beads-setup). Both the flag and the pin are contextual, so decide ` + `rather than re-run blind: an already-initialised repository or hooks the ` + `project deliberately owns can each make the plainer form the right call.`;
}
function decideBdInit(command) {
  if (!PREFILTER.test(command))
    return;
  for (const invocation of findInitInvocations(command)) {
    if (invocation.unresolved)
      continue;
    const missing = missingInitFlags(invocation.flags);
    if (missing !== undefined)
      return initAdvisory(missing);
  }
  return;
}
function decideBdInitParsed(parsed) {
  for (const position of parsed.commands) {
    const advisory = decideBdInit(position.raw);
    if (advisory)
      return advisory;
  }
  for (const child of parsed.nested) {
    const advisory = decideBdInitParsed(child);
    if (advisory)
      return advisory;
  }
  return;
}
var ADVISED_KEY = Symbol.for("com.srobroek.beads.init-advisory.sent");

// extensions/bd-lease-gate.ts
var PREFILTER2 = /\bbd\b[\s\S]{0,400}?--claim\b/;
var pendingClaims = new Map;
function decideLeaseClaim(parsed, event, ctx) {
  try {
    if (event.toolName !== "bash")
      return;
    const command = parsed.command;
    if (!command || !PREFILTER2.test(command))
      return;
    const input = event.input;
    const sessionCwd = ctx?.cwd ?? process.cwd();
    const inputCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : sessionCwd;
    pendingClaims.set(event.toolCallId, { cwd: leadingCdCwd(command, inputCwd), env: environmentForInput(event.input) });
  } catch {}
}

// extensions/pr-bead-link-gate.ts
import { execFileSync as execFileSync2 } from "child_process";
import { existsSync as existsSync2, statSync as statSync3 } from "fs";
import { dirname, join as join2, resolve as resolve4 } from "path";
var MAX_COMMAND_LENGTH = 64000;
var BEAD_REF = /(?:^|\s)(?:Bead|Closes-Bead|Bead-Id):\s*[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+/i;
var GH_TIMEOUT_MS = 1e4;
var VALUE_FLAGS4 = {
  "--title": true,
  "-t": true,
  "--base": true,
  "-B": true,
  "--head": true,
  "-H": true,
  "--repo": true,
  "-R": true,
  "--reviewer": true,
  "-r": true,
  "--assignee": true,
  "-a": true,
  "--label": true,
  "-l": true,
  "--project": true,
  "-p": true,
  "--milestone": true,
  "-m": true,
  "--body-file": true,
  "-F": true,
  "--template": true,
  "-T": true
};
var REASON = "This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer. To opt out, retire the nearest ledger with this gate's regular-file .beads/RETIRED marker; No-Bead: is not accepted.";
function beadsActive(dir) {
  let current = resolve4(dir);
  for (;; ) {
    const beads = join2(current, ".beads");
    if (existsSync2(beads)) {
      try {
        return !statSync3(join2(beads, "RETIRED")).isFile();
      } catch {
        return true;
      }
    }
    const parent = dirname(current);
    if (parent === current)
      return false;
    current = parent;
  }
}
function bodyOfGhCreate(segment) {
  const tokens = invocation(segment, ["gh", "pr", "create"]);
  if (!tokens)
    return null;
  let body = null;
  for (let i = 3;i < tokens.length; i++) {
    const token = tokens[i];
    if (!token)
      continue;
    if (!token.quoted && token.value === "--")
      break;
    if (token.quoted)
      continue;
    if (VALUE_FLAGS4[token.value]) {
      i++;
      continue;
    }
    if (token.value === "--body" || token.value === "-b") {
      body = tokens[i + 1]?.value ?? "";
      i++;
      continue;
    }
    if (token.value.startsWith("--body=")) {
      body = token.value.slice("--body=".length);
      continue;
    }
    const cluster = /^-([A-Za-z]*)b(=?)(.*)$/.exec(token.value);
    if (cluster && !token.value.startsWith("--")) {
      const attached = cluster[3] ?? "";
      body = attached.length > 0 || cluster[2] === "=" ? attached : tokens[++i]?.value ?? "";
    }
  }
  return body;
}
function decidePrCreate(body, active) {
  if (active === false || typeof active !== "boolean" && active.kind === "uncontrolled")
    return null;
  if (body === null)
    return null;
  if (BEAD_REF.test(body))
    return null;
  if (typeof active !== "boolean" && active.kind === "unknown") {
    return {
      block: true,
      reason: `${active.reason}. This PR must name a bead while repository control is unknown.`
    };
  }
  return { block: true, reason: REASON };
}
function decideCommand(command, active) {
  if (command.length > MAX_COMMAND_LENGTH)
    return null;
  for (const segment of commandSegments(command)) {
    const body = bodyOfGhCreate(segment);
    if (body === null || BEAD_REF.test(body))
      continue;
    const decision = decidePrCreate(body, typeof active === "function" ? active(segment) : active);
    if (decision)
      return decision;
  }
  return null;
}
function controlledByViewerPermission(permission) {
  return permission === "WRITE" || permission === "MAINTAIN" || permission === "ADMIN";
}
function repositoryFromGhCreate(command) {
  const tokens = invocation(command, ["gh", "pr", "create"]);
  if (!tokens)
    return null;
  let selected = null;
  for (let i = 3;i < tokens.length; i += 1) {
    const token = tokens[i];
    const value = token.value;
    if (value === "--repo" || value === "-R") {
      const next = tokens[++i];
      selected = next?.value ?? null;
    } else if (value.startsWith("--repo=")) {
      selected = value.slice(7);
    } else if (value.startsWith("-R") && value.length > 2) {
      selected = value.slice(2);
    } else if (/^-[A-Za-z]*R.+$/.test(value) && value.length > 3) {
      selected = value.slice(value.indexOf("R") + 1);
    } else if (value.startsWith("-") && VALUE_FLAGS4[value] === true) {
      i += 1;
    }
  }
  return selected && /^(?:[^/\s]+\/)?[^/\s]+\/[^/\s]+$/.test(selected) ? selected : null;
}
function repositoryFromView(view) {
  if (typeof view.nameWithOwner !== "string")
    return null;
  if (view.isFork === true)
    return typeof view.parent?.nameWithOwner === "string" ? view.parent.nameWithOwner : null;
  if (view.isFork === false)
    return view.nameWithOwner;
  return null;
}
function repositoryFromCurrentCheckout(cwd) {
  try {
    const raw = execFileSync2("gh", ["repo", "view", "--json", "nameWithOwner,isFork,parent"], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return repositoryFromView(JSON.parse(raw));
  } catch {
    return null;
  }
}
function repositoryControlled(repo) {
  if (!repo)
    return { kind: "unknown", reason: "Repository permission could not be determined because the repository could not be identified" };
  try {
    const permission = execFileSync2("gh", ["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"], {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return controlledByViewerPermission(permission) ? { kind: "controlled" } : { kind: "uncontrolled" };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return { kind: "unknown", reason: `Repository permission could not be determined: ${failure}` };
  }
}
function decideCommandParsed(parsed, active) {
  for (const segment of parsed.segments) {
    const decision = decideCommand(segment.join(" "), active);
    if (decision)
      return decision;
  }
  for (const child of parsed.nested) {
    const decision = decideCommandParsed(child, active);
    if (decision)
      return decision;
  }
  return null;
}

// extensions/session-beads-lifecycle.ts
import { isAbsolute as isAbsolute3, join as join3, resolve as resolve5 } from "path";
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
  return typeof cwd === "string" && cwd !== "" ? resolve5(fallback, cwd) : fallback;
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

// extensions/bash-gates.ts
function inputOf(event, ctx) {
  const input = event.input;
  return {
    command: commandFromInput(input),
    cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : ctx?.cwd ?? process.cwd()
  };
}
function suffix(gate, reason, resolution = "inspect the command and retry") {
  return { block: true, reason: blockReason({ gate, cause: reason, resolution }) };
}
async function decide(parsed, event, ctx, pi) {
  const { cwd } = inputOf(event, ctx);
  if (parsed.unknown)
    return suffix("bash-gates", "command could not be parsed", "split the command or run the mutation as a plain single command");
  const env = environmentForInput(event.input);
  if (settingsEnabled("beads", "bd-actor-gate", cwd)) {
    const actor = decideActorParsed(parsed, env);
    if (actor.kind === "block")
      return suffix("bd-actor-gate", actor.reason);
    if (actor.kind === "advisory" && typeof pi.sendMessage === "function")
      pi.sendMessage({ customType: "beads-bd-actor-advisory", content: actor.text, display: true, attribution: "user" }, { triggerTurn: false });
  }
  if (settingsEnabled("beads", "bd-close-gate", cwd)) {
    const close = await decideBdCloseParsed(parsed, cwd);
    if (close)
      return suffix("bd-close-gate", close.reason);
  }
  if (settingsEnabled("beads", "bd-init-advisory", cwd)) {
    const advisory = decideBdInitParsed(parsed);
    if (advisory && typeof pi.sendMessage === "function")
      pi.sendMessage({ customType: "beads-bd-init-advisory", content: advisory, display: true, attribution: "user" }, { triggerTurn: false });
  }
  if (settingsEnabled("beads", "bd-lease-gate", cwd))
    await decideLeaseClaim(parsed, event, ctx);
  if (settingsEnabled("beads", "bd-embedded-write-lock", cwd)) {
    const embedded = await decideEmbeddedWrite(parsed, event, ctx);
    if (embedded)
      return suffix("bd-embedded-write-lock", embedded.reason);
  }
  if (settingsEnabled("beads", "pr-bead-link-gate", cwd)) {
    const pr = decideCommandParsed(parsed, (segment) => beadsActive(cwd) && repositoryControlled(repositoryFromGhCreate(segment) ?? repositoryFromCurrentCheckout(cwd)));
    if (pr)
      return suffix("pr-bead-link-gate", pr.reason);
  }
  const rewritten = rewriteBashInput(event.input, ctx);
  if (rewritten && JSON.stringify(rewritten) !== JSON.stringify(event.input))
    return { input: rewritten };
  return;
}
function bashGates(pi) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (event.toolName !== "bash")
        return;
      const { command } = inputOf(event, ctx);
      if (!command)
        return;
      beginEmbeddedWrite(event.toolCallId);
      return await decide(parse(command), event, ctx, pi);
    } catch (error) {
      return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`, "split the command or run the mutation as a plain single command");
    }
  });
}
export {
  bashGates as default
};
