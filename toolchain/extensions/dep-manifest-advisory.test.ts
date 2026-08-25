import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import depManifestAdvisory, {
	adviseForAnchoredEdit,
	adviseForAstEdit,
	adviseForHashline,
	adviseForWrite,
	collectHits,
	depRegions,
	formatAdvisory,
	manifestKind,
	parseHashline,
	patternLiterals,
	resetDepManifestAdvisoryForTests,
	touchesRegion,
	type Reader,
} from "./dep-manifest-advisory.ts";

const CWD = "/tmp/dep-manifest-advisory-fixture";

const PACKAGE_JSON = [
	"{",
	'  "name": "demo",',
	'  "description": "docs live here",',
	'  "scripts": {',
	'    "test": "bun test"',
	"  },",
	'  "dependencies": {',
	'    "zod": "^3.23.8"',
	"  },",
	'  "devDependencies": {',
	'    "typescript": "^5.5.0"',
	"  }",
	"}",
].join("\n");

const CARGO_TOML = [
	"[package]",
	'name = "demo"',
	'description = "docs"',
	"",
	"[dependencies]",
	'serde = { version = "1", features = ["derive"] }',
	"",
	"[dev-dependencies]",
	'tempfile = "3"',
	"",
	"[target.'cfg(unix)'.dependencies]",
	'libc = "0.2"',
	"",
	"[[bin]]",
	'name = "demo"',
].join("\n");

const PYPROJECT = [
	"[build-system]",
	'requires = ["hatchling"]',
	'build-backend = "hatchling.build"',
	"",
	"[project]",
	'name = "demo"',
	'description = "docs"',
	"dependencies = [",
	'  "httpx>=0.27",',
	"]",
	"",
	"[project.optional-dependencies]",
	'cli = ["typer"]',
	"",
	"[tool.uv]",
	"dev-dependencies = [",
	'  "pytest>=8",',
	"]",
	"",
	"[tool.ruff]",
	"line-length = 100",
].join("\n");

const GO_MOD = [
	"module example.com/demo",
	"",
	"go 1.22",
	"",
	"require (",
	"\tgithub.com/foo/bar v1.2.3",
	")",
	"",
	"require golang.org/x/sync v0.7.0",
].join("\n");

const reader = (files: Record<string, string>): Reader => (abs) => files[abs] ?? null;

const pkgReader = reader({ [resolve(CWD, "package.json")]: PACKAGE_JSON });

describe("manifestKind", () => {
	test("keys off the basename, not the directory", () => {
		expect(manifestKind("apps/web/package.json")).toBe("npm");
		expect(manifestKind("/repo/Cargo.toml")).toBe("cargo");
		expect(manifestKind("pyproject.toml")).toBe("python");
		expect(manifestKind("go.mod")).toBe("go");
		expect(manifestKind("README.md")).toBeUndefined();
		expect(manifestKind("packages/cargo.toml.bak")).toBeUndefined();
	});
});

describe("depRegions", () => {
	test("package.json: every dependency table, no scripts or metadata", () => {
		expect(depRegions("npm", PACKAGE_JSON)).toEqual([
			{ start: 7, end: 9 },
			{ start: 10, end: 12 },
		]);
	});

	test("package.json: single-line table closes on its own line", () => {
		const text = ['{', '  "dependencies": { "zod": "^3" },', '  "private": true', "}"].join("\n");
		expect(depRegions("npm", text)).toEqual([{ start: 2, end: 2 }]);
	});

	test("Cargo.toml: dependency tables run to the next header", () => {
		expect(depRegions("cargo", CARGO_TOML)).toEqual([
			{ start: 5, end: 7 },
			{ start: 8, end: 10 },
			{ start: 11, end: 13 },
		]);
	});

	test("pyproject.toml: arrays and tables, never build-system requires", () => {
		expect(depRegions("python", PYPROJECT)).toEqual([
			{ start: 8, end: 10 },
			{ start: 12, end: 14 },
			{ start: 16, end: 18 },
		]);
	});

	test("go.mod: require block and bare require line", () => {
		expect(depRegions("go", GO_MOD)).toEqual([
			{ start: 5, end: 7 },
			{ start: 9, end: 9 },
		]);
	});

	test("a manifest with no dependency table yields nothing", () => {
		expect(depRegions("npm", '{\n  "name": "demo"\n}')).toEqual([]);
	});
});

