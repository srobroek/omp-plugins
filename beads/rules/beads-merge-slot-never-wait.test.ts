import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "beads-merge-slot-never-wait.md");

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
	"bd merge-slot acquire --holder me --wait",
	"bd -C repo merge-slot acquire --wait",
	"bd --directory repo merge-slot acquire --wait",
	"BEADS_ACTOR=omp/a bd merge-slot acquire --wait",
	"build && bd merge-slot acquire --wait",
	"if ready; then bd merge-slot acquire --wait",
];

const HOLD = [
	"echo 'bd merge-slot acquire --wait'",
	"git commit -m 'remove bd merge-slot --wait'",
	"bd merge-slot acquire --holder me",
	"bd merge-slot release --wait",
];

describe("beads-merge-slot-never-wait", () => {
	const re = condition();
	for (const text of FIRE) test(`fires: ${text}`, () => expect(re.test(text)).toBe(true));
	for (const text of HOLD) test(`holds: ${text}`, () => expect(re.test(text)).toBe(false));
});
