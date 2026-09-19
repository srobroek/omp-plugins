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
	"npm i -D typescript",
	"bun add left-pad",
	"uv add httpx",
	"cargo add serde",
	"go get example.com/x",
	"pip install requests",
	"cd x && bun add left-pad",
	"npm install typescript --save-dev",
	"npm search typescript",
	"npm view typescript",
	"pip index versions requests",
	"cargo search serde",
];

const MUST_NOT_FIRE = [
	"bun install --silent",
	"bun install --silent 2>&1 | tail -2",
	"bun install",
	"pnpm install --frozen-lockfile",
	"npm install",
	'bd create "... (npm i -D typescript)..."',
	'git commit -m "docs: explain npm i -D typescript"',
	"echo 'see npm install docs'",
	"cat <<'EOF'\nbun add foo\nEOF",
	"bun install --frozen-lockfile >/dev/null 2>&1; bun x tsc",
	'bd create --description "investigate bun install --frozen-lockfile before release"',
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
