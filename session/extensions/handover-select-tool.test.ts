import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import handoverSelectTool, {
	isPlaceholder,
	parseFrontmatter,
	selectHandovers,
} from "./handover-select-tool.ts";

const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

function writeHandover(dir: string, name: string, body: string): void {
	writeFileSync(join(dir, name), body, "utf8");
}

describe("parseFrontmatter", () => {
	test("reads scalars", () => {
		const fm = parseFrontmatter(`---\nproject: demo\nbranch: main\n---\nbody`);
		expect(fm.project).toBe("demo");
		expect(fm.branch).toBe("main");
	});
});

describe("isPlaceholder", () => {
	test("empty after fm is placeholder", () => {
		expect(isPlaceholder("---\nproject: x\n---\n")).toBe(true);
	});
	test("real prose is not", () => {
		expect(isPlaceholder("---\nproject: x\n---\n\nContinue from beads.\n")).toBe(false);
	});
});

describe("selectHandovers ranking", () => {
	test("prefers project match and recency over placeholder", () => {
		const dir = mkdtempSync(join(tmpdir(), "hsel-"));
		writeHandover(
			dir,
			"demo__old.md",
			`---\nproject: demo\nbranch: main\nupdated: 2020-01-01T00:00:00Z\nbeads: a-1\n---\n\nOld but real.\n`,
		);
		writeHandover(
			dir,
			"demo__new.md",
			`---\nproject: demo\nbranch: feat\nupdated: 2099-01-01T00:00:00Z\nbeads: a-2, a-3\n---\n\nFresh work.\n`,
		);
		writeHandover(
			dir,
			"other__x.md",
			`---\nproject: other\nupdated: 2099-06-01T00:00:00Z\n---\n\nUnrelated.\n`,
		);
		writeHandover(dir, "demo__empty.md", `---\nproject: demo\n---\n\nTODO\n`);
		const result = selectHandovers({ project: "demo", dir });
		expect(result.ok).toBe(true);
		expect(result.candidates[0]?.filename).toBe("demo__new.md");
		expect(result.candidates[0]?.score).toBeGreaterThan(result.candidates[1]?.score ?? 0);
		const empty = result.candidates.find((c) => c.filename === "demo__empty.md");
		expect(empty?.placeholder).toBe(true);
		expect(empty?.score ?? 0).toBeLessThan(result.candidates[0]?.score ?? 0);
	});

	test("empty dir is ok", () => {
		const dir = mkdtempSync(join(tmpdir(), "hsel-empty-"));
		mkdirSync(join(dir, "nested"));
		const result = selectHandovers({ dir: join(dir, "missing") });
		expect(result.ok).toBe(true);
		expect(result.candidates).toEqual([]);
	});
});

describe("registerTool", () => {
	test("execute ranks via fake pi", async () => {
		const captured: {
			name?: string;
			approval?: string;
			execute?: (
				id: string,
				params: Record<string, unknown>,
			) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
		} = {};
		handoverSelectTool({
			zod: z,
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		} as never);
		expect(captured.name).toBe("handover_select");
		expect(captured.approval).toBe("read");
		const dir = mkdtempSync(join(tmpdir(), "hsel-ex-"));
		writeHandover(dir, "p__t.md", `---\nproject: p\nupdated: 2099-01-01T00:00:00Z\n---\n\nGo.\n`);
		const out = await captured.execute!("id", { project: "p", dir });
		expect(out.details.ok).toBe(true);
		expect(String(out.content[0].text)).toContain("p__t.md");
	});
});
