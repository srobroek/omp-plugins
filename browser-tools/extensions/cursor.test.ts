import { describe, expect, test } from "bun:test";
import type { ElementHandle, Page } from "puppeteer-core";
import type { CursorMode } from "./lib/config.ts";
import type { CursorRuntime, CursorVisualCommand } from "./lib/cursor.ts";
import {
	CURSOR_CENTER_TOLERANCE_PX,
	CURSOR_PRELOAD_SOURCE,
	CURSOR_PRELOAD_VERSION,
	CURSOR_TOKENS,
	clearCursor,
	createCursorRuntime,
	installCursor,
	pointCursorAtTarget,
	resolveCursorMode,
} from "./lib/cursor.ts";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const SEED_TRANSFORM = `translate3d(${VIEWPORT_WIDTH / 2}px, ${VIEWPORT_HEIGHT / 2}px, 0) scale(1)`;

interface TestBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface FakeDriverPage {
	page: Page;
	preloads: string[];
	bootstraps: string[];
	commands: CursorVisualCommand[];
}

/**
 * Minimal stand-in for the observable Puppeteer contract the cursor uses:
 * `evaluateOnNewDocument` for registration, a string `evaluate` for the
 * current-document bootstrap, a function `evaluate` without arguments for the
 * reduced-motion probe, and a function `evaluate` with a command for rendering.
 */
function fakeDriverPage(
	options: { registerFails?: boolean; bootstrapFails?: boolean; renderFails?: boolean; reducedMotion?: boolean } = {},
): FakeDriverPage {
	const preloads: string[] = [];
	const bootstraps: string[] = [];
	const commands: CursorVisualCommand[] = [];
	const state = {
		evaluateOnNewDocument: async (source: string) => {
			if (options.registerFails === true) throw new Error("registration refused");
			preloads.push(source);
			return { identifier: `registration-${preloads.length}` };
		},
		evaluate: async (target: unknown, command?: CursorVisualCommand) => {
			if (typeof target === "string") {
				if (options.bootstrapFails === true) throw new Error("bootstrap refused");
				bootstraps.push(target);
				return undefined;
			}
			if (command === undefined) return options.reducedMotion === true;
			if (options.renderFails === true) throw new Error("render refused");
			commands.push(command);
			return undefined;
		},
		on: () => undefined,
		mainFrame: () => ({}),
	};
	return { page: state as unknown as Page, preloads, bootstraps, commands };
}

interface FakeTarget {
	resolve: () => Promise<ElementHandle<Element>>;
	counts: { scrolls: number; reads: number };
	handles: Array<ElementHandle<Element>>;
	disposed: Array<ElementHandle<Element>>;
}

/** Each resolution hands out a distinct handle, so handle ownership is observable. */
function fakeTarget(boxes: Array<TestBox | null>): FakeTarget {
	const counts = { scrolls: 0, reads: 0 };
	const handles: Array<ElementHandle<Element>> = [];
	const disposed: Array<ElementHandle<Element>> = [];
	const resolve = async () => {
		const state = {
			scrollIntoView: async () => {
				counts.scrolls += 1;
			},
			boundingBox: async () => {
				const box = boxes[Math.min(counts.reads, boxes.length - 1)] ?? null;
				counts.reads += 1;
				return box;
			},
			dispose: async () => {
				disposed.push(handle);
			},
		};
		const handle = state as unknown as ElementHandle<Element>;
		handles.push(handle);
		return handle;
	};
	return { resolve, counts, handles, disposed };
}

async function readyRuntime(mode: CursorMode, page: FakeDriverPage): Promise<CursorRuntime> {
	const runtime = createCursorRuntime({ mode, headless: false, warnings: [] });
	await installCursor(runtime, page.page);
	return runtime;
}

function command(kind: "move" | "pulse", target: { x: number; y: number }): CursorVisualCommand {
	return { version: CURSOR_PRELOAD_VERSION, actionId: "test", kind, target, durationMs: CURSOR_TOKENS.travelMs, documentEpoch: 0 };
}

interface FakeStyle {
	cssText: string;
	transform: string;
	properties: Record<string, string>;
	setProperty(name: string, value: string): void;
}

interface FakeShadow {
	mode: string;
	children: FakeNode[];
	appendChild(child: FakeNode): FakeNode;
}

