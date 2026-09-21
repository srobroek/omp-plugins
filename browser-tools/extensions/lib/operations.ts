import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Dialog, ElementHandle, KeyInput, Page } from "puppeteer-core";
import { errorMessage } from "./config.ts";
import { clearCursor, pointCursorAtTarget } from "./cursor.ts";
import type { AuditWriter } from "./policy.ts";
import { applyPagePolicy, checkNavigation, deriveDomainPolicy, requireFeature, visibleCookies } from "./policy.ts";
import type { HeadedSession } from "./session.ts";
import { closeCapturedSession, registerPage, selectedPage, selectTab, syncPages, whenSessionClosing } from "./session.ts";

/**
 * The single implementation of every navigate, read, and act operation. Registered
 * tools are thin adapters over these seams: `headed_nav`, `headed_read`, and
 * `headed_act` run one operation each, `headed_plan` runs a validated sequence of
 * them. No registered tool calls another registered tool.
 */

declare global {
	/** Buffer injected into the page by the console policy; absent until then. */
	var __ompHeadedConsole: unknown[] | undefined;
}

export const NAV_OPS = ["goto", "back", "forward", "reload", "wait", "viewport", "newTab", "selectTab", "closeTab"] as const;
export const READ_OPS = ["snapshot", "screenshot", "evaluate", "cookies", "console", "network", "metrics", "pdf", "html"] as const;
export const ACT_OPS = ["click", "type", "press", "scroll", "select", "upload", "dialog", "clear", "hover", "focus"] as const;

export type NavOp = (typeof NAV_OPS)[number];
export type ReadOp = (typeof READ_OPS)[number];
export type ActOp = (typeof ACT_OPS)[number];
export type OperationKind = "nav" | "read" | "act";


/** Bounded wait for the tab lock; a longer queue reports `tab busy` and does no browser work. */
const TAB_LOCK_WAIT_MS = 30_000;

/** Every operation input; a tool's parameters are this plus its own routing fields. */
export interface OperationParams {
	url?: string;
	text?: string;
	selector?: string;
	expression?: string;
	ref?: string;
	key?: string;
	value?: string;
	values?: string[];
	files?: string[];
	timeoutMs?: number;
	width?: number;
	height?: number;
	deviceScaleFactor?: number;
	tabId?: string;
	fullPage?: boolean;
	clip?: { x: number; y: number; width: number; height: number };
	limit?: number;
	since?: number;
	deltaX?: number;
	deltaY?: number;
	accept?: boolean;
	promptText?: string;
}

export interface OperationContext {
	session: HeadedSession;
	ctx: ExtensionContext;
	/** Absent only when the caller has no audit writer; policy decisions still apply. */
	audit?: AuditWriter;
	/** Host cancellation token, shape-checked rather than typed, exactly as the tool API hands it over. */
	signal?: unknown;
	/** Fixed tab identity for a plan step; standalone operations capture the selected tab at entry. */
	expectedTab?: { id: string; page: Page };
	/**
	 * The caller's own hold on this tab, set by an outer sequence such as a plan. The
	 * operation re-enters that hold instead of queueing behind the caller that owns it.
	 */
	tabHold?: TabLockHold;
}

/** A caller-fixable input; classified as `invalid request` however deep it is thrown. */
export class InvalidRequestError extends Error {}

/** Another caller held the tab longer than the acquisition bound; nothing was done. */
export class TabBusyError extends Error {}

/** The host cancelled before the operation started. */
export class CancelledError extends Error {}

/** The tab a caller pinned is no longer the session's selected tab. */
export class StaleTabError extends Error {}

/**
 * The session was closing or closed when the caller asked for its tab. Reported as
 * `unknown session`, the same category a call gets when it names a session that is gone:
 * from a caller's side a session whose teardown started is no longer usable.
 */
export class SessionClosedError extends Error {}

export type SafeErrorCategory =
	| "invalid request"
	| "unknown session"
	| "session timeout"
	| "launch failed"
	| "target_moved"
	| "tab busy"
	| "cancelled"
	| "stale tab"
	| "operation failed";

