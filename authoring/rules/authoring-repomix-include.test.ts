import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "authoring-repomix-include.md");
function condition(): RegExp {
	const text = fs.readFileSync(RULE, "utf8");
	const line = text.split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const [pattern] = JSON.parse(line.slice("condition:".length).trim()) as string[];
	return new RegExp(pattern, "u");
}

describe("authoring-repomix-include", () => {
	const re = condition();
	for (const input of ["repomix .", "repomix . --compress", "echo ok; repomix ."]) {
		test(`fires: ${input}`, () => expect(re.test(input)).toBe(true));
	}
	for (const input of ["repomix . --include src/**", "repomix . --stdout", "echo \"repomix .\""]) {
		test(`holds: ${input}`, () => expect(re.test(input)).toBe(false));
	}
});
