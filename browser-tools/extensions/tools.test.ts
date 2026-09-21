import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Browser, Page } from "puppeteer-core";
import headedBrowserTools from "./headed-browser-tools.ts";
import { resolveConfig } from "./lib/config.ts";
import type { CursorVisualCommand } from "./lib/cursor.ts";
import { createCursorRuntime } from "./lib/cursor.ts";
import { withTabHold } from "./lib/operations.ts";
import type { PlanOutcome } from "./lib/plan.ts";
import { PLAN_MESSAGE_LIMIT, PLAN_OUTPUT_LIMIT, PLAN_STEP_LIMIT, PLAN_STEP_OUTPUT_LIMIT } from "./lib/plan.ts";
import type { HeadedSession, SessionClosure } from "./lib/session.ts";
import { closeCapturedSession, installIdleSweep, registerPage, sessions } from "./lib/session.ts";

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
			selectedTabId: "tab-initial", refs: new Map(), network: [], lifecycle: "open", activeTabHolds: 0,
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
async function actFixture(options: {
	boxes: Array<{ x: number; y: number; width: number; height: number } | null>;
	renderFails?: boolean;
	onCursorCommand?: (command: CursorVisualCommand) => void;
	onBoundingBox?: () => void;
	disposeStalls?: boolean;
	onDispose?: () => void;
}): Promise<ActFixture> {
	const commands: CursorVisualCommand[] = [];
	const counts = { clicks: 0, reads: 0, handles: 0, disposals: 0 };
	// A fresh handle per resolution, so a leaked one is an observable imbalance.
	const resolveElement = () => {
		counts.handles += 1;
		return {
			scrollIntoView: async () => undefined,
			boundingBox: async () => {
				options.onBoundingBox?.();
				const box = options.boxes[Math.min(counts.reads, options.boxes.length - 1)] ?? null;
				counts.reads += 1;
				return box;
			},
			click: async () => { counts.clicks += 1; },
			dispose: async () => {
				counts.disposals += 1;
				options.onDispose?.();
				if (options.disposeStalls === true) await new Promise<never>(() => undefined);
			},
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
			options.onCursorCommand?.(command);
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
		pages: new Map(), pageIds: new WeakMap(), selectedTabId: "", refs: new Map(), network: [], lifecycle: "open", activeTabHolds: 0,
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

	test("does not spend the action timeout on cursor visualization", async () => {
		let armedTimeout: (() => void) | undefined;
		const fixture = await actFixture({
			boxes: [{ x: 10, y: 20, width: 40, height: 20 }],
			onCursorCommand: (command) => {
				if (command.kind === "move") armedTimeout?.();
			},
		});
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				armedTimeout = callback;
				return callback;
			},
			clearTimer: (timer: unknown) => {
				if (armedTimeout === timer) armedTimeout = undefined;
			},
		};
		const result = await register().get("headed_act")!.execute(
			"id",
			{ op: "click", sessionId: fixture.session.id, selector: "#save", timeoutMs: 500 },
			undefined,
			undefined,
			timeoutContext,
		);
		expect(result.details.error).toBeUndefined();
		expect(fixture.counts.clicks).toBe(1);
		expect(fixture.session.lifecycle).toBe("open");
	});

	test("contains a cursor geometry call that exceeds the action timeout", async () => {
		let armedTimeout: (() => void) | undefined;
		const fixture = await actFixture({
			boxes: [{ x: 10, y: 20, width: 40, height: 20 }],
			onBoundingBox: () => armedTimeout?.(),
		});
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				armedTimeout = callback;
				return callback;
			},
			clearTimer: (timer: unknown) => {
				if (armedTimeout === timer) armedTimeout = undefined;
			},
		};
		const result = await register().get("headed_act")!.execute(
			"id",
			{ op: "click", sessionId: fixture.session.id, selector: "#save", timeoutMs: 500 },
			undefined,
			undefined,
			timeoutContext,
		);
		expect(result.details.error).toBe("session timeout");
		expect(fixture.counts.clicks).toBe(0);
		expect(sessions.has(fixture.session.id)).toBe(false);
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

	test("bounds final handle disposal before releasing the tab", async () => {
		let armedTimeout: (() => void) | undefined;
		const fixture = await actFixture({
			boxes: [{ x: 0, y: 0, width: 20, height: 20 }],
			disposeStalls: true,
			onDispose: () => armedTimeout?.(),
		});
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				armedTimeout = callback;
				return callback;
			},
			clearTimer: (timer: unknown) => {
				if (armedTimeout === timer) armedTimeout = undefined;
			},
		};
		const result = await register().get("headed_act")!.execute("id", {
			op: "click", sessionId: fixture.session.id, selector: "#save", timeoutMs: 500,
		}, undefined, undefined, timeoutContext);
		expect(result.details.error).toBe("session timeout");
		expect(fixture.counts.clicks).toBe(1);
		expect(fixture.counts.disposals).toBe(1);
		expect(sessions.has(fixture.session.id)).toBe(false);
	});
});


