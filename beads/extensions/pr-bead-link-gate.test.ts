import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beadsActive, bodyOfGhCreate, controlledByViewerPermission, decideCommand, decidePrCreate, REASON, repositoryControlled, repositoryFromGhCreate } from "./pr-bead-link-gate.ts";

describe("repository subprocess contract", () => {
	test("uses gh repo view's viewerPermission output contract", () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-gh-"));
		const gh = join(dir, "gh");
		const args = join(dir, "args");
		writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_ARGS_FILE"\nprintf "%s\\n" "${' + 'GH_PERMISSION:-WRITE}"\n');
		chmodSync(gh, 0o755);
		const previousPath = process.env.PATH;
		const previousArgsFile = process.env.GH_ARGS_FILE;
		const previousPermission = process.env.GH_PERMISSION;
		process.env.PATH = `${dir}:${previousPath ?? ""}`;
		process.env.GH_ARGS_FILE = args;
		try {
			expect(repositoryControlled("owner/repo")).toEqual({ kind: "controlled" });
			process.env.GH_PERMISSION = "READ";
			expect(repositoryControlled("owner/repo")).toEqual({ kind: "uncontrolled" });
			expect(readFileSync(args, "utf8").trim().split("\n")).toEqual(["repo", "view", "owner/repo", "--json", "viewerPermission", "--jq", ".viewerPermission"]);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousPermission === undefined) delete process.env.GH_PERMISSION;
			else process.env.GH_PERMISSION = previousPermission;
			if (previousArgsFile === undefined) delete process.env.GH_ARGS_FILE;
			else process.env.GH_ARGS_FILE = previousArgsFile;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("refuses when the permission lookup fails and names the failure", () => {
		const dir = mkdtempSync(join(tmpdir(), "beads-gh-failure-"));
		const gh = join(dir, "gh");
		writeFileSync(gh, '#!/bin/sh\nprintf "%s" "permission lookup failed" >&2\nexit 1\n');
		chmodSync(gh, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath ?? ""}`;
		try {
			const control = repositoryControlled("owner/repo");
			expect(control.kind).toBe("unknown");
			const decision = decidePrCreate("plain prose", control);
			expect(decision?.block).toBe(true);
			expect(decision?.reason).toContain("Repository permission could not be determined");
			expect(decision?.reason).toContain("permission lookup failed");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

});

describe("repository control", () => {
	test("only write-capable viewer permissions control", () => {
		for (const permission of ["WRITE", "MAINTAIN", "ADMIN"]) expect(controlledByViewerPermission(permission)).toBe(true);
		for (const permission of ["READ", "TRIAGE", null, undefined, ""]) expect(controlledByViewerPermission(permission)).toBe(false);
	});
	test("resolves explicit repo and rejects ambiguous targets", () => {
		expect(repositoryFromGhCreate("gh pr create --repo owner/old --repo=owner/new --body x")).toBe("owner/new");
		expect(repositoryFromGhCreate("gh pr create \"--repo\" owner/quoted --body x")).toBe("owner/quoted");
		expect(repositoryFromGhCreate("gh pr create -R owner/short --body x")).toBe("owner/short");
		expect(repositoryFromGhCreate("gh pr create --title \"--repo owner/fake\" --body x")).toBeNull();
		expect(repositoryFromGhCreate("gh pr create --body \"--repo owner/fake\"")).toBeNull();
		expect(repositoryFromGhCreate("gh pr create -R owner/one -Rowner/two --body x")).toBe("owner/two");
		expect(repositoryFromGhCreate("gh pr create -dRowner/two --body x")).toBe("owner/two");
		expect(repositoryFromGhCreate("gh pr create --body \"--repo owner/fake\"")).toBeNull();
		expect(repositoryFromGhCreate("gh pr create --repo ghe.example.com/owner/project --body x")).toBe("ghe.example.com/owner/project");
	});
});

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

describe("beads activity", () => {
	test("allows bead-less bodies for a regular-file RETIRED sentinel", () => {
		const root = mkdtempSync(join(tmpdir(), "beads-retired-")); mkdirSync(join(root, ".beads")); writeFileSync(join(root, ".beads", "RETIRED"), "");
		try { expect(beadsActive(root)).toBe(false); expect(decidePrCreate("plain prose", beadsActive(root))).toBeNull(); } finally { rmSync(root, { recursive: true, force: true }); }
	});
	test("requires beads for ordinary and malformed RETIRED paths", () => {
		for (const retired of [false, true]) { const root = mkdtempSync(join(tmpdir(), "beads-live-")); mkdirSync(join(root, ".beads")); if (retired) mkdirSync(join(root, ".beads", "RETIRED")); try { expect(beadsActive(root)).toBe(true); expect(decidePrCreate("plain prose", beadsActive(root))).not.toBeNull(); } finally { rmSync(root, { recursive: true, force: true }); } }
	});
	test("does not inherit an ancestor sentinel past a nearer live ledger", () => {
		const root = mkdtempSync(join(tmpdir(), "beads-shadow-")); mkdirSync(join(root, ".beads")); writeFileSync(join(root, ".beads", "RETIRED"), ""); const child = join(root, "child"); mkdirSync(join(child, ".beads"), { recursive: true });
		try { expect(beadsActive(child)).toBe(true); expect(decidePrCreate("plain prose", beadsActive(child))).not.toBeNull(); } finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("decidePrCreate", () => {
	test("rejects internal linkage placeholders instead of treating them as an escape hatch", () => { const placeholder = ["No", "-Bead"].join(""); expect(decidePrCreate(`: revert of a bad merge`, true)).not.toBeNull(); expect(decidePrCreate(`:`, true)).not.toBeNull(); });

	test("blocks a body naming neither route and explains both", () => {
		const decision = decidePrCreate("Adds a fish alias.", true);
		expect(decision).toEqual({ block: true, reason: REASON });
		expect(decision?.reason).toContain("Bead: <id>");
	});


	test("allows Bead, Closes-Bead and several beads", () => {
		expect(decidePrCreate("Bead: chezmoi-4rc2", true)).toBeNull();
		expect(decidePrCreate("Closes-Bead: chezmoi-5vn", true)).toBeNull();
		expect(decidePrCreate("Bead: omp-1\nBead: omp-2", true)).toBeNull();
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

describe("per-segment repository control", () => {
	test("evaluates mixed targets independently in either order", () => {
		const controlled = (segment: string) => segment.includes("controlled/repo");
		expect(decideCommand("gh pr create --repo external/repo --body plain && gh pr create --repo controlled/repo --body plain", controlled)).not.toBeNull();
		expect(decideCommand("gh pr create --repo controlled/repo --body plain && gh pr create --repo external/repo --body plain", controlled)).not.toBeNull();
	});
	test("handles three mixed targets without sharing classification", () => {
		const controlled = (segment: string) => segment.includes("controlled/repo");
		expect(decideCommand("gh pr create --repo external/repo --body 'Bead: x-1' && gh pr create --repo controlled/repo --body plain && gh pr create --repo external/repo --body 'Bead: x-2'", controlled)).not.toBeNull();
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
