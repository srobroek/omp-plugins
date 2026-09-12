import { describe, expect, test } from "bun:test";

import { stampLease } from "./bd-lease-gate.ts";

const ANCHORS = "--set-metadata lease_host=boxy --set-metadata lease_pid=7";

describe("stampLease", () => {
	test("stamps host and pid onto a claim", () => {
		expect(stampLease("bd update omp-1 --claim", "boxy", 7)).toBe(
			`bd update omp-1 --claim ${ANCHORS}`,
		);
	});

	test("stamps every claim in a chain", () => {
		expect(stampLease("bd update a --claim && bd update b --claim", "boxy", 7)).toBe(
			`bd update a --claim ${ANCHORS} && bd update b --claim ${ANCHORS}`,
		);
	});

	test("stamps a claim that is not the first command, and reads env prefixes", () => {
		expect(stampLease("cd repo; bd update omp-2 --claim", "boxy", 7)).toBe(
			`cd repo; bd update omp-2 --claim ${ANCHORS}`,
		);
		expect(stampLease("BEADS_ACTOR=x bd update omp-3 --claim", "boxy", 7)).toBe(
			`BEADS_ACTOR=x bd update omp-3 --claim ${ANCHORS}`,
		);
	});

	test("preserves what follows the claim", () => {
		expect(stampLease("bd update omp-1 --claim | tee log", "boxy", 7)).toBe(
			`bd update omp-1 --claim ${ANCHORS} | tee log`,
		);
	});

	test("leaves bd ready alone: it rejects --set-metadata", () => {
		expect(stampLease("bd ready --claim --json", "boxy", 7)).toBeNull();
	});

	test("ignores a bd that is not at command position", () => {
		expect(stampLease("echo bd update x --claim", "boxy", 7)).toBeNull();
	});

	test("ignores a quoted --claim, which is text and not a flag", () => {
		expect(stampLease("bd comment omp-1 'do not --claim this'", "boxy", 7)).toBeNull();
		expect(stampLease("bd update omp-1 --notes '--claim'", "boxy", 7)).toBeNull();
	});

	test("does not corrupt a quoted separator", () => {
		expect(stampLease("bd update omp-1 --claim --notes 'a; b'", "boxy", 7)).toBe(
			`bd update omp-1 --claim --notes 'a; b' ${ANCHORS}`,
		);
	});

	test("leaves non-claiming bd commands alone", () => {
		expect(stampLease("bd show omp-1 --json", "boxy", 7)).toBeNull();
		expect(stampLease("bd update omp-1 --status open", "boxy", 7)).toBeNull();
	});

	test("does not stamp twice", () => {
		const once = stampLease("bd update omp-1 --claim", "boxy", 7) as string;
		expect(stampLease(once, "boxy", 7)).toBeNull();
	});

	test("stamps the unstamped claim in a chain whose sibling is already stamped", () => {
		expect(stampLease(`bd update a --claim ${ANCHORS} && bd update b --claim`, "boxy", 7)).toBe(
			`bd update a --claim ${ANCHORS} && bd update b --claim ${ANCHORS}`,
		);
	});

	test("refuses a command large enough to be a payload", () => {
		expect(stampLease(`bd update x --claim ${"y".repeat(64_001)}`, "boxy", 7)).toBeNull();
	});
});
