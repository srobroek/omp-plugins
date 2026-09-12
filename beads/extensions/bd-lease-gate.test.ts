import { describe, expect, test } from "bun:test";

import { stampLease } from "./bd-lease-gate.ts";

describe("stampLease", () => {
	test("stamps host and pid onto a claim", () => {
		const out = stampLease("bd update omp-1 --claim", "boxy", 4242);
		expect(out).toBe(
			"bd update omp-1 --claim --set-metadata lease_host=boxy --set-metadata lease_pid=4242",
		);
	});

	test("stamps a --claim carried by bd ready", () => {
		expect(stampLease("bd ready --claim --json", "boxy", 7)).toContain(
			"--claim --json --set-metadata lease_host=boxy --set-metadata lease_pid=7",
		);
	});

	test("leaves non-claiming bd commands alone", () => {
		expect(stampLease("bd show omp-1 --json", "boxy", 7)).toBeNull();
		expect(stampLease("bd update omp-1 --status open", "boxy", 7)).toBeNull();
	});

	test("does not stamp twice", () => {
		const once = stampLease("bd update omp-1 --claim", "boxy", 7);
		expect(once).not.toBeNull();
		expect(stampLease(once as string, "boxy", 7)).toBeNull();
	});

	test("stamps the claiming invocation, not a later command in the chain", () => {
		const out = stampLease(
			"bd update omp-1 --claim && bd comment omp-1 'started'",
			"boxy",
			9,
		);
		expect(out).toBe(
			"bd update omp-1 --claim --set-metadata lease_host=boxy --set-metadata lease_pid=9 && bd comment omp-1 'started'",
		);
	});

	test("survives a claim that is not the first command", () => {
		const out = stampLease("cd repo; bd update omp-2 --claim", "boxy", 11);
		expect(out).toBe(
			"cd repo; bd update omp-2 --claim --set-metadata lease_host=boxy --set-metadata lease_pid=11",
		);
	});

	test("refuses a command large enough to be a payload", () => {
		expect(stampLease(`bd update x --claim ${"y".repeat(64_001)}`, "boxy", 7)).toBeNull();
	});
});
