import { describe, expect, test } from "bun:test";

import { bodyOfGhCreate, decidePrCreate, REASON } from "./pr-bead-link-gate.ts";

describe("bodyOfGhCreate", () => {
	test("reads a quoted --body", () => {
		expect(bodyOfGhCreate("gh pr create --title t --body 'Bead: omp-1'")).toBe("Bead: omp-1");
	});

	test("reads --body= and -b spellings", () => {
		expect(bodyOfGhCreate('gh pr create --body="Bead: omp-2"')).toBe("Bead: omp-2");
		expect(bodyOfGhCreate("gh pr create -b 'Bead: omp-3'")).toBe("Bead: omp-3");
	});

	test("reports no body when the flag is absent", () => {
		expect(bodyOfGhCreate("gh pr create --fill")).toBeNull();
	});

	test("ignores commands that are not gh pr create", () => {
		expect(bodyOfGhCreate("gh pr edit 4 --body 'no bead'")).toBeNull();
		expect(bodyOfGhCreate("gh pr view 4 --json body")).toBeNull();
	});
});

describe("decidePrCreate", () => {
	test("blocks a body naming no bead", () => {
		const decision = decidePrCreate("Adds a fish alias.", true);
		expect(decision).toEqual({ block: true, reason: REASON });
	});

	test("allows Bead, Closes-Bead and several beads", () => {
		expect(decidePrCreate("Bead: omp-plugins-dd1", true)).toBeNull();
		expect(decidePrCreate("Closes-Bead: chezmoi-5vn", true)).toBeNull();
		expect(decidePrCreate("Bead: omp-1\nBead: omp-2", true)).toBeNull();
	});

	test("allows the stated escape hatch", () => {
		expect(decidePrCreate("No-Bead: revert of a bad merge", true)).toBeNull();
	});

	test("rejects an empty escape hatch", () => {
		expect(decidePrCreate("No-Bead:", true)).not.toBeNull();
	});

	test("stays silent where beads is not active", () => {
		expect(decidePrCreate("Adds a fish alias.", false)).toBeNull();
	});

	test("stays silent when the body is not visible", () => {
		expect(decidePrCreate(null, true)).toBeNull();
	});

	test("does not accept a bare id or a bead-shaped word", () => {
		expect(decidePrCreate("Fixes omp-plugins-dd1 somehow", true)).not.toBeNull();
		expect(decidePrCreate("Beading: omp-1", true)).not.toBeNull();
	});
});
