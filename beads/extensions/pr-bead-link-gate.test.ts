import { describe, expect, test } from "bun:test";

import { bodyOfGhCreate, decideCommand, decidePrCreate, REASON } from "./pr-bead-link-gate.ts";

describe("bodyOfGhCreate", () => {
	test("reads every real --body spelling, attached forms included", () => {
		expect(bodyOfGhCreate("gh pr create --title t --body 'Bead: omp-1'")).toBe("Bead: omp-1");
		expect(bodyOfGhCreate('gh pr create --body="Bead: omp-2"')).toBe("Bead: omp-2");
		expect(bodyOfGhCreate("gh pr create -b 'Bead: omp-3'")).toBe("Bead: omp-3");
		expect(bodyOfGhCreate("gh pr create -b'Bead: omp-4'")).toBe("Bead: omp-4");
		expect(bodyOfGhCreate("gh pr create -b=Bead:omp-5")).toBe("Bead:omp-5");
	});

	test("does not read a --body that lives inside another flag's value", () => {
		expect(bodyOfGhCreate("gh pr create --title 'add --body foo' --body 'Bead: omp-1'")).toBe(
			"Bead: omp-1",
		);
		expect(bodyOfGhCreate("gh pr create --title 'x --body sneaky'")).toBeNull();
	});

	test("ignores --body-file, which the gate cannot read", () => {
		expect(bodyOfGhCreate("gh pr create --body-file body.md")).toBeNull();
		expect(bodyOfGhCreate("gh pr create --body-file=b.md --title t")).toBeNull();
	});

	test("reports no body for --fill", () => {
		expect(bodyOfGhCreate("gh pr create --fill")).toBeNull();
	});

	test("ignores gh invocations that are not pr create", () => {
		expect(bodyOfGhCreate("gh pr edit 4 --body 'no bead'")).toBeNull();
		expect(bodyOfGhCreate("gh pr view 4 --json body")).toBeNull();
	});

	test("ignores a gh pr create that is not at command position", () => {
		expect(bodyOfGhCreate("echo gh pr create --body 'no bead'")).toBeNull();
	});

	test("reads through env prefixes", () => {
		expect(bodyOfGhCreate("GH_TOKEN=x gh pr create --body 'Bead: omp-9'")).toBe("Bead: omp-9");
	});
});

describe("decidePrCreate", () => {
	test("blocks a body naming no bead", () => {
		expect(decidePrCreate("Adds a fish alias.", true)).toEqual({ block: true, reason: REASON });
	});

	test("allows Bead, Closes-Bead and several beads", () => {
		expect(decidePrCreate("Bead: omp-plugins-dd1", true)).toBeNull();
		expect(decidePrCreate("Closes-Bead: chezmoi-5vn", true)).toBeNull();
		expect(decidePrCreate("Bead: omp-1\nBead: omp-2", true)).toBeNull();
	});

	test("allows the stated escape hatch and rejects an empty one", () => {
		expect(decidePrCreate("No-Bead: revert of a bad merge", true)).toBeNull();
		expect(decidePrCreate("No-Bead:", true)).not.toBeNull();
	});

	test("stays silent where beads is not active", () => {
		expect(decidePrCreate("Adds a fish alias.", false)).toBeNull();
	});

	test("does not accept a bare id or a bead-shaped word", () => {
		expect(decidePrCreate("Fixes omp-plugins-dd1 somehow", true)).not.toBeNull();
		expect(decidePrCreate("Beading: omp-1", true)).not.toBeNull();
	});
});

describe("decideCommand", () => {
	test("blocks a bead-less create anywhere in a chain", () => {
		expect(
			decideCommand("gh pr create --body 'Bead: omp-1' && gh pr create --body 'nothing'", true),
		).not.toBeNull();
	});

	test("allows a chain whose creates all name beads", () => {
		expect(
			decideCommand("gh pr create --body 'Bead: omp-1' ; gh pr create --body 'Bead: omp-2'", true),
		).toBeNull();
	});

	test("leaves a quoted separator inside a body intact", () => {
		expect(decideCommand("gh pr create --body 'Bead: omp-1; and more'", true)).toBeNull();
		expect(decideCommand("gh pr create --body 'no bead; just prose'", true)).not.toBeNull();
	});

	test("ignores unrelated gh commands", () => {
		expect(decideCommand("gh pr list --state open", true)).toBeNull();
		expect(decideCommand("gh run watch 42", true)).toBeNull();
	});
});

describe("short flag clusters", () => {
	test("reads a body attached to a clustered -b", () => {
		expect(bodyOfGhCreate("gh pr create -dbNoBead")).toBe("NoBead");
		expect(bodyOfGhCreate("gh pr create -db 'Bead: omp-1'")).toBe("Bead: omp-1");
	});

	test("blocks a clustered bead-less body", () => {
		expect(decideCommand("gh pr create -dbjust prose", true)).not.toBeNull();
	});

	test("leaves clusters without b alone", () => {
		expect(bodyOfGhCreate("gh pr create -d --fill")).toBeNull();
	});
});
