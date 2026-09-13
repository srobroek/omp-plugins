import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "srobroek-package-investigate.md");

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

const MUST_FIRE = [
	"bun add zod",
	"npm i -D typescript",
	"pip install requests",
	"cargo add serde",
	"cd x && bun add left-pad",
];

const MUST_NOT_FIRE = [
	"bun install --frozen-lockfile >/dev/null 2>&1; bun x tsc",
	'bd create --description "investigate bun install --frozen-lockfile before release"',
	"bun install",
	"npm install --production=false && npm test",
	"pnpm install --frozen-lockfile > log 2>&1",
];

describe("srobroek-package-investigate", () => {
	const re = condition();
	for (const text of MUST_FIRE) {
		test(`fires: ${JSON.stringify(text)}`, () => {
			expect(re.test(text)).toBe(true);
		});
	}
	for (const text of MUST_NOT_FIRE) {
		test(`holds: ${JSON.stringify(text)}`, () => {
			expect(re.test(text)).toBe(false);
		});
	}
});