export function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new InvalidRequestError(`headed-browser: ${name} is required`);
	return value;
}

export function isAborted(signal: unknown): boolean {
	if ((typeof signal !== "object" && typeof signal !== "function") || signal === null) return false;
	try {
		return Reflect.get(signal, "aborted") === true;
	} catch {
		return false;
	}
}

type HostSignal = {
	addEventListener?: (type: string, callback: () => void, options?: { once: boolean }) => void;
	removeEventListener?: (type: string, callback: () => void) => void;
};

function listenForAbort(signal: unknown, onAbort: () => void): () => void {
	if ((typeof signal !== "object" && typeof signal !== "function") || signal === null) return () => undefined;
	let add: HostSignal["addEventListener"];
	let remove: HostSignal["removeEventListener"];
	try {
		const candidate = signal as HostSignal;
		add = candidate.addEventListener;
		remove = candidate.removeEventListener;
	} catch {
		return () => undefined;
	}
	if (add === undefined || remove === undefined) return () => undefined;
	const listener = () => onAbort();
	try {
		add.call(signal, "abort", listener, { once: true });
	} catch {
		return () => undefined;
	}
	return () => {
		try {
			remove!.call(signal, "abort", listener);
		} catch {
			// A host signal may disappear while the operation settles; cleanup is best effort.
		}
	};
}


function operationTabId(context: OperationContext): string {
	return context.expectedTab?.id ?? context.session.selectedTabId;
}

function operationPage(context: OperationContext, tabId: string): Page {
	const { session, expectedTab } = context;
	const page = session.pages.get(tabId);
	if (session.selectedTabId !== tabId || !page || (expectedTab && page !== expectedTab.page)) {
		throw new StaleTabError(`headed-browser: tab ${tabId} is no longer the session's selected tab`);
	}
	return page;
}

/**
 * Maps a thrown value onto the small category vocabulary the tools report. Typed
 * errors classify by identity; the string tests cover throws raised deeper in the
 * session and driver modules.
 */
export function classifyError(op: string, error: unknown): SafeErrorCategory {
	if (error instanceof InvalidRequestError) return "invalid request";
	if (error instanceof TabBusyError) return "tab busy";
	if (error instanceof CancelledError) return "cancelled";
	if (error instanceof StaleTabError) return "stale tab";
	if (error instanceof SessionClosedError) return "unknown session";
	const message = errorMessage(error);
	if (message.includes("unknown session")) return "unknown session";
	if (message.includes("target_moved")) return "target_moved";
	if (message.includes("timed out after")) return "session timeout";
	if (op === "launch") return "launch failed";
	if (message.includes(" is required") || message.includes("unsupported headed_") || message.includes("selector or text is required")) {
		return "invalid request";
	}
	return "operation failed";
}

/**
 * Required-input gate for one navigation operation. Runners call it before any
 * browser work and `headed_plan` calls it for every step before the first effect,
 * so a plan and a standalone call reject the same inputs with the same message.
 */
export function validateNav(op: string, params: OperationParams): asserts op is NavOp {
	if (!(NAV_OPS as readonly string[]).includes(op)) throw new InvalidRequestError(`headed-browser: unsupported headed_nav op ${op}`);
	if (op === "goto") requireString(params.url, "url");
	if (op === "wait" && !params.selector && !params.text) throw new InvalidRequestError("headed-browser: selector or text is required for wait");
	if (op === "viewport" && (!params.width || !params.height)) throw new InvalidRequestError("headed-browser: width and height are required for viewport");
	if (op === "selectTab") requireString(params.tabId, "tabId");
}

export function validateRead(op: string, params: OperationParams): asserts op is ReadOp {
	if (!(READ_OPS as readonly string[]).includes(op)) throw new InvalidRequestError(`headed-browser: unsupported headed_read op ${op}`);
	if (op === "evaluate") requireString(params.expression, "expression");
}