interface FakeNode {
	tagName: string;
	className: string;
	textContent: string;
	offsetWidth: number;
	attributes: Record<string, string>;
	dataset: Record<string, string>;
	style: FakeStyle;
	/** Every transform written, oldest first; the seed is always the first entry. */
	transforms: string[];
	/** Every `--omp-cursor-duration` written, oldest first. */
	durations: string[];
	children: FakeNode[];
	parent: FakeNode | null;
	shadow: FakeShadow | null;
	isConnected: boolean;
	setAttribute(name: string, value: string): void;
	attachShadow(init: { mode: string }): FakeShadow;
	appendChild(child: FakeNode): FakeNode;
	remove(): void;
}

function fakeNode(tagName: string): FakeNode {
	const properties: Record<string, string> = {};
	const transforms: string[] = [];
	const durations: string[] = [];
	const node: FakeNode = {
		tagName,
		className: "",
		textContent: "",
		offsetWidth: 0,
		attributes: {},
		dataset: {},
		style: {
			cssText: "",
			properties,
			get transform() {
				return transforms.at(-1) ?? "";
			},
			set transform(value: string) {
				transforms.push(value);
			},
			setProperty: (name: string, value: string) => {
				properties[name] = value;
				if (name === "--omp-cursor-duration") durations.push(value);
			},
		},
		transforms,
		durations,
		children: [],
		parent: null,
		shadow: null,
		isConnected: false,
		setAttribute(name: string, value: string) {
			node.attributes[name] = value;
		},
		attachShadow(init: { mode: string }) {
			const children: FakeNode[] = [];
			node.shadow = {
				mode: init.mode,
				children,
				appendChild: (child: FakeNode) => {
					children.push(child);
					return child;
				},
			};
			return node.shadow;
		},
		appendChild(child: FakeNode) {
			node.children.push(child);
			child.parent = node;
			child.isConnected = node.isConnected;
			return child;
		},
		remove() {
			if (node.parent) node.parent.children = node.parent.children.filter((entry) => entry !== node);
			node.parent = null;
			node.isConnected = false;
		},
	};
	return node;
}

interface PageBridge {
	version: number;
	render(payload: CursorVisualCommand): void;
	dispose(): void;
}

interface FakeScope {
	document: { createElement(tag: string): FakeNode; documentElement: FakeNode; body: FakeNode | null; visibilityState: string };
	innerWidth: number;
	innerHeight: number;
	matchMedia(query: string): { matches: boolean };
	addEventListener(type: string, handler: () => void): void;
	__ompHeadedCursor?: PageBridge;
}

interface InstalledAgent {
	scope: FakeScope;
	root: FakeNode;
	listeners: Record<string, Array<() => void>>;
	bridge: PageBridge;
}

/**
 * Runs the real preload source against a synthetic scope. The agent reaches every
 * global through its `scope` parameter, so the same source that Firefox evaluates
 * is exercised here without a browser.
 */
function installAgent(options: { reducedMotion?: boolean; hidden?: boolean } = {}): InstalledAgent {
	const root = fakeNode("html");
	root.isConnected = true;
	const listeners: Record<string, Array<() => void>> = {};
	const scope: FakeScope = {
		document: {
			createElement: (tag: string) => fakeNode(tag),
			documentElement: root,
			body: null,
			visibilityState: options.hidden === true ? "hidden" : "visible",
		},
		innerWidth: VIEWPORT_WIDTH,
		innerHeight: VIEWPORT_HEIGHT,
		matchMedia: () => ({ matches: options.reducedMotion === true }),
		addEventListener: (type: string, handler: () => void) => {
			const group = listeners[type] ?? [];
			group.push(handler);
			listeners[type] = group;
		},
	};
	// The preload is a page expression; a synthetic `globalThis` binding scopes it.
	const evaluate = new Function("globalThis", CURSOR_PRELOAD_SOURCE) as (scope: FakeScope) => void;
	evaluate(scope);
	const bridge = scope.__ompHeadedCursor;
	if (!bridge) throw new Error("preload did not install a bridge");
	return { scope, root, listeners, bridge };
}

function overlayDot(agent: InstalledAgent): FakeNode {
	const host = agent.root.children[0];
	const dot = host?.shadow?.children.find((child) => child.className === "omp-cursor");
	if (!dot) throw new Error("overlay is not present");
	return dot;
}

