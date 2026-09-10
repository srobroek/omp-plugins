import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `srobroek-quota-notice-continue` matches only the bare gateway line. The
 * corpus behind these cases is 44,288 assistant texts from live sessions:
 * 116 whole-line emissions ("weighted" and plain), 116 fires, every fire the
 * whole text, 0 false positives (2026-09-10).
 */
const RULE = path.join(import.meta.dir, "srobroek-quota-notice-continue.md");

function condition(): RegExp {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error("no frontmatter");
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const pattern = JSON.parse(line.slice("condition:".length).trim()) as string;
	const flags = /^\(\?([ims]+)\)/.exec(pattern);
	return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
}

const FIRE = [
	"You have 31348 weighted tokens left",
	"You have 8020 tokens left.",
	"You have 65176 tokens left",
	"You have 351 weighted tokens left\n",
	"Reading files.\nYou have 863 weighted tokens left\n",
	"  You have 8,162 weighted tokens left.",
];

const HOLD = [
	'The gateway said "You have 31348 weighted tokens left" in run-03; treat it as noise.',
	"You have 3 tokens left in the bucket",
	"| 3 | 2m21s | the model emitted the literal text \"You have 31348 weighted tokens left\" and returned |",
	"You have weighted tokens left",
	"weighted tokens left: 31348",
];

describe("srobroek-quota-notice-continue", () => {
	const re = condition();
	for (const text of FIRE) {
		test(`fires: ${JSON.stringify(text)}`, () => {
			expect(re.test(text)).toBe(true);
		});
	}
	for (const text of HOLD) {
		test(`holds: ${JSON.stringify(text)}`, () => {
			expect(re.test(text)).toBe(false);
		});
	}
});
