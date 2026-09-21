import type { ElementHandle, Page } from "puppeteer-core";
import type { CursorMode } from "./config.ts";
import { errorMessage } from "./config.ts";

/**
 * Cursor visualization is decorative and untrusted. Nothing the page returns may
 * influence target resolution, geometry validation, policy, or the action result:
 * every coordinate and every movement verdict comes from driver geometry only.
 */

/** Bumped whenever the page-side contract changes; the install guard keys off this value. */
export const CURSOR_PRELOAD_VERSION = 1;

/**
 * The only carrier of cursor visual values. These are the user-tested tokens from
 * the live relay prototype; they are mirrored into CSS custom properties so the
 * page-side stylesheet holds no independent literals.
 */
export const CURSOR_TOKENS = {
	diameterPx: 24,
	borderRadius: "50%",
	borderWidthPx: 3,
	borderColor: "white",
	haloWidthPx: 4,
	haloColor: "cyan",
	travelColor: "cyan",
	pulseColor: "magenta",
	pulseScale: 1.35,
	travelMs: 600,
	travelEasing: "ease-in-out",
	pulseMs: 100,
	colorEasing: "linear",
	overlayZIndex: 2147483647,
	/** Slack added to a driver-side animation wait so the transform has landed. */
	settleSlackMs: 50,
	/** Hard driver-side deadline for one page render call. */
	commandDeadlineMs: 1000,
} as const;

/** Maximum center drift, in visual-viewport CSS pixels, that still counts as the same target. */
export const CURSOR_CENTER_TOLERANCE_PX = 4;

/** One initial positioning attempt plus the single allowed reposition. */
export const CURSOR_MAX_ATTEMPTS = 2;

export type ResolvedCursorMode = "off" | "instant" | "animated";

export type CursorCommandKind = "move" | "pulse" | "hide";

/** Compact, versioned payload; the page may only render it. */
export interface CursorVisualCommand {
	version: number;
	actionId: string;
	kind: CursorCommandKind;
	target: { x: number; y: number };
	durationMs: number;
	documentEpoch: number;
}

