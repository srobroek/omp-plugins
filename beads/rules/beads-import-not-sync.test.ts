import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "beads-import-not-sync.md");

function condition(): RegExp {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error("no frontmatter");
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const parsed = JSON.parse(line.slice("condition:".length).trim()) as string | string[];
	const pattern = Array.isArray(parsed) ? (parsed[0] as string) : parsed;
	const flags = /^\(\?([ims]+)\)/.exec(pattern);
	return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
}

const FIRE = [
	"bd import snapshot.jsonl",
	"bd -C repo import snapshot.jsonl --allow-stale",
	"bd --directory repo import snapshot.jsonl",
	"BEADS_ACTOR=omp/a bd import snapshot.jsonl",
	"build && bd import snapshot.jsonl",
	"if ready; then bd import snapshot.jsonl",
];

const HOLD = [
	"echo 'bd import snapshot.jsonl'",
	"git commit -m 'document bd import snapshot.jsonl'",
	"bd import --help",
	"bd dolt pull",
];

describe("beads-import-not-sync", () => {
	const re = condition();
	for (const text of FIRE) test(`fires: ${text}`, () => expect(re.test(text)).toBe(true));
	for (const text of HOLD) test(`holds: ${text}`, () => expect(re.test(text)).toBe(false));
});
