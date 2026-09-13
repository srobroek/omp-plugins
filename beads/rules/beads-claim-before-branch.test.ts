import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `beads-claim-before-branch` fires when a branch or worktree is created, which
 * is the moment a bead's work begins and the last point a claim still prevents
 * duplication rather than discovering it.
 *
 * The rule exists because name matching cannot do this job. Across 104 branch
 * names from one repository's PR history, the pair that actually collided --
 * `chore/ignore-orchestration` and `chore/gitignore-orchestration` -- scored
 * 0.33 on token similarity, 25th of 335 overlapping pairs, and every threshold
 * catching it also flagged roughly a hundred unrelated pairs (2026-09-12).
 *
 * In the measured `chezmoi-6ko` incident (2026-09-12), two sessions implemented
 * one open unassigned bead in parallel. The loser spent a worktree, signed
 * commit, source checks (89.5s), routed push and gitleaks (77s), draft PR,
 * teardown, and a second push (70s) before the conflict surfaced as a
 * `CONFLICTING` PR. Neither session broke the letter of the workflow: both saw
 * the bead as open and unassigned because neither had claimed it.
 *
 * HOLD cases carry the load here. The condition is anchored to command position
 * because the token stream includes quoted text, so prose describing a branch
 * creation must stay silent.
 */
const RULE = path.join(import.meta.dir, "beads-claim-before-branch.md");

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
	"wt switch --create feat/x --base origin/main",
	"wt switch --create feat/x --base origin/main --no-cd --format json",
	"git checkout -b feat/x",
	"git switch -c feat/x",
	"git worktree add ../wt feat/x",
	"git -C /Users/sjors/repo checkout -b feat/x",
	"cd /tmp && git switch -c feat/y",
	"echo hi; git checkout -b feat/z",
	"line one\ngit checkout -b feat/multiline",
];

const HOLD = [
	// switching to an existing branch is not starting work
	"wt switch feat/x",
	"wt switch --list",
	"git checkout main",
	"git switch main",
	// inspection and teardown
	"git worktree list",
	"git worktree remove ../wt",
	"git branch --list",
	// help forms stay usable
	"git checkout -b --help",
	"git worktree add --help",
	// prose and search: the reason the condition is anchored
	'echo "to start work run git checkout -b feat/x"',
	"grep -rn 'git worktree add' scripts/",
	// the remedy itself must never fire
	"bd update chezmoi-d6n --claim",
];

describe("beads-claim-before-branch", () => {
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
