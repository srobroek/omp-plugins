// @bun
// extensions/bash-gates.ts
import { resolve as resolve6 } from "path";

// extensions/bd-actor-gate.ts
import { basename, relative, resolve as resolve2, sep } from "path";

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
var TIMEOUT_MS = 25000;
var injectedRun = null;
function timeoutError() {
  return new Error("bd show lookup timed out; gate types remain unverified");
}
function tokenize2(command) {
  return tokenizeShell(command).map(({ value }) => value);
}
function denyReason(gateIds) {
  return `blocked by beads (a gate bead is resolved, never closed): ${gateIds.join(", ")} ` + "is a gate. `bd close` on it flips status to closed and does unblock the waiting " + "bead, so nothing fails loudly -- but no gate resolution happens. A `human` gate " + "loses the decision it stood for, and a `timer`/`gh:run`/`gh:pr`/`bead` gate is " + "asserted satisfied without anything evaluating it. Run `bd gate check` to have the " + "conditions evaluated, or `bd gate resolve <gate-id>` for the manual human answer; " + "then `bd close <step-id> --reason ...` on the step the gate blocked. `--force` does " + "not lift this guard: it forces the same unrecorded close.";
}
async function asyncShowRun(argv, cwd, deadline = Date.now() + TIMEOUT_MS) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw timeoutError();
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
        reject(timeoutError());
      }, remaining);
    });
    const result = await Promise.race([
      Promise.all([proc.exited, new Response(proc.stdout).text()]),
      timeout
    ]);
    if (Date.now() >= deadline)
      throw timeoutError();
    return { exitCode: result[0], stdout: result[1] };
  } finally {
    if (timer !== undefined)
      clearTimeout(timer);
  }
}
async function gateIdsAmongAsync(ids, dbArgs, cwd, deadline) {
  if (ids.length === 0)
    return [];
  if (Date.now() >= deadline)
    throw timeoutError();
  const run = injectedRun === null ? asyncShowRun : async (argv, dir, limit) => injectedRun?.(argv, dir, limit) ?? asyncShowRun(argv, dir, limit);
  const result = await run(["bd", ...dbArgs, "show", ...ids, "--json"], cwd, deadline);
  if (Date.now() >= deadline)
    throw timeoutError();
  if (result.exitCode !== 0)
    throw new Error(`bd show lookup failed with exit code ${result.exitCode}; gate types remain unverified`);
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
async function decideBdCloseParsed(parsed, cwd = process.cwd(), deadline) {
  const sharedDeadline = deadline ?? Date.now() + TIMEOUT_MS;
  for (const position of parsed.commands) {
    const invocations = closeInvocations(position.raw);
    if (invocations.length === 0)
      continue;
    const gates = new Set;
    for (const invocation of invocations) {
      for (const id of await gateIdsAmongAsync(invocation.ids, invocation.dbArgs, cwd, sharedDeadline))
        gates.add(id);
    }
    if (gates.size > 0)
      return { block: true, reason: denyReason([...gates]) };
  }
  for (const child of parsed.nested) {
    const decision = await decideBdCloseParsed(child, cwd, sharedDeadline);
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
var CONTROL_PREFIXES = {
  "!": true,
  if: true,
  elif: true,
  else: true,
  while: true,
  until: true,
  do: true
};
var TRANSPARENT_WRAPPERS = { command: true, env: true, sudo: true, time: true };
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
    const unset = {};
    while (true) {
      while (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "")) {
        prefix.push(tokens[i]);
        i++;
      }
      const word = (tokens[i] ?? "").split("/").pop() ?? "";
      if (CONTROL_PREFIXES[word] === true) {
        i++;
        continue;
      }
      if (TRANSPARENT_WRAPPERS[word] !== true)
        break;
      i++;
      if (word === "command")
        continue;
      while (true) {
        while (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "")) {
          prefix.push(tokens[i]);
          i++;
        }
        const flag = tokens[i];
        if (flag === undefined || !flag.startsWith("-"))
          break;
        if (word === "env") {
          if (flag === "--") {
            i++;
            break;
          }
          if (flag === "-i" || flag === "--ignore-environment") {
            unset.BEADS_ACTOR = true;
            unset.BD_ACTOR = true;
            i++;
            continue;
          }
          const unsetName = flag === "-u" || flag === "--unset" ? tokens[i + 1] : flag.startsWith("--unset=") ? flag.slice("--unset=".length) : flag.startsWith("-u") && flag.length > 2 ? flag.slice(2) : undefined;
          if (unsetName === "BEADS_ACTOR" || unsetName === "BD_ACTOR")
            unset[unsetName] = true;
          if (flag === "-u" || flag === "--unset")
            i += 2;
          else
            i++;
          continue;
        }
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
      out.push({ verb: verb.toLowerCase(), args: tokens.slice(scanned.next + 1), globals: scanned.globals, prefix, exported: { ...exported }, unset });
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
var RUN_UUID_SUFFIX = /_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
var UUID_ONLY = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function agentActor(ctx) {
  let header;
  try {
    const getHeader = ctx.sessionManager?.getHeader;
    if (typeof getHeader === "function")
      header = getHeader();
  } catch {
    header = undefined;
  }
  const headerKnown = header !== null && header !== undefined;
  if (headerKnown && (typeof header?.parentSession !== "string" || header.parentSession.length === 0))
    return;
  try {
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const sessionDir = ctx.sessionManager?.getSessionDir?.();
    if (typeof sessionFile !== "string" || typeof sessionDir !== "string")
      return;
    const file = basename(sessionFile);
    if (!file.endsWith(".jsonl"))
      return;
    const id = file.slice(0, -".jsonl".length);
    if (id === "")
      return;
    const root = resolve2(sessionDir);
    const rel = relative(root, resolve2(sessionFile));
    const parts = rel.split(sep);
    let run = parts[0];
    if (parts.length === 1) {
      const managerRun = basename(root);
      if (!RUN_UUID_SUFFIX.test(managerRun) || !headerKnown && UUID_ONLY.test(id))
        return;
      run = managerRun;
    }
    if (typeof run !== "string" || run === "" || run === "." || run === ".." || run.startsWith(`..${sep}`))
      return;
    const runScope = run.match(RUN_UUID_SUFFIX)?.[1] ?? run;
    return `omp/${runScope}/${id}`;
  } catch {
    return;
  }
}
function invocationActor(invocation, env) {
  const literal = (value) => {
    if (!value?.trim() || /[$`]/.test(value))
      return null;
    return value.trim();
  };
  const actorFlag = globalValue(invocation.globals, ["--actor"]);
  const explicit = literal(actorFlag);
  if (explicit !== null)
    return explicit;
  const resolve = (variable) => {
    if (invocation.unset[variable] === true)
      return null;
    const assignment = invocation.prefix.findLast((token) => token.startsWith(`${variable}=`));
    const value = assignment !== undefined ? assignment.slice(variable.length + 1) : invocation.exported[variable] ?? env[variable];
    return literal(value);
  };
  return resolve("BEADS_ACTOR") ?? resolve("BD_ACTOR");
}
function invocationFromArgv(args) {
  const scanned = scanGlobals(args, 0);
  const verb = args[scanned.next];
  if (verb === undefined)
    return;
  return { verb: verb.toLowerCase(), args: args.slice(scanned.next + 1), globals: scanned.globals, prefix: [], exported: {}, unset: {} };
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
    const claim = verb === "claim" || (verb === "update" || verb === "ready") && flagEnabled(args, ["--claim"]);
    if (claim)
      return { kind: "block", reason: CLAIM_REASON };
    if (CREATING_VERBS[verb] === true)
      return { kind: "block", reason: CREATE_REASON };
    advisory = true;
  }
  return advisory ? { kind: "advisory", text: ADVISORY_TEXT } : { kind: "allow" };
}

// extensions/bd-embedded-write-lock.ts
import { spawnSync as spawnSync2 } from "child_process";
import { closeSync, existsSync, openSync, readFileSync as readFileSync2, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join, resolve as resolve4 } from "path";

// extensions/beads-store.ts
import { spawnSync } from "child_process";
import { lstatSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, resolve as resolve3 } from "path";
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
    return realpathSync(isAbsolute(out) ? out : resolve3(cwd, out));
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
      lstatSync(resolve3(current, ".git"));
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
  const local = resolve3(cwd, ".beads");
  const common = repoIdentity(cwd);
  if (common === undefined)
    return;
  if (common !== cwd && common.endsWith("/.git")) {
    const primaryRoot = resolve3(common, "..");
    try {
      if (realpathSync(cwd) === primaryRoot && isDir(local))
        return local;
    } catch {
      return;
    }
    const primary = resolve3(primaryRoot, ".beads");
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
var PREFLIGHT_WAIT_MS = 500;
var RUNNER_WAIT_MS = 20000;
var POLL_MS = 20;
var PREFLIGHT_WAIT_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.preflight-wait-ms.v1");
function preflightWaitMs() {
  const configured = Reflect.get(globalThis, PREFLIGHT_WAIT_KEY);
  return typeof configured === "number" ? configured : PREFLIGHT_WAIT_MS;
}
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
      const stat = readFileSync2(`/proc/${pid}/stat`, "utf8");
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
  return isAbsolute2(path) ? path : resolve4(cwd, path);
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
    return resolve4(path);
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
    const holder = JSON.parse(readFileSync2(lock, "utf8"));
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
  return interpreter === undefined ? undefined : { interpreter, script: resolve4(script) };
}
function bunBinary() {
  const own = basename2(process.execPath);
  if (own === "bun" || own === "bun.exe")
    return process.execPath;
  const onPath = typeof Bun === "undefined" ? undefined : Bun.which("bun");
  if (onPath !== null && onPath !== undefined)
    return onPath;
  const install = process.env.BUN_INSTALL;
  if (install === undefined || install === "")
    return;
  const guess = join(install, "bin", "bun");
  return existsSync(guess) ? guess : undefined;
}
function quote(word) {
  return `'${word.replaceAll("'", "'\\''")}'`;
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
async function decideEmbeddedWrite(parsed, event, ctx, deadline = Date.now() + 25000) {
  try {
    if (event.toolName !== "bash")
      return;
    const input = event.input;
    const whole = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
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
        return { kind: "block", reason: result.reason };
      targets.push(...result.stores);
    }
    const unique = [...new Set(targets)];
    if (unique.length === 0)
      return;
    const store = unique[0];
    const direct = directShell(whole);
    if (store === undefined || unique.length > 1 || direct === undefined) {
      return {
        kind: "block",
        reason: `This command reaches the embedded store${unique.length > 1 ? "s" : ""} ${unique.join(", ")} in a form the Beads write lock cannot run under its serialising runner. Issue the \`bd\` command as its own tool call, as a single direct invocation.`
      };
    }
    const runner = embeddedWriteRunner();
    if (runner === undefined) {
      return {
        kind: "block",
        reason: `${store} is an embedded store, where two concurrent writers corrupt the Dolt journal, and the Beads write-lock runner that serialises writers could not be located: no \`bun\` binary was found on PATH, in BUN_INSTALL, or as this process's own interpreter, or the runner script is missing from the installed plugin. Install \`bun\` or reinstall the @srobroek/beads plugin; the write was refused rather than run unserialised.`
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
    const rewritten = `${direct.assignments}${quote(runner.interpreter)} ${quote(runner.script)} ${RUNNER_STORE_FLAG} ${quote(store)} ${RUNNER_WAIT_FLAG} ${RUNNER_WAIT_MS} -- ${direct.call}`;
    const next = { ...event.input };
    if (typeof input.command === "string")
      next.command = rewritten;
    else
      next.cmd = rewritten;
    return { kind: "rewrite", input: next };
  } catch {
    return { kind: "block", reason: "embedded write target could not be resolved" };
  }
}

// extensions/session-beads-lifecycle.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, realpathSync as realpathSync3, rmSync, statSync as statSync3 } from "fs";
import { dirname as dirname3, isAbsolute as isAbsolute3, join as join2, resolve as resolve5 } from "path";
var EMBEDDED_PIN_ENV = { BEADS_DOLT_SHARED_SERVER: "" };
function boundedBdEnvironment(base) {
  return {
    ...base,
    ...EMBEDDED_PIN_ENV,
    BD_NO_PAGER: "1",
    BD_NON_INTERACTIVE: "1",
    BD_DOLT_AUTO_START: "false",
    NO_COLOR: "1"
  };
}
function lifecycleBdEnvironment(cwd, base = process.env) {
  const env = { ...base };
  delete env.BEADS_DIR;
  const resolved = sessionPinFor(cwd);
  if (resolved !== undefined)
    env.BEADS_DIR = resolved;
  return boundedBdEnvironment(env);
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
  return typeof cwd === "string" && cwd !== "" ? resolve5(fallback, cwd) : fallback;
}
function canonicalStore2(path) {
  try {
    return realpathSync3(path);
  } catch {
    return resolve5(path);
  }
}
function bdStoreForInvocation(invocation, cwd, env) {
  if (flagEnabled(invocation.globals, ["--global", "--database"]))
    return;
  const directory = globalValue(invocation.globals, ["-C", "--directory"]);
  const db = globalValue(invocation.globals, ["--db"]);
  const base = directory === undefined ? cwd : resolve5(cwd, directory);
  if (db !== undefined) {
    const target = resolve5(base, db);
    if (!existsSync2(target))
      return;
    return canonicalStore2(statSync3(target).isDirectory() ? target : dirname3(target));
  }
  if (directory !== undefined)
    return canonicalStore2(sessionPinFor(base) ?? join2(base, ".beads"));
  const local = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="))?.slice("BEADS_DIR=".length);
  const pinned = local ?? env.BEADS_DIR;
  return canonicalStore2(pinned === undefined || pinned === "" ? sessionPinFor(cwd) ?? join2(cwd, ".beads") : isAbsolute3(pinned) ? pinned : resolve5(cwd, pinned));
}
function bdInvocationUsesExternalStore(invocation) {
  return flagEnabled(invocation.globals, ["--global", "--database"]);
}
var backgroundReads = new Set;
var LIFECYCLE_BRIDGE = Symbol.for("com.srobroek.beads.session-lifecycle.bridge.v1");
function lifecycleBridge() {
  const globals = globalThis;
  const existing = globals[LIFECYCLE_BRIDGE];
  if (existing !== undefined)
    return existing;
  const created = {};
  globals[LIFECYCLE_BRIDGE] = created;
  return created;
}
function pinnedBeadsDir(cwd, ctx) {
  const pin = ctx === undefined ? undefined : lifecycleBridge().sessionPinGetter?.(cwd, ctx);
  return pin ?? (ctx === undefined ? sessionPinFor(cwd) : undefined);
}
function rewriteBashInput(input, ctx) {
  const cwd = bashCallCwd(input, ctx?.cwd ?? process.cwd());
  const pin = pinnedBeadsDir(cwd, ctx);
  return pinBashInput(input, pin === "" ? undefined : pin);
}
async function admitBeadsWork(ctx, cwd = ctx?.cwd ?? process.cwd(), env = lifecycleBdEnvironment(cwd), refresh = true) {
  const gateAdmitter = lifecycleBridge().gateAdmitter;
  if (gateAdmitter === undefined)
    return;
  return await gateAdmitter(resolve5(cwd), boundedBdEnvironment(env), ctx, refresh);
}
async function admitBdMutation(input, ctx, targetEnabled) {
  const command = commandFromInput(input ?? {});
  if (!command)
    return;
  if (/\bcd\s+(?:"[^"]*\$[^"]*"|'[^']*\$[^']*'|\$[A-Za-z_])/u.test(command)) {
    return { block: true, reason: "cannot resolve the dynamic working directory before this mutation" };
  }
  const writes = bdInvocations(command).filter((invocation) => writesStore(invocation));
  if (writes.some((invocation) => invocation.prefix.some((token) => token.startsWith("BEADS_DIR=") && /[$`]/u.test(token)))) {
    return { block: true, reason: "Beads directory is selected dynamically and cannot be verified before this mutation" };
  }
  if (writes.length === 0)
    return;
  const effectiveInput = rewriteBashInput(input, ctx) ?? input;
  const cwd = bashCallCwd(effectiveInput, ctx?.cwd ?? process.cwd());
  const env = environmentForInput(effectiveInput);
  const writeTargets = embeddedWriteTargets(command, cwd, env);
  if (writeTargets.kind === "refused")
    return { block: true, reason: writeTargets.reason };
  const direct = writes.length === 1 ? writes[0] : undefined;
  if (direct !== undefined && bdInvocationUsesExternalStore(direct))
    return;
  const store = direct === undefined ? undefined : bdStoreForInvocation(direct, cwd, env);
  if (targetEnabled?.(store === undefined ? cwd : dirname3(store)) === false)
    return;
  return await admitBeadsWork(ctx, cwd, store === undefined ? env : { ...env, BEADS_DIR: store }, false);
}

// extensions/bash-gates.ts
var TOOL_CALL_BUDGET_MS = 25000;
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
function actorForCommand(command, ctx) {
  const actor = agentActor(ctx);
  if (actor === undefined)
    return;
  const invocations = bdInvocations(command);
  if (invocations.length === 0)
    return;
  if (invocations.some((invocation) => invocation.globals.some((token) => token === "--actor" || token.startsWith("--actor=")) || invocation.prefix.some((token) => token.startsWith("BEADS_ACTOR=")) || invocation.exported.BEADS_ACTOR !== undefined))
    return;
  return actor;
}
function inputForAgentActor(input, command, ctx) {
  const actor = actorForCommand(command, ctx);
  if (actor === undefined)
    return input;
  const key = typeof input.command === "string" ? "command" : "cmd";
  if (typeof input[key] !== "string")
    return input;
  const escaped = actor.replaceAll("'", "'\\''");
  return { ...input, [key]: `export BEADS_ACTOR='${escaped}'; ${input[key]}` };
}
function environmentForActorDecision(input, command, ctx) {
  const env = environmentForInput(input);
  const actor = actorForCommand(command, ctx);
  return actor === undefined ? env : { ...env, BEADS_ACTOR: actor };
}
async function decide(parsed, event, ctx, pi, deadline) {
  let input = event.input;
  const { cwd } = inputOf(event, ctx);
  if (parsed.unknown)
    return suffix("bash-gates", "command could not be parsed", "split the command or run the mutation as a plain single command");
  const env = environmentForActorDecision(input, parsed.command, ctx);
  if (settingsEnabled("beads", "bd-close-gate", cwd)) {
    try {
      const close = await decideBdCloseParsed(parsed, cwd, deadline);
      if (close !== undefined)
        return suffix("bd-close-gate", close.reason, "resolve the gate with `bd gate check` or `bd gate resolve <gate-id>`, then retry");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return suffix("bd-close-gate", reason, "retry after the Beads lookup is available; the close was refused without gate proof");
    }
  }
  if (settingsEnabled("beads", "bd-actor-gate", cwd)) {
    const actor = decideActorParsed(parsed, env);
    if (actor.kind === "block")
      return suffix("bd-actor-gate", actor.reason);
    if (actor.kind === "advisory" && typeof pi.sendMessage === "function")
      pi.sendMessage({ customType: "beads-bd-actor-advisory", content: actor.text, display: true, attribution: "user" }, { triggerTurn: false });
  }
  if (settingsEnabled("beads", "bd-embedded-write-lock", cwd)) {
    const embedded = await decideEmbeddedWrite(parsed, event, ctx, deadline);
    if (embedded?.kind === "block")
      return suffix("bd-embedded-write-lock", embedded.reason);
    if (embedded?.kind === "rewrite")
      input = embedded.input;
  }
  input = inputForAgentActor(input, parsed.command, ctx);
  const rewritten = rewriteBashInput(input, ctx) ?? input;
  if (JSON.stringify(rewritten) !== JSON.stringify(event.input))
    return { input: rewritten };
  return;
}
function bashGates(pi) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const input = event.input;
      const gatedTool = event.toolName === "task" || event.toolName === "bd_reconcile" && input.apply === true || event.toolName === "bd_formula_check" && input.deep === true;
      if (gatedTool) {
        const workspace = typeof input.workspace === "string" ? input.workspace : undefined;
        if (event.toolName === "bd_formula_check" && workspace === undefined)
          return suffix("beads-gate-admission", "deep formula checks require an explicit workspace so admission and execution cannot select different stores", "set workspace to the target checkout and retry");
        const cwd = workspace === undefined ? ctx?.cwd ?? process.cwd() : resolve6(ctx?.cwd ?? process.cwd(), workspace);
        const admission = await admitBeadsWork(ctx, cwd, lifecycleBdEnvironment(cwd));
        if (admission)
          return suffix("beads-gate-admission", admission.reason, "retry the operation; verification continues and the next attempt waits on the same read");
        return;
      }
      if (event.toolName !== "bash")
        return;
      const { command } = inputOf(event, ctx);
      if (!command)
        return;
      const admission = await admitBdMutation(event.input, ctx, (targetCwd) => settingsEnabled("beads", "beads-gate-admission", targetCwd));
      if (admission)
        return suffix("beads-gate-admission", admission.reason, "retry the command; verification continues and the next attempt waits on the same read");
      return await decide(parse(command), event, ctx, pi, Date.now() + TOOL_CALL_BUDGET_MS);
    } catch (error) {
      return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`, "split the command or run the mutation as a plain single command");
    }
  });
}
export {
  bashGates as default
};
