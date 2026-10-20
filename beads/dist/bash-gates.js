// @bun
// extensions/bash-gates.ts
import { resolve as resolve7 } from "path";

// extensions/bd-actor-gate.ts
import { basename, relative, resolve as resolve2, sep } from "path";

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
function shellQuoteBalanced(command) {
  if (typeof command !== "string")
    return true;
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
function leadingCdCwd(command, cwd) {
  const match = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command);
  if (!match)
    return cwd;
  const dir = match[1];
  if (!dir || /^[-~$]/.test(dir) || /[\\`"'*?\x5b\x5d{}]/.test(dir))
    return cwd;
  return dir.startsWith("/") ? dir : resolve(cwd, dir);
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
  if (typeof command !== "string") {
    return { kind: "parse-failure", reason: "command is not a string", command: "", segments: [], commands: [], unknown: true, nested: [] };
  }
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
    let index = executableName === executable ? position.argv.findIndex((word, i) => !position.words[i]?.quoted && (word.split("/").pop() ?? word) === executable) : -1;
    if (index < 0 && executable === "bd" && executableName !== "bd") {
      const runner = position.argv.findIndex((word) => /(?:^|\/)bd-embedded-write-runner\.(?:js|ts)$/.test(word));
      const delimiter = runner < 0 ? -1 : position.argv.indexOf("--", runner + 1);
      const child = delimiter < 0 ? -1 : delimiter + 1;
      if (child >= 0 && (position.argv[child]?.split("/").pop() ?? position.argv[child]) === "bd" && position.words[child]?.quoted !== true)
        index = child;
    }
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
          const assignment = tokens[i];
          prefix.push(assignment);
          const variable = assignment.slice(0, assignment.indexOf("="));
          if (variable === "BEADS_ACTOR" || variable === "BD_ACTOR")
            delete unset[variable];
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
var CREATE_REASON = "bd create / `bd new` / `bd create-form` without BEADS_ACTOR or BD_ACTOR records the invoking human's git identity in created_by. Owner is always the git identity and never identifies the agent. Set either variable to <harness>/<agent-name>/<session-id> so created_by is attributable, then retry.";
var ADVISORY_TEXT = "BEADS_ACTOR and BD_ACTOR are unset on this mutating `bd` command. Without an actor, created_by records the invoking human's git identity; Owner is always the git identity and never identifies the agent. Set either variable to <harness>/<agent-name>/<session-id> so writes and claims are attributable, then retry.";
function decideActorParsed(parsed, env = process.env) {
  if (parsed === null || typeof parsed !== "object")
    return { kind: "block", reason: "command could not be parsed" };
  const candidate = parsed;
  if (!Array.isArray(candidate.segments) || !candidate.segments.every((segment) => Array.isArray(segment) && segment.every((token) => typeof token === "string")) || !Array.isArray(candidate.nested)) {
    return { kind: "block", reason: "command could not be parsed" };
  }
  let advisory = false;
  for (const segment of candidate.segments) {
    const decision = decideActorGate(segment.join(" "), env);
    if (decision.kind === "block")
      return decision;
    if (decision.kind === "advisory")
      advisory = true;
  }
  for (const child of candidate.nested) {
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
import { closeSync, existsSync, openSync, readdirSync, readFileSync as readFileSync2, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join, resolve as resolve4 } from "path";

// extensions/beads-store.ts
import { spawnSync } from "child_process";
import { lstatSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, resolve as resolve3 } from "path";
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
var WAIT_MS = 120000;
var PREFLIGHT_WAIT_MS = 500;
var RUNNER_WAIT_MS = 120000;
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
var BEAD_ID2 = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/;
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
    return positional.length !== 1 || !BEAD_ID2.test(positional[0] ?? "");
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
  return `The Beads write lock cannot run this command: ${problem.part}. ${store} is an embedded store, where two concurrent writers corrupt the Dolt journal, so every \`bd\` write to it runs under the lock's serialising runner. ${problem.fix} ${ACCEPTED_SHAPES}`;
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
    const parsed = JSON.parse(readFileSync2(lock, "utf8"));
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
    return { script: resolve4(local) };
  const root = resolve4(here, "..");
  const missing = `${join(here, RUNNER_STEM)}.js`;
  const prefix = INSTALLED_PLUGIN_DIR.exec(basename2(root))?.[1];
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
        return { script: resolve4(script) };
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
  const own = basename2(execPath);
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
  return resolved !== undefined && basename2(resolved).startsWith("bun") && existsSync(resolved) ? resolved : undefined;
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
        reason: `${stores.join(", ")} ${stores.length > 1 ? "are embedded stores" : "is an embedded store"}, where two concurrent writers corrupt the Dolt journal, and the Beads write-lock runner that serialises writers could not be located: ${runner.unavailable} The write was refused rather than run unserialised.`
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

// extensions/bd-unclaim-gate.ts
var UNCLAIM = "unclaim";
var HELP_FLAGS = { "--help": true, "-h": true };
var IF_ASSIGNEE = "--if-assignee";
var GLOBAL_VALUE_FLAGS = { "--actor": true, "--database": true, "--db": true, "-C": true, "--directory": true };
function hasNonEmptyAssignee(args) {
  for (let index = 0;index < args.length; index++) {
    const token = args[index];
    if (token === undefined)
      continue;
    if (token === IF_ASSIGNEE) {
      const value = args[index + 1];
      if (value !== undefined && value.length > 0 && !value.startsWith("-"))
        return true;
      index++;
      continue;
    }
    if (token.startsWith(`${IF_ASSIGNEE}=`) && token.slice(IF_ASSIGNEE.length + 1).length > 0)
      return true;
  }
  return false;
}
function wrapperInvocations(parsed) {
  if (parsed.unknown)
    return [];
  const found = [];
  for (const position of parsed.commands) {
    const locate = (start) => {
      const token = position.argv[start];
      if (token === undefined)
        return;
      const basename = token.split("/").pop() ?? token;
      if (basename === "bd" && position.words[start]?.quoted !== true)
        return position.argv.slice(start + 1);
      if (basename === "env") {
        let index = start + 1;
        while (index < position.argv.length) {
          const option = position.argv[index];
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
            index++;
            continue;
          }
          if (option === "--")
            return locate(index + 1);
          if (!option.startsWith("-"))
            break;
          index++;
          if (["-u", "--unset", "-C", "--chdir", "--argv0"].includes(option))
            index++;
        }
        return locate(index);
      }
      if (basename === "command") {
        let index = start + 1;
        while (position.argv[index]?.startsWith("-") === true)
          index++;
        return locate(index);
      }
      return;
    };
    const args = locate(0);
    if (args === undefined)
      continue;
    let verb;
    for (let cursor = 0;cursor < args.length; cursor++) {
      const token = args[cursor];
      if (token === undefined || token === "--") {
        verb = args[cursor + 1];
        break;
      }
      if (!token.startsWith("-")) {
        verb = token;
        break;
      }
      if (!token.includes("=") && GLOBAL_VALUE_FLAGS[token] === true)
        cursor++;
    }
    found.push({ args: [verb ?? "", ...args], verb });
  }
  for (const child of parsed.nested)
    found.push(...wrapperInvocations(child));
  return found;
}
function decideBdUnclaimParsed(parsed) {
  if (parsed === null || typeof parsed !== "object" || !("unknown" in parsed) || typeof parsed.unknown !== "boolean") {
    return { block: true, reason: "unable to verify bd unclaim command syntax" };
  }
  if (parsed.unknown)
    return;
  if (!Array.isArray(parsed.commands) || !Array.isArray(parsed.nested)) {
    return { block: true, reason: "unable to verify bd unclaim command syntax" };
  }
  const invocations = [...parsedInvocations(parsed), ...wrapperInvocations(parsed)];
  for (const invocation of invocations) {
    if (invocation.verb?.toLowerCase() !== UNCLAIM)
      continue;
    let help = false;
    for (const argument of invocation.args) {
      if (argument === "--")
        break;
      if (HELP_FLAGS[argument] === true) {
        help = true;
        break;
      }
    }
    if (help)
      continue;
    if (!hasNonEmptyAssignee(invocation.args)) {
      return {
        block: true,
        reason: "bd unclaim requires a non-empty --if-assignee compare-and-swap guard"
      };
    }
  }
  return;
}

// extensions/bd-update-close-gate.ts
var UPDATE = "update";
var CLOSING_STATUSES = { closed: true, done: true };
var STATUS_FLAGS = ["--status", "-s"];
var UPDATE_CLOSE_REASON = 'Use `bd close ID --reason "<factual reason>"` instead.';
function statusValue(args) {
  for (let index = 0;index < args.length; index++) {
    const token = args[index];
    if (token === undefined)
      continue;
    const flag = STATUS_FLAGS.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
    if (flag === undefined)
      continue;
    if (token.startsWith(`${flag}=`))
      return token.slice(flag.length + 1).toLowerCase();
    return args[index + 1]?.toLowerCase();
  }
  return;
}
function hasClosingBdUpdate(parsed) {
  return parsedInvocations(parsed).some((invocation) => invocation.verb?.toLowerCase() === UPDATE && CLOSING_STATUSES[statusValue(invocation.args) ?? ""] === true);
}
function decideBdUpdateCloseParsed(parsed) {
  return hasClosingBdUpdate(parsed) ? { block: true, reason: UPDATE_CLOSE_REASON } : undefined;
}

// extensions/binary-hooks.ts
import { spawnSync as spawnSync3 } from "child_process";
import { closeSync as closeSync2, existsSync as existsSync2, openSync as openSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, readSync, realpathSync as realpathSync3, statSync as statSync3 } from "fs";
import { isAbsolute as isAbsolute3, join as join2, resolve as resolve5, sep as sep2 } from "path";
var BINARY_MAGICS = [
  [254, 237, 250, 206],
  [206, 250, 237, 254],
  [254, 237, 250, 207],
  [207, 250, 237, 254],
  [202, 254, 186, 190],
  [190, 186, 254, 202],
  [202, 254, 186, 191],
  [191, 186, 254, 202],
  [127, 69, 76, 70]
];
var SAMPLE_BYTES = 4096;
var GLOBAL_VALUE_FLAGS2 = new Set(["--actor", "--database", "--db", "-C", "--directory", "--dolt-auto-commit", "--mem-profile"]);
var SEPARATORS2 = new Set([";", "&", "|", "&&", "||", "(", ")", "{", "}", `
`]);
function runGit(cwd, args) {
  const result = spawnSync3("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1000 });
  if (result.error)
    throw result.error;
  return { status: result.status, stdout: result.stdout.trim() };
}
function hooksDirectory(cwd, git) {
  const result = git(cwd, ["rev-parse", "--git-path", "hooks"]);
  if (result.status === 0 && result.stdout !== "")
    return isAbsolute3(result.stdout) ? result.stdout : resolve5(cwd, result.stdout);
  const configured = git(cwd, ["config", "--path", "--get", "core.hooksPath"]);
  if (configured.status === 0 && configured.stdout !== "") {
    return isAbsolute3(configured.stdout) ? configured.stdout : resolve5(cwd, configured.stdout);
  }
  const conventional = join2(cwd, ".git", "hooks");
  return existsSync2(conventional) ? conventional : undefined;
}
function fileHasMarker(path, magicsOnly = false) {
  const fd = openSync2(path, "r");
  try {
    const bytes = Buffer.alloc(SAMPLE_BYTES);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const sample = bytes.subarray(0, count);
    if (!magicsOnly && sample.includes(0))
      return true;
    return BINARY_MAGICS.some((magic) => sample.length >= magic.length && magic.every((byte, index) => sample[index] === byte));
  } finally {
    closeSync2(fd);
  }
}
function hasBinaryHooks(cwd, git = runGit) {
  try {
    const directory = hooksDirectory(cwd, git);
    if (directory === undefined)
      return false;
    for (const entry of readdirSync2(directory)) {
      const path = join2(directory, entry);
      if (statSync3(path).isFile() && fileHasMarker(path))
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
function commandChunks(command) {
  const chunks = [];
  let start = 0;
  let quote = null;
  for (let index = 0;index < command.length; index++) {
    const character = command[index] ?? "";
    if (quote !== null) {
      if (character === quote)
        quote = null;
      else if (quote === '"' && character === "\\")
        index++;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      index++;
      continue;
    }
    if (SEPARATORS2.has(character)) {
      chunks.push({ start, end: index });
      if ((character === "&" || character === "|") && command[index + 1] === character)
        index++;
      start = index + 1;
    }
  }
  chunks.push({ start, end: command.length });
  return chunks;
}
function wordSpans(source) {
  const words = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index] ?? ""))
      index++;
    if (index >= source.length)
      break;
    const start = index;
    let value = "";
    let quote = null;
    while (index < source.length) {
      const character = source[index] ?? "";
      if (quote !== null) {
        if (character === quote)
          quote = null;
        else if (quote === '"' && character === "\\" && index + 1 < source.length)
          value += source[++index] ?? "";
        else
          value += character;
        index++;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        index++;
        continue;
      }
      if (character === "\\" && index + 1 < source.length) {
        value += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (/\s/.test(character) || SEPARATORS2.has(character))
        break;
      value += character;
      index++;
    }
    if (index === start)
      index++;
    else
      words.push({ value, start, end: index });
  }
  return words;
}
function initVerbIndex(words) {
  let index = words.findIndex((word) => (word.value.split("/").pop() ?? word.value) === "bd");
  if (index < 0)
    return;
  index++;
  while (index < words.length) {
    const flag = words[index]?.value ?? "";
    if (!flag.startsWith("-"))
      return flag === "init" ? index : undefined;
    if (flag === "--")
      return;
    if (GLOBAL_VALUE_FLAGS2.has(flag) && !flag.includes("="))
      index++;
    index++;
  }
  return;
}
function rewriteInitCalls(command) {
  const insertions = [];
  for (const chunk of commandChunks(command)) {
    const source = command.slice(chunk.start, chunk.end);
    const parsed = parse(source);
    if (parsed.unknown || parsed.commands.length !== 1)
      continue;
    const invocation = parsedInvocations(parsed).find((item) => item.verb === "init");
    if (invocation === undefined || invocation.args.includes("--skip-hooks"))
      continue;
    const words = wordSpans(source);
    const verbIndex = initVerbIndex(words);
    if (verbIndex === undefined)
      continue;
    insertions.push(chunk.start + (words[verbIndex]?.end ?? 0));
  }
  if (insertions.length === 0)
    return;
  let rewritten = command;
  for (const offset of insertions.sort((left, right) => right - left))
    rewritten = `${rewritten.slice(0, offset)} --skip-hooks${rewritten.slice(offset)}`;
  return rewritten;
}
function protectBinaryHookCommands(input, command, cwd, git = runGit) {
  try {
    const invocations = parsedInvocations(parse(command));
    const inits = invocations.filter((invocation) => invocation.verb === "init");
    const installs = invocations.filter((invocation) => invocation.verb === "hooks" && invocation.args[1] === "install");
    const needsInitGuard = inits.some((invocation) => !invocation.args.includes("--skip-hooks"));
    if (!needsInitGuard && installs.length === 0)
      return;
    if (!hasBinaryHooks(cwd, git))
      return;
    if (installs.length > 0) {
      return {
        kind: "block",
        reason: "`bd hooks install` was blocked because an existing Git hook is a binary executable that this installer could corrupt; it was blocked to keep the existing (binary) hooks intact."
      };
    }
    if (!needsInitGuard)
      return;
    const rewritten = rewriteInitCalls(command);
    if (rewritten === undefined) {
      return { kind: "block", reason: "`bd init` was blocked because binary Git hooks exist and the command could not be safely rewritten to add `--skip-hooks`; this keeps the existing (binary) hooks intact." };
    }
    const record = input !== null && typeof input === "object" ? input : undefined;
    const key = typeof record?.command === "string" ? "command" : typeof record?.cmd === "string" ? "cmd" : undefined;
    if (record === undefined || key === undefined)
      return;
    return { kind: "rewrite", input: { ...record, [key]: rewritten } };
  } catch {
    return;
  }
}

// extensions/session-beads-lifecycle.ts
import { existsSync as existsSync3, readFileSync as readFileSync4, realpathSync as realpathSync4, rmSync, statSync as statSync4 } from "fs";
import { dirname as dirname3, isAbsolute as isAbsolute4, join as join3, resolve as resolve6 } from "path";
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
var GATE_ADMISSION_MS = 20000;
function likelyBdCommand(command) {
  const tokens = tokenizeShell(command, { preserveBackslashes: true });
  const separators = { ";": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "{": true, "}": true };
  const segmentHasBd = (words) => {
    let index = 0;
    while (index < words.length) {
      const token = words[index];
      if (!token || token.startsQuoted)
        return false;
      const word = token.value.split("/").pop() ?? token.value;
      if (assignmentName(token.value) !== undefined || word === "!") {
        index++;
        continue;
      }
      if (["if", "then", "elif", "else", "while", "until", "do", "for", "in", "case", "function"].includes(word)) {
        index++;
        continue;
      }
      if (word === "bd")
        return true;
      if (!["command", "env", "exec", "mise", "nice", "nohup", "sudo", "time", "timeout", "xargs"].includes(word))
        return false;
      index++;
      if (word === "env") {
        while (index < words.length) {
          const option = words[index];
          if (!option || option.startsQuoted)
            return false;
          if (assignmentName(option.value) !== undefined) {
            index++;
            continue;
          }
          if (!option.value.startsWith("-"))
            break;
          const takesValue = option.value === "-u" || option.value === "--unset";
          index += takesValue ? 2 : 1;
        }
      } else if (word === "timeout" || word === "nice") {
        while (index < words.length && words[index]?.value.startsWith("-"))
          index++;
        if (index < words.length)
          index++;
      } else if (word === "sudo") {
        while (index < words.length && words[index]?.value.startsWith("-")) {
          const option = words[index]?.value;
          index += option === "-u" || option === "-g" || option === "--user" || option === "--group" ? 2 : 1;
        }
      } else if (word === "xargs") {
        while (index < words.length && words[index]?.value.startsWith("-"))
          index++;
      }
    }
    return false;
  };
  let segment = [];
  for (const token of tokens) {
    if (separators[token.value] === true) {
      if (segmentHasBd(segment))
        return true;
      segment = [];
    } else
      segment.push(token);
  }
  return segmentHasBd(segment);
}
function commandHasBd(command) {
  const parsed = parse(command);
  const invocations = parsedInvocations(parsed);
  if (invocations.length > 0)
    return { parsed, invocations, hasBd: true };
  if (bdInvocations(command).length > 0)
    return { parsed, invocations, hasBd: true };
  return { parsed, invocations, hasBd: likelyBdCommand(command) };
}
function hasExplicitPinText(command) {
  const tokens = tokenizeShell(command, { preserveBackslashes: true });
  for (let index = 0;index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.startsQuoted || token.value !== "env")
      continue;
    for (let option = index + 1;option < tokens.length; option++) {
      const value = tokens[option];
      if (!value || [";", "&&", "||", "&", "|", `
`, "(", ")", "{", "}"].includes(value.value))
        break;
      if (pinVariable(assignmentName(value.value)))
        return true;
      if (value.value === "-u" || value.value === "--unset") {
        if (pinVariable(tokens[option + 1]?.value))
          return true;
        option++;
      } else if (value.value.startsWith("-u") && pinVariable(value.value.slice(2))) {
        return true;
      } else if (value.value.startsWith("--unset=") && pinVariable(value.value.slice("--unset=".length))) {
        return true;
      }
    }
  }
  return false;
}
function pinVariable(name) {
  return name === "BEADS_DIR" || name === "BEADS_DOLT_SHARED_SERVER";
}
function assignmentName(value) {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(value)?.[1];
}
function hasExplicitPin(position) {
  const words = position.words;
  const executable = position.executable?.split("/").pop();
  const executableIndex = words.findIndex((word) => !word.quoted && (word.value.split("/").pop() ?? word.value) === executable);
  if (executableIndex < 0)
    return false;
  for (const word of words.slice(0, executableIndex)) {
    if (pinVariable(assignmentName(word.value)))
      return true;
  }
  for (let index = 0;index < executableIndex; index++) {
    const word = words[index];
    if (!word || word.quoted || word.value !== "env")
      continue;
    for (let option = index + 1;option < executableIndex; option++) {
      const value = words[option];
      if (!value || value.quoted)
        continue;
      if (value.value === "-u" || value.value === "--unset") {
        if (pinVariable(words[option + 1]?.value))
          return true;
        option++;
      } else if (value.value.startsWith("-u") && pinVariable(value.value.slice(2))) {
        return true;
      } else if (value.value.startsWith("--unset=") && pinVariable(value.value.slice("--unset=".length))) {
        return true;
      }
    }
  }
  return false;
}
function safeDirectBd(position) {
  if ((position.executable?.split("/").pop() ?? position.executable) !== "bd")
    return false;
  const executableIndex = position.words.findIndex((word) => !word.quoted && (word.value.split("/").pop() ?? word.value) === "bd");
  if (executableIndex < 0)
    return false;
  return position.words.slice(0, executableIndex).every((word) => assignmentName(word.value) !== undefined);
}
function unsafePinSyntax(command) {
  return /[(){}]|`|\$\(|<<-?/.test(command);
}
function exportPin(command, pin) {
  return `export BEADS_DOLT_SHARED_SERVER= BEADS_DIR=${shellQuote(pin)};
${command}`;
}
function rewriteUnnamedPin(command, pin) {
  const { parsed, invocations, hasBd } = commandHasBd(command);
  if (!hasBd)
    return;
  if (invocations.some((invocation) => hasExplicitPin(invocation.position)) || hasExplicitPinText(command))
    return;
  if (invocations.length === 0 || parsed.unknown || parsed.nested.length > 0 || unsafePinSyntax(command))
    return exportPin(command, pin);
  const insertions = [];
  let cursor = 0;
  let found = 0;
  for (const segment of commandSegments(command)) {
    const start = command.indexOf(segment, cursor);
    if (start < 0)
      return exportPin(command, pin);
    cursor = start + segment.length;
    const segmentParsed = parse(segment);
    if (segmentParsed.unknown || segmentParsed.nested.length > 0 || segmentParsed.commands.length === 0)
      continue;
    const position = segmentParsed.commands[0];
    if (!position || (position.executable?.split("/").pop() ?? position.executable) !== "bd")
      continue;
    found++;
    if (!safeDirectBd(position))
      return exportPin(command, pin);
    const offset = segment.search(/\S/);
    if (offset < 0)
      return exportPin(command, pin);
    insertions.push(start + offset);
  }
  if (found !== invocations.length)
    return exportPin(command, pin);
  if (insertions.length === 0)
    return;
  const prefix = `BEADS_DOLT_SHARED_SERVER= BEADS_DIR=${shellQuote(pin)} `;
  let rewritten = command;
  for (const offset of insertions.sort((a, b) => b - a))
    rewritten = `${rewritten.slice(0, offset)}${prefix}${rewritten.slice(offset)}`;
  return rewritten;
}
function pinBashInput(input, pin) {
  if (typeof pin !== "string" || input === null || typeof input !== "object")
    return;
  const record = input;
  const commandKey = typeof record.command === "string" ? "command" : typeof record.cmd === "string" ? "cmd" : undefined;
  if (commandKey === undefined || record[commandKey].trim() === "")
    return;
  const env = record.env;
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env)))
    return;
  const current = env?.BEADS_DIR;
  if (typeof current === "string" && current !== "")
    return;
  const command = record[commandKey];
  const { hasBd } = commandHasBd(command);
  if (!hasBd)
    return;
  if (typeof record.name === "string" && record.name !== "") {
    return { ...record, env: { ...env ?? {}, ...EMBEDDED_PIN_ENV, BEADS_DIR: pin } };
  }
  const rewritten = rewriteUnnamedPin(command, pin);
  if (rewritten === undefined)
    return;
  const next = { ...record, [commandKey]: rewritten };
  return next;
}
function bashCallCwd(input, fallback) {
  if (input === null || typeof input !== "object")
    return fallback;
  const cwd = input.cwd;
  return typeof cwd === "string" && cwd !== "" ? resolve6(fallback, cwd) : fallback;
}
function canonicalStore2(path) {
  try {
    return realpathSync4(path);
  } catch {
    return resolve6(path);
  }
}
function bdStoreForInvocation(invocation, cwd, env) {
  if (flagEnabled(invocation.globals, ["--global", "--database"]))
    return;
  const directory = globalValue(invocation.globals, ["-C", "--directory"]);
  const db = globalValue(invocation.globals, ["--db"]);
  const base = directory === undefined ? cwd : resolve6(cwd, directory);
  if (db !== undefined) {
    const target = resolve6(base, db);
    if (!existsSync3(target))
      return;
    return canonicalStore2(statSync4(target).isDirectory() ? target : dirname3(target));
  }
  if (directory !== undefined)
    return canonicalStore2(sessionPinFor(base) ?? join3(base, ".beads"));
  const local = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="))?.slice("BEADS_DIR=".length);
  const pinned = local ?? env.BEADS_DIR;
  return canonicalStore2(pinned === undefined || pinned === "" ? sessionPinFor(cwd) ?? join3(cwd, ".beads") : isAbsolute4(pinned) ? pinned : resolve6(cwd, pinned));
}
function bdInvocationUsesExternalStore(invocation) {
  return flagEnabled(invocation.globals, ["--global", "--database"]);
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
function environmentForBashInput(input, source = input) {
  const env = environmentForInput(source);
  const command = commandFromInput(input ?? {});
  for (const invocation of bdInvocations(command)) {
    const assignment = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="));
    if (assignment !== undefined)
      env.BEADS_DIR = assignment.slice("BEADS_DIR=".length);
  }
  return env;
}
async function admitBeadsWork(ctx, cwd = ctx?.cwd ?? process.cwd(), env = lifecycleBdEnvironment(cwd), refresh = true, deadline = Date.now() + GATE_ADMISSION_MS) {
  const gateAdmitter = lifecycleBridge().gateAdmitter;
  if (gateAdmitter === undefined)
    return;
  return await gateAdmitter(resolve6(cwd), boundedBdEnvironment(env), ctx, refresh, deadline);
}
async function admitBdMutation(input, ctx, targetEnabled, deadline = Date.now() + GATE_ADMISSION_MS) {
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
  const literalCd = /^\s*cd\s+([^\s;&|]+)\s*&&\s*([\s\S]+?)\s*$/.exec(command);
  const targetCommand = literalCd === null ? command : literalCd[2] ?? "";
  const targetCwd = literalCd === null ? cwd : leadingCdCwd(command, cwd);
  const env = environmentForBashInput(effectiveInput, input);
  const writeTargets = embeddedWriteTargets(targetCommand, targetCwd, env);
  if (writeTargets.kind === "refused")
    return { block: true, reason: writeTargets.reason };
  const direct = writes.length === 1 ? writes[0] : undefined;
  if (direct !== undefined && bdInvocationUsesExternalStore(direct))
    return;
  const store = direct === undefined ? undefined : bdStoreForInvocation(direct, targetCwd, env);
  if (targetEnabled?.(store === undefined ? targetCwd : dirname3(store)) === false)
    return;
  return await admitBeadsWork(ctx, targetCwd, store === undefined ? env : { ...env, BEADS_DIR: store }, false, deadline);
}

// extensions/bash-gates.ts
var TOOL_CALL_BUDGET_MS = 25000;
var toolCallBudgetMs = TOOL_CALL_BUDGET_MS;
function setToolCallBudgetForTests(ms) {
  toolCallBudgetMs = ms ?? TOOL_CALL_BUDGET_MS;
}
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
async function decide(parsed, event, ctx, pi, deadline, hooksSkipped = false, originalEvent = event) {
  let input = event.input;
  const activeParsed = parsed;
  const { cwd } = inputOf(event, ctx);
  if (activeParsed.unknown)
    return suffix("bash-gates", "command could not be parsed", "split the command or run the mutation as a plain single command");
  const env = environmentForActorDecision(input, activeParsed.command, ctx);
  if (settingsEnabled("beads", "bd-update-close-gate", cwd)) {
    const updateClose = decideBdUpdateCloseParsed(activeParsed);
    if (updateClose !== undefined)
      return suffix("bd-update-close-gate", updateClose.reason);
  }
  if (settingsEnabled("beads", "bd-close-gate", cwd)) {
    try {
      const close = await decideBdCloseParsed(activeParsed, cwd, deadline);
      if (close !== undefined)
        return suffix("bd-close-gate", close.reason, "resolve the gate with `bd gate check` or `bd gate resolve <gate-id>`, then retry");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return suffix("bd-close-gate", reason, "retry after the Beads lookup is available; the close was refused without gate proof");
    }
  }
  if (settingsEnabled("beads", "bd-unclaim-gate", cwd)) {
    const unclaim = decideBdUnclaimParsed(activeParsed);
    if (unclaim !== undefined)
      return suffix("bd-unclaim-gate", unclaim.reason, "retry with `bd unclaim <id> --if-assignee <your actor>`");
  }
  if (settingsEnabled("beads", "bd-actor-gate", cwd)) {
    const actor = decideActorParsed(activeParsed, env);
    if (actor.kind === "block")
      return suffix("bd-actor-gate", actor.reason);
    if (actor.kind === "advisory" && typeof pi.sendMessage === "function")
      pi.sendMessage({ customType: "beads-bd-actor-advisory", content: actor.text, display: true, attribution: "user" }, { triggerTurn: false });
  }
  if (settingsEnabled("beads", "bd-embedded-write-lock", cwd)) {
    const writeEvent = input === event.input ? event : { ...event, input };
    const embedded = await decideEmbeddedWrite(activeParsed, writeEvent, ctx, deadline);
    if (embedded?.kind === "block")
      return suffix("bd-embedded-write-lock", embedded.reason);
    if (embedded?.kind === "rewrite")
      input = embedded.input;
  }
  input = inputForAgentActor(input, activeParsed.command, ctx);
  const rewritten = rewriteBashInput(input, ctx) ?? input;
  if (hooksSkipped && JSON.stringify(rewritten) !== JSON.stringify(originalEvent.input)) {
    const key = typeof rewritten.command === "string" ? "command" : "cmd";
    if (typeof rewritten[key] === "string")
      rewritten[key] = `# Beads hooks skipped to keep the existing (binary) Git hooks intact.
${rewritten[key]}`;
    if (typeof pi.sendMessage === "function")
      pi.sendMessage({ customType: "beads-binary-hooks-advisory", content: "Hooks were skipped to keep the existing (binary) Git hooks intact.", display: true, attribution: "user" }, { triggerTurn: false });
  }
  if (JSON.stringify(rewritten) !== JSON.stringify(originalEvent.input))
    return { input: rewritten };
  return;
}
function bashGates(pi) {
  pi.on("tool_call", async (event, ctx) => {
    const deadline = Date.now() + toolCallBudgetMs;
    try {
      const input = event.input;
      const gatedTool = event.toolName === "task" || event.toolName === "bd_formula_check" && input.deep === true;
      if (gatedTool) {
        const workspace = typeof input.workspace === "string" ? input.workspace : undefined;
        if (event.toolName === "bd_formula_check" && workspace === undefined)
          return suffix("beads-gate-admission", "deep formula checks require an explicit workspace so admission and execution cannot select different stores", "set workspace to the target checkout and retry");
        const cwd = workspace === undefined ? ctx?.cwd ?? process.cwd() : resolve7(ctx?.cwd ?? process.cwd(), workspace);
        const admission = await admitBeadsWork(ctx, cwd, lifecycleBdEnvironment(cwd), true, deadline);
        if (admission)
          return suffix("beads-gate-admission", admission.reason, "retry the operation; verification continues and the next attempt waits on the same read");
        return;
      }
      if (event.toolName !== "bash")
        return;
      const { command } = inputOf(event, ctx);
      if (!command)
        return;
      let hooksSkipped = false;
      const hookGuard = protectBinaryHookCommands(event.input, command, inputOf(event, ctx).cwd);
      if (hookGuard?.kind === "block")
        return suffix("binary-git-hooks", hookGuard.reason);
      let effectiveEvent = event;
      if (hookGuard?.kind === "rewrite") {
        effectiveEvent = { ...event, input: hookGuard.input };
        hooksSkipped = true;
      }
      const admission = await admitBdMutation(effectiveEvent.input, ctx, (targetCwd) => settingsEnabled("beads", "beads-gate-admission", targetCwd), deadline);
      if (admission)
        return suffix("beads-gate-admission", admission.reason, "retry the command; verification continues and the next attempt waits on the same read");
      return await decide(parse(commandFromInput(effectiveEvent.input)), effectiveEvent, ctx, pi, deadline, hooksSkipped, event);
    } catch (error) {
      return suffix("bash-gates", `command could not be parsed (${error instanceof Error ? error.message : String(error)})`, "split the command or run the mutation as a plain single command");
    }
  });
}
export {
  bashGates as default,
  setToolCallBudgetForTests
};
