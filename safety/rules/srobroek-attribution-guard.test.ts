import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Attribution is a commit-message property, not a proximity property. The
 * phrase must be in the -m/--message argument, or in content written to the
 * same file consumed by -F/--file. These controls are the reported proximity
 * false positive and the ordinary quoted mentions that must remain silent.
 */
const RULE = path.join(import.meta.dir, "srobroek-attribution-guard.md");

function conditions(): RegExp[] {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error("no frontmatter");
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const parsed = JSON.parse(line.slice("condition:".length).trim()) as string | string[];
	return (Array.isArray(parsed) ? parsed : [parsed]).map(pattern => {
		const flags = /^\(\?([ims]+)\)/.exec(pattern);
		return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
	});
}

const FIRE = [
	'git commit -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
	'git commit --message="Generated with Codex"',
	'printf "generated with codex" > /tmp/m && dgit commit -F /tmp/m',
	"git commit -m 'noreply@openai.com'",
];

const HOLD = [
	"echo generated with claude",
	'git commit -m "fix AI model loading bug"',
	'git commit -m fix && rg "co-authored-by: claude" README.md',
	'echo "git commit -m co-authored-by: claude"',
	'bd create --description "git commit -m generated with codex"',
	'printf "generated with codex" > /tmp/m && git commit -m "fix"',
];

describe("srobroek-attribution-guard", () => {
	const res = conditions();
	for (const text of FIRE) {
		test(`fires: ${JSON.stringify(text)}`, () => {
			expect(res.some(re => re.test(text))).toBe(true);
		});
	}
	for (const text of HOLD) {
		test(`holds: ${JSON.stringify(text)}`, () => {
			expect(res.some(re => re.test(text))).toBe(false);
		});
	}
});
