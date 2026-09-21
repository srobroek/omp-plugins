import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Dialog, ElementHandle, KeyInput, Page } from "puppeteer-core";
import { errorMessage } from "./config.ts";
import { clearCursor, pointCursorAtTarget } from "./cursor.ts";
import type { AuditWriter } from "./policy.ts";
import { applyPagePolicy, checkNavigation, deriveDomainPolicy, requireFeature, visibleCookies } from "./policy.ts";
import type { HeadedSession } from "./session.ts";
import { closeSession, registerPage, selectedPage, selectTab, syncPages } from "./session.ts";

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
}

/** A caller-fixable input; classified as `invalid request` however deep it is thrown. */
export class InvalidRequestError extends Error {}

/** Another caller held the tab longer than the acquisition bound; nothing was done. */
export class TabBusyError extends Error {}

/** The host cancelled before the operation started. */
export class CancelledError extends Error {}

/** The tab a caller pinned is no longer the session's selected tab. */
export class StaleTabError extends Error {}

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
	return typeof signal === "object" && signal !== null && "aborted" in signal && (signal as { aborted?: unknown }).aborted === true;
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
 * holds it, so two outer tool calls — a plan step and a standalone action included —
 * never interleave work on the same user-controlled tab.
 */
const tabLocks = new WeakMap<HeadedSession, Map<string, Promise<void>>>();

async function withTabLock<T>(session: HeadedSession, ctx: ExtensionContext, tabId: string, operation: () => Promise<T>): Promise<T> {
	const locks = tabLocks.get(session) ?? new Map<string, Promise<void>>();
	tabLocks.set(session, locks);
	const holder = locks.get(tabId);
	// Resolved only after this turn finishes, so the next waiter starts strictly later.
	const { promise: released, resolve: release } = Promise.withResolvers<void>();
	locks.set(tabId, released);
	if (holder) {
		const { promise: expired, resolve: expire } = Promise.withResolvers<"expired">();
		const timer = ctx.setTimeout(() => expire("expired"), TAB_LOCK_WAIT_MS);
		// Neither branch rejects: a holder chain only ever resolves, and the expiry is a timer.
		const outcome = await Promise.race([holder.then(() => "ready" as const), expired]);
		ctx.clearTimer(timer);
		if (outcome === "expired") {
			// This turn never runs, so waiters behind it adopt the holder's completion
			// instead of a turn that will never release.
			release(holder);
			throw new TabBusyError(`headed-browser: tab ${tabId} stayed busy for ${TAB_LOCK_WAIT_MS} ms and nothing was done`);
		}
	}
	try {
		return await operation();
	} finally {
		release();
		if (locks.get(tabId) === released) locks.delete(tabId);
	}
}

async function withPageTimeout<T>(
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
			const cleanup = closeSession(session.id, `${label}-timeout`);
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
	await withTabLock(session, ctx, tabId, async () => {
		if (isAborted(context.signal)) throw new CancelledError("headed-browser: cancelled before navigation started");
		let page = operationPage(context, tabId);
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
			await page.setViewport({ width: params.width!, height: params.height!, deviceScaleFactor: params.deviceScaleFactor ?? 1 });
		} else if (op === "newTab") {
			page = await withPageTimeout(session, ctx, "newTab", timeout, () => session.browser.newPage());
			const tabId = await registerPage(session, page);
			session.selectedTabId = tabId;
			if (audit) await applyPagePolicy(page, session, audit);
			if (params.url) {
				const url = checkNavigation(params.url, deriveDomainPolicy(session.config)).href;
				await withPageTimeout(session, ctx, "newTab navigation", timeout, () => page.goto(url, { timeout, waitUntil: "domcontentloaded" }));
			}
		} else if (op === "selectTab") selectTab(session, params.tabId);
		else if (op === "closeTab") {
			page = params.tabId ? selectTab(session, params.tabId) : page;
			await withPageTimeout(session, ctx, "closeTab", timeout, () => page.close());
			await syncPages(session);
		}
	});
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
	return withTabLock(session, ctx, tabId, read);
}

export async function runAct(context: OperationContext, op: string, params: OperationParams): Promise<void> {
	validateAct(op, params);
	const { session, ctx, signal } = context;
	const timeout = params.timeoutMs ?? session.config.navigationTimeoutMs;
	const tabId = operationTabId(context);
	await withTabLock(session, ctx, tabId, async () => {
		if (isAborted(signal)) throw new CancelledError("headed-browser: cancelled before action started");
		const page = operationPage(context, tabId);
		await withPageTimeout(session, ctx, `act ${op}`, timeout, async () => {
			if (op === "press") await page.keyboard.press(requireString(params.key, "key") as KeyInput);
			else if (op === "scroll") await page.mouse.wheel({ deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 });
			else if (op === "dialog") await handleDialog(page, params.accept !== false, params.promptText, ctx, timeout);
			else {
				try {
					// Target-bearing ops resolve through the driver, show the driver-resolved
					// target, and revalidate driver geometry before acting on it. The handle
					// handed back is owned here, so it is released once the action ends.
					const element = await pointCursorAtTarget(session.cursor, page, () => targetElement(session, page, params), signal);
					try {
						if (isAborted(signal)) throw new CancelledError("headed-browser: cancelled after cursor visualization");
						if (op === "click") await element.click();
						else if (op === "hover") await element.hover();
						else if (op === "focus") await element.focus();
						else if (op === "clear") await element.evaluate((node) => { const input = node as HTMLInputElement; input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
						else if (op === "type") {
							const password = await element.evaluate((node) => node instanceof HTMLInputElement && node.type === "password");
							if (password) requireFeature(session.config, "PasswordEntry");
							await element.type(requireString(params.text, "text"));
						} else if (op === "select") {
							await element.select(...(params.values ?? (params.value ? [params.value] : [])));
						} else if (op === "upload") {
							requireFeature(session.config, "FileUpload");
							// `targetElement` yields `ElementHandle<Element>`; `uploadFile` is typed
							// for an input handle, and the element type is only knowable at runtime.
							await (element as ElementHandle<HTMLInputElement>).uploadFile(...params.files!);
						}
					} finally {
						await element.dispose().catch(() => undefined);
					}
				} finally {
					await clearCursor(session.cursor, page);
				}
			}
		});
	});
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