/** Driver-owned registration and mode state; no page-supplied value is stored here. */
export interface CursorRuntime {
	requested: CursorMode;
	mode: ResolvedCursorMode;
	registrations: WeakMap<Page, string>;
	epochs: WeakMap<Page, number>;
	warnings: string[];
	actionCount: number;
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

declare global {
	/** Bridge installed by the preload; absent until then, and never trusted. */
	var __ompHeadedCursor: { version: number; render(command: CursorVisualCommand): void } | undefined;
}

const HOST_STYLE = [
	"position:fixed",
	"left:0",
	"top:0",
	"width:0",
	"height:0",
	"margin:0",
	"padding:0",
	"border:0",
	"pointer-events:none",
	`z-index:${CURSOR_TOKENS.overlayZIndex}`,
	"",
].join(";");

const SHADOW_STYLE = `:host{--omp-cursor-size:${CURSOR_TOKENS.diameterPx}px;--omp-cursor-radius:${CURSOR_TOKENS.borderRadius};--omp-cursor-border-width:${CURSOR_TOKENS.borderWidthPx}px;--omp-cursor-border-color:${CURSOR_TOKENS.borderColor};--omp-cursor-halo-width:${CURSOR_TOKENS.haloWidthPx}px;--omp-cursor-halo-color:${CURSOR_TOKENS.haloColor};--omp-cursor-travel-color:${CURSOR_TOKENS.travelColor};--omp-cursor-pulse-color:${CURSOR_TOKENS.pulseColor};--omp-cursor-easing:${CURSOR_TOKENS.travelEasing};--omp-cursor-color-easing:${CURSOR_TOKENS.colorEasing};--omp-cursor-duration:0ms}
.omp-cursor{all:initial;position:fixed;left:0;top:0;width:var(--omp-cursor-size);height:var(--omp-cursor-size);margin:calc(var(--omp-cursor-size) / -2) 0 0 calc(var(--omp-cursor-size) / -2);box-sizing:border-box;border-radius:var(--omp-cursor-radius);border:var(--omp-cursor-border-width) solid var(--omp-cursor-border-color);background:var(--omp-cursor-travel-color);box-shadow:0 0 0 var(--omp-cursor-halo-width) var(--omp-cursor-halo-color);pointer-events:none;transform:translate3d(0, 0, 0);transition:transform var(--omp-cursor-duration) var(--omp-cursor-easing),background-color var(--omp-cursor-duration) var(--omp-cursor-color-easing)}
.omp-cursor[data-state="pulse"]{background:var(--omp-cursor-pulse-color)}`;

/**
 * Page-side agent. Rendering is synchronous — the driver owns every wait — and
 * every global is reached through `scope`, so the identical source runs as a
 * preload where `scope` is `globalThis` and under a synthetic scope in tests.
 */
const CURSOR_AGENT_BODY = `
const KEY = "__ompHeadedCursor";
const VERSION = ${CURSOR_PRELOAD_VERSION};
const PULSE_SCALE = ${CURSOR_TOKENS.pulseScale};
const HOST_STYLE = ${JSON.stringify(HOST_STYLE)};
const SHADOW_STYLE = ${JSON.stringify(SHADOW_STYLE)};
const previous = scope[KEY];
if (previous && previous.version === VERSION) return;
if (previous && typeof previous.dispose === "function") { try { previous.dispose(); } catch { /* a stale root is replaced below */ } }
const doc = scope.document;
if (!doc || typeof doc.createElement !== "function") return;
let host = null;
let dot = null;
const drop = () => {
	if (host && typeof host.remove === "function") { try { host.remove(); } catch { /* already detached */ } }
	host = null;
	dot = null;
};
const place = (node, x, y, scale, duration) => {
	node.style.setProperty("--omp-cursor-duration", duration + "ms");
	node.style.transform = "translate3d(" + x + "px, " + y + "px, 0) scale(" + scale + ")";
};
const viewportCenter = () => {
	const root = doc.documentElement;
	const width = typeof scope.innerWidth === "number" && scope.innerWidth > 0 ? scope.innerWidth : (root && root.clientWidth) || 0;
	const height = typeof scope.innerHeight === "number" && scope.innerHeight > 0 ? scope.innerHeight : (root && root.clientHeight) || 0;
	return { x: width / 2, y: height / 2 };
};
const ensure = () => {
	if (dot && host && host.isConnected !== false) return dot;
	drop();
	const root = doc.documentElement || doc.body;
	if (!root || typeof root.appendChild !== "function") return null;
	host = doc.createElement("div");
	host.setAttribute("aria-hidden", "true");
	host.setAttribute("data-omp-headed-cursor", String(VERSION));
	host.style.cssText = HOST_STYLE;
	const shadow = host.attachShadow({ mode: "closed" });
	const style = doc.createElement("style");
	style.textContent = SHADOW_STYLE;
	const node = doc.createElement("div");
	node.className = "omp-cursor";
	shadow.appendChild(style);
	shadow.appendChild(node);
	root.appendChild(host);
	// A new dot starts at the viewport center, never at the origin, so the very
	// first target action still travels visibly.
	node.dataset.state = "travel";
	const seed = viewportCenter();
	place(node, seed.x, seed.y, 1, 0);
	// A forced reflow establishes the before-change style; without it the seed and
	// the first target transform collapse into one style change and never animate.
	void node.offsetWidth;
	dot = node;
	return dot;
};
const instantOnly = () => {
	if (doc.visibilityState === "hidden") return true;
	try { return scope.matchMedia("(prefers-reduced-motion: reduce)").matches === true; } catch { return false; }
};
const api = {
	version: VERSION,
	dispose: drop,
	render(command) {
		if (!command || command.version !== VERSION) return;
		if (command.kind === "hide") { drop(); return; }
		const node = ensure();
		if (!node) return;
		const point = command.target || {};
		const x = typeof point.x === "number" && isFinite(point.x) ? point.x : 0;
		const y = typeof point.y === "number" && isFinite(point.y) ? point.y : 0;
		const requested = typeof command.durationMs === "number" && command.durationMs > 0 ? command.durationMs : 0;
		const duration = instantOnly() ? 0 : requested;
		const scale = command.kind === "pulse" && duration > 0 ? PULSE_SCALE : 1;
		node.dataset.state = command.kind === "pulse" ? "pulse" : "travel";
		place(node, x, y, scale, duration);
	},
};
Object.defineProperty(scope, KEY, { value: api, configurable: true, enumerable: false, writable: false });
if (typeof scope.addEventListener === "function") scope.addEventListener("pagehide", drop);
`;

/** Fixed preload expression, installed verbatim on every page. */
export const CURSOR_PRELOAD_SOURCE = `((scope) => {${CURSOR_AGENT_BODY}})(globalThis)`;

export function resolveCursorMode(mode: CursorMode, headless: boolean): ResolvedCursorMode {
	if (mode === "auto") return headless ? "off" : "animated";
	return mode;
}

export function createCursorRuntime(input: {
	mode: CursorMode;
	headless: boolean;
	warnings: string[];
}): CursorRuntime {
	return {
		requested: input.mode,
		mode: resolveCursorMode(input.mode, input.headless),
		registrations: new WeakMap(),
		epochs: new WeakMap(),
		warnings: input.warnings,
		actionCount: 0,
	};
}

/**
 * Registers the preload once per page and bootstraps the already-loaded document.
 * Never throws: a failure downgrades visualization to `off` with one warning so
 * the browser action itself stays unaffected.
 */
export async function installCursor(runtime: CursorRuntime, page: Page): Promise<boolean> {
	if (runtime.mode === "off") return false;
	if (runtime.registrations.has(page)) return true;
	try {
		const registration = await page.evaluateOnNewDocument(CURSOR_PRELOAD_SOURCE);
		runtime.registrations.set(page, registration.identifier);
		runtime.epochs.set(page, 0);
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) runtime.epochs.set(page, (runtime.epochs.get(page) ?? 0) + 1);
		});
		// A preload only covers documents created after registration, so the document
		// already loaded in this page is bootstrapped exactly once, here.
		await page.evaluate(CURSOR_PRELOAD_SOURCE);
	} catch (error) {
		disableCursor(runtime, `preload installation failed: ${errorMessage(error)}`);
		return false;
	}
	// Reduced motion removes the driver-side travel wait as well as the transition.
	// The probe touches nothing but animation duration, so a lying page gains nothing.
	if (runtime.mode === "animated" && (await prefersReducedMotion(page))) runtime.mode = "instant";
	return true;
}

