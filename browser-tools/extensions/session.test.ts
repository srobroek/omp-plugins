import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import type { EffectiveConfig } from "./lib/config.ts";
import type { HeadedSession } from "./lib/session.ts";
import { closeAllSessions, listLeakedSessions, sessions } from "./lib/session.ts";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	sessions.clear();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function testAgentDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "headed-session-shutdown-test-"));
	temporaryDirectories.push(path);
	process.env.PI_CODING_AGENT_DIR = path;
	return path;
}

function fakeSession(id: string): HeadedSession {
	return {
		id,
		browser: {} as Browser,
		resolvedBrowser: { engine: "firefox", channel: "firefox", path: "/browser", probedPaths: [] },
		profileMode: "clean",
		profile: {
			sessionDir: "/tmp/headed-session",
			profileDir: "/tmp/headed-session/profile",
			downloadsDir: "/tmp/headed-session/downloads",
			artifactsDir: "/tmp/headed-session/artifacts",
			persistentProfile: false,
			warnings: [],
			containerCookiesSkipped: 0,
			cookieDomains: [],
			copyStrategy: "node",
		},
		config: { keepArtifactsOnClose: false, warnings: [] } as unknown as EffectiveConfig,
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		pages: new Map(),
		pageIds: new WeakMap(),
		selectedTabId: "",
		refs: new Map(),
		network: [],
		warnings: [],
	};
}

describe("headed browser session shutdown", () => {
	test("returns before the shutdown budget when teardown would take 60000ms", async () => {
		await testAgentDirectory();
		const session = fakeSession("hb-slow");
		sessions.set(session.id, session);
		const started = performance.now();
		const report = await closeAllSessions("session-shutdown", {
			budgetMs: 100,
			close: async () => new Promise<void>(() => undefined),
		});
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(500);
		expect(report.leaked).toEqual([session.id]);
	});

	test("persists a teardown leak so a later session can discover it", async () => {
		await testAgentDirectory();
		const session = fakeSession("hb-leaked");
		sessions.set(session.id, session);
		await closeAllSessions("session-shutdown", {
			budgetMs: 10,
			close: async () => new Promise<void>(() => undefined),
		});
		const leaked = await listLeakedSessions();
		expect(leaked).toHaveLength(1);
		expect(leaked[0]).toMatchObject({ sessionId: session.id, status: "leaked", sessionDir: session.profile.sessionDir, profileDir: session.profile.profileDir });
	});
});
