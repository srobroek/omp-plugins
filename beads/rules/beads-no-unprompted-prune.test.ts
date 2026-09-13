import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "beads-no-unprompted-prune.md");

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
	"bd prune --older-than 90d",
	"task && bd -C . flatten --force",
	"bd --directory . purge",
	"bd purge --force; bd prune --dry-run",
	"BEADS_ACTOR=omp/a bd flatten --force",
	"if ready; then bd prune --older-than 90d",
];

const HOLD = [
	"bd prune --dry-run",
	"bd purge --help",
	"echo 'bd purge --force'",
	"git commit -m 'document bd flatten'",
];

describe("beads-no-unprompted-prune", () => {
	const re = condition();
	for (const text of FIRE) test(`fires: ${text}`, () => expect(re.test(text)).toBe(true));
	for (const text of HOLD) test(`holds: ${text}`, () => expect(re.test(text)).toBe(false));
});