/**
 * Resolves the action target through the driver, points the cursor at it, and
 * revalidates driver geometry afterwards. Returns the handle the caller must act
 * on and then dispose. Throws `target_moved` — before any action runs — when the
 * target keeps moving after the single allowed reposition; every handle this
 * function abandons, including the last one on that path, is disposed here.
 */
export async function pointCursorAtTarget(
	runtime: CursorRuntime,
	page: Page,
	resolve: () => Promise<ElementHandle<Element>>,
	signal?: unknown,
): Promise<ElementHandle<Element>> {
	let element = await resolve();
	const cancelled =
		typeof signal === "object" && signal !== null && "aborted" in signal && (signal as { aborted?: unknown }).aborted === true;
	if (runtime.mode === "off" || cancelled) return element;
	for (let attempt = 0; attempt < CURSOR_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 0) {
			// The reposition resolves a fresh handle; the superseded one would otherwise
			// keep its remote object alive for the life of the page.
			await disposeHandle(element);
			element = await resolve();
		}
		await scrollTargetIntoView(element);
		const before = await readBox(element);
		// An unrendered target has nothing to point at; the action reports its own error.
		if (!before) return element;
		const travelMs = runtime.mode === "animated" ? CURSOR_TOKENS.travelMs : 0;
		// Downgraded, cancelled, or failed visualization must never gate the action.
		if (!(await send(runtime, page, "move", boxCenter(before), travelMs))) return element;
		const after = await readBox(element);
		if (after && isSameTarget(before, after)) {
			await send(runtime, page, "pulse", boxCenter(after), CURSOR_TOKENS.pulseMs);
			return element;
		}
	}
	await disposeHandle(element);
	throw new Error(
		`headed-browser: target_moved; the target shifted beyond ${CURSOR_CENTER_TOLERANCE_PX} CSS pixels after ${CURSOR_MAX_ATTEMPTS} positioning attempts and no action was performed`,
	);
}

/** Removes the overlay on completion, failure, cancellation, or teardown. Never throws. */
export async function clearCursor(runtime: CursorRuntime, page: Page): Promise<void> {
	if (runtime.mode === "off" || !runtime.registrations.has(page)) return;
	await runCommand(page, buildCommand(runtime, page, "hide", { x: 0, y: 0 }, 0));
}

