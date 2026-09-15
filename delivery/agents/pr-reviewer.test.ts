import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./pr-reviewer.md", import.meta.url), "utf8");
const external = source.match(/- External or uncontrolled target:([\s\S]*?)(?=\n {3}- Controlled target:)/)?.[1] ?? "";

describe("external reviewer silence contract", () => {
	test("external branch contains no internal linkage vocabulary", () => {
		expect(external).not.toBe("");
		for (const term of ["Bead", "ID", "agent", "gate", "orchestration", "workflow", "missing", "guess"]) {
			expect(external.toLowerCase()).not.toContain(term.toLowerCase());
		}
	});
});
