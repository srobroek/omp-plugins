import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RULES = join(import.meta.dir, "..", "rules");

type RuleName = "beads-no-editor" | "beads-contention-retry";

function conditions(rule: RuleName): RegExp[] {
	const text = readFileSync(join(RULES, `${rule}.md`), "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error(`missing frontmatter in ${rule}`);
	const line = (frontmatter[1] ?? "").split(/\r?\n/).find(entry => entry.startsWith("condition:"));
	if (!line) throw new Error(`missing condition in ${rule}`);
	const patterns = JSON.parse(line.slice("condition:".length).trim()) as unknown;
	if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== "string")) {
		throw new Error(`condition is not a string list in ${rule}`);
	}
	return patterns.map(pattern => new RegExp(pattern, "u"));
}

function fires(rule: RuleName, input: string): boolean {
	return conditions(rule).every(condition => condition.test(input));
}

describe("beads-no-editor", () => {
	test("beads-no-editor fires on bd edit", () => {
		for (const input of ["bd edit bd-12", "BEADS_ACTOR=x bd -C repo edit bd-12"]) {
			expect(fires("beads-no-editor", input)).toBe(true);
		}
	});

	test("beads-no-editor does not fire on safe bd commands", () => {
		for (const input of ["bd edit --help", "bd show bd-12", "bd update bd-12 --title x"]) {
			expect(fires("beads-no-editor", input)).toBe(false);
		}
	});
});

describe("beads-contention-retry", () => {
	const messages = [
		"bd: a maintenance operation is running on this workspace: retry when it completes",
		"bd: other bd commands are using this workspace: wait for them to finish and retry",
		"bd: lock busy: held by another process",
		"bd: lock already held by another process",
		"bd: workspace gate busy",
	];

	test("beads-contention-retry fires on each observed contention message", () => {
		const rules = conditions("beads-contention-retry");
		expect(rules).toHaveLength(messages.length);
		for (const [index, message] of messages.entries()) {
			expect(rules[index]?.test(message)).toBe(true);
		}
	});

	test("beads-contention-retry does not fire on unrelated bd errors", () => {
		const unrelated = "bd: connection refused while reading the issue database";
		for (const condition of conditions("beads-contention-retry")) {
			expect(condition.test(unrelated)).toBe(false);
		}
	});
});
