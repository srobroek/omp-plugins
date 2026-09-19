import { describe, expect, test } from "bun:test";

import { shouldInvestigate } from "../extensions/package-investigate.ts";

const MUST_FIRE = [
	"npm i -D typescript",
	"bun add left-pad",
	"cd x && bun add left-pad",
	"npm install typescript --save-dev",
	"uv add httpx",
	"cargo add serde",
	"go get example.com/x",
	"pip install requests",
	"npm search typescript",
	"pip index versions requests",
	"cargo search serde",
];

const MUST_NOT_FIRE = [
	'bd create "note ; npm install foo happened"',
	'git commit -m "fix; bun add left-pad was wrong"',
	'echo "step 2 & pip install requests"',
	"bun install",
	"bun install --silent",
	"pnpm install --frozen-lockfile",
	"npm install",
	"cat <<'EOF'\nbun add foo\nEOF",
];

describe("srobroek-package-investigate", () => {
	for (const text of MUST_FIRE) {
		test(`fires: ${JSON.stringify(text)}`, () => expect(shouldInvestigate(text)).toBe(true));
	}
	for (const text of MUST_NOT_FIRE) {
		test(`holds: ${JSON.stringify(text)}`, () => expect(shouldInvestigate(text)).toBe(false));
	}
});
