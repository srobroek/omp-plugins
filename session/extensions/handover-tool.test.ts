import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import handoverTool, {
	buildContent,
	createHandover,
	parseBeads,
	slug,
	yamlScalar,
} from "./handover-tool.ts";


// Structural stand-in for pi.zod: the module only builds a parameter schema with
// it (object/string/array/boolean chains); execute() receives already-parsed params.
const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

describe("slug", () => {
	test("normalizes", () => {
		expect(slug("Foo/Bar Baz")).toBe("foo-bar-baz");
		expect(slug("...")).toBe("handover");
	});
});

describe("yamlScalar", () => {
	test("quotes safely", () => {
		expect(yamlScalar('a"b')).toBe(JSON.stringify('a"b'));
	});
});

describe("parseBeads", () => {
	test("splits", () => {
		expect(parseBeads("a, b,")).toEqual(["a", "b"]);
		expect(parseBeads()).toEqual([]);
	});
});

describe("buildContent", () => {
	test("beads layout", () => {
		const text = buildContent({
			project: "p",
			repoRoot: "/r",
			worktree: "/r",
			branch: "main",
			task: "t",
			beads: ["bd-1"],
		});
		expect(text).toContain("Active Beads");
		expect(text).toContain("- bd-1:");
		expect(text).not.toContain("## Incomplete");
	});
	test("default layout", () => {
		const text = buildContent({
			project: "p",
			repoRoot: "/r",
			worktree: "/r",
			branch: "main",
			task: "t",
		});
		expect(text).toContain("## Incomplete");
	});
});

describe("createHandover integration", () => {
	test("writes 0600 file", () => {
		const dir = mkdtempSync(join(tmpdir(), "handover-"));
		const result = createHandover({
			cwd: process.cwd(),
			outDir: dir,
			project: "demo",
			task: "task-1",
			branch: "main",
			repoRoot: "/tmp/demo",
			worktree: "/tmp/demo",
		});
		expect(result.ok).toBe(true);
		expect(result.path).toBe(join(dir, "demo__task-1.md"));
		const body = readFileSync(result.path!, "utf8");
		expect(body).toContain("project:");
		const mode = statSync(result.path!).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

describe("registerTool", () => {
	test("execute writes via fake pi", async () => {
		const captured: {
			name?: string;
			execute?: (
				id: string,
				params: Record<string, unknown>,
				a?: unknown,
				b?: unknown,
				c?: { cwd?: string },
			) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
		} = {};
		const fakePi = {
			zod: z,
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		};
		handoverTool(fakePi as never);
		expect(captured.name).toBe("new_handover");
		const dir = mkdtempSync(join(tmpdir(), "handover-ex-"));
		const out = await captured.execute!("id", {
			outDir: dir,
			project: "ex",
			task: "t",
			branch: "b",
			repoRoot: "/r",
			worktree: "/r",
		});
		expect(out.details.ok).toBe(true);
		expect(String(out.content[0].text)).toContain("ex__t.md");
	});
});

