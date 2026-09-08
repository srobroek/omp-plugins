#!/usr/bin/env bun
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";

interface Named { name: string; path?: string; filePath?: string; _source?: { path: string } }
interface Registered { definition: Named }
interface LoadResult { extensions: unknown[]; runtime: unknown; errors: Array<{ path: string; error: string }> }
interface CatalogEntry { name: string; source: string }

// Run with Bun and a pinned, separately installed OMP. No provider requests or MCP startup.
const VERSION = "18.1.14";
const repo = resolve(process.env.OMP_SMOKE_REPO ?? join(import.meta.dir, ".."));
const started = performance.now();
const timeoutMs = Number(process.env.OMP_SMOKE_TIMEOUT_MS ?? 600_000);
const host = process.env.OMP_HOST_ROOT;
const cli = process.env.OMP_BIN ?? "omp";
const rows: unknown[] = [];
const children = new Set<Subprocess>();
let interrupted = false;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function files(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const out: string[] = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (["node_modules", ".git", ".beads"].includes(e.name)) continue;
    const p = join(path, e.name);
    if (e.isDirectory()) out.push(...await files(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
function same(actual: string[], expected: string[], label: string) {
  const a = [...actual].sort(), b = [...expected].sort();
  check(JSON.stringify(a) === JSON.stringify(b), `${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function command(argv: string[], cwd: string, env: Record<string, string>, deadline = 60_000) {
  check(!interrupted && performance.now() - started < timeoutMs, "Smoke interrupted or deadline exceeded");
  const p = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.add(p);
  const timer = setTimeout(() => p.kill("SIGKILL"), deadline);
  try {
    const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    // Never print CLI stderr: failures may contain configuration values.
    return { code, stdout };
  } finally { clearTimeout(timer); children.delete(p); }
}
async function expected(root: string) {
  const pkg = await json(join(root, "package.json"));
  check(pkg.omp && typeof pkg.omp === "object" && !Array.isArray(pkg.omp), `${basename(root)}: malformed omp marker`);
  const manifest = await json(join(root, ".omp-plugin/plugin.json"));
  const extensions = pkg.omp.extensions ?? [];
  check(Array.isArray(extensions), `${basename(root)}: invalid extensions declaration`);
  for (const asset of extensions) check(typeof asset === "string" && existsSync(resolve(root, asset)), `${basename(root)}: missing manifest asset ${asset}`);
  const names = async (surface: string, suffix: string) => (await files(join(root, surface))).filter(p => p.endsWith(suffix));
  const rules = await names("rules", ".md");
  const agents = await names("agents", ".md");
  const skills = await names("skills", "/SKILL.md");
  const agentNames = await Promise.all(agents.map(async p => {
    const text = await readFile(p, "utf8");
    const match = text.match(/^name:\s*["']?([^\r\n"']+)/m);
    check(match, `${p}: agent has no name`); return match[1].trim();
  }));
  // Tool names are not a package.json field: declarations in the manifest-selected
  // source entries are the independent expectation, including cold dist runs.
  const tools: string[] = [];
  for (const entry of extensions) {
    const source = String(entry).replace(/^\.\/dist\//, "./extensions/").replace(/\.js$/, ".ts");
    const text = await readFile(resolve(root, source), "utf8");
    const registrations = [...text.matchAll(/\.registerTool\s*\(\s*\{\s*name:\s*["']([^"']+)["']/g)];
    check(registrations.length === (text.match(/\.registerTool\s*\(/g) ?? []).length, `${source}: unsupported tool declaration; add an explicit expectation`);
    tools.push(...registrations.map(m => m[1]));
  }
  const mcp = typeof manifest.mcpServers === "object" ? Object.keys(manifest.mcpServers) : [];
  return {
    name: basename(root), root, extensions: extensions.map((p: string) => resolve(root, p)), tools,
    rules: rules.map(p => basename(p, ".md")), agents: agentNames, skills: skills.map(p => basename(dirname(p))), mcp
  };
}

async function worker(configPath: string) {
  const config = await json(configPath);
  check(host, "Set OMP_HOST_ROOT to the pinned OMP package directory");
  // The host installation is runtime-selected and is deliberately not a repo dependency.
  const sdk = (p: string) => import(join(host, "src", `${p}.ts`));
  const { discoverAndLoadExtensions, discoverExtensionPaths, loadExtensions } = await sdk("extensibility/extensions/loader");
  const { ExtensionRunner } = await sdk("extensibility/extensions/runner");
  const { wrapRegisteredTools, ExtensionToolWrapper } = await sdk("extensibility/extensions/wrapper");
  const { SessionManager } = await sdk("session/session-manager");
  const { ModelRegistry } = await sdk("config/model-registry");
  const { discoverAuthStorage } = await sdk("session/auth-broker-config");
  const { loadCapability } = await sdk("discovery/index");
  const { discoverAgents } = await sdk("task/discovery");
  const { getEnabledPlugins } = await sdk("extensibility/plugins/loader");
  const { validateToolArguments } = await import(Bun.resolveSync("@oh-my-pi/pi-ai", host));
  check(typeof validateToolArguments === "function", "Host SDK lacks validateToolArguments");
  const cwd = process.cwd();
  const roots: string[] = config.roots;
  const expectations = await Promise.all(roots.map(expected));
  const installed = await getEnabledPlugins(cwd, { home: process.env.HOME });
  same(installed.map((p: Named) => p.name), expectations.map(p => `@srobroek/${p.name}`), "CLI install registry");
  for (const p of expectations) {
    const actual = installed.find((item: Named) => item.name === `@srobroek/${p.name}`);
    check(actual, `${p.name}: missing installed root`);
    p.extensions = p.extensions.map((entry: string) => resolve(actual.path, entry.slice(p.root.length + 1)));
    p.root = await realpath(actual.path);
  }
  const discovered = await discoverExtensionPaths([], cwd);
  same(discovered, expectations.flatMap(p => p.extensions), "registry extension discovery");
  const capabilities: Record<string, Named[]> = {};
  for (const id of ["skills", "rules", "mcps"]) {
    const result = await loadCapability(id, { cwd });
    check(!(result.errors?.length), `${id}: discovery errors`);
    capabilities[id] = result.items;
  }
  const agents = (await discoverAgents(cwd, process.env.HOME)).agents;
  const auth = await discoverAuthStorage(process.env.PI_CODING_AGENT_DIR);
  const registry = new ModelRegistry(auth, join(process.env.PI_CODING_AGENT_DIR!, "models.yml"));
  async function exercise(result: LoadResult, wanted: string[], label: string) {
    check(result.errors.length === 0, `${label}: ${result.errors.map(e => `${basename(e.path)}: ${e.error}`).join("; ")}`);
    const session = SessionManager.inMemory(cwd);
    const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, session, registry);
    const errors: string[] = [];
    runner.onError((e: { event: string; error: string }) => errors.push(`${e.event}: ${e.error}`));
    let active = [...wanted];
    const actions = {
      sendMessage: (message: { customType?: string; content?: unknown; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) => {
        check(!options?.triggerTurn, "Startup message requested a provider turn");
        session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      },
      sendUserMessage: () => { throw new Error("Unexpected provider interaction"); },
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      getActiveTools: () => active, getAllTools: () => runner.getAllRegisteredTools().map((t: Registered) => t.definition),
      setActiveTools: async (names: string[]) => { active = names; }, getCommands: () => [],
      setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: () => { },
      getSessionName: () => session.getSessionName(), setSessionName: (name: string) => session.setSessionName(name),
    };
    const context = {
      getModel: () => undefined, isIdle: () => true, abort: () => { }, hasPendingMessages: () => false,
      shutdown: () => { }, getSystemPrompt: () => []
    };
    try {
      for (let init = 0; init < 2; init++) {
        runner.initialize(actions, context, undefined, undefined, "rpc");
        await runner.emit({ type: "session_start" });
        same(runner.getAllRegisteredTools().map((t: Registered) => t.definition.name), wanted, `${label}: registration round ${init}`);
      }
      const tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
      for (const tool of tools) {
        check(tool.parameters, `${tool.name}: missing schema`);
        let rejected = false;
        try { validateToolArguments(tool, { type: "toolCall", id: "invalid", name: tool.name, arguments: null }); }
        catch { rejected = true; }
        check(rejected, `${tool.name}: host schema accepted null arguments`);
      }
      // Dispatch through the actual runner, not directly through captured pi handlers.
      const harmless = await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "smoke-read", input: { path: join(cwd, "absent.txt") } });
      check(!harmless?.block, `${label}: unrelated read was blocked`);
      const resume = tools.find((t: Named) => t.name === "resume_session");
      if (resume) {
        const args = { mode: "list", path: cwd, worktrees: false, git: false };
        validateToolArguments(resume, { type: "toolCall", id: "smoke-list", name: resume.name, arguments: args });
        const observed = await new ExtensionToolWrapper(resume, runner).execute("smoke-list", args);
        check(observed.details?.sessions === 0 && !observed.isError, `${label}: isolated session listing failed`);
      }
      const dep = tools.find((t: Named) => t.name === "dep_apply");
      if (dep) {
        const wrapped = new ExtensionToolWrapper(dep, runner);
        for (const autoApprove of [false, true]) for (const xdevApproved of [false, true]) {
          let rejected = false;
          try {
            const observed = await wrapped.execute(`smoke-denied-${autoApprove}-${xdevApproved}`,
              { ecosystem: "npm", name: "smoke-never-install", version: "0.0.0", path: cwd },
              undefined, undefined, { autoApprove, xdevApproved });
            rejected = typeof observed.details?.error === "string" && /interactive|approval|confirm/i.test(observed.details.error);
          } catch (e) { rejected = /requires approval|no interactive UI/.test(String(e)); }
          check(rejected, `${label}: dep_apply must reject headless, including yolo and xd dispatch`);
        }
      }
      check(errors.length === 0, `${label}: lifecycle errors: ${errors.join("; ")}`);
      return { extensions: result.extensions.length, tools: tools.length, initRounds: 2, schemaRejections: tools.length };
    } finally {
      await runner.emit({ type: "session_shutdown" });
      runner.clearManagedTimers();
      runner.disposeFileFallbacks();
      check(errors.length === 0, `${label}: lifecycle errors: ${errors.join("; ")}`);
    }
  }
  for (const p of expectations) {
    const counts: Record<string, number> = {};
    for (const [key, items] of [["skills", capabilities.skills], ["rules", capabilities.rules], ["agents", agents], ["mcp", capabilities.mcps]] as const) {
      const wanted = key === "mcp" && config.carrier === "marketplace" ? p.mcp.map(name => `${p.name}:${name}`) : p[key];
      const matched = items.filter((item: Named) => wanted.includes(item.name));
      const found = matched.map((item: Named) => item.name);
      for (const item of matched) {
        const source = item.filePath ?? item.path ?? item._source?.path;
        check(source && (await realpath(source)).startsWith(`${p.root}/`), `${p.name}: ${key} resolved outside its installed payload`);
      }
      const required = wanted;
      same(found, required, `${p.name}: ${config.carrier} ${key}`);
      counts[key] = found.length;
    }
    rows.push({
      plugin: p.name, carrier: config.carrier, variant: config.variant, ...counts,
      sourceExtensions: p.extensions.filter((entry: string) => entry.endsWith(".ts")).length,
      distExtensions: p.extensions.filter((entry: string) => entry.endsWith(".js")).length,
      ...await exercise(await loadExtensions(p.extensions, cwd), p.tools, p.name)
    });
  }
  const combined = await exercise(await discoverAndLoadExtensions([], cwd), expectations.flatMap(p => p.tools), "combined");
  auth.close();
  return { rows, combined, mcp: "discovery-only; no servers started" };
}

async function main() {
  check(host && existsSync(join(host, "src/extensibility/extensions/loader.ts")), "Set OMP_HOST_ROOT to an installed OMP18.1.14 package containing src");
  const sdkVersion = (await json(join(host, "package.json"))).version;
  check(sdkVersion === VERSION, `SDK version must be ${VERSION}; got ${sdkVersion}`);
  const entries: CatalogEntry[] = (await json(join(repo, ".omp-plugin/marketplace.json"))).plugins.filter((p: CatalogEntry) => typeof p.source === "string" && p.source.startsWith("./"));
  check(entries.length === 27, `Expected 27 checkout plugins, found ${entries.length}`);
  const temp = await mkdtemp(join(tmpdir(), "omp-plugin-loading-"));
  const clean = () => { interrupted = true; for (const child of children) child.kill("SIGKILL"); };
  const timer = setTimeout(clean, timeoutMs);
  process.on("SIGINT", clean); process.on("SIGTERM", clean);
  try {
    const baseEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "", LANG: "C.UTF-8", OMP_HOST_ROOT: resolve(host), OMP_BIN: cli,
      OPENAI_API_KEY: "isolated-smoke-not-a-credential", NO_COLOR: "1"
    };
    const variant = "declared";
    for (const carrier of ["link", "marketplace"]) {
      check(performance.now() - started < timeoutMs, "Overall smoke deadline exceeded");
      const caseStart = performance.now();
      const root = join(temp, `${variant}-${carrier}`), payload = join(root, "payload"), cwd = join(root, "work");
      const env = {
        ...baseEnv, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "home/.omp/agent"),
        XDG_CONFIG_HOME: join(root, "xdg/config"), XDG_DATA_HOME: join(root, "xdg/data"), XDG_CACHE_HOME: join(root, "xdg/cache"), XDG_STATE_HOME: join(root, "xdg/state")
      };
      for (const dir of [cwd, payload, env.HOME, env.PI_CODING_AGENT_DIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) await mkdir(dir, { recursive: true });
      const version = await command([cli, "--version"], cwd, env);
      check(version.code === 0 && version.stdout.includes(VERSION), `CLI must be OMP${VERSION}`);
      const roots: string[] = [];
      for (const entry of entries) {
        const target = join(payload, entry.name);
        await cp(resolve(repo, entry.source), target, {
          recursive: true, dereference: true,
          filter: p => !["node_modules", ".git", ".beads"].includes(basename(p)) && !/\.test\.[jt]s$/.test(p)
        });
        await expected(target);
        roots.push(target);
      }
      await mkdir(join(payload, ".omp-plugin"));
      await writeFile(join(payload, ".omp-plugin/marketplace.json"), JSON.stringify({ name: "isolated-smoke", owner: { name: "Smoke" }, plugins: entries }));
      const runCLI = async (args: string[]) => { const result = await command([cli, "plugin", ...args], cwd, env); check(result.code === 0, `CLI plugin ${args[0]} ${args[1] ?? ""} failed (${result.code}); output withheld`); };
      if (carrier === "marketplace") await runCLI(["marketplace", "add", payload]);
      for (const entry of entries) await runCLI(carrier === "link" ? ["link", join(payload, entry.name), "--scope", "project"] : ["install", `${entry.name}@isolated-smoke`, "--scope", "project"]);
      const config = join(root, "case.json");
      await writeFile(config, JSON.stringify({ roots, carrier, variant }));
      const child = Bun.spawn([process.execPath, import.meta.path, "--worker", config], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      children.add(child);
      const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      children.delete(child);
      check(code === 0, `${variant}/${carrier}: worker failed (${code}): ${stdout.trim()}`);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      check(result.rows.length === 27, "Worker returned incomplete coverage");
      rows.push({ variant, carrier, elapsedMs: Math.round(performance.now() - caseStart), ...result });
    }
    // Each fixture invokes the same real loader/manifest validator in an isolated
    // child; accepting a malformed fixture is a smoke failure, never a skipped case.
    for (const kind of ["broken-import", "missing-asset", "malformed-marker"]) {
      const root = join(temp, `negative-${kind}`);
      await cp(join(temp, "declared-link/payload/authoring"), root, { recursive: true });
      const pkgPath = join(root, "package.json"), pkg = await json(pkgPath);
      if (kind === "malformed-marker") pkg.omp = "invalid";
      else if (kind === "missing-asset") pkg.omp.extensions.push("./extensions/absent.ts");
      else await writeFile(resolve(root, pkg.omp.extensions[0]), 'import "./smoke-missing-import.ts"; export default function() {}\n');
      await writeFile(pkgPath, JSON.stringify(pkg));
      const env = {
        ...baseEnv, HOME: join(temp, "declared-link/home"), PI_CODING_AGENT_DIR: join(temp, "declared-link/home/.omp/agent"),
        XDG_CONFIG_HOME: join(temp, "declared-link/xdg/config"), XDG_DATA_HOME: join(temp, "declared-link/xdg/data"),
        XDG_CACHE_HOME: join(temp, "declared-link/xdg/cache"), XDG_STATE_HOME: join(temp, "declared-link/xdg/state")
      };
      const result = await command([process.execPath, import.meta.path, "--negative", root], join(temp, "declared-link/work"), env);
      check(result.code !== 0 && result.stdout.includes('"fixtureRejected":true'), `${kind}: fixture did not fail through the expected validation path`);
      rows.push({ negative: kind, exitCode: result.code, rejected: true });
    }
    return { status: "PASS", hostVersion: VERSION, plugins: 27, carrierCases: 54, negatives: 3, elapsedMs: Math.round(performance.now() - started), rows };
  } finally {
    clearTimeout(timer); clean(); process.off("SIGINT", clean); process.off("SIGTERM", clean);
    await rm(temp, { recursive: true, force: true });
  }
}
try {
  if (process.argv[2] === "--worker") console.log(JSON.stringify(await worker(process.argv[3])));
  else if (process.argv[2] === "--negative") {
    try {
      const p = await expected(process.argv[3]);
      const { loadExtensions } = await import(join(host!, "src/extensibility/extensions/loader.ts"));
      const loaded = await loadExtensions(p.extensions, process.cwd());
      check(loaded.errors.length === 0, "broken extension import");
      console.log(JSON.stringify({ fixtureRejected: false }));
    } catch { console.log(JSON.stringify({ fixtureRejected: true })); process.exitCode = 1; }
  } else console.log(JSON.stringify(await main()));
} catch (error) {
  console.log(JSON.stringify({ status: "FAIL", error: String(error), elapsedMs: Math.round(performance.now() - started), rows }));
  process.exitCode = 1;
}
