import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import headedBrowserTools from "./headed-browser-tools.ts";
import { resolveConfig } from "./lib/config.ts";
import type { CursorVisualCommand } from "./lib/cursor.ts";
import { createCursorRuntime } from "./lib/cursor.ts";
import type { PlanOutcome } from "./lib/plan.ts";
import { PLAN_STEP_LIMIT, PLAN_STEP_OUTPUT_LIMIT } from "./lib/plan.ts";
import type { HeadedSession } from "./lib/session.ts";
import { registerPage, sessions } from "./lib/session.ts";

type RegisteredTool = {
	name: string;
	approval: string;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};

function fakeZod(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	for (const method of ["string", "number", "boolean", "enum", "array", "object", "optional", "passthrough"]) chain[method] = self;
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

/** Temporary audit directories; a plan writes audit records the way production does. */
const temps: string[] = [];

afterEach(async () => {
	sessions.clear();
	await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("headed browser tool registration", () => {
	test("registers five tools with the expected approvals", () => {
		const tools = register();
		expect([...tools.keys()]).toEqual(["headed_session", "headed_nav", "headed_read", "headed_act", "headed_plan"]);
		expect(tools.get("headed_session")?.approval).toBe("exec");
		expect(tools.get("headed_nav")?.approval).toBe("write");
		expect(tools.get("headed_read")?.approval).toBe("read");
		expect(tools.get("headed_act")?.approval).toBe("write");
		expect(tools.get("headed_plan")?.approval).toBe("write");
	});

	test("returns a sanitized category for missing required parameters", async () => {
		const tool = register().get("headed_session")!;
		const result = await tool.execute("id", { op: "close" });
		expect(result.details.ok).toBe(false);
		expect(result.details.error).toBe("invalid request");
	});

	test("returns a sanitized category for an unknown session", async () => {
		const tool = register().get("headed_session")!;
		const rawDriverMessage = "/tmp/driver-message: disconnected";
		const result = await tool.execute("id", { op: "close", sessionId: rawDriverMessage });
		expect(result.details.ok).toBe(false);
		expect(result.details.error).toBe("unknown session");
		expect(result.details.error).not.toContain(rawDriverMessage);
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
			evaluateOnNewDocument: async () => ({ identifier: "new-tab-registration" }),
			evaluate: async () => undefined,
			setRequestInterception: async (enabled: boolean) => { requestInterception = enabled; },
			url: () => "about:blank",
			mainFrame: () => ({}),
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
			selectedTabId: "tab-initial", refs: new Map(), network: [],
			cursor: createCursorRuntime({ mode: config.cursorMode, headless: config.headless, warnings: [] }),
			warnings: [],
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
		expect(timedOut.details.error).toBe("session timeout");
		expect(disconnected).toBe(true);
		expect(sessions.has(session.id)).toBe(false);
		releaseScreenshot();
		await Promise.resolve();
		expect(postTimeoutMutation).toBe(false);
	});

});

interface ActFixture {
	session: HeadedSession;
	commands: CursorVisualCommand[];
	counts: { clicks: number; handles: number; disposals: number };
}

/** A session whose selected tab exposes only what a target-bearing act needs. */
async function actFixture(options: { boxes: Array<{ x: number; y: number; width: number; height: number } | null>; renderFails?: boolean }): Promise<ActFixture> {
	const commands: CursorVisualCommand[] = [];
	const counts = { clicks: 0, reads: 0, handles: 0, disposals: 0 };
	// A fresh handle per resolution, so a leaked one is an observable imbalance.
	const resolveElement = () => {
		counts.handles += 1;
		return {
			scrollIntoView: async () => undefined,
			boundingBox: async () => {
				const box = options.boxes[Math.min(counts.reads, options.boxes.length - 1)] ?? null;
				counts.reads += 1;
				return box;
			},
			click: async () => { counts.clicks += 1; },
			dispose: async () => { counts.disposals += 1; },
		};
	};
	const pageState = {
		on: () => undefined,
		url: () => "about:blank",
		close: async () => undefined,
		mainFrame: () => ({}),
		evaluateOnNewDocument: async () => ({ identifier: "act-registration" }),
		evaluate: async (target: unknown, command?: CursorVisualCommand) => {
			if (typeof target === "string" || command === undefined) return undefined;
			if (options.renderFails === true) throw new Error("render refused");
			commands.push(command);
			return undefined;
		},
		$: async () => resolveElement(),
	};
	// Puppeteer Page and ElementHandle are represented by the contract a target-bearing act uses.
	const page = pageState as unknown as Page;
	const browserState = { pages: async () => [page], close: async () => undefined, disconnect: async () => undefined, process: () => undefined };
	const config = await resolveConfig(process.cwd(), { cursorMode: "instant" }, async () => ({ values: {}, source: "test", warnings: [] }));
	const warnings: string[] = [];
	const session: HeadedSession = {
		id: "hb-act", browser: browserState as unknown as Browser,
		resolvedBrowser: { engine: "firefox", channel: "firefox", path: "/browser", probedPaths: [] },
		profileMode: "clean",
		profile: {
			sessionDir: "/tmp/hb-act", profileDir: "/tmp/hb-act/profile", downloadsDir: "/tmp/hb-act/downloads",
			artifactsDir: "/tmp/hb-act/artifacts", cookieDomains: [], containerCookiesSkipped: 0, warnings: [],
			persistentProfile: false, copyStrategy: "node",
		},
		config, createdAt: Date.now(), lastActivityAt: Date.now(),
		pages: new Map(), pageIds: new WeakMap(), selectedTabId: "", refs: new Map(), network: [],
		cursor: createCursorRuntime({ mode: config.cursorMode, headless: config.headless, warnings }),
		warnings,
	};
	session.selectedTabId = await registerPage(session, page);
	sessions.set(session.id, session);
	return { session, commands, counts };
}

const actContext = {
	sessionManager: { getSessionId: () => "tool-test" },
	setTimeout: (_callback: () => void, _ms: number) => 0,
	clearTimer: (_timer: unknown) => undefined,
};

describe("headed act cursor integration", () => {
	test("points at the driver-resolved target, clicks, and clears the overlay", async () => {
		const fixture = await actFixture({ boxes: [{ x: 10, y: 20, width: 40, height: 20 }] });
		const result = await register().get("headed_act")!.execute("id", { op: "click", sessionId: fixture.session.id, selector: "#save" }, undefined, undefined, actContext);
		expect(result.details.error).toBeUndefined();
		expect(fixture.counts.clicks).toBe(1);
		expect(fixture.commands.map((entry) => entry.kind)).toEqual(["move", "pulse", "hide"]);
		expect(fixture.commands[0]?.target).toEqual({ x: 30, y: 30 });
		// Every resolved handle is released: the acted-on one here, superseded ones in the driver.
		expect(fixture.counts.disposals).toBe(fixture.counts.handles);
	});

	test("reports target_moved and never clicks a target that keeps moving", async () => {
		const fixture = await actFixture({
			boxes: [
				{ x: 0, y: 0, width: 20, height: 20 },
				{ x: 300, y: 0, width: 20, height: 20 },
				{ x: 300, y: 0, width: 20, height: 20 },
				{ x: 600, y: 0, width: 20, height: 20 },
			],
		});
		const result = await register().get("headed_act")!.execute("id", { op: "click", sessionId: fixture.session.id, selector: "#save" }, undefined, undefined, actContext);
		expect(result.details.error).toBe("target_moved");
		expect(fixture.counts.clicks).toBe(0);
		expect(fixture.commands.map((entry) => entry.kind)).toEqual(["move", "move", "hide"]);
		expect(fixture.counts.handles).toBe(2);
		expect(fixture.counts.disposals).toBe(2);
	});

	test("clicks anyway when the cursor script fails", async () => {
		const fixture = await actFixture({ boxes: [{ x: 0, y: 0, width: 20, height: 20 }], renderFails: true });
		const result = await register().get("headed_act")!.execute("id", { op: "click", sessionId: fixture.session.id, selector: "#save" }, undefined, undefined, actContext);
		expect(result.details.error).toBeUndefined();
		expect(fixture.counts.clicks).toBe(1);
		expect(fixture.session.cursor.mode).toBe("off");
		expect(fixture.session.warnings).toHaveLength(1);
		expect(fixture.session.warnings[0]).toContain("cursor visualization disabled");
		expect(fixture.counts.disposals).toBe(fixture.counts.handles);
	});
});

interface PlanFixture {
	session: HeadedSession;
	/** Every operation the selected tab performed, in the order it performed them. */
	log: string[];
	commands: CursorVisualCommand[];
	counts: { handles: number; disposals: number };
	auditDir: string;
	/** Resolves once the gated navigation is in flight, so a test needs no timed wait. */
	gotoStarted: Promise<void>;
	releaseGoto: () => void;
}

/** A session whose selected tab records navigation, reads, and actions in order. */
async function planFixture(options: { gateGoto?: boolean; failGoto?: boolean; html?: string; onGoto?: () => void; onCursorCommand?: (command: CursorVisualCommand) => void; navigateOnClick?: boolean } = {}): Promise<PlanFixture> {
	const log: string[] = [];
	const commands: CursorVisualCommand[] = [];
	const counts = { handles: 0, disposals: 0 };
	let releaseGoto: () => void = () => undefined;
	let announceGoto: () => void = () => undefined;
	// An operation that lands while the navigation is still in flight names itself, so an
	// overlap is a wrong log entry rather than a timing guess.
	let navigating = false;
	const gate = new Promise<void>((resolve) => {
		releaseGoto = () => resolve();
	});
	const gotoStarted = new Promise<void>((resolve) => {
		announceGoto = () => resolve();
	});
	const mainFrame = {};
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	const pageState = {
		on: (type: string, listener: (value: unknown) => void) => { const group = listeners.get(type) ?? []; group.push(listener); listeners.set(type, group); },
		url: () => "about:blank",
		close: async () => undefined,
		mainFrame: () => mainFrame,
		evaluateOnNewDocument: async () => ({ identifier: "plan-registration" }),
		evaluate: async (target: unknown, command?: CursorVisualCommand) => {
			if (typeof target === "string" || command === undefined) return undefined;
			commands.push(command);
			options.onCursorCommand?.(command);
			return undefined;
		},
		goto: async () => {
			log.push("goto");
			options.onGoto?.();
			if (options.gateGoto === true) {
				navigating = true;
				announceGoto();
				await gate;
				navigating = false;
			}
			if (options.failGoto === true) throw new Error("headed-browser: the server refused the navigation");
			for (const listener of listeners.get("framenavigated") ?? []) listener(mainFrame);
			return null;
		},
		waitForSelector: async () => {
			log.push(navigating ? "wait-during-goto" : "wait");
			return null;
		},
		content: async () => {
			log.push("html");
			return options.html ?? "<main>ready</main>";
		},
		$: async () => {
			counts.handles += 1;
			return {
				scrollIntoView: async () => undefined,
				boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 20 }),
				click: async () => {
					log.push(navigating ? "click-during-goto" : "click");
					if (options.navigateOnClick) for (const listener of listeners.get("framenavigated") ?? []) listener(mainFrame);
				},
				dispose: async () => { counts.disposals += 1; },
			};
		},
	};
	// Puppeteer Page and ElementHandle are represented by the contract a plan step uses.
	const page = pageState as unknown as Page;
	const browserState = { pages: async () => [page], close: async () => undefined, disconnect: async () => undefined, process: () => undefined };
	const auditDir = await mkdtemp(join(tmpdir(), "headed-plan-audit-"));
	temps.push(auditDir);
	const config = await resolveConfig(process.cwd(), { cursorMode: "instant", auditDir }, async () => ({ values: {}, source: "test", warnings: [] }));
	const warnings: string[] = [];
	const session: HeadedSession = {
		id: "hb-plan", browser: browserState as unknown as Browser,
		resolvedBrowser: { engine: "firefox", channel: "firefox", path: "/browser", probedPaths: [] },
		profileMode: "clean",
		profile: {
			sessionDir: "/tmp/hb-plan", profileDir: "/tmp/hb-plan/profile", downloadsDir: "/tmp/hb-plan/downloads",
			artifactsDir: "/tmp/hb-plan/artifacts", cookieDomains: [], containerCookiesSkipped: 0, warnings: [],
			persistentProfile: false, copyStrategy: "node",
		},
		config, createdAt: Date.now(), lastActivityAt: Date.now(),
		pages: new Map(), pageIds: new WeakMap(), selectedTabId: "", refs: new Map(), network: [],
		cursor: createCursorRuntime({ mode: config.cursorMode, headless: config.headless, warnings }),
		warnings,
	};
	session.selectedTabId = await registerPage(session, page);
	sessions.set(session.id, session);
	return { session, log, commands, counts, auditDir, gotoStarted, releaseGoto };
}

function planOutcome(result: { content: Array<{ text: string }> }): PlanOutcome {
	return JSON.parse(result.content[0]!.text) as PlanOutcome;
}

describe("headed plan execution", () => {
	test("rejects the whole plan before performing any operation", async () => {
		const fixture = await planFixture();
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "act", op: "click" },
			],
		}, undefined, undefined, actContext);
		expect(result.details.error).toBe("invalid request");
		expect(fixture.log).toEqual([]);
	});

	test("refuses malformed, tab-changing, script-running, and oversized plans", async () => {
		const fixture = await planFixture();
		const plan = register().get("headed_plan")!;
		const refused = [
			[{ kind: "nav", op: "goto", url: "https://example.com", waitFor: "load" }],
			[{ kind: "nav", op: "selectTab", tabId: "tab-other" }],
			[{ kind: "read", op: "evaluate", expression: "1 + 1" }],
			[{ kind: "read", op: "teleport" }],
			Array.from({ length: PLAN_STEP_LIMIT + 1 }, () => ({ kind: "read", op: "network" })),
		];
		for (const steps of refused) {
			const result = await plan.execute("id", { sessionId: fixture.session.id, steps }, undefined, undefined, actContext);
			expect(result.details.error).toBe("invalid request");
		}
		expect(fixture.log).toEqual([]);
		const atLimit = await plan.execute("id", {
			sessionId: fixture.session.id,
			steps: Array.from({ length: PLAN_STEP_LIMIT }, () => ({ kind: "read", op: "network" })),
		}, undefined, undefined, actContext);
		expect(atLimit.details.error).toBeUndefined();
		expect(planOutcome(atLimit).executed).toBe(PLAN_STEP_LIMIT);
	});

	test("runs mixed steps in order and returns one compact result per step", async () => {
		const fixture = await planFixture();
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "nav", op: "wait", selector: "#ready" },
				{ kind: "read", op: "html" },
				{ kind: "act", op: "click", selector: "#save" },
			],
		}, undefined, undefined, actContext);
		expect(result.details.error).toBeUndefined();
		expect(fixture.log).toEqual(["goto", "wait", "html", "click"]);
		const outcome = planOutcome(result);
		expect(outcome.steps.map((step) => [step.index, step.kind, step.op, step.ok])).toEqual([
			[0, "nav", "goto", true],
			[1, "nav", "wait", true],
			[2, "read", "html", true],
			[3, "act", "click", true],
		]);
		expect(outcome.executed).toBe(4);
		expect(outcome.tabId).toBe(fixture.session.selectedTabId);
		expect(outcome.steps[2]?.result).toBe("<main>ready</main>");
		// Only reads carry a payload; a navigation or an action reports its outcome alone.
		expect(outcome.steps.filter((step) => step.kind !== "read").every((step) => step.result === undefined)).toBe(true);
	});

	test("invalidates pre-navigation refs before a later action step", async () => {
		const fixture = await planFixture();
		fixture.session.refs.get(fixture.session.selectedTabId)?.set("e1", "#old-target");
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "act", op: "click", ref: "e1" },
			],
		}, undefined, undefined, actContext);
		expect(result.details.error).toBe("invalid request");
		expect(result.details.failedIndex).toBe(1);
		expect(fixture.log).toEqual(["goto"]);
		expect(fixture.session.refs.get(fixture.session.selectedTabId)?.has("e1")).toBe(false);
	});

	test("truncates a read payload that exceeds the step allowance", async () => {
		const fixture = await planFixture({ html: "x".repeat(PLAN_STEP_OUTPUT_LIMIT * 3) });
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "read", op: "html" }],
		}, undefined, undefined, actContext);
		const step = planOutcome(result).steps[0];
		const payload = step?.result;
		expect(step?.truncated).toBe(true);
		expect(typeof payload).toBe("string");
		if (typeof payload !== "string") throw new Error("expected truncated string payload");
		expect(payload.length).toBe(PLAN_STEP_OUTPUT_LIMIT);
	});

	test("stops at the first failing step and reports its index and category", async () => {
		const fixture = await planFixture({ failGoto: true });
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "read", op: "network" },
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "nav", op: "wait", selector: "#ready" },
				{ kind: "act", op: "click", selector: "#save" },
			],
		}, undefined, undefined, actContext);
		expect(result.details.error).toBe("operation failed");
		expect(result.details.failedIndex).toBe(1);
		expect(fixture.log).toEqual(["goto"]);
		const outcome = planOutcome(result);
		expect(outcome.executed).toBe(1);
		expect(outcome.steps).toHaveLength(2);
		expect(outcome.steps[1]?.message).toContain("refused the navigation");
	});

	test("stops as soon as the host cancels and runs no later step", async () => {
		const signal = { aborted: false };
		const fixture = await planFixture({ onGoto: () => { signal.aborted = true; } });
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "nav", op: "wait", selector: "#ready" },
				{ kind: "act", op: "click", selector: "#save" },
			],
		}, signal, undefined, actContext);
		expect(result.details.error).toBe("cancelled");
		expect(result.details.failedIndex).toBe(1);
		expect(fixture.log).toEqual(["goto"]);
		expect(planOutcome(result).executed).toBe(1);
	});

	test("never overlaps a standalone action with a plan step on the same tab", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const plan = register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "nav", op: "wait", selector: "#ready" },
			],
		}, undefined, undefined, actContext);
		// The plan reached the gated navigation, so it holds the tab while the click is queued.
		await fixture.gotoStarted;
		const act = register().get("headed_act")!.execute("id", { op: "click", sessionId: fixture.session.id, selector: "#save" }, undefined, undefined, actContext);
		fixture.releaseGoto();
		const [planResult, actResult] = await Promise.all([plan, act]);
		expect(planResult.details.error).toBeUndefined();
		expect(actResult.details.error).toBeUndefined();
		// A `-during-goto` entry would mean the lock let two mutations share the tab. FIFO
		// order also holds: the click waited for the gated step, the plan's next step for the click.
		expect(fixture.log).toEqual(["goto", "click", "wait"]);
	});


	test("cancels an action after it acquires a previously occupied tab lock", async () => {
		const fixture = await planFixture({ gateGoto: true });
		let abortChecks = 0;
		const signal = {
			get aborted(): boolean {
				abortChecks += 1;
				// The plan's pre-step check releases the in-flight navigation. Its action
				// then queues behind that lock owner and observes cancellation only after
				// acquiring the lock. The exact read count proves this is the post-lock check.
				if (abortChecks === 1) fixture.releaseGoto();
				return abortChecks > 1;
			},
		};
		const navigation = register().get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com",
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const plan = register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "act", op: "click", selector: "#save" }],
		}, signal, undefined, actContext);
		const [navigationResult, planResult] = await Promise.all([navigation, plan]);
		expect(navigationResult.details.error).toBeUndefined();
		expect(planResult.details.error).toBe("cancelled");
		expect(abortChecks).toBe(2);
		expect(fixture.log).toEqual(["goto"]);
		expect(fixture.commands).toEqual([]);
	});

	test("cancels after cursor visualization without dispatching the action", async () => {
		const signal = { aborted: false };
		const fixture = await planFixture({
			onCursorCommand: (command) => { if (command.kind === "pulse") signal.aborted = true; },
		});
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "act", op: "click", selector: "#save" }],
		}, signal, undefined, actContext);
		expect(result.details.error).toBe("cancelled");
		expect(fixture.log).toEqual([]);
		expect(fixture.commands.map((command) => command.kind)).toEqual(["move", "pulse", "hide"]);
		expect(fixture.counts.disposals).toBe(fixture.counts.handles);
	});

	test("invalidates refs when an action causes top-level navigation", async () => {
		const fixture = await planFixture({ navigateOnClick: true });
		fixture.session.refs.get(fixture.session.selectedTabId)?.set("e1", "#old-target");
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "act", op: "click", ref: "e1" },
				{ kind: "act", op: "click", ref: "e1" },
			],
		}, undefined, undefined, actContext);
		expect(result.details.error).toBe("invalid request");
		expect(result.details.failedIndex).toBe(1);
		expect(fixture.log).toEqual(["click"]);
		expect(fixture.session.refs.get(fixture.session.selectedTabId)?.has("e1")).toBe(false);
	});
	test("points the cursor at an acting step exactly as the standalone action does", async () => {
		const fixture = await planFixture();
		const planned = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "act", op: "click", selector: "#save" }],
		}, undefined, undefined, actContext);
		expect(planned.details.error).toBeUndefined();
		expect(fixture.log).toEqual(["click"]);
		expect(fixture.commands.map((entry) => entry.kind)).toEqual(["move", "pulse", "hide"]);
		expect(fixture.commands[0]?.target).toEqual({ x: 10, y: 10 });
		expect(fixture.counts.disposals).toBe(fixture.counts.handles);
		const standalone = await actFixture({ boxes: [{ x: 0, y: 0, width: 20, height: 20 }] });
		await register().get("headed_act")!.execute("id", { op: "click", sessionId: standalone.session.id, selector: "#save" }, undefined, undefined, actContext);
		expect(fixture.commands.map((entry) => entry.kind)).toEqual(standalone.commands.map((entry) => entry.kind));
	});

	test("records a bounded plan audit trail that repeats no page payload", async () => {
		const fixture = await planFixture();
		await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "read", op: "html" },
			],
		}, undefined, undefined, actContext);
		const [name] = await readdir(fixture.auditDir);
		const records = (await readFile(join(fixture.auditDir, name!), "utf8")).trim().split("\n")
			.map((line) => JSON.parse(line) as { op: string; reason?: string });
		expect(records.filter((record) => record.op === "plan").map((record) => record.reason)).toEqual(["2 steps", "2/2 steps"]);
		expect(records.some((record) => (record.reason ?? "").includes("ready"))).toBe(false);
	});
});