export function validateAct(op: string, params: OperationParams): asserts op is ActOp {
	if (!(ACT_OPS as readonly string[]).includes(op)) throw new InvalidRequestError(`headed-browser: unsupported headed_act op ${op}`);
	if (op === "press") requireString(params.key, "key");
	if (op === "type") requireString(params.text, "text");
	if (op === "select" && (params.values?.length ?? 0) === 0 && !params.value) {
		throw new InvalidRequestError("headed-browser: value or values is required for select");
	}
	if (op === "upload" && !params.files?.length) throw new InvalidRequestError("headed-browser: files is required for upload");
	// Target-bearing ops resolve an element; the others act on the page itself.
	if (op !== "press" && op !== "scroll" && op !== "dialog" && !params.selector && !params.ref) {
		throw new InvalidRequestError("headed-browser: selector or valid ref is required");
	}
}

/**
 * One FIFO writer lock per session tab. Every mutation and every page-touching read
 * holds it, so two outer tool calls — a plan and a standalone action included — never
 * interleave work on the same user-controlled tab. A caller may hold the tab across
 * several operations: `runPlan` acquires one hold through `withTabHold` and hands it to
 * every step, and those steps re-enter that hold rather than releasing the tab between
 * them, so a standalone call queued after the plan started runs only once it ends.
 *
 * A turn holds the lock of every tab it touches, including one it selects part-way
 * through: `newTab` takes the created tab's lock before publishing the selection, and
 * `closeTab` takes the lock of the tab it closes. Those are the only nested acquisitions,
 * and they cannot cycle: `runNav` reaches them only after `operationPage` confirmed the
 * turn holds the session's currently selected tab, at most one turn holds that at a time,
 * and a turn holding any other tab is stale and rejected before it gets there. The
 * acquisition bound applies to a nested wait too, so the worst case is `tab busy`.
 *
 * Entering, leaving, and re-entering a tab each stamp `session.lastActivityAt`, and
 * `session.activeTabHolds` counts the holds running right now, so a long operation and a
 * long sequence of short ones both stay out of the idle sweep without a timer of their own.
 *
 * A session whose teardown started takes no new holds and wakes the ones it has parked:
 * a waiter fails with `unknown session` instead of resuming in a dying browser.
 */
const tabLocks = new WeakMap<HeadedSession, TabLockState>();

interface TabLockState {
	/** Tail of each tab's FIFO queue: the slot the next waiter must await. */
	queue: Map<string, Promise<void>>;
	/** The hold currently running on each tab; its identity is what re-entry matches. */
	holders: Map<string, TabLockHold>;
}

/**
 * One caller's exclusive hold on one tab. Its fields belong to the lock functions below
 * and to nobody else; a holder passes the value itself along to re-enter.
 */
export interface TabLockHold {
	readonly tabId: string;
	/** This hold's slot in the tab's FIFO queue; resolved by `release`. */
	readonly slot: Promise<void>;
	readonly release: () => void;
}

function lockState(session: HeadedSession): TabLockState {
	const existing = tabLocks.get(session);
	if (existing !== undefined) return existing;
	const created: TabLockState = { queue: new Map(), holders: new Map() };
	tabLocks.set(session, created);
	return created;
}

function sessionClosed(session: HeadedSession, tabId: string): SessionClosedError {
	return new SessionClosedError(`headed-browser: unknown session ${session.id} closed before tab ${tabId} could be used`);
}

