#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectDir = path.resolve(process.argv[2] ?? '.');
const settingsPath = path.join(projectDir, 'project.inlang', 'settings.json');

function fail(message) {
  console.error(`locale drift: ${message}`);
  process.exit(1);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`cannot read ${label} (${filePath}): ${error.message}`);
  }
}

function messageKeys(value, label, prefix = '', keys = new Set()) {
  if (typeof value === 'string' || Array.isArray(value)) {
    if (!prefix) fail(`${label} must be a message object`);
    keys.add(prefix);
    return keys;
  }

  if (!value || typeof value !== 'object') {
    fail(`${label} has unsupported value at ${prefix || '<root>'}`);
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    const id = prefix ? `${prefix}.${key}` : key;
    messageKeys(child, label, id, keys);
  }
  return keys;
}

const settings = readJson(settingsPath, 'Inlang settings');
const { baseLocale, locales = [] } = settings;
if (
  typeof baseLocale !== 'string' ||
  !Array.isArray(locales) ||
  locales.length === 0 ||
  locales.some((locale) => typeof locale !== 'string') ||
  !locales.includes(baseLocale)
) {
  fail('settings must declare a string baseLocale included in non-empty string locales');
}

const configuredPatterns =
  settings['plugin.inlang.messageFormat']?.pathPattern ??
  './messages/{locale}.json';
const patterns = Array.isArray(configuredPatterns)
  ? configuredPatterns
  : [configuredPatterns];
if (
  patterns.length === 0 ||
  patterns.some(
    (pattern) =>
      typeof pattern !== 'string' ||
      (!pattern.includes('{locale}') && !pattern.includes('{languageTag}')),
  )
) {
  fail('message pathPattern must contain {locale} or {languageTag}');
}

function keysForLocale(locale) {
  const keys = new Set();
  for (const pattern of patterns) {
    const relativePath = pattern
      .replaceAll('{locale}', locale)
      .replaceAll('{languageTag}', locale);
    const filePath = path.resolve(projectDir, relativePath);
    messageKeys(
      readJson(filePath, `catalog ${locale}`),
      `catalog ${locale}`,
      '',
      keys,
    );
  }
  return keys;
}

const baseKeys = keysForLocale(baseLocale);
if (baseKeys.size === 0) fail(`base catalog ${baseLocale} has no messages`);

let drift = false;
for (const locale of locales) {
  const keys = keysForLocale(locale);
  const missing = [...baseKeys].filter((key) => !keys.has(key)).sort();
  const orphaned = [...keys].filter((key) => !baseKeys.has(key)).sort();

  if (missing.length === 0 && orphaned.length === 0) {
    console.log(`${locale}: complete (${keys.size} keys)`);
    continue;
  }

  drift = true;
  console.error(`${locale}: ${missing.length} missing, ${orphaned.length} orphaned`);
  for (const key of missing) console.error(`  missing: ${key}`);
  for (const key of orphaned) console.error(`  orphaned: ${key}`);
}

if (drift) process.exit(1);
