import { describe, expect, test } from "bun:test";

import { hasUnclaimedBranchCreation } from "../extensions/claim-before-branch.ts";

const OLD_MATCHER = /(?:^|[;|&]\s*)(?:wt\s+switch\s+(?:[^\n]*\s)?--create\b|git(?:\s+-C\s+\S+)?\s+(?:checkout\s+-b\b|switch\s+-c\b|worktree\s+add\b))(?![^\n]*--help)/m;

const FIRE = [
	"wt switch --create feat/x --base origin/main",
	"git checkout -b feat/x",
	"git switch -c feat/x",
	"git worktree add ../wt feat/x",
	"git -C /Users/sjors/repo checkout -b feat/x",
	"cd /tmp && git switch -c feat/y",
	"echo hi; git checkout -b feat/z",
];

const HOLD = [
	"wt switch --help",
	"wt switch --version",
	"git checkout -b --help",
	"git worktree add --version",
	"grep -o 'wt switch --create feat/x --base origin/main' installed/plugin.ts",
	"printf '%s\\n' 'search output: wt switch --create feat/x --base origin/main'",
	"printf '%s\\n' '```sh' 'wt switch --create feat/x --base origin/main' '```'",
	"echo \"quoted example: wt switch --create feat/x --base origin/main\"",
	"git commit -F - <<'EOF'\nwt switch --create feat/x --base origin/main\nEOF",
	"wt switch feat/x",
	"git worktree list",
];

/** The released regex is retained as a regression oracle for why this became a gate. */
describe("beads claim-before-branch extension", () => {
	for (const command of FIRE) {
		test(`fires: ${JSON.stringify(command)}`, () => {
			expect(OLD_MATCHER.test(command)).toBe(true);
			expect(hasUnclaimedBranchCreation(command)).toBe(true);
		});
	}
	for (const command of HOLD) {
		test(`holds: ${JSON.stringify(command)}`, () => {
			expect(hasUnclaimedBranchCreation(command)).toBe(false);
		});
	}
	test("released matcher falsely fires on a here-document body", () => {
		const command = "git commit -F - <<'EOF'\nwt switch --create feat/x --base origin/main\nEOF";
		expect(OLD_MATCHER.test(command)).toBe(true);
		expect(hasUnclaimedBranchCreation(command)).toBe(false);
	});
});