async function acquireTab(session: HeadedSession, ctx: ExtensionContext, tabId: string, signal?: unknown): Promise<TabLockHold> {
	// Checked before a slot is taken, so a call arriving during a teardown adds nothing to drain.
	if (session.lifecycle !== "open") throw sessionClosed(session, tabId);
	if (isAborted(signal)) throw new CancelledError("headed-browser: cancelled before tab acquisition");
	const state = lockState(session);
	const holder = state.queue.get(tabId);
	// Resolved only after this turn finishes, so the next waiter starts strictly later.
	const { promise: slot, resolve: settle } = Promise.withResolvers<void>();
	state.queue.set(tabId, slot);
	if (holder) {
		const { promise: expired, resolve: expire } = Promise.withResolvers<"expired">();
		const { promise: cancelled, resolve: cancel } = Promise.withResolvers<"cancelled">();
		const timer = ctx.setTimeout(() => expire("expired"), TAB_LOCK_WAIT_MS);
		let waiting = true;
		const removeAbortListener = listenForAbort(signal, () => {
			if (!waiting) return;
			cancel("cancelled");
		});
		try {
			// The signal may have aborted between the initial check and listener registration.
			if (isAborted(signal)) cancel("cancelled");
			// None of the four rejects: a holder chain only ever resolves, the expiry is a timer,
			// the close gate resolves the moment a teardown starts, and the host signal resolves on abort.
			const outcome = await Promise.race([
				holder.then(() => "ready" as const),
				expired,
				whenSessionClosing(session).then(() => "closed" as const),
				cancelled,
			]);
			waiting = false;
			if (outcome !== "ready") {
				// This turn never runs, so waiters behind it adopt the holder's completion
				// instead of a turn that will never release.
				settle(holder);
				if (outcome === "closed") throw sessionClosed(session, tabId);
				if (outcome === "cancelled") throw new CancelledError("headed-browser: cancelled while waiting for tab");
				throw new TabBusyError(`headed-browser: tab ${tabId} stayed busy for ${TAB_LOCK_WAIT_MS} ms and nothing was done`);
			}
			// The turn ahead may have been the one that closed the session, or the close may have
			// landed in the same tick the queue advanced; either way this turn does no page work.
			if (session.lifecycle !== "open") {
				settle(holder);
				throw sessionClosed(session, tabId);
			}
		} finally {
			waiting = false;
			removeAbortListener();
			ctx.clearTimer(timer);
		}
	}
	const hold: TabLockHold = { tabId, slot, release: () => { settle(); } };
	state.holders.set(tabId, hold);
	session.activeTabHolds += 1;
	session.lastActivityAt = Date.now();
	return hold;
}

function releaseTab(session: HeadedSession, hold: TabLockHold): void {
	const state = lockState(session);
	// The map entry is this hold's one record of being active, so the count stays balanced
	// however often a release is attempted.
	if (state.holders.get(hold.tabId) === hold) {
		state.holders.delete(hold.tabId);
		session.activeTabHolds -= 1;
	}
	hold.release();
	if (state.queue.get(hold.tabId) === hold.slot) state.queue.delete(hold.tabId);
	session.lastActivityAt = Date.now();
}

/**
 * Holds one tab for the whole of `operation`. Every operation run with the hold handed
 * to the callback belongs to this one turn, so a caller that queues after the hold is
 * taken cannot land between two of them.
 */
export async function withTabHold<T>(
	session: HeadedSession,
	ctx: ExtensionContext,
	tabId: string,
	operation: (hold: TabLockHold) => Promise<T>,
	signal?: unknown,
): Promise<T> {
	const hold = await acquireTab(session, ctx, tabId, signal);
	try {
		return await operation(hold);
	} finally {
		releaseTab(session, hold);
	}
}


/**
 * Runs one operation under the tab lock and hands it the hold it runs under, so the
 * operation can extend that turn onto a second tab it selects. A caller holding this tab
 * already — a plan running its own step, or a `newTab` finishing on the tab it created —
 * re-enters its turn and keeps the hold; every other caller takes the lock for this
 * operation alone and releases it afterwards.
 */
async function withTabLock<T>(
	session: HeadedSession,
	ctx: ExtensionContext,
	tabId: string,
	hold: TabLockHold | undefined,
	operation: (hold: TabLockHold) => Promise<T>,
	signal?: unknown,
): Promise<T> {
	if (hold !== undefined && lockState(session).holders.get(tabId) === hold) {
		// A teardown that started while this sequence held the tab ends it here rather than
		// letting its next step reach a browser being killed.
		if (session.lifecycle !== "open") throw sessionClosed(session, tabId);
		session.lastActivityAt = Date.now();
		try {
			return await operation(hold);
		} finally {
			session.lastActivityAt = Date.now();
		}
	}
	return withTabHold(session, ctx, tabId, operation, signal);
}

