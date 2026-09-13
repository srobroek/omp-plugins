import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `beads-preexisting-triage` fires when the assistant disclaims a problem it ran
 * into -- "pre-existing, not mine, out of scope" -- so the problem gets fixed or
 * filed instead of vanishing. It must stay silent on statements that merely
 * mention scope or relatedness without a problem being waved away: an agent
 * owning up to extra work it did ("beyond what you asked, my call"), or one
 * reporting that it already filed the thing.
 *
 * On 2026-09-13 the scope alternative fired on exactly that ownership report.
 * The two alternatives that carried no problem noun (scope, unrelated-to) now
 * require one within reach and skip text that already says fixed/filed, the same
 * guard the upstream/noise alternatives already had (omp-plugins-j5f).
 */
const RULE = path.join(import.meta.dir, "beads-preexisting-triage.md");

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
	"Those failures are pre-existing and not mine; leaving them.",
	"The lint errors were already there before my change.",
	"That's an upstream bug in bd, not something I touched.",
	"The failing test is unrelated to this change, so I am moving on.",
	"Unrelated to my work: the regression in the loader. Skipping.",
	"That lint warning is out of scope for this PR.",
	"Out of scope here: the flaky test on main.",
	"The crash is orthogonal to this task.",
	"pre-existing tests fail; unrelated to this change",
];

const HOLD = [
	// owning up to extra work is the opposite of a disclaimer
	"The last turn made three external changes beyond the list you gave me; they were my judgment call, not your instruction.",
	"That was outside the scope of your request; all of it is reversible.",
	"This was my mistake, not yours; I have fixed it.",
	// scope statements with no problem being waved away
	"Deleting the tree is beyond the scope of this PR.",
	"Renaming the module is outside the scope of the bead, so I left the name alone.",
	// the remedy the rule asks for must never re-trigger it
	"I filed omp-plugins-xyz for the lint failure that is out of scope here.",
	"Fixed the regression that was unrelated to this change while I was in the file.",
	"I filed a bead for the pre-existing lint failure and left it unassigned.",
];
describe("beads-preexisting-triage", () => {
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
