import { describe, expect, test } from "bun:test";

import findToolsScanTool, { scanSurfaces, SURFACES } from "./find-tools-scan-tool.ts";

const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
const z = new Proxy({}, { get: () => chain() }) as never;

describe("scanSurfaces isolation", () => {
	test("one fetch failure does not fail other surfaces", async () => {
		const fetchFn = (async (url: string | URL) => {
			const href = String(url);
			if (href.includes("registry.modelcontextprotocol.io")) {
				throw new Error("network down");
			}
			if (href.includes("registry.npmjs.org")) {
				return new Response(JSON.stringify({ objects: [{ package: { name: "x-mcp", description: "hit" } }] }), {
					status: 200,
				});
			}
			if (href.includes("smithery")) {
				return new Response("{}", { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const { results, gaps } = await scanSurfaces(
			{ query: "browser" },
			{
				fetchFn,
				run: async () => ({ ok: false, stdout: "", stderr: "nope" }),
				readFile: () => null,
				which: () => false,
				env: {},
			},
		);
		expect(results).toHaveLength(SURFACES.length);
		const mcp = results.find((r) => r.surface === "mcp_registry");
		expect(mcp?.ok).toBe(false);
		const npm = results.find((r) => r.surface === "npm");
		expect(npm?.ok).toBe(true);
		expect(npm?.hits.some((h) => h.name === "x-mcp")).toBe(true);
		const smithery = results.find((r) => r.surface === "smithery");
		expect(smithery?.skipped).toBe(true);
		expect(smithery?.reason).toContain("SMITHERY_API_KEY");
		expect(gaps.some((g) => g.surface === "mcp_registry")).toBe(true);
		expect(gaps.some((g) => g.surface === "smithery")).toBe(true);
	});

	test("surfaces subset skips others", async () => {
		const { results, gaps } = await scanSurfaces(
			{ query: "x", surfaces: ["local"] },
			{
				fetchFn: (async () => new Response("should not run")) as typeof fetch,
				run: async () => ({ ok: true, stdout: "plugins", stderr: "" }),
				readFile: () => "{}",
				which: () => true,
				env: {},
			},
		);
		expect(results.find((r) => r.surface === "local")?.ok).toBe(true);
		expect(results.find((r) => r.surface === "npm")?.skipped).toBe(true);
		expect(gaps.some((g) => g.surface === "npm" && g.reason === "not requested")).toBe(true);
	});
});

describe("registerTool", () => {
	test("execute uses mocked deps via isolated scan not needed — tool name/approval", async () => {
		const captured: {
			name?: string;
			approval?: string;
			execute?: (
				id: string,
				params: Record<string, unknown>,
			) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
		} = {};
		findToolsScanTool({
			zod: z,
			registerTool: (d: Record<string, unknown>) => Object.assign(captured, d),
			on: () => {},
		} as never);
		expect(captured.name).toBe("find_tools_scan");
		expect(captured.approval).toBe("read");
	});
});
