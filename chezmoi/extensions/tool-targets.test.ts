import { describe, expect, test } from "bun:test";

import { EDIT_TOOLS, targetPaths } from "./tool-targets.ts";

// One copy is tested: scripts/check-shared-detector.py keeps every copy byte-identical.
describe("targetPaths", () => {
	test("reads file_path, path, _path and paths", () => {
		expect(targetPaths({ file_path: "a.ts" })).toEqual(["a.ts"]);
		expect(targetPaths({ path: "b.ts" })).toEqual(["b.ts"]);
		expect(targetPaths({ _path: "e.ts" })).toEqual(["e.ts"]);
		expect(targetPaths({ paths: ["c.ts", ""] })).toEqual(["c.ts"]);
		expect(targetPaths({})).toEqual([]);
	});

	test("reads every hashline section header and MV destination", () => {
		const input = "[a.ts#AB12]\nPUT 1.=1:\n+x\n['b c.ts'#CD34]\nMV d.ts\n+MV body.ts";
		expect(targetPaths({ input })).toEqual(["a.ts", "b c.ts", "d.ts"]);
	});

	test("reads apply_patch file and move headers", () => {
		const input = "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Add File: c.ts\n+z\n*** End Patch";
		expect(targetPaths({ _input: input })).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	test("reads patch-mode rename destinations alongside the edited path", () => {
		const input = { path: "src/app.py", edits: [{ op: "update", rename: "src/main.py" }, null, "x", { rename: "" }] };
		expect(targetPaths(input)).toEqual(["src/app.py", "src/main.py"]);
	});

	test("lists each path once", () => {
		expect(targetPaths({ path: "a.ts", paths: ["a.ts"], input: "[a.ts#AB12]\nMV a.ts" })).toEqual(["a.ts"]);
	});
});

describe("EDIT_TOOLS", () => {
	test("names the host tools that write by path, not the apply_patch wire name", () => {
		expect([...EDIT_TOOLS].sort()).toEqual(["ast_edit", "edit", "write"]);
	});
});
