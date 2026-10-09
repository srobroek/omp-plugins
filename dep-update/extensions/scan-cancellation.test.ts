import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import depScanTool from "./dep-scan-tool";
import { fetchJson, queryRegistry, researchProject } from "./lib";

function scanTool() {
	let execute!: (id: string, params: { path: string }, signal: AbortSignal, update: undefined, ctx: { cwd: string }) => Promise<{ details: ScanDetails }>;
	const string = () => {
		const schema = { optional: () => schema, describe: () => schema };
		return schema;
	};
	depScanTool({ zod: { string, object: (shape: unknown) => shape }, registerTool: (tool: { name: string; execute: typeof execute }) => {
		if (tool.name === "dep_scan") execute = tool.execute;
	} } as never);
	return execute;
}

type ScanDetails = { complete: boolean; records: Array<{ name: string; status: string; reason?: string }> };

const outcome = (records: ScanDetails["records"]) => records.map(({ name, status, reason }) => ({ name, status, reason }));

function project(names = ["first", "second"]) {
	const dir = mkdtempSync(join(tmpdir(), "dep-scan-cancel-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: Object.fromEntries(names.map((name) => [name, "1.0.0"])) }));
	return dir;
}
describe("scan cancellation", () => {
	test("pre-cancelled callers stop before project or registry work and report an incomplete scan", async () => {
		const controller = new AbortController();
		const reason = new Error("stop scan");
		controller.abort(reason);
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("unexpected fetch"); }, { preconnect: () => {} }));
		try {
			expect(await researchProject("/nonexistent-cancelled-project", "", controller.signal)).toMatchObject({ exit: 0, records: [], complete: false });
			await expect(queryRegistry("npm", "first", "1.0.0", "", controller.signal)).rejects.toBe(reason);
			await expect(fetchJson("npm", "first", "https://registry.npmjs.org/first", "", controller.signal)).rejects.toBe(reason);
			const { details } = await scanTool()("id", { path: "/nonexistent-cancelled-project" }, controller.signal, undefined, { cwd: "/" });
			expect(details).toMatchObject({ complete: false, records: [] });
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			fetchMock.mockRestore();
		}
	});

	for (const phase of ["request", "body"] as const) {
		test(`in-flight ${phase} cancellation is an incomplete scan that never queries later dependencies`, async () => {
			const dir = project();
			const controller = new AbortController();
			const reason = new Error("cancel active scan");
			let started!: () => void;
			const active = new Promise<void>((resolve) => { started = resolve; });
			const requests: string[] = [];
			const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: unknown, init?: RequestInit) => {
				requests.push(String(url));
				const signal = init?.signal;
				if (!signal) throw new Error("missing request signal");
				const pending = () => new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					started();
				});
				if (phase === "request") return pending();
				return { ok: true, json: pending } as unknown as Response;
			}, { preconnect: () => {} }) as typeof fetch);
			try {
				const result = scanTool()("id", { path: dir }, controller.signal, undefined, { cwd: dir });
				await active;
				controller.abort(reason);
				const { details } = await result;
				expect(details.complete).toBe(false);
				expect(outcome(details.records)).toEqual([
					{ name: "first", status: "UNCHECKED", reason: "not checked: cancelled" },
					{ name: "second", status: "UNCHECKED", reason: "not checked: cancelled" },
				]);
				expect(requests).toEqual(["https://registry.npmjs.org/first"]);
			} finally {
				controller.abort(reason);
				fetchMock.mockRestore();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("the aggregate deadline is an incomplete scan: the cut-short query and the rest are unchecked", async () => {
		const dir = project(["first", "second", "third"]);
		const requests: string[] = [];
		// `second` hangs until its request signal aborts, so only the scan deadline ends it.
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: unknown, init?: RequestInit) => {
			requests.push(String(url));
			if (!String(url).endsWith("/second")) return Response.json({ "dist-tags": { latest: "1.0.1" }, versions: { "1.0.1": {} } });
			const signal = init?.signal;
			if (!signal) throw new Error("missing request signal");
			return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		}, { preconnect: () => {} }) as typeof fetch);
		try {
			const started = Date.now();
			const result = await researchProject(dir, "", new AbortController().signal, 2_000);
			expect(Date.now() - started).toBeLessThan(8_000);
			expect(result.complete).toBe(false);
			expect(outcome(result.records)).toEqual([
				{ name: "first", status: "OK", reason: undefined },
				{ name: "second", status: "UNCHECKED", reason: "not checked: scan deadline reached" },
				{ name: "third", status: "UNCHECKED", reason: "not checked: scan deadline reached" },
			]);
			expect(requests).toEqual(["https://registry.npmjs.org/first", "https://registry.npmjs.org/second"]);
			expect(result.stderr).toContain("PARTIAL: scan deadline reached; 2 dependencies were not checked.");
		} finally {
			fetchMock.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);

	test("ordinary registry failures remain unresolvable and allow the next dependency", async () => {
		const dir = project();
		const requests: string[] = [];
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: unknown) => {
			requests.push(String(url));
			if (requests.length === 1) return new Response("denied", { status: 403 });
			return Response.json({ "dist-tags": { latest: "1.0.1" }, versions: { "1.0.1": {} } });
		}, { preconnect: () => {} }) as typeof fetch);
		try {
			const result = await researchProject(dir, "", new AbortController().signal);
			expect(result.records.map(({ name, status, reason }) => ({ name, status, reason }))).toEqual([
				{ name: "first", status: "UNRESOLVABLE", reason: "auth-required" },
				{ name: "second", status: "OK", reason: undefined },
			]);
			expect(requests).toEqual(["https://registry.npmjs.org/first", "https://registry.npmjs.org/second"]);
		} finally {
			fetchMock.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
