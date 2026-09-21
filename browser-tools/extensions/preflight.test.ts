import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import headedBrowserPreflight from "./headed-browser-preflight.ts";

const ADVISED_KEY = Symbol.for("com.srobroek.browser-tools.headed-preflight.sent");
const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	delete (globalThis as Record<PropertyKey, unknown>)[ADVISED_KEY];
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("headed browser preflight", () => {
	test("emits an advisory when the aggregate session-start budget lapses", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "headed-preflight-test-"));
		temporaryDirectories.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const sent: Array<{ content: string }> = [];
		let handler: ((event: unknown, ctx: { cwd: string }) => Promise<void>) | undefined;
		const pi = {
			on: (event: string, callback: (event: unknown, ctx: { cwd: string }) => Promise<void>) => {
				if (event === "session_start") handler = callback;
			},
			sendMessage: (message: { content: string }) => sent.push(message),
		};
		headedBrowserPreflight(pi as never, {
			resolveConfig: async () => ({ engine: "firefox", browserChannel: "auto", executablePath: "", sourceProfileName: "" } as never),
			runPreflight: async () => new Promise<never>(() => undefined),
			budgetMs: 20,
		});
		if (!handler) throw new Error("session_start handler was not registered");
		await handler({}, { cwd: agentDir });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("preflight could not complete");
	});
});
