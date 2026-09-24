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

// extensions/bd-lease-heartbeat.ts
var HEARTBEAT_INTERVAL_MS = 60000;
var HEARTBEAT_TIMEOUT_MS = 1e4;
var PREFILTER = /\bbd\b[\s\S]{0,400}?--claim\b/;
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
var injectedRun = null;
var injectedClock = null;
function setHeartbeatRunForTests(run) {
  injectedRun = run;
}
function setHeartbeatClockForTests(clock) {
  injectedClock = clock;
}
var pendingClaims = new Map;
var activeBySession = new Map;
var toolSessions = new Map;
var contextKeys = new WeakMap;
var nextContextKey = 0;
function sessionKey(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0)
      return `session:${id}`;
  } catch {}
  const manager = ctx?.sessionManager;
  if (manager !== null && typeof manager === "object") {
    const existing = contextKeys.get(manager);
    if (existing !== undefined)
      return existing;
    const key = `manager:${++nextContextKey}`;
    contextKeys.set(manager, key);
    return key;
  }
  return "session:unknown";
}
function pendingKey(session, toolCallId) {
  return `${session}\x00${toolCallId}`;
}
function timerClock(ctx) {
  if (injectedClock !== null)
    return injectedClock;
  if (typeof ctx.setInterval !== "function" || typeof ctx.clearTimer !== "function")
    return;
  return {
    setInterval: (callback, milliseconds) => ctx.setInterval(callback, milliseconds),
    setTimeout: typeof ctx.setTimeout === "function" ? (callback, milliseconds) => ctx.setTimeout(callback, milliseconds) : undefined,
    clearTimer: (timer) => ctx.clearTimer(timer)
  };
}
function commandPositions(parsed) {
  const positions = [...parsed.commands];
  for (const child of parsed.nested)
    positions.push(...commandPositions(child));
  return positions;
}
function executableIndex(position) {
  if ((position.executable?.split("/").pop() ?? position.executable) !== "bd")
    return -1;
  return position.words.findIndex((word) => !word.quoted && (word.value.split("/").pop() ?? word.value) === "bd");
}
function claimInvocationIds(parsed) {
  if (parsed.unknown)
    return [];
  const ids = new Set;
  for (const position of commandPositions(parsed)) {
    const start = executableIndex(position);
    if (start < 0)
      continue;
    let update = false;
    let claim = false;
    const named = [];
    for (const token of position.words.slice(start + 1)) {
      if (!update) {
        if (!token.quoted && token.value === "update")
          update = true;
        continue;
      }
      if (!token.quoted && token.value === "--claim")
        claim = true;
      if (!token.value.startsWith("-") && BEAD_ID.test(token.value))
        named.push(token.value);
    }
    if (update && claim)
      for (const id of named)
        ids.add(id);
  }
  return [...ids];
}
function resultOutput(event) {
  const content = (event.content ?? []).map((part) => ("text" in part) && typeof part.text === "string" ? part.text : "").join(`
`);
  const details = event.details;
  const stdout = details !== null && typeof details === "object" && "stdout" in details && typeof details.stdout === "string" ? details.stdout : "";
  return [content, stdout].filter(Boolean).join(`
`);
}
function exitCode(event) {
  const details = event.details;
  if (details !== null && typeof details === "object" && "exitCode" in details && typeof details.exitCode === "number")
    return details.exitCode;
  return event.isError ? 1 : 0;
}
function claimPending(ctx, toolCallId) {
  return pendingClaims.get(pendingKey(sessionKey(ctx), toolCallId));
}
function decideLeaseHeartbeatClaim(parsed, event, ctx) {
  try {
    if (event.toolName !== "bash")
      return;
    const session = sessionKey(ctx);
    toolSessions.set(event.toolCallId, session);
    if (!PREFILTER.test(parsed.command))
      return;
    const ids = claimInvocationIds(parsed);
    if (ids.length === 0)
      return;
    const input = event.input;
    const inputCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ctx.cwd ?? process.cwd();
    pendingClaims.set(pendingKey(session, event.toolCallId), {
      toolCallId: event.toolCallId,
      session,
      cwd: leadingCdCwd(parsed.command, inputCwd),
      env: environmentForInput(event.input),
      ctx,
      ids
    });
  } catch {}
}
var GLOBAL_VALUE_FLAGS = {
  "--database": true,
  "--db": true,
  "--directory": true,
  "-C": true
};
function idsChangedBy(command) {
  const parsed = parse(command);
  if (parsed.unknown)
    return [];
  const changed = new Set;
  for (const position of commandPositions(parsed)) {
    const start = executableIndex(position);
    if (start < 0)
      continue;
    const ids = new Set;
    let verb;
    let status;
    let statusNeedsValue = false;
    const args = position.words.slice(start + 1);
    for (let i = 0;i < args.length; i++) {
      const token = args[i];
      if (!token)
        continue;
      if (verb === undefined) {
        if (!token.quoted && GLOBAL_VALUE_FLAGS[token.value] === true) {
          if (!token.value.includes("="))
            i++;
          continue;
        }
        if (!token.quoted && !token.value.startsWith("-"))
          verb = token.value.toLowerCase();
        continue;
      }
      if (statusNeedsValue) {
        if (!token.quoted)
          status = token.value.toLowerCase();
        statusNeedsValue = false;
        continue;
      }
      if (!token.quoted && token.value === "--status") {
        statusNeedsValue = true;
        continue;
      }
      if (!token.quoted && token.value.startsWith("--status=")) {
        status = token.value.slice("--status=".length).toLowerCase();
        continue;
      }
      if (!token.value.startsWith("-") && BEAD_ID.test(token.value))
        ids.add(token.value);
    }
    if (verb === "close" || verb === "done" || verb === "unclaim" || verb === "update" && status !== undefined && status !== "in_progress") {
      for (const id of ids)
        changed.add(id);
    }
  }
  return [...changed];
}
function stateFor(session) {
  let state = activeBySession.get(session);
  if (state === undefined) {
    state = new Map;
    activeBySession.set(session, state);
  }
  return state;
}
function stopHeartbeat(active) {
  if (active.stopped)
    return;
  active.stopped = true;
  try {
    active.clock.clearTimer(active.timer);
  } catch {}
  const state = activeBySession.get(active.session);
  if (state?.get(active.id) === active) {
    state.delete(active.id);
    if (state.size === 0)
      activeBySession.delete(active.session);
  }
}
function unrefTimer(timer) {
  if (timer === null || typeof timer !== "object" && typeof timer !== "function")
    return;
  try {
    const unref = timer.unref;
    if (typeof unref === "function")
      unref.call(timer);
  } catch {}
}
function noticeFailure(active, reason) {
  if (active.noticed)
    return;
  active.noticed = true;
  try {
    const message = {
      customType: "com.srobroek.beads.lease-heartbeat",
      content: `Beads lease heartbeat failed for ${active.id}; the claim may no longer be held (${reason}).`,
      display: true,
      attribution: "user"
    };
    Promise.resolve(active.pi.sendMessage(message, { deliverAs: "aside", triggerTurn: false })).catch(() => {
      return;
    });
  } catch {}
}
async function heartbeat(active) {
  if (active.stopped || active.running)
    return;
  active.running = true;
  let timeoutTimer;
  try {
    const deadline = Date.now() + HEARTBEAT_TIMEOUT_MS;
    const run = injectedRun ?? defaultRun;
    const command = Promise.resolve().then(() => run(["bd", "heartbeat", active.id, "--json"], active.cwd, active.env, deadline));
    let result;
    if (active.clock.setTimeout === undefined) {
      result = await command;
    } else {
      const timeout = Promise.withResolvers();
      timeoutTimer = active.clock.setTimeout?.(() => timeout.resolve({ exitCode: 124, stdout: "", stderr: "bd heartbeat timed out" }), HEARTBEAT_TIMEOUT_MS);
      unrefTimer(timeoutTimer);
      result = await Promise.race([command, timeout.promise]);
    }
    if (timeoutTimer !== undefined)
      active.clock.clearTimer(timeoutTimer);
    if (active.stopped)
      return;
    const output = result.stdout.trim();
    let jsonError;
    if (output.length > 0) {
      try {
        const parsed = JSON.parse(output);
        if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
          const error = parsed.error;
          if (error !== undefined && error !== null && String(error).trim() !== "")
            jsonError = `bd heartbeat returned an error: ${String(error)}`;
        }
      } catch {
        jsonError = "bd heartbeat returned invalid JSON";
      }
    }
    if (Date.now() >= deadline || result.exitCode === 124) {
      noticeFailure(active, "bd heartbeat timed out");
      stopHeartbeat(active);
    } else if (result.exitCode !== 0) {
      noticeFailure(active, result.stderr?.replace(/\s+/g, " ").trim() || `bd exited ${result.exitCode}`);
      stopHeartbeat(active);
    } else if (jsonError !== undefined) {
      noticeFailure(active, jsonError);
      stopHeartbeat(active);
    }
  } catch (error) {
    if (timeoutTimer !== undefined)
      active.clock.clearTimer(timeoutTimer);
    if (!active.stopped) {
      noticeFailure(active, error instanceof Error ? error.message : String(error));
      stopHeartbeat(active);
    }
  } finally {
    active.running = false;
  }
}
function startHeartbeat(pi, claim, id) {
  const clock = timerClock(claim.ctx);
  if (clock === undefined)
    return;
  const state = stateFor(claim.session);
  if (state.has(id))
    return;
  const active = {};
  active.id = id;
  active.session = claim.session;
  active.cwd = claim.cwd;
  active.env = claim.env;
  active.ctx = claim.ctx;
  active.pi = pi;
  active.clock = clock;
  active.running = false;
  active.stopped = false;
  active.paused = false;
  active.noticed = false;
  try {
    active.timer = clock.setInterval(() => heartbeat(active), HEARTBEAT_INTERVAL_MS);
    unrefTimer(active.timer);
    state.set(id, active);
  } catch {
    active.stopped = true;
  }
}
function pauseSession(session) {
  const state = activeBySession.get(session);
  if (state === undefined)
    return;
  for (const active of state.values()) {
    if (active.stopped || active.paused)
      continue;
    active.paused = true;
    try {
      active.clock.clearTimer(active.timer);
    } catch {}
  }
}
function resumeSession(session) {
  const state = activeBySession.get(session);
  if (state === undefined)
    return;
  for (const active of [...state.values()]) {
    if (active.stopped || !active.paused)
      continue;
    active.paused = false;
    try {
      active.timer = active.clock.setInterval(() => heartbeat(active), HEARTBEAT_INTERVAL_MS);
      unrefTimer(active.timer);
    } catch {
      stopHeartbeat(active);
      continue;
    }
    heartbeat(active);
  }
}
function stopSession(session) {
  const state = activeBySession.get(session);
  if (state === undefined)
    return;
  for (const active of [...state.values()])
    stopHeartbeat(active);
}
function stopAllSessions() {
  for (const session of [...activeBySession.keys()])
    stopSession(session);
}
async function onToolResult(pi, event, ctx) {
  try {
    const claim = claimPending(ctx, event.toolCallId);
    if (claim === undefined)
      return;
    pendingClaims.delete(pendingKey(claim.session, claim.toolCallId));
    if (event.isError || exitCode(event) !== 0)
      return;
    const ids = new Set([...claim.ids, ...claimedIds(resultOutput(event))]);
    for (const id of ids)
      startHeartbeat(pi, claim, id);
    return;
  } catch {
    return;
  }
}
async function onStopResult(event, ctx) {
  try {
    const recordedSession = toolSessions.get(event.toolCallId);
    toolSessions.delete(event.toolCallId);
    if (event.toolName !== "bash" || event.isError || exitCode(event) !== 0)
      return;
    const input = event.input;
    if (typeof input.command !== "string")
      return;
    const session = recordedSession ?? sessionKey(ctx);
    const state = activeBySession.get(session);
    if (state === undefined)
      return;
    for (const id of idsChangedBy(input.command)) {
      const active = state.get(id);
      if (active !== undefined)
        stopHeartbeat(active);
    }
  } catch {}
}
function bdLeaseHeartbeat(pi) {
  pi.on("tool_call", (event, ctx) => {
    try {
      if (event.toolName !== "bash")
        return;
      const input = event.input;
      if (typeof input.command !== "string")
        return;
      decideLeaseHeartbeatClaim(parse(input.command), event, ctx);
    } catch {}
  });
  pi.on("tool_result", async (event, ctx) => {
    await onToolResult(pi, event, ctx);
    await onStopResult(event, ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    try {
      pauseSession(sessionKey(ctx));
    } catch {}
  });
  pi.on("agent_start", (_event, ctx) => {
    try {
      resumeSession(sessionKey(ctx));
    } catch {}
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    try {
      stopAllSessions();
      pendingClaims.clear();
    } catch {}
  });
}
async function defaultRun(argv, cwd, env, deadline = Date.now() + HEARTBEAT_TIMEOUT_MS) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return { exitCode: 124, stdout: "", stderr: "bd heartbeat timed out" };
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: remaining,
    killSignal: "SIGKILL",
    env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" }
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (Date.now() >= deadline)
    return { exitCode: 124, stdout: "", stderr: "bd heartbeat timed out" };
  return { exitCode: await proc.exited ?? 1, stdout, stderr };
}
export {
  HEARTBEAT_INTERVAL_MS,
  decideLeaseHeartbeatClaim,
  bdLeaseHeartbeat as default,
  setHeartbeatClockForTests,
  setHeartbeatRunForTests
};
