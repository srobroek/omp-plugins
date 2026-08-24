import { describe, expect, test } from "bun:test";

import formulaCheckTool, {
	bodySteps,
	deepAssertFromMol,
	gateTypeFailures,
	parseDryRun,
	unsubstitutedFailures,
} from "./formula-check-tool.ts";


// Structural stand-in for pi.zod: the module only builds a parameter schema with
// it (object/string/array/boolean chains); execute() receives already-parsed params.
const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

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
				dependencies: [{ issue_id: "b" }],
			}),
		).toEqual([]);
	});
});

describe("registerTool", () => {
	test("registers bd_formula_check", () => {
		const captured: Record<string, unknown> = {};
		const fakePi = {
			zod: z,
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		formulaCheckTool(fakePi as never);
		expect(captured.name).toBe("bd_formula_check");
	});
});