describe("cursor mode resolution", () => {
	test("auto animates headed sessions and stays off when headless", () => {
		expect(resolveCursorMode("auto", false)).toBe("animated");
		expect(resolveCursorMode("auto", true)).toBe("off");
	});

	test("explicit modes survive headless resolution", () => {
		expect(resolveCursorMode("off", false)).toBe("off");
		expect(resolveCursorMode("instant", true)).toBe("instant");
		expect(resolveCursorMode("animated", true)).toBe("animated");
	});
});

describe("cursor preload installation", () => {
	test("registers once per page and bootstraps the current document", async () => {
		const page = fakeDriverPage();
		const runtime = createCursorRuntime({ mode: "animated", headless: false, warnings: [] });
		expect(await installCursor(runtime, page.page)).toBe(true);
		expect(await installCursor(runtime, page.page)).toBe(true);
		expect(page.preloads).toHaveLength(1);
		expect(page.bootstraps).toHaveLength(1);
		// One versioned agent covers both the future documents and the loaded one.
		expect(page.bootstraps[0]).toBe(page.preloads[0]);
		expect(runtime.registrations.get(page.page)).toBe("registration-1");
	});

	test("installs nothing when visualization is off", async () => {
		const page = fakeDriverPage();
		const runtime = createCursorRuntime({ mode: "auto", headless: true, warnings: [] });
		expect(await installCursor(runtime, page.page)).toBe(false);
		expect(page.preloads).toEqual([]);
		expect(page.bootstraps).toEqual([]);
		expect(runtime.warnings).toEqual([]);
	});

	test("downgrades to off with a single warning when registration fails", async () => {
		const page = fakeDriverPage({ registerFails: true });
		const runtime = createCursorRuntime({ mode: "animated", headless: false, warnings: [] });
		expect(await installCursor(runtime, page.page)).toBe(false);
		expect(runtime.mode).toBe("off");
		expect(runtime.warnings).toHaveLength(1);
		await installCursor(runtime, page.page);
		expect(runtime.warnings).toHaveLength(1);
	});

	test("downgrades to off when the current-document bootstrap fails", async () => {
		const page = fakeDriverPage({ bootstrapFails: true });
		const runtime = createCursorRuntime({ mode: "animated", headless: false, warnings: [] });
		expect(await installCursor(runtime, page.page)).toBe(false);
		expect(runtime.mode).toBe("off");
		expect(runtime.warnings).toHaveLength(1);
	});

	test("drops travel animation for a reduced-motion page", async () => {
		const reduced = await readyRuntime("animated", fakeDriverPage({ reducedMotion: true }));
		expect(reduced.mode).toBe("instant");
		const normal = await readyRuntime("animated", fakeDriverPage());
		expect(normal.mode).toBe("animated");
	});
});