async function prefersReducedMotion(page: Page): Promise<boolean> {
	try {
		return await page.evaluate(readReducedMotion);
	} catch {
		return false;
	}
}

function buildCommand(
	runtime: CursorRuntime,
	page: Page,
	kind: CursorCommandKind,
	target: { x: number; y: number },
	durationMs: number,
): CursorVisualCommand {
	runtime.actionCount += 1;
	return {
		version: CURSOR_PRELOAD_VERSION,
		actionId: `cursor-${runtime.actionCount}`,
		kind,
		target,
		durationMs,
		documentEpoch: runtime.epochs.get(page) ?? 0,
	};
}

async function send(
	runtime: CursorRuntime,
	page: Page,
	kind: CursorCommandKind,
	target: { x: number; y: number },
	durationMs: number,
): Promise<boolean> {
	if (runtime.mode === "off") return false;
	const outcome = await runCommand(page, buildCommand(runtime, page, kind, target, durationMs));
	if (!outcome.ok) {
		disableCursor(runtime, `${kind} command failed: ${outcome.detail}`);
		return false;
	}
	// The driver, not the page, owns animation timing, so geometry is re-read at the
	// animation endpoint without consuming anything the page reported.
	if (durationMs > 0) await Bun.sleep(durationMs + CURSOR_TOKENS.settleSlackMs);
	return true;
}

async function runCommand(
	page: Page,
	command: CursorVisualCommand,
): Promise<{ ok: true } | { ok: false; detail: string }> {
	let failure: unknown;
	const tracked = page.evaluate(renderCursorCommand, command).then(
		() => "ok" as const,
		(error: unknown) => {
			failure = error;
			return "failed" as const;
		},
	);
	// A wedged page must not stall the action long enough to trip the session timeout.
	const outcome = await Promise.race([tracked, Bun.sleep(CURSOR_TOKENS.commandDeadlineMs).then(() => "timeout" as const)]);
	if (outcome === "ok") return { ok: true };
	if (outcome === "timeout") return { ok: false, detail: `no response within ${CURSOR_TOKENS.commandDeadlineMs} ms` };
	return { ok: false, detail: errorMessage(failure) };
}

/** Runs inside the page; every caller discards the result. */
function renderCursorCommand(command: CursorVisualCommand): void {
	const bridge = globalThis.__ompHeadedCursor;
	if (!bridge || bridge.version !== command.version) {
		throw new Error("headed-browser: cursor bridge unavailable");
	}
	bridge.render(command);
}

/** Runs inside the page; affects animation duration only. */
function readReducedMotion(): boolean {
	try {
		return matchMedia("(prefers-reduced-motion: reduce)").matches === true;
	} catch {
		return false;
	}
}

function disableCursor(runtime: CursorRuntime, detail: string): void {
	runtime.mode = "off";
	const warning = `headed-browser: cursor visualization disabled (${detail})`;
	if (!runtime.warnings.includes(warning)) runtime.warnings.push(warning);
}

/** Releasing a remote object must never turn into an action failure. */
async function disposeHandle(element: ElementHandle<Element>): Promise<void> {
	try {
		await element.dispose();
	} catch {
		/* the handle died with its document */
	}
}

async function scrollTargetIntoView(element: ElementHandle<Element>): Promise<void> {
	// A detached or unrendered target surfaces through the geometry read that follows.
	try {
		await element.scrollIntoView();
	} catch {
		/* ignored */
	}
}

/**
 * Trusted geometry. Puppeteer reports the box in the same visual-viewport CSS
 * pixels that mouse input uses, which is exactly what the fixed overlay needs;
 * screenshot, device-pixel, and layout-viewport spaces are never mixed in.
 */
async function readBox(element: ElementHandle<Element>): Promise<Box | null> {
	try {
		return await element.boundingBox();
	} catch {
		return null;
	}
}

function boxCenter(box: Box): { x: number; y: number } {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Overlap plus a bounded center delta: the same-target test both attempts use. */
function isSameTarget(before: Box, after: Box): boolean {
	const overlapping =
		before.x < after.x + after.width &&
		after.x < before.x + before.width &&
		before.y < after.y + after.height &&
		after.y < before.y + before.height;
	const start = boxCenter(before);
	const end = boxCenter(after);
	return overlapping && Math.hypot(end.x - start.x, end.y - start.y) <= CURSOR_CENTER_TOLERANCE_PX;
}