export async function withPageTimeout<T>(
	session: HeadedSession,
	ctx: ExtensionContext,
	label: string,
	timeoutMs: number,
	operation: () => Promise<T>,
): Promise<T> {
	const { promise: timeout, resolve } = Promise.withResolvers<{ kind: "timeout" }>();
	const timer = ctx.setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
	try {
		const result = await Promise.race([
			operation().then((value) => ({ kind: "value" as const, value })),
			timeout,
		]);
		if (result.kind === "timeout") {
			const warning = `headed-browser: ${label} timed out after ${timeoutMs} ms; session ${session.id} closed`;
			if (!session.warnings.includes(warning)) session.warnings.push(warning);
			// Containment by session, not by id: this operation holds the session, so it owns the
			// one teardown or adopts the one already running, and the mark that comes with it
			// lands before the kills below.
			const cleanup = closeCapturedSession(session, `${label}-timeout`);
			session.remote?.tunnelProcess.kill();
			session.remote?.browserProcess.kill();
			session.browser.process()?.kill();
			void session.browser.disconnect().catch(() => undefined);
			void cleanup.catch((error: unknown) => {
				session.warnings.push(`headed-browser: timeout cleanup failed: ${errorMessage(error)}`);
			});
			throw new Error(warning);
		}
		return result.value;
	} finally {
		ctx.clearTimer(timer);
	}
}

export async function runNav(context: OperationContext, op: string, params: OperationParams): Promise<void> {
	validateNav(op, params);
	const { session, ctx, audit } = context;
	const timeout = params.timeoutMs ?? session.config.navigationTimeoutMs;
	const tabId = operationTabId(context);
	await withTabLock(session, ctx, tabId, context.tabHold, async (hold) => {
		if (isAborted(context.signal)) throw new CancelledError("headed-browser: cancelled before navigation started");
		// Also the deadlock guard for the nested acquisitions below: a turn that no longer holds
		// the selected tab is rejected here, before it can ask for a second tab's lock.
		const page = operationPage(context, tabId);
		if (op === "goto") {
			const url = requireString(params.url, "url");
			try {
				checkNavigation(url, deriveDomainPolicy(session.config));
				await audit?.write(session, "goto", "allow", url);
				await withPageTimeout(session, ctx, "goto", timeout, () => page.goto(url, { timeout, waitUntil: "domcontentloaded" }));
			} catch (error) {
				await audit?.write(session, "goto", "block", url, errorMessage(error));
				throw error;
			}
		} else if (op === "back") await withPageTimeout(session, ctx, "back", timeout, () => page.goBack({ timeout, waitUntil: "domcontentloaded" }));
		else if (op === "forward") await withPageTimeout(session, ctx, "forward", timeout, () => page.goForward({ timeout, waitUntil: "domcontentloaded" }));
		else if (op === "reload") await withPageTimeout(session, ctx, "reload", timeout, () => page.reload({ timeout, waitUntil: "domcontentloaded" }));
		else if (op === "wait") {
			if (params.selector) await withPageTimeout(session, ctx, "wait", timeout, () => page.waitForSelector(params.selector!, { timeout }));
			else {
				// Hoisted: narrowing on a mutable property does not survive into the closure.
				const needle = requireString(params.text, "text");
				await withPageTimeout(session, ctx, "wait", timeout, () => page.waitForFunction((text) => document.body?.innerText.includes(text), { timeout }, needle));
			}
		} else if (op === "viewport") {
			await withPageTimeout(session, ctx, "viewport", timeout, () =>
				page.setViewport({ width: params.width!, height: params.height!, deviceScaleFactor: params.deviceScaleFactor ?? 1 }));
		} else if (op === "newTab") {
			const created = await withPageTimeout(session, ctx, "newTab", timeout, () => session.browser.newPage());
			const createdTabId = await withPageTimeout(session, ctx, "newTab registration", timeout, () => registerPage(session, created));
			// A tab becomes reachable only once it is the selected one, so this hold is taken
			// before the selection is published and can never be contended. From the moment
			// another caller can resolve the new tab, this turn owns it: its policy and its first
			// navigation finish before any queued call touches it.
			await withTabLock(session, ctx, createdTabId, hold, async () => {
				session.selectedTabId = createdTabId;
				if (audit) await withPageTimeout(session, ctx, "newTab policy", timeout, () => applyPagePolicy(created, session, audit));
				if (params.url) {
					const url = checkNavigation(params.url, deriveDomainPolicy(session.config)).href;
					await withPageTimeout(session, ctx, "newTab navigation", timeout, () => created.goto(url, { timeout, waitUntil: "domcontentloaded" }));
				}
			}, context.signal);
		} else if (op === "selectTab") selectTab(session, params.tabId);
		else if (op === "closeTab") {
			const targetTabId = params.tabId ?? tabId;
			// The tab is held before it is selected and closed, so a call already working on it
			// finishes first and none starts on a page that is going away. Closing the tab this
			// turn already holds re-enters that hold instead of waiting for itself.
			await withTabLock(session, ctx, targetTabId, hold, async () => {
				const target = selectTab(session, targetTabId);
				await withPageTimeout(session, ctx, "closeTab", timeout, () => target.close());
				await syncPages(session);
			}, context.signal);
		}
	}, context.signal);
}

