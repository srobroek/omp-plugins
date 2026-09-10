import { afterEach, describe, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer-core";
import headedBrowserTools from "./headed-browser-tools.ts";
import { resolveConfig } from "./lib/config.ts";
import type { HeadedSession } from "./lib/session.ts";
import { sessions } from "./lib/session.ts";

type RegisteredTool = {
	name: string;
	approval: string;
	execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }>;
};

function fakeZod(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	for (const method of ["string", "number", "boolean", "enum", "array", "object", "optional"]) chain[method] = self;
	return chain;
}

function register(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		zod: fakeZod(),
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		on: () => undefined,
	};
	headedBrowserTools(pi as never);
	return tools;
}

afterEach(() => sessions.clear());

describe("headed browser tool registration", () => {
	test("registers four tools with the expected approvals", () => {
		const tools = register();
		expect([...tools.keys()]).toEqual(["headed_session", "headed_nav", "headed_read", "headed_act"]);
		expect(tools.get("headed_session")?.approval).toBe("exec");
		expect(tools.get("headed_nav")?.approval).toBe("write");
		expect(tools.get("headed_read")?.approval).toBe("read");
		expect(tools.get("headed_act")?.approval).toBe("write");
	});

	test("returns a structured error for missing required parameters", async () => {
		const tool = register().get("headed_session")!;
		const result = await tool.execute("id", { op: "close" });
		expect(result.details.ok).toBe(false);
		expect(result.details.error).toBe("headed-browser: sessionId is required");
	});

	test("returns a structured error for an unknown session", async () => {
		const tool = register().get("headed_session")!;
		const result = await tool.execute("id", { op: "close", sessionId: "hb-ffffff" });
		expect(result.details.ok).toBe(false);
		expect(result.details.error).toBe("headed-browser: unknown session hb-ffffff");
	});
	test("applies request policy before using a new tab", async () => {
		const attachedEvents: string[] = [];
		let requestInterception = false;
		let disconnected = false;
		let postTimeoutMutation = false;
		let releaseScreenshot: () => void = () => undefined;
		const screenshotBlocked = new Promise<void>((resolve) => {
			releaseScreenshot = () => resolve();
		});
		const initialPageState = {
			on: () => undefined,
			url: () => "about:blank",
			close: async () => undefined,
		};
		const newPageState = {
			on: (event: string) => { attachedEvents.push(event); },
			evaluateOnNewDocument: async () => undefined,
			setRequestInterception: async (enabled: boolean) => { requestInterception = enabled; },
			url: () => "about:blank",
			cookies: async () => {
				await screenshotBlocked;
				if (!disconnected) postTimeoutMutation = true;
				return [];
			},
			close: async () => undefined,
		};
		// Puppeteer Page is intentionally represented by the minimal observable contract used by newTab.
		const initialPage = initialPageState as unknown as Page;
		const newPage = newPageState as unknown as Page;
		const browserState = {
			newPage: async () => newPage,
			close: async () => undefined,
			disconnect: async () => { disconnected = true; },
			process: () => ({ kill: () => { disconnected = true; } }),
		};
		// Puppeteer Browser is intentionally represented by the minimal observable contract used by newTab.
		const browser = browserState as unknown as Browser;
		const config = await resolveConfig(process.cwd(), {}, async () => ({ values: {}, source: "test", warnings: [] }));
		const session: HeadedSession = {
			id: "hb-newtab", browser,
			resolvedBrowser: { engine: "firefox", channel: "firefox", path: "/browser", probedPaths: [] },
			profileMode: "clean",
			profile: {
				sessionDir: "/tmp/hb-newtab",
				profileDir: "/tmp/hb-newtab/profile",
				downloadsDir: "/tmp/hb-newtab/downloads",
				artifactsDir: "/tmp/hb-newtab/artifacts",
				cookieDomains: [],
				containerCookiesSkipped: 0,
				warnings: [],
				persistentProfile: false,
				copyStrategy: "node",
			},
			config, createdAt: Date.now(), lastActivityAt: Date.now(),
			pages: new Map([["tab-initial", initialPage]]), pageIds: new WeakMap([[initialPage, "tab-initial"]]),
			selectedTabId: "tab-initial", refs: new Map(), network: [], warnings: [],
		};
		sessions.set(session.id, session);
		const tool = register().get("headed_nav")!;
		const ctx = {
			sessionManager: { getSessionId: () => "tool-test" },
			setTimeout: (_callback: () => void, _ms: number) => 0,
			clearTimer: (_timer: unknown) => undefined,
		};
		const result = await tool.execute("id", { op: "newTab", sessionId: session.id, timeoutMs: 500 }, undefined, undefined, ctx);
		expect(result.details.error).toBeUndefined();
		expect(result.details.sessionId).toBe(session.id);
		expect(requestInterception).toBe(true);
		expect(attachedEvents).toContain("request");
		expect(session.selectedTabId).not.toBe("tab-initial");
		let triggerTimeout: () => void = () => undefined;
		const timeoutCtx = {
			sessionManager: { getSessionId: () => "tool-test" },
			setTimeout: (callback: () => void, _ms: number) => { triggerTimeout = callback; return 1; },
			clearTimer: (_timer: unknown) => undefined,
		};
		const cookieRead = register().get("headed_read")!.execute("id", { op: "cookies", sessionId: session.id, timeoutMs: 5 }, undefined, undefined, timeoutCtx);
		await Promise.resolve();
		triggerTimeout();
		const timedOut = await cookieRead;
		expect(timedOut.details.error).toContain("timed out after 5 ms");
		expect(disconnected).toBe(true);
		expect(sessions.has(session.id)).toBe(false);
		releaseScreenshot();
		await Promise.resolve();
		expect(postTimeoutMutation).toBe(false);
	});

});
