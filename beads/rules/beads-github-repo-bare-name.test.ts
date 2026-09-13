import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "beads-github-repo-bare-name.md");

function conditions(): RegExp[] {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error("no frontmatter");
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const parsed = JSON.parse(line.slice("condition:".length).trim()) as string[];
	return parsed.map(pattern => {
		const flags = /^\(\?([ims]+)\)/.exec(pattern);
		return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
	});
}

const FIRE = [
	"bd config set github.repo owner/repo",
	"bd config set github.org owner",
	"bd -C repo config set github.repo owner/repo",
	"bd --directory repo config set github.org owner",
	"BEADS_ACTOR=omp/a bd config set github.repo owner/repo",
	"build && bd config set github.org owner",
];

const HOLD = [
	"echo 'bd config set github.repo owner/repo'",
	"git commit -m 'replace bd config set github.org'",
	"bd config set github.repo repo",
	"bd config set github.owner owner",
];

function matches(text: string, rules: RegExp[]): boolean {
	return rules.some(rule => rule.test(text));
}

describe("beads-github-repo-bare-name", () => {
	const rules = conditions();
	for (const text of FIRE) test(`fires: ${text}`, () => expect(matches(text, rules)).toBe(true));
	for (const text of HOLD) test(`holds: ${text}`, () => expect(matches(text, rules)).toBe(false));
});