export async function runRead(
	context: OperationContext,
	op: string,
	params: OperationParams,
	options: { inlineBinary?: boolean } = {},
): Promise<unknown> {
	validateRead(op, params);
	const { session, ctx } = context;
	const tabId = operationTabId(context);
	const read = async (): Promise<unknown> => {
		if (isAborted(context.signal)) throw new CancelledError("headed-browser: cancelled before read started");
		const page = operationPage(context, tabId);
		const timeout = params.timeoutMs ?? session.config.navigationTimeoutMs;
		if (op === "snapshot") return withPageTimeout(session, ctx, "snapshot", timeout, () => domSnapshot(session, page, params.selector));
		if (op === "screenshot") {
			await mkdir(session.profile.artifactsDir, { recursive: true, mode: 0o700 });
			const path = join(session.profile.artifactsDir, `screenshot-${Date.now()}.png`);
			const data = await withPageTimeout(session, ctx, "screenshot", timeout, () => page.screenshot({ path, fullPage: params.fullPage, clip: params.clip, encoding: "binary" }));
			// A batched caller takes the artifact reference; inline bytes would dominate its result.
			return options.inlineBinary === false ? { path } : { path, base64: Buffer.from(data).toString("base64") };
		}
		if (op === "evaluate") {
			requireFeature(session.config, "Evaluate");
			const expression = requireString(params.expression, "expression");
			// Puppeteer evaluates a string argument as a page expression itself, so the
			// tool needs no `eval` of its own.
			const value = await withPageTimeout(session, ctx, "evaluate", timeout, () => page.evaluate(expression));
			return /document\.cookie/.test(expression) ? "<REDACTED>" : value;
		}
		if (op === "cookies") return visibleCookies(await withPageTimeout(session, ctx, "cookies", timeout, () => page.cookies()), session.config);
		if (op === "console") {
			return withPageTimeout(session, ctx, "console", timeout, () => page.evaluate(() => {
				if (!("__ompHeadedConsole" in globalThis)) return [];
				const entries = globalThis.__ompHeadedConsole;
				return Array.isArray(entries) ? entries : [];
			}));
		}
		if (op === "network") {
			const since = params.since ?? 0;
			const limit = params.limit ?? 100;
			return session.network.filter((entry) => entry.ts >= since).slice(-limit);
		}
		if (op === "metrics") return withPageTimeout(session, ctx, "metrics", timeout, () => readMetrics(page));
		if (op === "pdf") {
			const path = join(session.profile.artifactsDir, `page-${Date.now()}.pdf`);
			await withPageTimeout(session, ctx, "pdf", timeout, () => page.pdf({ path, printBackground: true }));
			return { path };
		}
		return withPageTimeout(session, ctx, "html", timeout, () => (params.selector ? page.$eval(params.selector, (element) => element.outerHTML) : page.content()));
	};
	return withTabLock(session, ctx, tabId, context.tabHold, read, context.signal);
}

