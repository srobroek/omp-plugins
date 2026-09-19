import { describe, expect, test } from "bun:test";

import {
	bodySteps,
	deepAssertFromMol,
	gateTypeFailures,
	parseDryRun,
	parseDryRunJson,
	parsePourHelp,
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

describe("parseDryRunJson", () => {
	test("parses a JSON fixture into steps and gates", () => {
		const parsed = parseDryRunJson(JSON.stringify({
			schema_version: 1,
			data: {
				steps: [{ title: "Root", origin: "demo" }, { title: "Write code", origin: "demo.write" }],
				gates: [{ type: "human", origin: "demo.gate-review" }],
			},
		}));
		expect(parsed).toEqual({
			steps: ["Root <- demo", "Write code <- demo.write"],
			gates: ["Gate: human"],
		});
		expect(bodySteps(parsed?.steps ?? []).length).toBe(1);
	});

	test("rejects malformed or unrecognised JSON", () => {
		expect(parseDryRunJson("not JSON")).toBeUndefined();
		expect(parseDryRunJson(JSON.stringify({ steps: [{ title: "missing origin" }], gates: [] }))).toBeUndefined();
	});
});

describe("parsePourHelp", () => {
	test("selects JSON when help advertises the flag", () => {
		expect(parsePourHelp("Usage: bd mol pour <proto>\nGlobal Flags: --json")).toEqual({ json: true });
	});

	test("retains textual fallback and exact error", () => {
		expect(parsePourHelp("Usage: bd mol pour <proto>\nFlags: --dry-run")).toEqual({ json: false });
		expect(parsePourHelp("unexpected output")).toEqual({
			error: "formula-check: unrecognised pour output; run the command manually",
		});
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