describe("cursor page agent", () => {
	test("renders an inert, accessibility-hidden overlay inside a closed shadow root", () => {
		const agent = installAgent();
		agent.bridge.render(command("move", { x: 10, y: 20 }));
		const host = agent.root.children[0]!;
		expect(host.attributes["aria-hidden"]).toBe("true");
		expect(host.style.cssText).toContain("pointer-events:none");
		expect(host.shadow?.mode).toBe("closed");
		const style = host.shadow?.children.find((child) => child.tagName === "style");
		expect(style?.textContent).toContain(`--omp-cursor-size:${CURSOR_TOKENS.diameterPx}px`);
	});

	test("seeds a new dot at the viewport center and travels to the first target", () => {
		const agent = installAgent();
		agent.bridge.render(command("move", { x: 10, y: 20 }));
		const dot = overlayDot(agent);
		expect(dot.transforms).toEqual([SEED_TRANSFORM, "translate3d(10px, 20px, 0) scale(1)"]);
		expect(dot.durations).toEqual(["0ms", `${CURSOR_TOKENS.travelMs}ms`]);
		expect(dot.dataset.state).toBe("travel");
	});

	test("keeps travelling for every later target", () => {
		const agent = installAgent();
		agent.bridge.render(command("move", { x: 10, y: 20 }));
		agent.bridge.render(command("move", { x: 80, y: 90 }));
		const dot = overlayDot(agent);
		expect(dot.style.transform).toBe("translate3d(80px, 90px, 0) scale(1)");
		expect(dot.durations).toEqual(["0ms", `${CURSOR_TOKENS.travelMs}ms`, `${CURSOR_TOKENS.travelMs}ms`]);
	});

	test("pulses the target with the pulse token", () => {
		const agent = installAgent();
		agent.bridge.render(command("move", { x: 10, y: 20 }));
		agent.bridge.render({ ...command("pulse", { x: 10, y: 20 }), durationMs: CURSOR_TOKENS.pulseMs });
		const dot = overlayDot(agent);
		expect(dot.dataset.state).toBe("pulse");
		expect(dot.durations.at(-1)).toBe(`${CURSOR_TOKENS.pulseMs}ms`);
		expect(dot.style.transform).toBe(`translate3d(10px, 20px, 0) scale(${CURSOR_TOKENS.pulseScale})`);
	});

	test("removes every transition for reduced motion and for a hidden document", () => {
		for (const agent of [installAgent({ reducedMotion: true }), installAgent({ hidden: true })]) {
			agent.bridge.render(command("move", { x: 10, y: 20 }));
			agent.bridge.render(command("move", { x: 80, y: 90 }));
			agent.bridge.render({ ...command("pulse", { x: 80, y: 90 }), durationMs: CURSOR_TOKENS.pulseMs });
			const dot = overlayDot(agent);
			expect(dot.durations).toEqual(["0ms", "0ms", "0ms", "0ms"]);
			expect(dot.dataset.state).toBe("pulse");
			expect(dot.style.transform).toBe("translate3d(80px, 90px, 0) scale(1)");
		}
	});

	test("keeps one root across repeated installation and ignores foreign versions", () => {
		const agent = installAgent();
		agent.bridge.render(command("move", { x: 10, y: 20 }));
		const evaluate = new Function("globalThis", CURSOR_PRELOAD_SOURCE) as (scope: FakeScope) => void;
		evaluate(agent.scope);
		expect(agent.scope.__ompHeadedCursor).toBe(agent.bridge);
		expect(agent.root.children).toHaveLength(1);
		agent.bridge.render({ ...command("move", { x: 60, y: 60 }), version: CURSOR_PRELOAD_VERSION + 1 });
		expect(overlayDot(agent).transforms).toEqual([SEED_TRANSFORM, "translate3d(10px, 20px, 0) scale(1)"]);
	});

	test("clears the overlay on hide and on navigation, then reseeds on demand", () => {
		const agent = installAgent();
		agent.bridge.render(command("move", { x: 10, y: 20 }));
		agent.bridge.render({ ...command("move", { x: 10, y: 20 }), kind: "hide" });
		expect(agent.root.children).toHaveLength(0);
		agent.bridge.render(command("move", { x: 30, y: 40 }));
		expect(agent.root.children).toHaveLength(1);
		expect(overlayDot(agent).transforms).toEqual([SEED_TRANSFORM, "translate3d(30px, 40px, 0) scale(1)"]);
		for (const handler of agent.listeners.pagehide ?? []) handler();
		expect(agent.root.children).toHaveLength(0);
	});
});