export async function runAct(context: OperationContext, op: string, params: OperationParams): Promise<void> {
	validateAct(op, params);
	const { session, ctx, signal } = context;
	const timeout = params.timeoutMs ?? session.config.navigationTimeoutMs;
	const tabId = operationTabId(context);
	await withTabLock(session, ctx, tabId, context.tabHold, async () => {
		if (isAborted(signal)) throw new CancelledError("headed-browser: cancelled before action started");
		const page = operationPage(context, tabId);
		if (op === "press" || op === "scroll" || op === "dialog") {
			await withPageTimeout(session, ctx, `act ${op}`, timeout, async () => {
				if (op === "press") await page.keyboard.press(requireString(params.key, "key") as KeyInput);
				else if (op === "scroll") await page.mouse.wheel({ deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 });
				else await handleDialog(page, params.accept !== false, params.promptText, ctx, timeout);
			});
			return;
		}

		let element: ElementHandle<Element> | undefined;
		// Cursor animation is decorative and deliberately outside the action deadline.
		// Cursor driver calls and the actual action retain independent containment timers.
		const runCursorDriver = <T>(operation: () => Promise<T>) =>
			withPageTimeout(session, ctx, `act ${op} target`, timeout, operation);
		try {
			element = await pointCursorAtTarget(
				session.cursor,
				page,
				() => targetElement(session, page, params),
				signal,
				runCursorDriver,
			);
			if (isAborted(signal)) throw new CancelledError("headed-browser: cancelled after cursor visualization");
			const target = element;
			await withPageTimeout(session, ctx, `act ${op}`, timeout, async () => {
				if (op === "click") await target.click();
				else if (op === "hover") await target.hover();
				else if (op === "focus") await target.focus();
				else if (op === "clear") await target.evaluate((node) => { const input = node as HTMLInputElement; input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
				else if (op === "type") {
					const password = await target.evaluate((node) => node instanceof HTMLInputElement && node.type === "password");
					if (password) requireFeature(session.config, "PasswordEntry");
					await target.type(requireString(params.text, "text"));
				} else if (op === "select") {
					await target.select(...(params.values ?? (params.value ? [params.value] : [])));
				} else if (op === "upload") {
					requireFeature(session.config, "FileUpload");
					// `targetElement` yields `ElementHandle<Element>`; `uploadFile` is typed
					// for an input handle, and the element type is only knowable at runtime.
					await (target as ElementHandle<HTMLInputElement>).uploadFile(...params.files!);
				}
			});
		} finally {
			try {
				if (element !== undefined) {
					const held = element;
					await runCursorDriver(() => held.dispose().catch(() => undefined));
				}
			} finally {
				await clearCursor(session.cursor, page);
			}
		}
	}, signal);
}

async function domSnapshot(session: HeadedSession, page: Page, selector?: string): Promise<{ lines: string[] }> {
	const nodes = await page.evaluate((rootSelector) => {
		const root = rootSelector ? document.querySelector(rootSelector) : document;
		if (!root) throw new Error(`selector not found: ${rootSelector}`);
		const interesting = "a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,img,[role],[tabindex]";
		const cssPath = (element: Element): string => {
			const parts: string[] = [];
			let current: Element | null = element;
			while (current && current !== document.documentElement) {
				let part = current.tagName.toLowerCase();
				if (current.id) { part += `#${CSS.escape(current.id)}`; parts.unshift(part); break; }
				const parent: Element | null = current.parentElement;
				if (parent) {
					const siblings = [...parent.children].filter((child) => child.tagName === current?.tagName);
					if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
				}
				parts.unshift(part); current = parent;
			}
			return parts.join(" > ");
		};
		const role = (element: Element): string => {
			const explicit = element.getAttribute("role"); if (explicit) return explicit;
			const tag = element.tagName.toLowerCase(); const type = (element.getAttribute("type") ?? "").toLowerCase();
			if (tag === "a" && element.hasAttribute("href")) return "link";
			if (tag === "button" || (tag === "input" && ["button", "submit"].includes(type))) return "button";
			if (tag === "input" && type === "checkbox") return "checkbox";
			if (tag === "input" && type === "radio") return "radio";
			if (tag === "select") return "combobox";
			if (tag === "textarea" || tag === "input") return "textbox";
			if (/^h[1-6]$/.test(tag)) return "heading";
			if (tag === "img") return "image";
			return tag;
		};
		const name = (element: Element): string => {
			const labelledBy = element.getAttribute("aria-labelledby");
			const labelText = labelledBy?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
			const associated = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.labels?.[0]?.textContent?.trim() : "";
			return [element.getAttribute("aria-label"), labelText, associated, element.getAttribute("alt"), element.getAttribute("title"), element.getAttribute("placeholder"), element.textContent?.trim()].find(Boolean)?.slice(0, 120) ?? "";
		};
		return [...root.querySelectorAll(interesting)].filter((element) => {
			const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
			return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
		}).map((element) => ({ role: role(element), name: name(element), path: cssPath(element), attrs: { disabled: element.hasAttribute("disabled"), checked: element.getAttribute("aria-checked") ?? undefined, expanded: element.getAttribute("aria-expanded") ?? undefined } }));
	}, selector);
	const refs = new Map<string, string>();
	const lines = nodes.map((node, index) => {
		const ref = `e${index + 1}`; refs.set(ref, node.path);
		const attrs = Object.entries(node.attrs).filter(([, value]) => value !== false && value !== undefined).map(([key, value]) => `${key}=${value}`).join(" ");
		return `${ref} ${node.role} ${JSON.stringify(node.name)}${attrs ? ` [${attrs}]` : ""}`;
	});
	session.refs.set(session.selectedTabId, refs);
	return { lines };
}

async function targetElement(session: HeadedSession, page: Page, params: OperationParams): Promise<ElementHandle<Element>> {
	const selector = params.selector ?? (params.ref ? session.refs.get(session.selectedTabId)?.get(params.ref) : undefined);
	if (!selector) throw new InvalidRequestError("headed-browser: selector or valid ref is required");
	const element = await page.$(selector);
	if (!element) throw new Error(`headed-browser: no element matches ${selector}`);
	return element;
}

async function readMetrics(page: Page): Promise<Record<string, unknown>> {
	return page.evaluate(() => {
		const navigation = performance.getEntriesByType("navigation")[0]?.toJSON() ?? "unsupported";
		const paint = performance.getEntriesByType("paint").map((entry) => entry.toJSON());
		const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
		const summary: Record<string, { count: number; transferSize: number; duration: number }> = {};
		for (const resource of resources) {
			const key = resource.initiatorType || "other";
			const bucket = summary[key] ?? { count: 0, transferSize: 0, duration: 0 };
			summary[key] = bucket;
			bucket.count += 1; bucket.transferSize += resource.transferSize; bucket.duration += resource.duration;
		}
		const supported = PerformanceObserver.supportedEntryTypes ?? [];
		return { navigation, paint: paint.length > 0 ? paint : "unsupported", resources: summary, layoutShift: supported.includes("layout-shift") ? performance.getEntriesByType("layout-shift").map((entry) => entry.toJSON()) : "unsupported", largestContentfulPaint: supported.includes("largest-contentful-paint") ? performance.getEntriesByType("largest-contentful-paint").map((entry) => entry.toJSON()) : "unsupported", pageMetrics: "unsupported", coverage: "unsupported", tracing: "unsupported" };
	});
}

async function handleDialog(page: Page, accept: boolean, promptText: string | undefined, ctx: ExtensionContext, timeoutMs: number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onDialog = async (dialog: Dialog): Promise<void> => {
		try { if (accept) await dialog.accept(promptText); else await dialog.dismiss(); resolve(); }
		catch (error) { reject(error); }
	};
	const timer = ctx.setTimeout(() => {
		page.off("dialog", onDialog);
		reject(new Error("headed-browser: no dialog appeared before timeout"));
	}, timeoutMs);
	page.once("dialog", onDialog);
	try { await promise; }
	finally { page.off("dialog", onDialog); ctx.clearTimer(timer); }
}
