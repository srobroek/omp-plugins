import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const rulePath = path.join(import.meta.dir, "build-direct-edit-prose-scope.md");

function frontmatter(text: string): Record<string, string> {
	const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) throw new Error("rule has no frontmatter");
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const separator = line.indexOf(":");
		fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
	}
	return fields;
}
const cases = [
	{
		name: "ordinary direct edits allow related prose only",
		mustContain: ["directly explains or specifies the code being modified", "Related prose includes"],
	},
	{
		name: "ordinary direct edits forbid unrelated cleanup but honor explicit requests",
		mustContain: ["NEVER clean up, reformat, rewrite, or correct unrelated prose", "An explicit user request"],
	},
	{
		name: "first-party Slopvac may fix the whole controlled document",
		mustContain: ["first-party or controlled documents", "whole-document Slopvac lint and fix is permitted", "including findings outside the edited passages"],
	},
	{
		name: "upstream Slopvac remains hunk-scoped",
		mustContain: ["upstream or otherwise uncontrolled repositories", "only added or modified hunks", "never fix findings in untouched passages"],
	},
	{
		name: "ordinary edits remain narrow despite the Slopvac exception",
		mustContain: ["Ordinary manual/direct edits and all upstream documentation or comments remain related and hunk-scoped"],
	},
] as const;

const text = fs.readFileSync(rulePath, "utf8");
const fields = frontmatter(text);

test("direct-edit prose scope is global and addressable", () => {
	expect(fields.name).toBe("build-direct-edit-prose-scope");
	expect(fields.alwaysApply).toBe("true");
	expect(fields.agents).toBeUndefined();
});

for (const behavior of cases) {
	test(behavior.name, () => {
		for (const phrase of behavior.mustContain) expect(text).toContain(phrase);
	});
}