interface PlanFixture {
	session: HeadedSession;
	/** Every operation the selected tab performed, in the order it performed them. */
	log: string[];
	commands: CursorVisualCommand[];
	/** `browserCloses` proves a teardown that two callers asked for still happened once. */
	counts: { handles: number; disposals: number; browserCloses: number };
	auditDir: string;
	/** Resolves once the gated navigation is in flight, so a test needs no timed wait. */
	gotoStarted: Promise<void>;
	releaseGoto: () => void;
}

/** A session whose selected tab records navigation, reads, and actions in order. */
async function planFixture(options: {
	gateGoto?: boolean;
	failGoto?: boolean;
	gotoError?: string;
	html?: string;
	consolePayload?: unknown;
	redactSecrets?: boolean;
	onGoto?: () => void;
	onViewport?: () => void;
	onCursorCommand?: (command: CursorVisualCommand) => void;
	navigateOnClick?: boolean;
} = {}): Promise<PlanFixture> {
	const log: string[] = [];
	const commands: CursorVisualCommand[] = [];
	const counts = { handles: 0, disposals: 0, browserCloses: 0 };
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
			if (typeof target === "string") return undefined;
			if (command === undefined) return options.consolePayload;
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
			if (options.failGoto === true || options.gotoError !== undefined) {
				throw new Error(options.gotoError ?? "headed-browser: the server refused the navigation");
			}
			for (const listener of listeners.get("framenavigated") ?? []) listener(mainFrame);
			return null;
		},
		setViewport: async () => {
			log.push("viewport");
			options.onViewport?.();
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
	const browserState = {
		pages: async () => [page],
		close: async () => { counts.browserCloses += 1; },
		disconnect: async () => undefined,
		process: () => undefined,
	};
	const auditDir = await mkdtemp(join(tmpdir(), "headed-plan-audit-"));
	temps.push(auditDir);
	const config = await resolveConfig(process.cwd(), { cursorMode: "instant", auditDir, redactSecrets: options.redactSecrets }, async () => ({ values: {}, source: "test", warnings: [] }));
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
		pages: new Map(), pageIds: new WeakMap(), selectedTabId: "", refs: new Map(), network: [], lifecycle: "open", activeTabHolds: 0,
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
		expect(JSON.stringify(payload).length).toBe(PLAN_STEP_OUTPUT_LIMIT);
	});

	test("redacts a secret before truncation can split its token shape", async () => {
		const tokenHead = "eyABCDEFGHIJK.abcdefghijklmnop.";
		const visibleTail = "qrstu";
		const secret = `${tokenHead}qrstuvwxyzABCDE`;
		const padding = "x".repeat(PLAN_STEP_OUTPUT_LIMIT - 2 - tokenHead.length - visibleTail.length);
		const fixture = await planFixture({ html: `${padding} ${secret} ${"x".repeat(200)}` });
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "read", op: "html" }],
		}, undefined, undefined, actContext);
		expect(planOutcome(result).steps[0]?.truncated).toBe(true);
		expect(result.content[0]?.text).not.toContain(`${tokenHead}${visibleTail}`);
	});

	test("preserves sensitive-key values when plan redaction is disabled", async () => {
		const secret = "eyABCDEFGHIJK.abcdefghijklmnop.qrstuvwxyzABCDE";
		const fixture = await planFixture({
			consolePayload: [{ Authorization: secret }],
			redactSecrets: false,
		});
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "read", op: "console" }],
		}, undefined, undefined, actContext);
		expect(result.details.error).toBeUndefined();
		expect(result.content[0]?.text).toContain(secret);
	});

	test("applies plan limits to the escaped representation it emits", async () => {
		const fixture = await planFixture({ html: "\\\"".repeat(5_000) });
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: Array.from({ length: 8 }, () => ({ kind: "read", op: "html" })),
		}, undefined, undefined, actContext);
		const outcome = planOutcome(result);
		const emittedPayloadLength = outcome.steps.reduce((total, step) =>
			total + (step.result === undefined ? 0 : JSON.stringify(step.result).length), 0);
		expect(emittedPayloadLength).toBeLessThanOrEqual(PLAN_OUTPUT_LIMIT);
		expect(outcome.steps.every((step) => JSON.stringify(step.result).length <= PLAN_STEP_OUTPUT_LIMIT)).toBe(true);
		expect(result.content[0]?.text.length).toBeLessThan(PLAN_OUTPUT_LIMIT + 4_096);
	});

	test("does not pretty-print structured payloads beyond plan limits", async () => {
		const fixture = await planFixture();
		fixture.session.network = Array.from({ length: 100 }, (_, index) => ({
			ts: index,
			method: "GET",
			url: `https://example.com/${"x".repeat(20)}`,
		}));
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: Array.from({ length: 8 }, () => ({ kind: "read", op: "network" })),
		}, undefined, undefined, actContext);
		const outcome = planOutcome(result);
		expect(outcome.steps.every((step) => step.truncated === undefined)).toBe(true);
		expect(result.content[0]?.text).not.toContain("\n");
		expect(result.content[0]?.text.length).toBeLessThan(PLAN_OUTPUT_LIMIT + 4_096);
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

	test("redacts a failure secret before truncating its token shape", async () => {
		const tokenHead = "eyABCDEFGHIJK.abcdefghijklmnop.";
		const visibleTail = "qrstu";
		const secret = `${tokenHead}qrstuvwxyzABCDE`;
		const padding = "x".repeat(PLAN_MESSAGE_LIMIT - 1 - tokenHead.length - visibleTail.length);
		const fixture = await planFixture({ gotoError: `${padding} ${secret} ${"x".repeat(100)}` });
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "nav", op: "goto", url: "https://example.com" }],
		}, undefined, undefined, actContext);
		expect(result.details.error).toBe("operation failed");
		expect(result.content[0]?.text).not.toContain(`${tokenHead}${visibleTail}`);
	});

	test("redacts earlier plan output when a later timeout closes the session", async () => {
		const secret = "eyABCDEFGHIJK.abcdefghijklmnop.qrstuvwxyzABCDE";
		let armedTimeout: (() => void) | undefined;
		const fixture = await planFixture({
			html: `<main>${secret}</main>`,
			gateGoto: true,
			onGoto: () => armedTimeout?.(),
		});
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				armedTimeout = callback;
				return callback;
			},
			clearTimer: (timer: unknown) => {
				if (armedTimeout === timer) armedTimeout = undefined;
			},
		};
		const result = await register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "read", op: "html" },
				{ kind: "nav", op: "goto", url: "https://example.com", timeoutMs: 5 },
			],
		}, undefined, undefined, timeoutContext);
		fixture.releaseGoto();
		expect(result.details.error).toBe("session timeout");
		expect(result.content[0]?.text).not.toContain(secret);
		expect(result.content[0]?.text).toContain("<REDACTED>");
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

	test("runs a standalone action only after the plan's last step on the same tab", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const plan = register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "nav", op: "wait", selector: "#ready" },
			],
		}, undefined, undefined, actContext);
		// The plan reached the gated navigation, so it holds the tab while the click queues.
		await fixture.gotoStarted;
		// `headed_act` reaches the tab lock synchronously — the session lookup and the input
		// validation ahead of it are both synchronous — so the click is a queued waiter from
		// here on, behind the hold the plan took for its whole sequence.
		const act = register().get("headed_act")!.execute("id", { op: "click", sessionId: fixture.session.id, selector: "#save" }, undefined, undefined, actContext);
		expect(fixture.log).toEqual(["goto"]);
		fixture.releaseGoto();
		const [planResult, actResult] = await Promise.all([plan, act]);
		expect(planResult.details.error).toBeUndefined();
		expect(actResult.details.error).toBeUndefined();
		// The plan holds the tab across its own steps, so the click that queued during step 0
		// runs after the last step instead of between the two. A `-during-goto` entry would
		// mean two callers shared the tab.
		expect(fixture.log).toEqual(["goto", "wait", "click"]);
	});

	test("cancels a plan while it waits for a previously occupied tab", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const controller = new AbortController();
		const tools = register();
		const navigation = tools.get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com",
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const plan = tools.get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "act", op: "click", selector: "#save" }],
		}, controller.signal, undefined, actContext);
		await drained();
		controller.abort();
		const state = await Promise.race([plan.then(() => "settled" as const), drained().then(() => "parked" as const)]);
		expect(state).toBe("settled");
		const planResult = await plan;
		expect(planResult.details.error).toBe("cancelled");
		expect(fixture.log).toEqual(["goto"]);
		expect(fixture.commands).toEqual([]);
		fixture.releaseGoto();
		expect((await navigation).details.error).toBeUndefined();
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