describe("touchesRegion", () => {
	const region = { start: 7, end: 9 };

	test("ranges overlap; gaps count only when strictly inside", () => {
		expect(touchesRegion({ start: 8, end: 8 }, region)).toBe(true);
		expect(touchesRegion({ start: 1, end: 20 }, region)).toBe(true);
		expect(touchesRegion({ start: 10, end: 12 }, region)).toBe(false);
		expect(touchesRegion({ start: 7, end: 7, gap: "before" }, region)).toBe(false);
		expect(touchesRegion({ start: 8, end: 8, gap: "before" }, region)).toBe(true);
		expect(touchesRegion({ start: 7, end: 7, gap: "after" }, region)).toBe(true);
		expect(touchesRegion({ start: 9, end: 9, gap: "after" }, region)).toBe(false);
	});
});

describe("parseHashline", () => {
	test("splits sections and reads every op locator shape", () => {
		const payload = [
			"[package.json#A1B2]",
			"PUT 8.=8:",
			'+    "zod": "^4"',
			"CUT 11.=11",
			"PUT <5:",
			"+x",
			"PUT >7:",
			"+y",
			"PUT 4*:",
			"+z",
			"PUT 12.=12 @tail",
			"[README.md#C3D4]",
			"REM",
		].join("\n");
		expect(parseHashline(payload)).toEqual([
			{
				path: "package.json",
				touches: [
					{ start: 8, end: 8 },
					{ start: 11, end: 11 },
					{ start: 5, end: 5, gap: "before" },
					{ start: 7, end: 7, gap: "after" },
					{ start: 4, end: 4 },
					{ start: 12, end: 12 },
				],
			},
			{ path: "README.md", touches: [] },
		]);
	});

	test("body rows are content, never ops", () => {
		const payload = ["[package.json#A1B2]", "PUT 3.=3:", '+  "description": "new",', "+PUT 8.=8:"].join(
			"\n",
		);
		expect(parseHashline(payload)[0]?.touches).toEqual([{ start: 3, end: 3 }]);
	});
});

describe("adviseForWrite", () => {
	test("fires when the dependency table changes", () => {
		const changed = PACKAGE_JSON.replace('"^3.23.8"', '"^3.24.0"');
		const hits = adviseForWrite("package.json", changed, CWD, pkgReader);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.cli).toBe("bun add");
		expect(hits[0]?.lock).toBe("bun.lock");
	});

	test("stays silent when only prose changes", () => {
		const docs = PACKAGE_JSON.replace("docs live here", "docs live in the README");
		expect(adviseForWrite("package.json", docs, CWD, pkgReader)).toEqual([]);
	});

	test("stays silent when only formatting changes", () => {
		const reindented = PACKAGE_JSON.replaceAll("\n    ", "\n      ");
		expect(adviseForWrite("package.json", reindented, CWD, pkgReader)).toEqual([]);
	});

	test("fires when a whole dependency table is added", () => {
		const bare = '{\n  "name": "demo"\n}';
		const withDeps = '{\n  "name": "demo",\n  "dependencies": {\n    "zod": "^3"\n  }\n}';
		const hits = adviseForWrite("package.json", withDeps, CWD, reader({ [resolve(CWD, "package.json")]: bare }));
		expect(hits).toHaveLength(1);
	});

	test("creating a manifest is scaffolding, not amending", () => {
		expect(adviseForWrite("package.json", PACKAGE_JSON, CWD, reader({}))).toEqual([]);
	});

	test("ignores non-manifest and non-file targets", () => {
		expect(adviseForWrite("README.md", "text", CWD, pkgReader)).toEqual([]);
		expect(adviseForWrite("xd://ast_edit", "{}", CWD, pkgReader)).toEqual([]);
	});

	test("an existing lockfile names the manager that owns the manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "dep-advisory-"));
		writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
		const manifest = join(dir, "package.json");
		writeFileSync(manifest, PACKAGE_JSON);
		const changed = PACKAGE_JSON.replace('"^3.23.8"', '"^3.24.0"');
		const hits = adviseForWrite(manifest, changed, dir, reader({ [manifest]: PACKAGE_JSON }));
		expect(hits[0]?.cli).toBe("pnpm add");
	});
});

