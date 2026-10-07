import { expect, test } from "bun:test";
import { allocate, defectValue, dupScores, isNoFinding, jaccard, THRESHOLDS, tokens } from "./advisor-census";

// Shapes taken from delivered Watchdog notes in local session transcripts.
const NO_FINDING = [
	"EVIDENCE: `Pushing to Dolt remote... Push complete.` DEFECT: none in my assigned topics; this is the required Beads ledger sync.",
	"EVIDENCE: the user selected `Publish for home update`. DEFECT: none—this is the explicitly selected publication path.",
	"EVIDENCE: the manifest totals `1603` rows. DEFECT: no defect in my assigned topics is shown; the broader manifest is within scope.",
	"EVIDENCE: no newly quoted destructive command in this update.\nDEFECT: —\nBREAKS: —\nFIX: —",
	"EVIDENCE: saved artifact listing includes `Review067.json`. DEFECT: none shown; the requested review inputs are present. BREAKS: n/a",
	"No finding on your assigned topics in this update; the parallel tracks are now dispatched.",
	"No scope concern: library integration is within the expected feature surface.",
	"EVIDENCE: ...",
	"**DEFECT:** N/A",
	"LGTM.",
	"Silence",
];

const FINDING = [
	"EVIDENCE: close reason says `direct main publish`; no delta shows authorization to publish to `main`. DEFECT: direct publish to main without authorization. FIX: open a PR.",
	"EVIDENCE: `git status --short` reports `unstaged 194`. DEFECT: any reset here would destroy existing work. FIX: stash or commit first.",
	"EVIDENCE: `library.rs:435-438` doubles thresholds.\nDEFECT: This changes quadratic refresh cost into a missed final refresh.\nFIX: refresh once after the loop.",
	"The successful `bd dolt pull` clears the ledger prerequisite; the shared base is still not published to the remote.",
	"EVIDENCE: test file deleted. DEFECT: none of the remaining tests cover the parser. FIX: restore parser.test.ts.",
	"EVIDENCE: diff drops the guard. DEFECT: no input validation remains on the CLI flag, so a bad path crashes. FIX: validate before use.",
];

test("isNoFinding flags none, dash, placeholder, and 'No finding' notes", () => {
	for (const note of NO_FINDING) expect({ note, noFinding: isNoFinding(note) }).toEqual({ note, noFinding: true });
});

test("isNoFinding keeps substantive notes, including ones that mention 'none of' or 'no <noun>' inside the defect", () => {
	for (const note of FINDING) expect({ note, noFinding: isNoFinding(note) }).toEqual({ note, noFinding: false });
});

test("defectValue reads the DEFECT field up to the next field and is undefined without one", () => {
	expect(defectValue("EVIDENCE: a. DEFECT: lost work. FIX: stash.")).toBe("lost work.");
	expect(defectValue("EVIDENCE: a.\nDEFECT: **none**\nBREAKS: x")).toBe("none**");
	expect(defectValue("plain prose note")).toBeUndefined();
});

test("tokens drops field labels, stop words, and words of two characters or fewer", () => {
	expect([...tokens("EVIDENCE: the fix is in a.ts. DEFECT: none FIX: x")].sort()).toEqual([]);
	expect([...tokens("Deleting branch main destroys branch history")].sort()).toEqual([
		"branch",
		"deleting",
		"destroys",
		"history",
		"main",
	]);
});

test("jaccard is shared over union, and zero when either side is empty", () => {
	expect(jaccard(new Set(["a1", "b2", "c3"]), new Set(["b2", "c3", "d4"]))).toBe(0.5);
	expect(jaccard(new Set(["abc"]), new Set(["abc"]))).toBe(1);
	expect(jaccard(new Set(), new Set(["abc"]))).toBe(0);
	expect(jaccard(new Set(), new Set())).toBe(0);
});

test("dupScores gives each note its best similarity to any earlier note, first note zero", () => {
	const first = "EVIDENCE: `rm -rf build` runs in the repository root. DEFECT: deletes tracked fixtures.";
	const repeat = "EVIDENCE: `rm -rf build` still runs in the repository root. DEFECT: deletes tracked fixtures again.";
	const unrelated = "EVIDENCE: push targets origin main directly. DEFECT: bypasses review.";
	const scores = dupScores([first, unrelated, repeat]);
	expect(scores[0]).toBe(0);
	expect(scores[1]).toBeLessThan(THRESHOLDS.dupJaccard);
	expect(scores[2]).toBeGreaterThanOrEqual(THRESHOLDS.dupJaccard);
	expect(scores[2]).toBe(jaccard(tokens(repeat), tokens(first)));
	expect(dupScores([])).toEqual([]);
});

test("allocate spot-checks no-finding strata once and floors each advisor's finding strata", () => {
	const populations = new Map([
		["Watchdog/nit/finding", 389],
		["Watchdog/nit/no-finding", 521],
		["Watchdog/concern/finding", 342],
		["Completion/concern/finding", 49],
		["Completion/nit/finding", 3],
	]);
	const slots = allocate(populations, 30);
	expect([...slots.values()].reduce((a, b) => a + b, 0)).toBe(30);
	expect(slots.get("Watchdog/nit/no-finding")).toBe(1);
	expect((slots.get("Completion/concern/finding") ?? 0) + (slots.get("Completion/nit/finding") ?? 0)).toBe(
		THRESHOLDS.minLabeledSubstantive,
	);
	expect(allocate(new Map([["Completion/concern/finding", 4]]), 30).get("Completion/concern/finding")).toBe(4);
});
