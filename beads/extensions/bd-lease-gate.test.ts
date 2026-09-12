import { describe, expect, test } from "bun:test";

import { anchorArgs, claimedIds } from "./bd-lease-gate.ts";

/** Shapes bd 1.1.2 prints for a claim, envelope and plain. */
const ENVELOPE = '{"data":[{"id":"omp-plugins-dd1","status":"in_progress","assignee":"omp/Main/01a08b2b"}]}';

describe("claimedIds", () => {
	test("reads the id out of a claim's own JSON", () => {
		expect(claimedIds(ENVELOPE)).toEqual(["omp-plugins-dd1"]);
	});

	test("reads a plain claimed line", () => {
		expect(claimedIds("Claimed chezmoi-5vn (in_progress)")).toEqual(["chezmoi-5vn"]);
	});

	test("collects every bead a batch claim reports, without duplicates", () => {
		const out = '{"id":"omp-1"}\n{"id":"omp-2"}\n{"id":"omp-1"}';
		expect(claimedIds(out).sort()).toEqual(["omp-1", "omp-2"]);
	});

	test("ignores text that carries no bead id", () => {
		expect(claimedIds("error: unknown flag: --set-metadata")).toEqual([]);
		expect(claimedIds("")).toEqual([]);
	});

	test("ignores values that are not bead-shaped", () => {
		expect(claimedIds('{"id":"not a bead"}')).toEqual([]);
		expect(claimedIds('{"id":"12345"}')).toEqual([]);
	});
});

describe("anchorArgs", () => {
	test("builds an argv, so nothing is quoted or parsed as shell", () => {
		expect(anchorArgs("omp-1", "boxy", 7)).toEqual([
			"bd",
			"update",
			"omp-1",
			"--set-metadata",
			"lease_host=boxy",
			"--set-metadata",
			"lease_pid=7",
		]);
	});

	test("carries a host with punctuation without escaping", () => {
		expect(anchorArgs("omp-1", "box-1", 7)[4]).toBe("lease_host=box-1");
	});
});
