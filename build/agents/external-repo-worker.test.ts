import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agent = readFileSync(join(import.meta.dir, "external-repo-worker.md"), "utf8");

const externalTextBoundary = [
	"external or otherwise uncontrolled repository",
	"omit internal Beads, bead IDs, internal IDs, agents, gates, orchestration, and rationale",
	"Do not emit euphemistic placeholders or empty linkage labels",
	"First-party or controlled repositories retain normal internal linkage",
] as const;

const directEditProseScope = [
	"change prose only when it directly explains or specifies the modified code",
	"NEVER Clean up, reformat, rewrite, or correct unrelated prose",
	"only added or modified hunks in external or otherwise uncontrolled repositories",
	"First-party or controlled documents permit whole-document Slopvac lint and fixes",
	"Ordinary manual/direct edits and all upstream documentation or comments remain related and hunk-scoped",
] as const;

test("external worker keeps internal workflow context out of external repository text", () => {
	for (const phrase of externalTextBoundary) expect(agent).toContain(phrase);
});

test("external worker scopes direct-edit prose and Slopvac fixes", () => {
	for (const phrase of directEditProseScope) expect(agent).toContain(phrase);
});
