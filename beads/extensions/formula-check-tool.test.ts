import { describe, expect, test } from "bun:test";

import {
	bodySteps,
	deepAssertFromMol,
	gateTypeFailures,
	parseDryRun,
	unsubstitutedFailures,
} from "./formula-check-tool.ts";



describe("parseDryRun", () => {
	test("classifies steps vs gates", () => {
		const out = [
			"  - Root (from demo)",
			"  - Write code (from demo.write)",
			"  - Gate: human (from demo.gate-review)",
			"  - gate-runner (from demo.gate-runner)",
		].join("\n");
		const { steps, gates } = parseDryRun(out);
		expect(gates).toEqual(["Gate: human"]);
		expect(steps.some((s) => s.includes("gate-runner"))).toBe(true);
		expect(bodySteps(steps).length).toBe(2);
	});
});

describe("gateTypeFailures", () => {
	test("rejects bead gates", () => {
		const fails = gateTypeFailures(["Gate: bead"]);
		expect(fails.length).toBe(1);
		expect(fails[0]).toContain("bead");
	});
	test("accepts known types", () => {
		expect(gateTypeFailures(["Gate: human", "Gate: gh:pr"])).toEqual([]);
	});
});

describe("unsubstitutedFailures", () => {
	test("flags leftover braces", () => {
		const fails = unsubstitutedFailures("title: {{name}} leftover");
		expect(fails.length).toBe(1);
	});
	test("empty when none", () => {
		expect(unsubstitutedFailures("ok")).toEqual([]);
	});
});

describe("deepAssertFromMol", () => {
	test("fails without issues", () => {
		expect(deepAssertFromMol({})[0]).toContain("no `issues`");
	});
	test("fails on multiple entry points", () => {
		const fails = deepAssertFromMol({
			issues: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
			dependencies: [],
		});
		expect(fails[0]).toContain("more than one entry point");
	});
	test("ok with one entry", () => {
		expect(
			deepAssertFromMol({
				issues: [
					{ id: "a", title: "A" },
					{ id: "b", title: "B" },
				],
				dependencies: [{ issue_id: "b", depends_on_id: "a" }],
			}),
		).toEqual([]);
	});
});

