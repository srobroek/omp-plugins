import { describe, expect, test } from "bun:test";

import { hasUnclaimedBranchCreation } from "../extensions/claim-before-branch.ts";

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
	"grep -o 'wt switch --create feat/x --base origin/main' installed/plugin.ts | wt switch --list",
	"echo \"run wt switch --create feat/x --base origin/main\"",
	"printf '%s\\n' '```sh' 'wt switch --create feat/x --base origin/main' '```'",
	"git commit -F - <<'EOF'\nwt switch --create feat/x --base origin/main\nEOF",
	"wt switch feat/x",
	"git worktree list",
];

describe("beads claim-before-branch extension", () => {
	for (const command of FIRE) {
		test(`fires: ${JSON.stringify(command)}`, () => {
			expect(hasUnclaimedBranchCreation(command)).toBe(true);
		});
	}
	for (const command of HOLD) {
		test(`holds: ${JSON.stringify(command)}`, () => {
			expect(hasUnclaimedBranchCreation(command)).toBe(false);
		});
	}
});