describe("adviseForHashline", () => {
	const advise = (payload: string) => adviseForHashline(payload, CWD, pkgReader);

	test("fires on a version bump inside the table", () => {
		expect(advise('[package.json#A1B2]\nPUT 8.=8:\n+    "zod": "^3.24.0"')).toHaveLength(1);
	});

	test("fires on an insert after the table opener", () => {
		expect(advise('[package.json#A1B2]\nPUT >7:\n+    "ky": "^1"')).toHaveLength(1);
	});

	test("fires when the whole table block is replaced", () => {
		expect(advise('[package.json#A1B2]\nPUT 7*:\n+  "dependencies": {}')).toHaveLength(1);
	});

	test("silent on a prose edit to the same manifest", () => {
		expect(advise('[package.json#A1B2]\nPUT 3.=3:\n+  "description": "new docs",')).toEqual([]);
	});

	test("silent on a sibling key inserted before the table", () => {
		expect(advise('[package.json#A1B2]\nPUT <7:\n+  "license": "MIT",')).toEqual([]);
	});

	test("silent on the scripts block", () => {
		expect(advise('[package.json#A1B2]\nPUT 4*:\n+  "scripts": {}')).toEqual([]);
	});

	test("only the manifest section of a multi-file patch counts", () => {
		const payload = [
			"[README.md#1111]",
			"PUT 1.=1:",
			"+# demo",
			"[package.json#A1B2]",
			"PUT 8.=8:",
			'+    "zod": "^4"',
		].join("\n");
		const hits = advise(payload);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.path).toBe("package.json");
	});

	test("silent when the manifest is not on disk", () => {
		expect(adviseForHashline('[package.json#A1B2]\nPUT 8.=8:\n+x', CWD, reader({}))).toEqual([]);
	});
});

describe("adviseForAnchoredEdit", () => {
	test("fires when the anchor quotes a dependency line", () => {
		expect(adviseForAnchoredEdit("package.json", '"zod": "^3.23.8"', CWD, pkgReader)).toHaveLength(1);
	});

	test("silent when the anchor quotes prose", () => {
		expect(adviseForAnchoredEdit("package.json", '"description": "docs live here"', CWD, pkgReader)).toEqual(
			[],
		);
	});
});

describe("ast_edit", () => {
	test("literals drop metavariables", () => {
		expect(patternLiterals('"zod": $VERSION')).toEqual(['"zod":']);
		expect(patternLiterals("$A")).toEqual([]);
	});

	test("fires only when a pattern literal sits in the table", () => {
		const paths = ["package.json"];
		expect(adviseForAstEdit(paths, ['"zod": $V'], CWD, pkgReader)).toHaveLength(1);
		expect(adviseForAstEdit(paths, ['"description": $V'], CWD, pkgReader)).toEqual([]);
		expect(adviseForAstEdit(paths, ["$A"], CWD, pkgReader)).toEqual([]);
	});
});

