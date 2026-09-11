import { describe, expect, test } from "bun:test";

import { defaultRun, SURFACES, scanSurfaces } from "./find-tools-scan-tool.ts";


describe("scanSurfaces isolation", () => {
	test("one fetch failure does not fail other surfaces", async () => {
		const fetchFn = Object.assign(async (url: string | URL) => {
			const href = String(url);
			if (href.includes("registry.modelcontextprotocol.io")) throw new Error("network down");
			if (href.includes("registry.npmjs.org")) return new Response(JSON.stringify({ objects: [{ package: { name: "x-mcp", description: "hit" } }] }), { status: 200 });
			if (href.includes("smithery")) return new Response("{}", { status: 200 });
			return new Response("{}", { status: 404 });
		}, { preconnect: () => {} }) as typeof fetch;

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
				fetchFn: Object.assign(async () => new Response("should not run"), { preconnect: () => {} }) as typeof fetch,
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

	test.each(["{", "{}", "null"])("invalid npm responses disclose incomplete coverage: %s", async (invalid) => {
		let calls = 0;
		const { results, gaps } = await scanSurfaces({ query: "example", surfaces: ["npm"] }, {
			fetchFn: Object.assign(async () => new Response(calls++ === 0
				? JSON.stringify({ objects: [{ package: { name: "retained-hit" } }] }) : invalid), { preconnect: () => {} }) as typeof fetch,
		});
		const npm = results.find((result) => result.surface === "npm");
		expect(npm?.ok).toBe(false);
		expect(npm?.hits.map((hit) => hit.name)).toEqual(["retained-hit"]);
		expect(gaps.some((gap) => gap.surface === "npm")).toBe(true);
	});
});

describe("local MCP inventory privacy", () => {
	test("never returns configuration values or parser fragments", async () => {
		const secret = "SYNTHETIC_MCP_SECRET_CANARY";
		const config = JSON.stringify({
			mcpServers: {
				[secret]: { command: secret, args: [secret], env: { TOKEN: secret } },
				remote: { url: `https://${secret}`, headers: { Authorization: secret }, enabled: false },
			}
		});
		for (const body of [config, config.slice(0, -1), JSON.stringify({ mcpServers: [secret] })]) {
			const result = await scanSurfaces({ query: "local", surfaces: ["local"] }, {
				readFile: () => body, which: () => false,
				run: async () => { throw new Error("unexpected spawn"); },
			});
			expect(JSON.stringify(result)).not.toContain(secret);
			const inventory = result.results.find((r) => r.surface === "local")?.hits.find((h) => h.name.endsWith("mcp.json"));
			expect(inventory?.detail).toBe(body === config
				? '{"configured":2,"disabled":1,"stdio":1,"remote":1}'
				: "invalid MCP inventory; configuration omitted");
		}
	});
});

describe("read discovery execution boundary", () => {
	test("default and explicitly selected skills discovery never execute package code", async () => {
		for (const surfaces of [undefined, ["skills_cli"]]) {
			const commands: string[][] = [];
			const result = await scanSurfaces({ query: "browser", surfaces }, {
				fetchFn: Object.assign(async () => new Response("{}"), { preconnect: () => {} }) as typeof fetch,
				which: () => true,
				readFile: () => null,
				env: {},
				run: async (argv) => {
					commands.push(argv);
					return { ok: true, stdout: "{}", stderr: "" };
				},
			});
			expect(commands.every(([bin]) => bin === "omp" || bin === "gh")).toBe(true);
			expect(result.gaps.find((gap) => gap.surface === "skills_cli")?.reason).toMatch(/approval/i);
			expect(result.results.find((surface) => surface.surface === "skills_cli")?.skipped).toBe(true);
		}
	});
});

// Real subprocess deadlines and inherited OS pipes cannot be exercised with fake timers.
describe("bounded discovery subprocesses", () => {
	test("kills a SIGTERM-resistant command at the deadline", async () => {
		const started = Date.now();
		const result = await defaultRun([process.execPath, "-e",
			'process.on("SIGTERM", () => {}); setInterval(() => {}, 10); setTimeout(() => process.exit(), 3000);',
		], 150);
		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/deadline/i);
		expect(Date.now() - started).toBeLessThan(1800);
	});

	test("bounds shared stdout and stderr collection", async () => {
		const result = await defaultRun([process.execPath, "-e",
			'process.stdout.write("x".repeat(70000)); process.stderr.write("y".repeat(70000));',
		], 2000);
		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/output limit/i);
		expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThan(65_700);
	});

	test("closes pipes held by a detached descendant after its parent exits", async () => {
		const started = Date.now();
		const result = await defaultRun([process.execPath, "-e",
			`const {spawn} = require("node:child_process"); const p = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(), 3000)"], {detached:true, stdio:["ignore",1,2]}); p.unref();`,
		], 150);
		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/deadline/i);
		expect(Date.now() - started).toBeLessThan(1800);
	});

	test("cancellation interrupts running commands and prevents later spawns", async () => {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 100);
		const started = Date.now();
		try {
			const result = await defaultRun([process.execPath, "-e", "setTimeout(() => {}, 3000)"], 5000, { signal: ac.signal });
			expect(result.ok).toBe(false);
			expect(result.stderr).toMatch(/cancelled/i);
			expect(Date.now() - started).toBeLessThan(1800);
			const commands: string[][] = [];
			await scanSurfaces({ query: "x", surfaces: ["local", "discover", "github"] }, {
				signal: ac.signal, which: () => true, readFile: () => null,
				run: async (argv) => { commands.push(argv); return { ok: true, stdout: "", stderr: "" }; },
			});
			expect(commands).toEqual([]);
		} finally {
			clearTimeout(timer);
		}
	});
});
