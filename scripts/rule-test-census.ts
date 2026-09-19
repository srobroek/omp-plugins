#!/usr/bin/env bun
/**
 * Heuristic: a conditional rule is covered when a same-plugin *.test.ts file
 * contains the rule name and has at least two test()/it() blocks: one whose
 * title contains fire, match, or block, and one whose title contains not,
 * ignore, or allow. Keep the allowlist temporary: it may only shrink.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(import.meta.path), "..");
const allowlistPath = join(repo, "scripts/rule-test-census.allowlist");
const glob = new Bun.Glob("*/rules/*.md");
const files = await Array.fromAsync(glob.scan({ cwd: repo, onlyFiles: true }));
const conditional: Array<{ plugin: string; name: string; path: string }> = [];
for (const path of files) {
  const text = await readFile(join(repo, path), "utf8");
  if (!/^condition:\s*/m.test(text)) continue;
  const filename = path.split("/").at(-1);
  const fallbackName = filename?.replace(/\.md$/, "");
  const name = /^name:\s*(?:["']?)([^"'\n]+?)(?:["']?)\s*$/m.exec(text)?.[1]?.trim() ?? fallbackName;
  if (!name) throw new Error(`Unable to determine rule name from ${path}`);
  conditional.push({ plugin: path.split("/")[0] ?? "", name, path });
}
const allowText = await readFile(allowlistPath, "utf8").catch(() => "");
const allowlist = new Set(allowText.split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim()).filter(Boolean));
const stale: string[] = [];
const missing: string[] = [];
for (const rule of conditional) {
  const tests = await Array.fromAsync(new Bun.Glob(`${rule.plugin}/**/*.test.ts`).scan({ cwd: repo, onlyFiles: true }));
  const candidates = [];
  for (const test of tests) {
    const text = await readFile(join(repo, test), "utf8");
    if (!text.includes(rule.name)) continue;
    const titles = [...text.matchAll(/\b(?:test|it)\s*\(\s*["'`]([^"'`]+)["'`]/g)].flatMap((match) => match[1] ? [match[1].toLowerCase()] : []);
    const fires = titles.some((title) => /fire|match|block/.test(title));
    const allows = titles.some((title) => /not|ignore|allow/.test(title));
    if (fires && allows) candidates.push(test);
  }
  const covered = candidates.length > 0;
  if (covered && allowlist.has(rule.name)) stale.push(`${rule.name} (allowlist entry now covered by ${candidates[0]})`);
  else if (!covered && !allowlist.has(rule.name)) missing.push(`${rule.name} (${rule.path})`);
}
for (const name of allowlist) if (!conditional.some((rule) => rule.name === name)) stale.push(`${name} (no conditional rule)`);
if (stale.length || missing.length) {
  if (stale.length) console.error(`STALE ALLOWLIST (${stale.length}); remove covered/unknown entries:\n${stale.map((x) => `- ${x}`).join("\n")}`);
  if (missing.length) console.error(`MISSING RULE COVERAGE (${missing.length}); add a must-fire and must-not-fire test or allowlist temporarily:\n${missing.map((x) => `- ${x}`).join("\n")}`);
  process.exit(1);
}
console.log(`PASS: ${conditional.length} conditional rules covered; allowlist ${allowlist.size}`);
