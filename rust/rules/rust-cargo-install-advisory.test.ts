import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "rust-cargo-install-advisory.md");

function conditions(): RegExp[] {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error("no frontmatter");
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const parsed = JSON.parse(line.slice("condition:".length).trim()) as string | string[];
	const patterns = Array.isArray(parsed) ? parsed : [parsed];
	return patterns.map(pattern => {
		const flags = /^\(\?([ims]+)\)/.exec(pattern);
		return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
	});
}

const FIRE = [
	"cargo install cargo-nextest",
	"cargo install --locked ripgrep",
	"echo ready; cargo install cargo-deny",
];

const HOLD = [
	"cargo test",
	"cargo install --help",
	"echo cargo install ripgrep",
	"bd create --description \"cargo install cargo-nextest\"",
	"echo \"cargo install cargo-nextest\"",
];

describe("rust-cargo-install-advisory", () => {
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
