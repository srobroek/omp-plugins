import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import depScanTool from "./dep-scan-tool";
import { fetchJson, queryRegistry, researchProject } from "./lib";

function scanTool() {
	let execute!: (id: string, params: { path: string; offline_fixture_dir: string }, signal: AbortSignal, update: undefined, ctx: { cwd: string }) => Promise<unknown>;
	const string = () => {
		const schema = { optional: () => schema, describe: () => schema };
		return schema;
	};
	depScanTool({ zod: { string, object: (shape: unknown) => shape }, registerTool: (tool: { name: string; execute: typeof execute }) => {
		if (tool.name === "dep_scan") execute = tool.execute;
	} } as never);
	return execute;
}

function project() {
	const dir = mkdtempSync(join(tmpdir(), "dep-scan-cancel-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { first: "1.0.0", second: "1.0.0" } }));
	return dir;
}

describe("scan cancellation", () => {
	test("pre-cancelled callers stop before project or registry work", async () => {
		const controller = new AbortController();
		const reason = new Error("stop scan");
		controller.abort(reason);
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected fetch"); });
		try {
			await expect(researchProject("/nonexistent-cancelled-project", "", controller.signal)).rejects.toBe(reason);
			await expect(queryRegistry("npm", "first", "1.0.0", "", controller.signal)).rejects.toBe(reason);
			await expect(fetchJson("npm", "first", "https://registry.npmjs.org/first", "", controller.signal)).rejects.toBe(reason);
			await expect(scanTool()("id", { path: "/nonexistent-cancelled-project", offline_fixture_dir: "" }, controller.signal, undefined, { cwd: "/" })).rejects.toBe(reason);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			fetchMock.mockRestore();
		}
	});

	for (const phase of ["request", "body"] as const) {
		test(`in-flight ${phase} cancellation rejects host execution without querying later dependencies`, async () => {
			const dir = project();
			const controller = new AbortController();
			const reason = new Error("cancel active scan");
			let started!: () => void;
			const active = new Promise<void>((resolve) => { started = resolve; });
			const requests: string[] = [];
			const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
				requests.push(String(url));
				const signal = init?.signal;
				if (!signal) throw new Error("missing request signal");
				const pending = () => new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					started();
				});
				if (phase === "request") return pending();
				return { ok: true, json: pending } as unknown as Response;
			}) as typeof fetch);
			try {
				const result = scanTool()("id", { path: dir, offline_fixture_dir: "" }, controller.signal, undefined, { cwd: dir });
				const outcome = result.then(() => ({ resolved: true }), (error: unknown) => ({ error }));
				await active;
				controller.abort(reason);
				expect(await outcome).toEqual({ error: reason });
				expect(requests).toEqual(["https://registry.npmjs.org/first"]);
			} finally {
				controller.abort(reason);
				fetchMock.mockRestore();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("ordinary registry failures remain unresolvable and allow the next dependency", async () => {
		const dir = project();
		const requests: string[] = [];
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
			requests.push(String(url));
			if (requests.length === 1) return new Response("denied", { status: 403 });
			return Response.json({ "dist-tags": { latest: "1.0.1" }, versions: { "1.0.1": {} } });
		}) as typeof fetch);
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
