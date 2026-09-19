#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
const repo = resolve(dirname(import.meta.path), "..");
const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};
const load = async (path: string): Promise<JsonObject> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path}: expected a JSON object`);
    return value as JsonObject;
  } catch (error) {
    fail(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
};
const sorted = (values: Iterable<string>) => [...values].sort();
const describeMismatch = (label: string, actual: Set<string>, expected: Set<string>) => {
  const missing = sorted([...expected].filter((name) => !actual.has(name)));
  const extra = sorted([...actual].filter((name) => !expected.has(name)));
  if (missing.length || extra.length) {
    const details = [missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `extra ${extra.join(", ")}` : ""]
      .filter(Boolean)
      .join("; ");
    fail(`${label} mismatch: ${details}`);
  }
};

const manifestPaths = await Array.fromAsync(new Bun.Glob("*/.omp-plugin/plugin.json").scan({ cwd: repo, onlyFiles: true }));
const plugins = new Set<string>();
for (const relative of manifestPaths) {
  const name = relative.split("/")[0];
  plugins.add(name);
  const manifestPath = join(repo, relative);
  const manifest = await load(manifestPath);
  if (manifest.name !== name) fail(`${relative}: name ${JSON.stringify(manifest.name)} does not match directory ${name}`);
  const version = manifest.version;
  if (typeof version !== "string" || !version) fail(`${relative}: version must be a non-empty string`);
  const packagePath = join(repo, name, "package.json");
  const packageJson = await load(packagePath);
  if (packageJson.version !== version) {
    fail(`${name}: package.json version ${JSON.stringify(packageJson.version)} does not match plugin.json version ${JSON.stringify(version)}`);
  }
}

const marketplace = await load(join(repo, ".omp-plugin/marketplace.json"));
if (!Array.isArray(marketplace.plugins)) fail(".omp-plugin/marketplace.json: plugins must be an array");
const marketplaceNames = new Set<string>();
for (const entry of marketplace.plugins as unknown[]) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("marketplace entry must be an object");
  const source = (entry as JsonObject).source;
  const name = (entry as JsonObject).name;
  if (typeof source === "string" && source.startsWith("./")) {
    if (typeof name !== "string" || source !== `./${name}`) fail(`marketplace local source ${JSON.stringify(source)} has mismatched name`);
    marketplaceNames.add(name);
  }
}
describeMismatch("local marketplace entries and plugin manifests", marketplaceNames, plugins);

const release = await load(join(repo, "release-please-config.json"));
if (!release.packages || typeof release.packages !== "object" || Array.isArray(release.packages)) fail("release-please-config.json: packages must be an object");
const releaseNames = new Set(Object.keys(release.packages as JsonObject));
describeMismatch("release-please packages and plugin manifests", releaseNames, plugins);
console.log(`PASS: validated ${plugins.size} plugins against marketplace, release-please, and package versions`);