interface TabLockFixture {
	session: HeadedSession;
	/** Every page operation, named by the tab it happened on, in the order it happened. */
	log: string[];
	/** A registered tab that is not the selected one: the tab a `closeTab({ tabId })` names. */
	idleTabId: string;
	/** Resolves once the created tab's first navigation is in flight. */
	navigationStarted: Promise<void>;
	releaseNavigation: () => void;
}

/**
 * A session with a selected tab, a second registered tab, and a browser that opens a third
 * whose first navigation is gated, so an operation that lands on the wrong tab at the wrong
 * time is a wrong log order rather than a timing guess.
 */
async function tabLockFixture(options: {
	createdRegistrationStalls?: boolean;
	onCreatedRegistration?: () => void;
	createdPolicyStalls?: boolean;
	onCreatedPolicy?: () => void;
} = {}): Promise<TabLockFixture> {
	const log: string[] = [];
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const closed = new Set<string>();
	const tabPage = (name: string, gated: boolean) => ({
		on: () => undefined,
		url: () => "about:blank",
		mainFrame: () => ({}),
		evaluateOnNewDocument: async () => {
			if (name === "created") options.onCreatedRegistration?.();
			if (name === "created" && options.createdRegistrationStalls === true) await new Promise<never>(() => undefined);
			return { identifier: `${name}-registration` };
		},
		evaluate: async () => undefined,
		setRequestInterception: async () => {
			if (name === "created") options.onCreatedPolicy?.();
			if (name === "created" && options.createdPolicyStalls === true) await new Promise<never>(() => undefined);
		},
		goto: async () => {
			log.push(`${name}:goto`);
			if (gated) {
				started.resolve();
				await gate.promise;
			}
			log.push(`${name}:goto-done`);
			return null;
		},
		content: async () => {
			log.push(`${name}:html`);
			return `<main>${name}</main>`;
		},
		close: async () => {
			log.push(`${name}:close`);
			closed.add(name);
		},
	});
	// Puppeteer Page is represented by the contract a navigation, a read, and a tab op use.
	const selected = tabPage("selected", false) as unknown as Page;
	const idle = tabPage("idle", false) as unknown as Page;
	const created = tabPage("created", true) as unknown as Page;
	const opened: Array<{ name: string; page: Page }> = [{ name: "selected", page: selected }, { name: "idle", page: idle }];
	const browserState = {
		pages: async () => opened.filter(({ name }) => !closed.has(name)).map(({ page }) => page),
		newPage: async () => {
			log.push("browser:newPage");
			opened.push({ name: "created", page: created });
			return created;
		},
		close: async () => undefined,
		disconnect: async () => undefined,
		process: () => undefined,
	};
	const auditDir = await mkdtemp(join(tmpdir(), "headed-tab-lock-audit-"));
	temps.push(auditDir);
	const config = await resolveConfig(process.cwd(), { cursorMode: "instant", auditDir }, async () => ({ values: {}, source: "test", warnings: [] }));
	const warnings: string[] = [];
	const session: HeadedSession = {
		id: "hb-tab-lock", browser: browserState as unknown as Browser,
		resolvedBrowser: { engine: "firefox", channel: "firefox", path: "/browser", probedPaths: [] },
		profileMode: "clean",
		profile: {
			sessionDir: "/tmp/hb-tab-lock", profileDir: "/tmp/hb-tab-lock/profile", downloadsDir: "/tmp/hb-tab-lock/downloads",
			artifactsDir: "/tmp/hb-tab-lock/artifacts", cookieDomains: [], containerCookiesSkipped: 0, warnings: [],
			persistentProfile: false, copyStrategy: "node",
		},
		config, createdAt: Date.now(), lastActivityAt: Date.now(),
		pages: new Map(), pageIds: new WeakMap(), selectedTabId: "", refs: new Map(), network: [], lifecycle: "open", activeTabHolds: 0,
		cursor: createCursorRuntime({ mode: config.cursorMode, headless: config.headless, warnings }),
		warnings,
	};
	session.selectedTabId = await registerPage(session, selected);
	const idleTabId = await registerPage(session, idle);
	sessions.set(session.id, session);
	return { session, log, idleTabId, navigationStarted: started.promise, releaseNavigation: gate.resolve };
}

