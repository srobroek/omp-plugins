// @bun
// package.json
var package_default = {
  name: "@srobroek/beads",
  version: "2.0.2",
  description: "Beads issue tracking: dependency DAGs, formulas, and decisions recorded as beads.",
  private: true,
  omp: {
    extensions: [
      "./dist/bash-gates.js",
      "./dist/formula-check-tool.js",
      "./dist/bd-pool-discipline.js",
      "./dist/session-beads-lifecycle.js",
      "./dist/unreported-failure-advisory.js",
      "./dist/claim-before-branch.js"
    ]
  }
};

// extensions/shell-tokenizer.ts
var SEPARATORS = new Set([";", "&", "|", "(", ")", `
`]);

// extensions/shell-command.ts
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
function invocationFromArgv(args) {
  const scanned = scanGlobals(args, 0);
  const verb = args[scanned.next];
  if (verb === undefined)
    return;
  return { verb: verb.toLowerCase(), args: args.slice(scanned.next + 1), globals: scanned.globals, prefix: [], exported: {} };
}

// extensions/bd-embedded-write-lock.ts
import { closeSync, existsSync, openSync, readFileSync, realpathSync as realpathSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { isAbsolute as isAbsolute2, join, resolve as resolve2 } from "path";

// extensions/beads-store.ts
import { execFileSync } from "child_process";
import { realpathSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
function repoIdentity(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return realpathSync(isAbsolute(out) ? out : resolve(cwd, out));
  } catch {
    return cwd;
  }
}
function sessionPinFor(cwd) {
  const local = resolve(cwd, ".beads");
  const common = repoIdentity(cwd);
  if (common !== cwd && common.endsWith("/.git")) {
    const primaryRoot = resolve(common, "..");
    if (realpathSync(cwd) === primaryRoot && isDir(local))
      return local;
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
var BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
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
    return subaction === undefined || !BEAD_ID.test(subaction);
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
    const holder = JSON.parse(readFileSync(lock, "utf8"));
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
async function withEmbeddedWriteLock(cwd, toolCallId, write, env = process.env) {
  const store = embeddedStoreFor(cwd, env);
  if (store === undefined)
    return { kind: "done", value: await write() };
  const got = await hold(store, toolCallId);
  if (got.kind === "failed")
    return got;
  try {
    return { kind: "done", value: await write() };
  } finally {
    release(store, toolCallId);
  }
}
var activeHolds = new Map;
var surrenderedCalls = new Set;

// extensions/session-beads-lifecycle.ts
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

// extensions/formula-check-tool.ts
var BEADS_PRESENT = Symbol.for("com.srobroek.beads.present.v1");
globalThis[BEADS_PRESENT] = { version: package_default.version };
var TIMEOUT_MS = 120000;
var VALID_GATE_TYPES = ["human", "timer", "gh:run", "gh:pr"];
var injectedSpawn = null;
function setBdSpawnForTests(fn) {
  injectedSpawn = fn;
}
async function runBd(cmd, cwd, holder, env = process.env) {
  if (!writesStore(invocationFromArgv(cmd)))
    return spawnBd(cmd, cwd, env);
  const locked = await withEmbeddedWriteLock(cwd ?? process.cwd(), holder ?? `bd-formula-check-${process.pid}-${runs++}`, () => spawnBd(cmd, cwd, env), env);
  if (locked.kind === "failed")
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: locked.reason };
  return locked.value;
}
var runs = 0;
async function spawnBd(cmd, cwd, env) {
  if (injectedSpawn !== null)
    return injectedSpawn(cmd, cwd, env);
  try {
    const proc = Bun.spawn(["bd", ...cmd], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL"
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: message };
  }
}
async function cookCheck(formula, varargs, cwd, env = process.env) {
  const result = await runBd(["cook", formula, "--dry-run", ...varargs], cwd, undefined, env);
  if (result.error)
    return [`cook failed to spawn: ${result.error}`];
  if (!result.ok) {
    const out = [result.stdout, result.stderr].filter(Boolean).join(`
`).trim();
    return [`cook failed \u2014 the real error:
${out}`];
  }
  return [];
}
function parseDryRun(out) {
  const steps = [];
  const gates = [];
  const re = /^\s+- (.*?) \(from ([^)]+)\)\s*$/;
  for (const line of out.split(`
`)) {
    const m = line.match(re);
    if (!m)
      continue;
    const title = m[1];
    const origin = m[2];
    if (title === undefined || origin === undefined)
      continue;
    if (title.startsWith("Gate:") && origin.includes(".gate-")) {
      gates.push(title);
    } else {
      steps.push(`${title} <- ${origin}`);
    }
  }
  return { steps, gates };
}
function jsonItem(item, gate) {
  if (typeof item === "string")
    return gate && !item.startsWith("Gate:") ? `Gate: ${item}` : item;
  if (!item || typeof item !== "object" || Array.isArray(item))
    return;
  const record = item;
  const title = [record.title, record.name, record.label, record.type].find((value) => typeof value === "string" && value.trim() !== "");
  if (!title)
    return;
  if (gate)
    return title.startsWith("Gate:") ? title : `Gate: ${title}`;
  const origin = [record.origin, record.source, record.id, record.path].find((value) => typeof value === "string" && value.trim() !== "");
  return origin ? `${title} <- ${origin}` : undefined;
}
function parseDryRunJson(out) {
  const parsed = parseTrailingJson(out);
  if (parsed === undefined)
    return;
  const value = envelopeData(parsed);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return;
  const record = value;
  const steps = record.steps;
  const gates = record.gates;
  if (!Array.isArray(steps) || !Array.isArray(gates))
    return;
  const normalizedSteps = steps.map((item) => jsonItem(item, false));
  const normalizedGates = gates.map((item) => jsonItem(item, true));
  if (normalizedSteps.some((item) => item === undefined) || normalizedGates.some((item) => item === undefined))
    return;
  return { steps: normalizedSteps, gates: normalizedGates };
}
function bodySteps(steps) {
  return steps.filter((s) => {
    const origin = s.split(" <- ", 2)[1] ?? "";
    return origin.includes(".");
  });
}
function gateTypeFailures(gates) {
  const failures = [];
  for (const g of gates) {
    const t = g.replace("Gate:", "").trim();
    if (!VALID_GATE_TYPES.includes(t)) {
      failures.push(`gate type ${JSON.stringify(t)} is not in ${JSON.stringify([...VALID_GATE_TYPES].sort())} \u2014 it is accepted at cook, poured as an open gate, then SKIPPED by \`bd gate check\`, so the step waits forever`);
    }
  }
  return failures;
}
function unsubstitutedFailures(out) {
  if (!out.includes("{{"))
    return [];
  const failures = [];
  for (const line of out.split(`
`)) {
    if (line.includes("{{")) {
      failures.push(`unsubstituted {{var}} in pour output: ${line.trim()}`);
    }
  }
  return failures;
}
function deepAssertFromMol(mol) {
  if (!mol || typeof mol !== "object")
    return ["mol show returned malformed data"];
  const issues = mol.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return ["mol show returned no `issues` array; cannot verify the anchor rule"];
  }
  if (!Array.isArray(mol.dependencies))
    return ["mol show returned no `dependencies` array"];
  const titles = new Map;
  for (const issue of issues) {
    if (!issue || typeof issue !== "object")
      return ["mol show returned malformed or duplicate issues"];
    const record = issue;
    if (typeof record.id !== "string" || !record.id || titles.has(record.id)) {
      return ["mol show returned malformed or duplicate issues"];
    }
    titles.set(record.id, typeof record.title === "string" ? record.title : record.id);
  }
  const blocked = new Set;
  for (const edge of mol.dependencies) {
    if (!edge || typeof edge !== "object")
      return ["mol show returned malformed dependencies"];
    const record = edge;
    if (typeof record.issue_id !== "string" || typeof record.depends_on_id !== "string" || !titles.has(record.issue_id) || !titles.has(record.depends_on_id)) {
      return ["mol show returned malformed dependencies"];
    }
    blocked.add(record.issue_id);
  }
  const zeroDep = [...titles.keys()].filter((id) => !blocked.has(id)).map((id) => titles.get(id) ?? id);
  if (zeroDep.length !== 1) {
    return [
      `${zeroDep.length} steps have no dependency; expected exactly one entry point (more than one entry point or a cycle violates the anchor rule): ${JSON.stringify(zeroDep)}`
    ];
  }
  return [];
}
var UNRECOGNISED_POUR_OUTPUT = "formula-check: unrecognised pour output; run the command manually";
function parsePourHelp(stdout, stderr = "") {
  const text = [stdout, stderr].filter(Boolean).join(`
`).trim();
  if (/\B--json\b/.test(text) && /\bmol\s+pour\b/i.test(text))
    return { json: true };
  if (/\b(?:usage|options|flags)\b/i.test(text) && /\bmol\s+pour\b/i.test(text))
    return { json: false };
  return { error: UNRECOGNISED_POUR_OUTPUT };
}
async function deepAssert(formula, varargs, toolCallId, workspace, env = process.env) {
  const locked = await withEmbeddedWriteLock(workspace ?? process.cwd(), toolCallId, async () => {
    const poured = await runBd(["mol", "pour", formula, ...varargs], workspace, toolCallId, env);
    const combined = [poured.stdout, poured.stderr].join(`
`);
    const root = combined.match(/Root issue: (\S+)/)?.[1];
    const recovery = root ? `Created root ${root} remains in ${workspace ?? "the current workspace"}; inspect with bd mol show ${root}. No cleanup was attempted.` : "Pour may have created state, but no root id was recovered. Inspect the workspace before retrying; no cleanup was attempted.";
    if (poured.error || !poured.ok)
      return [`real pour failed: ${poured.error ?? combined}
${recovery}`];
    if (!root)
      return [recovery];
    const shown = await runBd(["mol", "show", root, "--json"], workspace, toolCallId, env);
    if (shown.error || !shown.ok)
      return [`mol show failed: ${shown.error ?? [shown.stdout, shown.stderr].join(`
`)}
${recovery}`];
    const mol = envelopeData(parseTrailingJson(shown.stdout));
    const failures = deepAssertFromMol(mol);
    return failures.map((failure) => `${failure}
${recovery}`);
  }, env);
  if (locked.kind === "failed")
    return [`real pour was not attempted: ${locked.reason}`];
  return locked.value;
}
async function assertFormula(params, toolCallId) {
  const varargs = [];
  for (const v of params.varargs ?? []) {
    varargs.push("--var", v);
  }
  const cwd = params.workspace;
  const failures = [];
  const cookFails = await cookCheck(params.formula, varargs, cwd);
  if (cookFails.length) {
    const text = cookFails.map((f) => `FAIL ${f}`).join(`
`);
    return { ok: false, text, failures: cookFails, steps: 0, gates: 0 };
  }
  const help = await runBd(["mol", "pour", "--help"], cwd);
  const capability = parsePourHelp(help.stdout, help.stderr);
  if (help.error || !help.ok || "error" in capability) {
    const failure = help.error ?? ("error" in capability ? capability.error : "bd mol pour --help failed");
    return { ok: false, text: `FAIL ${failure}`, failures: [failure], steps: 0, gates: 0 };
  }
  const dryArgs = ["mol", "pour", params.formula, "--dry-run", ...capability.json ? ["--json"] : [], ...varargs];
  const dry = await runBd(dryArgs, cwd);
  if (dry.error || !dry.ok) {
    const out = dry.error ? dry.error : [dry.stdout, dry.stderr].filter(Boolean).join(`
`).trim();
    const fail = `pour --dry-run failed:
${out}`;
    return { ok: false, text: `FAIL ${fail}`, failures: [fail], steps: 0, gates: 0 };
  }
  const listing = [dry.stdout, dry.stderr].filter(Boolean).join(`
`);
  const parsed = capability.json ? parseDryRunJson(listing) : parseDryRun(listing);
  if (!parsed || !capability.json && parsed.steps.length === 0 && parsed.gates.length === 0) {
    return { ok: false, text: `FAIL ${UNRECOGNISED_POUR_OUTPUT}`, failures: [UNRECOGNISED_POUR_OUTPUT], steps: 0, gates: 0 };
  }
  const body = bodySteps(parsed.steps);
  if (body.length === 0)
    failures.push("pour --dry-run returned no recognized body steps; cannot verify this formula");
  const lines = [
    `selection: ${(params.varargs ?? []).join(" ") || "(defaults)"}`,
    `  steps poured: ${body.length}   gates: ${parsed.gates.length}`
  ];
  if (params.expectSteps !== undefined && body.length !== params.expectSteps) {
    failures.push(`step count ${body.length} != expected ${params.expectSteps}`);
  }
  if (params.expectGates !== undefined && parsed.gates.length !== params.expectGates) {
    failures.push(`gate count ${parsed.gates.length} != expected ${params.expectGates}`);
  }
  failures.push(...gateTypeFailures(parsed.gates));
  failures.push(...unsubstitutedFailures(listing));
  if (params.deep && failures.length === 0) {
    failures.push(...await deepAssert(params.formula, varargs, toolCallId, cwd));
  }
  for (const f of failures)
    lines.push(`FAIL ${f}`);
  if (!failures.length)
    lines.push("  OK");
  return {
    ok: failures.length === 0,
    text: lines.join(`
`),
    failures,
    steps: body.length,
    gates: parsed.gates.length
  };
}
function formulaCheckTool(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: "bd_formula_check",
    label: "Assert bd formula pour",
    description: "Cook-validate a bd formula, parse `bd mol pour --dry-run`, check gates and unsubstituted braces. Default is dry-run (read). deep=true performs a real pour in the workspace and uses exec approval.",
    parameters: z.object({
      formula: z.string().describe("Formula stem to assert"),
      varargs: z.array(z.string()).optional().describe("Selection vars as k=v pairs (passed as --var)"),
      deep: z.boolean().optional().describe("If true, pour for real and assert a single entry point (mutates workspace; exec approval)"),
      workspace: z.string().optional().describe("Repo cwd for bd; defaults to the current working directory"),
      expectSteps: z.number().optional().describe("Expected body step count"),
      expectGates: z.number().optional().describe("Expected gate count")
    }),
    approval: (toolCall) => {
      let input;
      if (typeof toolCall === "object" && toolCall !== null && "input" in toolCall) {
        input = toolCall.input;
      }
      const deep = typeof input === "object" && input !== null && "deep" in input && Boolean(input.deep);
      return deep ? "exec" : "read";
    },
    execute: async (toolCallId, params) => {
      const result = await assertFormula(params, toolCallId);
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          ok: result.ok,
          formula: params.formula,
          varargs: params.varargs ?? [],
          deep: Boolean(params.deep),
          steps: result.steps,
          gates: result.gates,
          failures: result.failures
        }
      };
    }
  });
}
export {
  VALID_GATE_TYPES,
  assertFormula,
  bodySteps,
  cookCheck,
  deepAssert,
  deepAssertFromMol,
  formulaCheckTool as default,
  gateTypeFailures,
  parseDryRun,
  parseDryRunJson,
  parsePourHelp,
  runBd,
  setBdSpawnForTests,
  unsubstitutedFailures
};
