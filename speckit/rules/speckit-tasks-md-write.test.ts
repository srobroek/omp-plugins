import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "speckit-tasks-md-write.md");

function scopes(): Map<string, Bun.Glob> {
	const line = fs.readFileSync(RULE, "utf8").split(/\r?\n/).find(l => l.startsWith("scope:"));
	if (!line) throw new Error("no scope");
	const out = new Map<string, Bun.Glob>();
	for (const token of (JSON.parse(line.slice("scope:".length).trim()) as string).split(/\s*,\s*/)) {
		const match = /^tool:(\w+)\((.+)\)$/.exec(token);
		if (!match?.[1] || !match[2]) throw new Error(`unexpected scope token ${token}`);
		out.set(match[1], new Bun.Glob(match[2]));
	}
	return out;
}

describe("speckit-tasks-md-write", () => {
	const scope = scopes();

	test("fires on edit and write of relative and absolute specs/*/tasks.md", () => {
		expect([...scope.keys()]).toEqual(["edit", "write"]);
		for (const glob of scope.values()) {
			expect(glob.match("specs/001-a/tasks.md")).toBe(true);
			expect(glob.match("/Users/x/repo/specs/001-a/tasks.md")).toBe(true);
		}
	});

	test("does not fire on other spec files or a tasks.md outside specs/", () => {
		for (const glob of scope.values()) {
			expect(glob.match("/Users/x/repo/specs/001-a/spec.md")).toBe(false);
			expect(glob.match("docs/tasks.md")).toBe(false);
			expect(glob.match("specs/tasks.md")).toBe(false);
		}
	});
});