/**
 * One event-loop turn, no duration: the microtask queue is drained to exhaustion before a
 * check-phase callback runs, so a queued call that can progress on its own already has.
 */
function drained(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

describe("headed browser tab lock lifecycle", () => {
	test("keeps a newly created tab to itself until its first navigation finishes", async () => {
		const fixture = await tabLockFixture();
		const tools = register();
		const navigation = tools.get("headed_nav")!.execute("id", {
			op: "newTab", sessionId: fixture.session.id, url: "https://example.com", timeoutMs: 500,
		}, undefined, undefined, actContext);
		await fixture.navigationStarted;
		// The created tab is the session's selected tab from here, so this read resolves to it.
		const read = tools.get("headed_read")!.execute("id", { op: "html", sessionId: fixture.session.id }, undefined, undefined, actContext);
		await drained();
		fixture.releaseNavigation();
		const [navigated, html] = await Promise.all([navigation, read]);
		expect(navigated.details.error).toBeUndefined();
		expect(html.details.error).toBeUndefined();
		expect(fixture.log).toEqual(["browser:newPage", "created:goto", "created:goto-done", "created:html"]);
	});

	test("bounds new-tab registration while holding the selected tab", async () => {
		let armedTimeout: (() => void) | undefined;
		const fixture = await tabLockFixture({
			createdRegistrationStalls: true,
			onCreatedRegistration: () => armedTimeout?.(),
		});
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				armedTimeout = callback;
				return callback;
			},
			clearTimer: (timer: unknown) => {
				if (armedTimeout === timer) armedTimeout = undefined;
			},
		};
		const result = await register().get("headed_nav")!.execute("id", {
			op: "newTab", sessionId: fixture.session.id, timeoutMs: 500,
		}, undefined, undefined, timeoutContext);
		expect(result.details.error).toBe("session timeout");
		expect(sessions.has(fixture.session.id)).toBe(false);
		expect(fixture.log).toEqual(["browser:newPage"]);
	});

	test("bounds new-tab policy installation while holding both tabs", async () => {
		let armedTimeout: (() => void) | undefined;
		const fixture = await tabLockFixture({
			createdPolicyStalls: true,
			onCreatedPolicy: () => armedTimeout?.(),
		});
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				armedTimeout = callback;
				return callback;
			},
			clearTimer: (timer: unknown) => {
				if (armedTimeout === timer) armedTimeout = undefined;
			},
		};
		const result = await register().get("headed_nav")!.execute("id", {
			op: "newTab", sessionId: fixture.session.id, timeoutMs: 500,
		}, undefined, undefined, timeoutContext);
		expect(result.details.error).toBe("session timeout");
		expect(sessions.has(fixture.session.id)).toBe(false);
		expect(fixture.log).toEqual(["browser:newPage"]);
	});

	test("bounds a stalled viewport change and releases its tab hold", async () => {
		let armedTimeout: (() => void) | undefined;
		const fixture = await planFixture({ onViewport: () => armedTimeout?.() });
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				armedTimeout = callback;
				return callback;
			},
			clearTimer: (_timer: unknown) => undefined,
		};
		const result = await register().get("headed_nav")!.execute("id", {
			op: "viewport", sessionId: fixture.session.id, width: 1280, height: 720, timeoutMs: 500,
		}, undefined, undefined, timeoutContext);
		expect(result.details.error).toBe("session timeout");
		expect(sessions.has(fixture.session.id)).toBe(false);
		expect(fixture.counts.browserCloses).toBe(1);
		expect(fixture.log).toEqual(["viewport"]);
	});

	test("keeps cookie grants out of a plan's tab hold", async () => {
		const fixture = await planFixture({ gateGoto: true });
		fixture.session.sourceProfile = fixture.auditDir;
		const tools = register();
		const plan = tools.get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "nav", op: "goto", url: "https://example.com" }],
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const grant = tools.get("headed_session")!.execute("id", {
			op: "grantCookies", sessionId: fixture.session.id, domains: "example.com",
		}, undefined, undefined, actContext);
		const state = await Promise.race([grant.then(() => "settled" as const), drained().then(() => "parked" as const)]);
		expect(state).toBe("parked");
		fixture.releaseGoto();
		const [planResult, grantResult] = await Promise.all([plan, grant]);
		expect(planResult.details.error).toBeUndefined();
		expect(grantResult.details.error).toBeUndefined();
		expect(fixture.log).toEqual(["goto"]);
	});

	test("bounds cookie extraction and injection while holding the selected tab", async () => {
		const fixture = await planFixture();
		fixture.session.sourceProfile = fixture.auditDir;
		const timeoutContext = {
			...actContext,
			setTimeout: (callback: () => void, _ms: number) => {
				callback();
				return 1;
			},
			clearTimer: (_timer: unknown) => undefined,
		};
		const result = await register().get("headed_session")!.execute("id", {
			op: "grantCookies", sessionId: fixture.session.id, domains: "example.com", timeoutMs: 500,
		}, undefined, undefined, timeoutContext);
		expect(result.details.error).toBe("session timeout");
		expect(sessions.has(fixture.session.id)).toBe(false);
		expect(fixture.counts.browserCloses).toBe(1);
	});

	test("rejects a cookie grant when selection changes while it waits", async () => {
		const fixture = await planFixture();
		fixture.session.sourceProfile = fixture.auditDir;
		const tabId = fixture.session.selectedTabId;
		const { promise: work, resolve: finishWork } = Promise.withResolvers<void>();
		const holder = withTabHold(fixture.session, actContext as unknown as ExtensionContext, tabId, () => work);
		await drained();
		const grant = register().get("headed_session")!.execute("id", {
			op: "grantCookies", sessionId: fixture.session.id, domains: "example.com",
		}, undefined, undefined, actContext);
		await drained();
		fixture.session.selectedTabId = "replacement-tab";
		finishWork();
		await holder;
		const result = await grant;
		fixture.session.selectedTabId = tabId;
		expect(result.details.error).toBe("stale tab");
		expect(fixture.session.profile.cookieDomains).toEqual([]);
	});

	test("closes a named tab only after the call holding that tab finishes", async () => {
		const fixture = await tabLockFixture();
		const { promise: work, resolve: finishWork } = Promise.withResolvers<void>();
		const holder = withTabHold(fixture.session, actContext as unknown as ExtensionContext, fixture.idleTabId, async () => {
			await work;
			fixture.log.push("idle:holder-done");
		});
		await drained();
		const close = register().get("headed_nav")!.execute("id", {
			op: "closeTab", sessionId: fixture.session.id, tabId: fixture.idleTabId, timeoutMs: 500,
		}, undefined, undefined, actContext);
		await drained();
		finishWork();
		await holder;
		const result = await close;
		expect(result.details.error).toBeUndefined();
		expect(fixture.log).toEqual(["idle:holder-done", "idle:close"]);
		expect(fixture.session.pages.has(fixture.idleTabId)).toBe(false);
	});

	test("leaves a session with a held tab out of the idle close", async () => {
		const fixture = await planFixture();
		let sweep: (() => Promise<void>) | undefined;
		const sweepContext = {
			...actContext,
			setInterval: (callback: () => Promise<void>, _ms: number) => { sweep = callback; return 1; },
		} as unknown as ExtensionContext;
		installIdleSweep(sweepContext);
		const { promise: work, resolve: finishWork } = Promise.withResolvers<void>();
		const holder = withTabHold(fixture.session, sweepContext, fixture.session.selectedTabId, () => work);
		await drained();
		// An operation allowed to wait longer than the idle threshold makes no lock transition
		// while it waits, so its session looks idle to the sweep.
		const idleMs = fixture.session.config.idleCloseSec * 1000;
		fixture.session.lastActivityAt = Date.now() - idleMs - 1_000;
		await sweep!();
		expect(sessions.has(fixture.session.id)).toBe(true);
		finishWork();
		await holder;
		// Releasing stamps activity, so the released session gets a fresh idle window.
		await sweep!();
		expect(sessions.has(fixture.session.id)).toBe(true);
		fixture.session.lastActivityAt = Date.now() - idleMs - 1_000;
		await sweep!();
		expect(sessions.has(fixture.session.id)).toBe(false);
	});

	test("fails a call queued before a close instead of waking it in a dead session", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const tools = register();
		const plan = tools.get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [{ kind: "nav", op: "goto", url: "https://example.com" }],
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const queued = tools.get("headed_read")!.execute("id", { op: "html", sessionId: fixture.session.id }, undefined, undefined, actContext);
		await drained();
		await closeCapturedSession(fixture.session, "test-close");
		// A lock that ignores the close leaves this waiter parked on a holder it cannot outlive.
		// The close already settled it here, so the failure wins the race against the next turn.
		const settled = await Promise.race([queued.then(() => "failed" as const), drained().then(() => "parked" as const)]);
		expect(settled).toBe("failed");
		expect((await queued).details.error).toBe("unknown session");
		expect(fixture.log).toEqual(["goto"]);
		fixture.releaseGoto();
		await plan;
		// The queued read never reached the page, before or after the holder released.
		expect(fixture.log).toEqual(["goto"]);
	});

	test("ends a running plan at its next step when the session closes mid-step", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const plan = register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "nav", op: "wait", selector: "#ready" },
			],
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		await closeCapturedSession(fixture.session, "test-close");
		fixture.releaseGoto();
		const result = await plan;
		const outcome = planOutcome(result);
		expect(outcome.executed).toBe(1);
		expect(outcome.failedIndex).toBe(1);
		expect(outcome.error).toBe("unknown session");
		// The plan held the tab across the close, so only its in-flight step touched the page.
		expect(fixture.log).toEqual(["goto"]);
	});

	test("cancels a standalone navigation while it waits for the tab", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const signal = { aborted: false };
		const tools = register();
		const active = tools.get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com/active",
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const queued = tools.get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com/queued",
		}, signal, undefined, actContext);
		await drained();
		signal.aborted = true;
		fixture.releaseGoto();
		const [activeResult, queuedResult] = await Promise.all([active, queued]);
		expect(activeResult.details.error).toBeUndefined();
		expect(queuedResult.details.error).toBe("cancelled");
		expect(fixture.log).toEqual(["goto"]);
	});

	test("cancels a standalone read while it waits for the tab", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const signal = { aborted: false };
		const tools = register();
		const active = tools.get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com/active",
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const queued = tools.get("headed_read")!.execute("id", {
			op: "html", sessionId: fixture.session.id,
		}, signal, undefined, actContext);
		await drained();
		signal.aborted = true;
		fixture.releaseGoto();
		const [activeResult, queuedResult] = await Promise.all([active, queued]);
		expect(activeResult.details.error).toBeUndefined();
		expect(queuedResult.details.error).toBe("cancelled");
		expect(fixture.log).toEqual(["goto"]);
	});

	test("settles a cancelled waiter promptly and preserves FIFO for its follower", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const tools = register();
		const active = tools.get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com/active",
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const controller = new AbortController();
		const queued = tools.get("headed_read")!.execute("id", {
			op: "html", sessionId: fixture.session.id,
		}, controller.signal, undefined, actContext);
		await drained();
		const follower = tools.get("headed_read")!.execute("id", {
			op: "html", sessionId: fixture.session.id,
		}, undefined, undefined, actContext);
		await drained();
		controller.abort();
		const queuedState = await Promise.race([
			queued.then(() => "settled" as const),
			drained().then(() => "parked" as const),
		]);
		expect(queuedState).toBe("settled");
		expect((await queued).details.error).toBe("cancelled");
		expect(fixture.log).toEqual(["goto"]);
		const followerState = await Promise.race([
			follower.then(() => "settled" as const),
			drained().then(() => "parked" as const),
		]);
		expect(followerState).toBe("parked");
		fixture.releaseGoto();
		const [activeResult, followerResult] = await Promise.all([active, follower]);
		expect(activeResult.details.error).toBeUndefined();
		expect(followerResult.details.error).toBeUndefined();
		expect(fixture.log).toEqual(["goto", "html"]);
	});

	test("writes no plan record and runs no step for a plan cancelled while it queued", async () => {
		const fixture = await planFixture({ gateGoto: true });
		const signal = { aborted: false };
		// A standalone navigation owns the tab, so the plan below is a queued waiter.
		const navigation = register().get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com",
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const plan = register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "wait", selector: "#ready" },
				{ kind: "act", op: "click", selector: "#save" },
			],
		}, signal, undefined, actContext);
		await drained();
		// Cancelled while parked: the plan passed its pre-acquisition check and will acquire
		// the tab, which is the window in which it used to audit an allowed start.
		signal.aborted = true;
		fixture.releaseGoto();
		const [navigated, cancelled] = await Promise.all([navigation, plan]);
		expect(navigated.details.error).toBeUndefined();
		expect(cancelled.details.error).toBe("cancelled");
		const outcome = planOutcome(cancelled);
		expect(outcome.executed).toBe(0);
		expect(outcome.steps).toEqual([]);
		// The navigation's own record stands; the plan contributed none.
		const [name] = await readdir(fixture.auditDir);
		const records = (await readFile(join(fixture.auditDir, name!), "utf8")).trim().split("\n")
			.map((line) => JSON.parse(line) as { op: string; decision: string });
		expect(records.filter((record) => record.op === "plan")).toEqual([]);
		expect(records.map((record) => record.op)).toEqual(["goto"]);
		expect(fixture.log).toEqual(["goto"]);
	});

	test("splices a timed-out waiter out and lets its follower run in order", async () => {
		const fixture = await planFixture();
		// Only the lock's acquisition wait registers a 30 s timer here: each queued read carries
		// its own shorter page timeout, so firing these callbacks drives the lock timeout alone.
		const lockTimeouts: Array<() => void> = [];
		const lockContext = {
			sessionManager: { getSessionId: () => "tool-test" },
			setTimeout: (callback: () => void, ms: number) => {
				if (ms === 30_000) lockTimeouts.push(callback);
				return lockTimeouts.length;
			},
			clearTimer: (_timer: unknown) => undefined,
		} as unknown as ExtensionContext;
		const { promise: work, resolve: finishWork } = Promise.withResolvers<void>();
		const owner = withTabHold(fixture.session, lockContext, fixture.session.selectedTabId, async () => {
			await work;
			fixture.log.push("owner-done");
		});
		await drained();
		const waiter = register().get("headed_read")!.execute("id", { op: "html", sessionId: fixture.session.id, timeoutMs: 500 }, undefined, undefined, lockContext);
		await drained();
		// A read, so the follower's first page touch is its own `content()` call and nothing else
		// stands between waking and that log entry.
		const follower = register().get("headed_read")!.execute("id", { op: "html", sessionId: fixture.session.id, timeoutMs: 500 }, undefined, undefined, lockContext);
		await drained();
		expect(lockTimeouts).toHaveLength(2);
		// Only the first waiter's acquisition expires; the follower keeps waiting.
		lockTimeouts[0]!();
		expect((await waiter).details.error).toBe("tab busy");
		await drained();
		// The follower had a full turn to run and could not: the abandoned slot resolves with the
		// owner's completion, not straight away, so the owner still holds the tab.
		expect(fixture.log).toEqual([]);
		finishWork();
		await owner;
		// The abandoned turn handed its slot the owner's completion, so the follower runs on the
		// owner's release rather than waiting for a turn that never releases.
		expect((await follower).details.error).toBeUndefined();
		expect(fixture.log).toEqual(["owner-done", "html"]);
	});

	test("wakes a follower when a plan step throws inside the hold", async () => {
		const fixture = await planFixture({ gateGoto: true, failGoto: true });
		const plan = register().get("headed_plan")!.execute("id", {
			sessionId: fixture.session.id,
			steps: [
				{ kind: "nav", op: "goto", url: "https://example.com" },
				{ kind: "nav", op: "wait", selector: "#ready" },
			],
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const follower = register().get("headed_act")!.execute("id", { op: "click", sessionId: fixture.session.id, selector: "#save" }, undefined, undefined, actContext);
		await drained();
		fixture.releaseGoto();
		const [failed, clicked] = await Promise.all([plan, follower]);
		const outcome = planOutcome(failed);
		expect(outcome.error).toBe("operation failed");
		expect(outcome.failedIndex).toBe(0);
		expect(clicked.details.error).toBeUndefined();
		// A failed step stops the plan and its hold ends with it, so the follower ran after the
		// plan and not during it: a `click-during-goto` entry would mean two callers shared the tab.
		expect(fixture.log).toEqual(["goto", "click"]);
	});

	test("releases the hold when an operation throws out of it, waking its follower", async () => {
		const fixture = await planFixture({ gateGoto: true, failGoto: true });
		// A standalone navigation throws out of the hold instead of recording a failed step, so
		// only the `finally` in the hold can hand the tab to the waiter behind it.
		const navigation = register().get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com",
		}, undefined, undefined, actContext);
		await fixture.gotoStarted;
		const follower = register().get("headed_act")!.execute("id", { op: "click", sessionId: fixture.session.id, selector: "#save" }, undefined, undefined, actContext);
		await drained();
		expect(fixture.log).toEqual(["goto"]);
		fixture.releaseGoto();
		const [threw, clicked] = await Promise.all([navigation, follower]);
		expect(threw.details.error).toBe("operation failed");
		expect(clicked.details.error).toBeUndefined();
		expect(fixture.log).toEqual(["goto", "click"]);
	});

	test("refuses a queued caller from the moment the close tool starts, before its record lands", async () => {
		const fixture = await planFixture();
		const { promise: work, resolve: finishWork } = Promise.withResolvers<void>();
		const owner = withTabHold(fixture.session, actContext as unknown as ExtensionContext, fixture.session.selectedTabId, () => work);
		await drained();
		const queued = register().get("headed_read")!.execute("id", { op: "html", sessionId: fixture.session.id }, undefined, undefined, actContext);
		await drained();
		// The registered tool, not `closeCapturedSession`: its audit append is a real file write,
		// so the whole window below sits inside that pending append.
		const closing = register().get("headed_session")!.execute("id", { op: "close", sessionId: fixture.session.id }, undefined, undefined, actContext);
		// Handing the tab over during the append is exactly the window the queued read used to
		// run in: it wakes on microtasks, which all run before the append's completion callback.
		finishWork();
		await owner;
		await drained();
		expect(fixture.log).toEqual([]);
		expect((await queued).details.error).toBe("unknown session");
		const closed = await closing;
		expect(closed.details.error).toBeUndefined();
		expect(sessions.has(fixture.session.id)).toBe(false);
		// The close still recorded its own decision, after the refusal rather than before it.
		const [name] = await readdir(fixture.auditDir);
		const records = (await readFile(join(fixture.auditDir, name!), "utf8")).trim().split("\n")
			.map((line) => JSON.parse(line) as { op: string; decision: string });
		expect(records.map((record) => record.op)).toEqual(["close"]);
		expect(fixture.log).toEqual([]);
	});

	test("gives a close and an overlapping page timeout their own outcomes from one teardown", async () => {
		const fixture = await planFixture({ gateGoto: true });
		let firePageTimeout: () => void = () => undefined;
		const timeoutContext = {
			sessionManager: { getSessionId: () => "tool-test" },
			setTimeout: (callback: () => void, _ms: number) => { firePageTimeout = callback; return 1; },
			clearTimer: (_timer: unknown) => undefined,
		};
		// In flight and holding the tab, with its page timeout under the test's control.
		const navigation = register().get("headed_nav")!.execute("id", {
			op: "goto", sessionId: fixture.session.id, url: "https://example.com",
		}, undefined, undefined, timeoutContext);
		await fixture.gotoStarted;
		// The close marks the session and parks on its audit append.
		const closing = register().get("headed_session")!.execute("id", { op: "close", sessionId: fixture.session.id }, undefined, undefined, actContext);
		// Inside that append the containment path takes the session over: it deletes the id and
		// owns the teardown, which is what used to make the close report its own session unknown.
		firePageTimeout();
		fixture.releaseGoto();
		const [timedOut, closed] = await Promise.all([navigation, closing]);
		expect(timedOut.details.error).toBe("session timeout");
		expect(closed.details.error).toBeUndefined();
		// Both callers end on the one closure, and the reason names whoever started it.
		const closure = JSON.parse(closed.content[0]!.text) as SessionClosure;
		expect(closure).toEqual({ deleted: [fixture.session.profile.sessionDir], reason: "goto-timeout" });
		expect(fixture.counts.browserCloses).toBe(1);
		expect(sessions.has(fixture.session.id)).toBe(false);
		expect(fixture.session.lifecycle).toBe("closed");
	});
});
