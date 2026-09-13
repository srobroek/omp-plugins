import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "beads-no-bd-edit.md");

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
	"bd edit task-1",
	"build && bd -C repo edit task-1",
	"BEADS_ACTOR=omp/a bd edit task-1",
	"bd --directory repo edit task-1",
	"if ready; then bd edit task-1",
];

const HOLD = [
	"echo 'bd edit task-1'",
	"git commit -m 'bd edit docs'",
	"bd edit --help",
	"bd help edit",
];

describe("beads-no-bd-edit", () => {
	const re = condition();
	for (const text of FIRE) test(`fires: ${text}`, () => expect(re.test(text)).toBe(true));
	for (const text of HOLD) test(`holds: ${text}`, () => expect(re.test(text)).toBe(false));
});
