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
var VALUE_FLAGS = new Set([
  "--actor",
  "--database",
  "--db",
  "-C",
  "--directory",
  "--dolt-auto-commit",
  "--mem-profile"
]);
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
var pendingAdvisory = new Map;

// extensions/session-beads-lifecycle.ts
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";

// extensions/bd-embedded-write-lock.ts
import { hostname } from "os";
var HOST = hostname().split(".")[0] ?? "localhost";
var REGISTRY_KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.v1");
var activeHolds = new Map;

// extensions/session-beads-lifecycle.ts
function beadsDir(cwd) {
  const pin = process.env.BEADS_DIR;
  const dir = pin ? isAbsolute(pin) ? pin : resolve(cwd, pin) : join(cwd, ".beads");
  try {
    return statSync(dir).isDirectory() ? dir : undefined;
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

// extensions/unreported-failure-advisory.ts
var BD_TIMEOUT_MS = 1200;
var MAX_SIGNALS = 6;
var MAX_TRACKED = 24;
var MAX_SIGNAL_CHARS = 120;
var CHECK_RE = /\b(?:(?:bun|npm|pnpm|yarn|deno|node)\s+(?:run\s+)?(?:test|typecheck|type-check|lint|check|build)|bunx\s+\S+|npx\s+\S+|tsc\b|biome\b|eslint\b|oxlint\b|vitest\b|jest\b|mocha\b|slopvac\b|pytest\b|ruff\b|mypy\b|pyright\b|tox\b|cargo\s+(?:test|clippy|check|build|fmt)|go\s+(?:test|vet|build)|golangci-lint\b|just\s+\S+|make\b|mise\s+run\s+\S+|moon\s+run\s+\S+|uv\s+run\s+\S+|poetry\s+run\s+\S+|pre-commit\s+run)/i;
var WRAPPER_VALUE_FLAGS = {
  "-C": true,
  "-g": true,
  "--group": true,
  "-h": true,
  "--host": true,
  "-p": true,
  "--prompt": true,
  "-R": true,
  "--chroot": true,
  "-T": true,
  "--command-timeout": true,
  "-u": true,
  "--unset": true,
  "--user": true
};
function commandStart(tokens) {
  let index = 0;
  while (index < tokens.length) {
    while (/^[A-Za-z_]\w*=/.test(tokens[index] ?? ""))
      index++;
    const wrapper = tokens[index];
    if (wrapper === "command") {
      if (tokens[index + 1]?.startsWith("-"))
        return tokens.length;
      index++;
      continue;
    }
    if (wrapper !== "env" && wrapper !== "sudo")
      return index;
    index++;
    while (tokens[index]?.startsWith("-")) {
      const flag = tokens[index];
      index++;
      if (WRAPPER_VALUE_FLAGS[flag] === true)
        index++;
    }
    if (wrapper === "env") {
      while (/^[A-Za-z_]\w*=/.test(tokens[index] ?? ""))
        index++;
    }
  }
  return index;
}
var LOG_RECORD_RE = /^\s*\[?(?:DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL|FATAL|TRACE)\]?[:\s]/i;
function matchLine(match) {
  const text = match.input ?? "";
  const index = match.index ?? 0;
  const end = text.indexOf(`
`, index);
  return text.slice(text.lastIndexOf(`
`, index) + 1, end === -1 ? undefined : end);
}
function countedFailure(match, label) {
  if (Number(match[1]) === 0 || LOG_RECORD_RE.test(matchLine(match)))
    return;
  return label(match[1]);
}
var RULES = [
  {
    re: /^[^\n]*\berror[ \t]+(TS\d{4,5})\b[^\n]*$/gim,
    signal: (match) => {
      const file = match[0].match(/(\S+?)(?:\(\d+,\d+\)|:\d+:\d+)/);
      return file === null ? `error ${match[1]}` : `${file[1]} error ${match[1]}`;
    }
  },
  {
    re: /^[ \t>|*+-]{0,8}(?:[[(\u2717\u00D7][ \t]*)?(FAIL(?:ED)?|FAILURES?|ERRORS?)\b(?![:.]\S)[^\n]*/gm,
    signal: (match) => match[0].trim()
  },
  {
    re: /\b(\d+)[ \t]+fail(?:ed|ing|ures?|s)?\b/gi,
    signal: (match) => countedFailure(match, (count) => `${count} failed`)
  },
  {
    re: /\bfail(?:ures?|ed|s)[ \t]*[:=][ \t]*"?(\d+)/gi,
    signal: (match) => countedFailure(match, (count) => `${count} failed`)
  },
  {
    re: /\bfound[ \t]+(\d+)[ \t]+errors?\b/gi,
    signal: (match) => countedFailure(match, (count) => `found ${count} errors`)
  },
  {
    re: /\bexit(?:ed)?[ \t]*(?:with[ \t]*)?(?:code|status)[ \t]*[:=]?[ \t]*(-?\d+)/gi,
    signal: (match) => Number(match[1]) === 0 ? undefined : `exit code ${match[1]}`
  }
];
var observed = new Map;
function resetUnreportedFailureAdvisoryForTests() {
  observed.clear();
}
function checkLabel(command) {
  for (const tokens of commandSegments(command)) {
    const candidate = tokens.slice(commandStart(tokens)).join(" ");
    const match = candidate.match(CHECK_RE);
    if (match?.index === 0)
      return match[0].replace(/\s+/g, " ").toLowerCase();
  }
  return;
}
function failureSignals(text) {
  const signals = [];
  const seen = new Set;
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.re)) {
      const raw = rule.signal(match);
      if (raw === undefined)
        continue;
      const signal = raw.replace(/\s+/g, " ").trim().slice(0, MAX_SIGNAL_CHARS);
      if (signal.length === 0 || seen.has(signal))
        continue;
      seen.add(signal);
      signals.push(signal);
      if (signals.length >= MAX_SIGNALS)
        return signals;
    }
  }
  return signals;
}
function signalSubjects(signal) {
  const subjects = new Set;
  for (const token of signal.match(/[\w./\\-]+/g) ?? []) {
    if (/^TS\d{4,5}$/.test(token) || /^(?:Test|test_)[\w-]+$/.test(token)) {
      subjects.add(token.toLowerCase());
      continue;
    }
    if (!/[A-Za-z_]\.[A-Za-z]{1,4}$/.test(token) || token.length < 5)
      continue;
    subjects.add(token.toLowerCase());
    const base = token.slice(token.lastIndexOf("/") + 1);
    if (base.length >= 5)
      subjects.add(base.toLowerCase());
  }
  return [...subjects];
}
function unreportedFailures(observedSignals, beadsFiledThisSession) {
  const filed = beadsFiledThisSession.map((text) => text.trim().toLowerCase()).filter((text) => text.length > 0);
  const unreported = [];
  const seen = new Set;
  for (const signal of observedSignals) {
    if (seen.has(signal))
      continue;
    seen.add(signal);
    if (filed.length === 0) {
      unreported.push(signal);
      continue;
    }
    const subjects = signalSubjects(signal);
    if (subjects.length === 0)
      continue;
    if (subjects.some((subject) => filed.some((text) => text.includes(subject))))
      continue;
    unreported.push(signal);
  }
  return unreported;
}
function bugTexts(stdout) {
  const data = envelopeData(parseTrailingJson(stdout));
  if (!Array.isArray(data))
    return;
  const texts = [];
  for (const row of data) {
    if (row === null || typeof row !== "object")
      continue;
    const record = row;
    const text = [record.title, record.description].filter((part) => typeof part === "string").join(" ");
    if (text.length > 0)
      texts.push(text);
  }
  return texts;
}
function formatUnreportedAdvisory(unreported, checks) {
  const lines = ["Failing checks ran this session and no bug bead names them:"];
  for (const signal of unreported.slice(0, MAX_SIGNALS)) {
    const check = checks.get(signal);
    lines.push(`- ${signal}${check === undefined ? "" : ` (${check})`}`);
  }
  if (unreported.length > MAX_SIGNALS)
    lines.push(`- ...and ${unreported.length - MAX_SIGNALS} more`);
  lines.push('MUST record what you saw: `bd create "<what fails, where>" -t bug`. Leave it unassigned and do not block your own bead on it.');
  lines.push("DEFAULT The bead is the carrier -- a line in a summary dies with this session.");
  lines.push("NOT needed if you already fixed it, or already filed it under a title that names the file.");
  return lines.join(`
`);
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
function exitLine(event) {
  const details = event.details;
  if (details === null || typeof details !== "object")
    return "";
  const code = details.exitCode;
  return typeof code === "number" && code !== 0 ? `Command exited with code ${code}
` : "";
}
function sessionKey(ctx) {
  return ctx?.sessionManager?.getSessionId?.() ?? "default";
}
async function listBugs(cwd) {
  try {
    const proc = Bun.spawn(["bd", "list", "--type", "bug", "--all", "--limit", "0", "--json"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_JSON_ENVELOPE: "1" },
      timeout: BD_TIMEOUT_MS,
      killSignal: "SIGKILL"
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? out : "";
  } catch {
    return "";
  }
}
function unreportedFailureAdvisory(pi) {
  pi.on("session_start", (_event, ctx) => {
    observed.delete(sessionKey(ctx));
  });
  pi.on("tool_result", (event, ctx) => {
    try {
      const command = commandFromInput(event.input ?? {});
      if (!command)
        return;
      const label = checkLabel(command);
      if (label === undefined)
        return;
      const signals = failureSignals(exitLine(event) + resultText(event));
      if (signals.length === 0)
        return;
      const key = sessionKey(ctx);
      let seen = observed.get(key);
      if (seen === undefined) {
        seen = new Map;
        observed.set(key, seen);
      }
      for (const signal of signals) {
        if (seen.size >= MAX_TRACKED && !seen.has(signal))
          return;
        seen.set(signal, label);
      }
    } catch {}
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const key = sessionKey(ctx);
    const seen = observed.get(key);
    observed.delete(key);
    try {
      if (seen === undefined || seen.size === 0)
        return;
      const cwd = ctx?.cwd ?? process.cwd();
      if (beadsDir(cwd) === undefined)
        return;
      const bugs = bugTexts(await listBugs(cwd));
      if (bugs === undefined)
        return;
      const unreported = unreportedFailures([...seen.keys()], bugs);
      if (unreported.length === 0)
        return;
      pi.sendMessage({
        customType: "com.srobroek.beads.unreported-failure",
        content: formatUnreportedAdvisory(unreported, seen),
        display: true,
        attribution: "user"
      }, { triggerTurn: false });
    } catch (error) {
      pi.logger.error("beads unreported-failure check failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
export {
  bugTexts,
  checkLabel,
  unreportedFailureAdvisory as default,
  failureSignals,
  formatUnreportedAdvisory,
  resetUnreportedFailureAdvisoryForTests,
  signalSubjects,
  unreportedFailures
};