describe("cursor targeting", () => {
	test("points at the driver-resolved center and pulses a stable target", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("instant", page);
		const target = fakeTarget([{ x: 20, y: 40, width: 10, height: 20 }]);
		const handle = await pointCursorAtTarget(runtime, page.page, target.resolve);
		expect(target.handles).toHaveLength(1);
		expect(target.handles[0]).toBe(handle);
		expect(target.counts.scrolls).toBe(1);
		expect(page.commands.map((entry) => entry.kind)).toEqual(["move", "pulse"]);
		expect(page.commands[0]?.target).toEqual({ x: 25, y: 50 });
		expect(page.commands[0]?.durationMs).toBe(0);
		expect(page.commands[1]?.durationMs).toBe(CURSOR_TOKENS.pulseMs);
		// The caller owns the handle it receives.
		expect(target.disposed).toEqual([]);
	});

	test("uses the travel token in animated mode", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("animated", page);
		const target = fakeTarget([{ x: 0, y: 0, width: 4, height: 4 }]);
		await pointCursorAtTarget(runtime, page.page, target.resolve);
		expect(page.commands[0]?.durationMs).toBe(CURSOR_TOKENS.travelMs);
	});

	test("tolerates drift inside the bounded center delta", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("instant", page);
		const drift = CURSOR_CENTER_TOLERANCE_PX - 1;
		const target = fakeTarget([
			{ x: 0, y: 0, width: 20, height: 20 },
			{ x: drift, y: 0, width: 20, height: 20 },
		]);
		await pointCursorAtTarget(runtime, page.page, target.resolve);
		expect(page.commands.map((entry) => entry.kind)).toEqual(["move", "pulse"]);
		expect(target.handles).toHaveLength(1);
	});

	test("repositions once when the target moves, disposing the superseded handle", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("instant", page);
		const target = fakeTarget([
			{ x: 0, y: 0, width: 20, height: 20 },
			{ x: 200, y: 0, width: 20, height: 20 },
			{ x: 200, y: 0, width: 20, height: 20 },
			{ x: 200, y: 0, width: 20, height: 20 },
		]);
		const handle = await pointCursorAtTarget(runtime, page.page, target.resolve);
		expect(target.handles).toHaveLength(2);
		expect(target.handles[1]).toBe(handle);
		expect(target.disposed[0]).toBe(target.handles[0]);
		expect(page.commands.map((entry) => entry.kind)).toEqual(["move", "move", "pulse"]);
		expect(page.commands[1]?.target).toEqual({ x: 210, y: 10 });
	});

	test("reports target_moved without acting after a second movement", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("instant", page);
		const target = fakeTarget([
			{ x: 0, y: 0, width: 20, height: 20 },
			{ x: 200, y: 0, width: 20, height: 20 },
			{ x: 200, y: 0, width: 20, height: 20 },
			{ x: 400, y: 0, width: 20, height: 20 },
		]);
		await expect(pointCursorAtTarget(runtime, page.page, target.resolve)).rejects.toThrow(/target_moved/);
		expect(page.commands.map((entry) => entry.kind)).toEqual(["move", "move"]);
		// Nobody receives a handle on this path, so both are released here.
		expect(target.disposed).toEqual(target.handles);
		expect(target.handles).toHaveLength(2);
	});

	test("treats a vanished target as movement", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("instant", page);
		const target = fakeTarget([{ x: 0, y: 0, width: 20, height: 20 }, null, { x: 0, y: 0, width: 20, height: 20 }, null]);
		await expect(pointCursorAtTarget(runtime, page.page, target.resolve)).rejects.toThrow(/target_moved/);
		expect(target.disposed).toEqual(target.handles);
	});

	test("skips geometry and visualization entirely when off", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("off", page);
		const target = fakeTarget([{ x: 0, y: 0, width: 20, height: 20 }]);
		const handle = await pointCursorAtTarget(runtime, page.page, target.resolve);
		expect(target.handles[0]).toBe(handle);
		expect(target.counts.scrolls).toBe(0);
		expect(target.counts.reads).toBe(0);
		expect(target.disposed).toEqual([]);
		expect(page.commands).toEqual([]);
	});

	test("skips visualization for an aborted call", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("instant", page);
		const target = fakeTarget([{ x: 0, y: 0, width: 20, height: 20 }]);
		await pointCursorAtTarget(runtime, page.page, target.resolve, { aborted: true });
		expect(page.commands).toEqual([]);
		expect(target.counts.reads).toBe(0);
		expect(target.disposed).toEqual([]);
	});

	test("hands the target back and disables visualization when a render fails", async () => {
		const page = fakeDriverPage({ renderFails: true });
		const runtime = await readyRuntime("instant", page);
		const target = fakeTarget([{ x: 0, y: 0, width: 20, height: 20 }]);
		const handle = await pointCursorAtTarget(runtime, page.page, target.resolve);
		expect(target.handles[0]).toBe(handle);
		expect(target.disposed).toEqual([]);
		expect(runtime.mode).toBe("off");
		expect(runtime.warnings).toHaveLength(1);
		// Only the pre-command geometry read happened; no verdict came from the page.
		expect(target.counts.reads).toBe(1);
		await clearCursor(runtime, page.page);
		expect(page.commands).toEqual([]);
	});

	test("hides the overlay through the driver on cleanup", async () => {
		const page = fakeDriverPage();
		const runtime = await readyRuntime("instant", page);
		await clearCursor(runtime, page.page);
		expect(page.commands.map((entry) => entry.kind)).toEqual(["hide"]);
	});
});