describe("collectHits", () => {
	test("dispatches per tool and ignores everything else", () => {
		const changed = PACKAGE_JSON.replace('"^3.23.8"', '"^3.24.0"');
		expect(collectHits("write", { path: "package.json", content: changed }, CWD, pkgReader)).toHaveLength(1);
		expect(
			collectHits("edit", { input: '[package.json#A1B2]\nPUT 8.=8:\n+x' }, CWD, pkgReader),
		).toHaveLength(1);
		expect(
			collectHits("edit", { path: "package.json", old_string: '"zod": "^3.23.8"' }, CWD, pkgReader),
		).toHaveLength(1);
		expect(
			collectHits("ast_edit", { paths: ["package.json"], ops: [{ pat: '"zod": $V', out: "" }] }, CWD, pkgReader),
		).toHaveLength(1);
		expect(collectHits("bash", { command: "bun add zod" }, CWD, pkgReader)).toEqual([]);
		expect(collectHits("write", { path: "package.json" }, CWD, pkgReader)).toEqual([]);
	});
});

describe("formatAdvisory", () => {
	test("names the manifest, the CLI, and the lockfile", () => {
		const text = formatAdvisory(
			[{ path: "package.json", abs: "/repo/package.json", kind: "npm", cli: "bun add", lock: "bun.lock" }],
			"/repo",
		);
		expect(text).toContain("package.json");
		expect(text).toContain("bun add");
		expect(text).toContain("bun.lock");
	});
});

describe("integration", () => {
	const wire = () => {
		const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
		depManifestAdvisory({
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: (e: Record<string, unknown>) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		} as never);
		return handlers;
	};

	beforeEach(() => resetDepManifestAdvisoryForTests());

	test("tool_result prepends the reminder, then dedupes; a failed call still owes it", () => {
		const handlers = wire();
		const call = handlers.tool_call![0]!;
		const done = handlers.tool_result![0]!;
		const dir = mkdtempSync(join(tmpdir(), "dep-advisory-live-"));
		const live = join(dir, "package.json");
		writeFileSync(live, PACKAGE_JSON);
		const input = { input: `[${live}#A1B2]\nPUT 8.=8:\n+    "zod": "^4"` };

		// tool_call never blocks: this is an advisory.
		expect(call({ toolName: "edit", toolCallId: "a1", input })).toBeUndefined();
		expect(
			done({ toolName: "edit", toolCallId: "a1", isError: true, content: [{ type: "text", text: "boom" }] }),
		).toBeUndefined();

		call({ toolName: "edit", toolCallId: "a2", input });
		const patched = done({
			toolName: "edit",
			toolCallId: "a2",
			content: [{ type: "text", text: "edited" }],
		});
		expect(JSON.stringify(patched)).toContain("bun add");

		call({ toolName: "edit", toolCallId: "a3", input });
		expect(
			done({ toolName: "edit", toolCallId: "a3", content: [{ type: "text", text: "edited" }] }),
		).toBeUndefined();
	});

	test("a prose edit to the same manifest leaves the result untouched", () => {
		const handlers = wire();
		const dir = mkdtempSync(join(tmpdir(), "dep-advisory-prose-"));
		const live = join(dir, "package.json");
		writeFileSync(live, PACKAGE_JSON);

		handlers.tool_call![0]!({
			toolName: "edit",
			toolCallId: "p1",
			input: { input: `[${live}#A1B2]\nPUT 3.=3:\n+  "description": "new docs",` },
		});
		expect(
			handlers.tool_result![0]!({
				toolName: "edit",
				toolCallId: "p1",
				content: [{ type: "text", text: "edited" }],
			}),
		).toBeUndefined();
	});

	test("handlers swallow malformed events", () => {
		const handlers = wire();
		expect(handlers.tool_call![0]!({ toolName: "edit", toolCallId: "x", input: null })).toBeUndefined();
		expect(handlers.tool_result![0]!({ toolName: "edit", toolCallId: "x" })).toBeUndefined();
	});
});
