import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "beads-dolt-sync-cadence.md");

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
	"bd dolt pull",
	"bd dolt push",
	"bd -C repo dolt pull",
	"bd --directory repo dolt push",
	"HOME=/tmp/h BEADS_ACTOR=omp/a bd dolt push",
	"bun test && bd dolt push",
	"if landed; then bd dolt push",
];

const HOLD = [
	"echo 'bd dolt push'",
	"git commit -m \"run bd dolt pull first\"",
	"bd dolt status",
	"bd dolt start",
	"git push origin main",
	"bd list --json",
];

describe("beads-dolt-sync-cadence", () => {
	const re = condition();
	for (const text of FIRE) test(`fires: ${text}`, () => expect(re.test(text)).toBe(true));
	for (const text of HOLD) test(`does not fire: ${text}`, () => expect(re.test(text)).toBe(false));
});
