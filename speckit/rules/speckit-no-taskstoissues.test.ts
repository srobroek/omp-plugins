import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "speckit-no-taskstoissues.md");
const text = fs.readFileSync(RULE, "utf8");

function field(name: string): string {
	const line = text.split(/\r?\n/).find(l => l.startsWith(`${name}:`));
	if (!line) throw new Error(`no ${name}`);
	return line.slice(name.length + 1).trim();
}

function conditions(): RegExp[] {
	return (JSON.parse(field("condition")) as string[]).map(raw => {
		const flags = /^\(\?([ims]+)\)/.exec(raw);
		return flags ? new RegExp(raw.slice(flags[0].length), flags[1]) : new RegExp(raw);
	});
}

const fires = (input: string): boolean => conditions().some(re => re.test(input));
// Built from parts so this file's own tool arguments never look like an invocation.
const slash = "/speckit" + ".taskstoissues";
const skill = "speckit-tasks" + "toissues";
const githubSlash = "/speckit" + ".github.taskstoissues";
const githubHyphenSlash = "/speckit" + "-github-taskstoissues";
const githubSkill = "speckit-github-tasks" + "toissues";
const githubDotSkill = "speckit.github.tasks" + "toissues";

describe("speckit-no-taskstoissues", () => {
	test("fires on a line-start slash command", () => {
		expect(fires(slash)).toBe(true);
		expect(fires(`Run this:\n  ${slash} now`)).toBe(true);
	});

	test("fires on a read of the taskstoissues skill", () => {
		expect(fires(JSON.stringify({ i: "Reading skill", path: `skill://${skill}` }))).toBe(true);
	});

	test("fires on the spec-kit 1.2 github extension names", () => {
		expect(fires(githubSlash)).toBe(true);
		expect(fires(`Run this:\n  ${githubHyphenSlash} now`)).toBe(true);
		expect(fires(JSON.stringify({ path: `skill://${githubSkill}` }))).toBe(true);
		expect(fires(JSON.stringify({ path: `skill://${githubDotSkill}` }))).toBe(true);
	});

	test("does not fire on other github extension commands or longer names", () => {
		expect(fires(`${"/speckit"}.github.issues`)).toBe(false);
		expect(fires(`${githubSlash}-extra`)).toBe(false);
		expect(fires(JSON.stringify({ path: `skill://${githubSkill}-extra` }))).toBe(false);
	});

	test("does not fire on a mention inside a sentence or code span", () => {
		expect(fires(`Never run ${slash} in a beads repo.`)).toBe(false);
		expect(fires(`Never run ${githubSlash} in a beads repo.`)).toBe(false);
		expect(fires(`The skill://${githubSkill} skill is blocked.`)).toBe(false);
		expect(fires(`Use \`${slash}\` only outside beads.`)).toBe(false);
		expect(fires(`The skill://${skill} skill is blocked.`)).toBe(false);
	});

	test("does not watch bash and interrupts only tool calls", () => {
		expect(JSON.parse(field("scope")).split(/\s*,\s*/)).toEqual(["text", "tool:read"]);
		expect(field("interruptMode")).toBe("tool-only");
	});
});
