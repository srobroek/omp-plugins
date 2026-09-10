import type { Browser, Page } from "puppeteer-core";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveConfig, ProfileMode } from "./config.ts";
import type { ResolvedBrowser } from "./discovery.ts";
import type { RemoteResources } from "./driver.ts";
import { closeRemote } from "./driver.ts";
import type { MaterializedProfile } from "./profile.ts";
import { removeMaterializedProfile } from "./profile.ts";

export interface ConsoleEntry {
	ts: number;
	level: string;
	args: unknown[];
}

export interface NetworkEntry {
	ts: number;
	method: string;
	url: string;
	status?: number;
	fromCache?: boolean;
	timingMs?: number;
	failure?: string;
}

export interface HeadedSession {
	id: string;
	browser: Browser;
	resolvedBrowser: ResolvedBrowser;
	profileMode: ProfileMode;
	profile: MaterializedProfile;
	sourceProfile?: string;
	config: EffectiveConfig;
	createdAt: number;
	lastActivityAt: number;
	pages: Map<string, Page>;
	pageIds: WeakMap<Page, string>;
	selectedTabId: string;
	refs: Map<string, Map<string, string>>;
	network: NetworkEntry[];
	remote?: RemoteResources;
	warnings: string[];
}

export interface SessionSummary {
	sessionId: string;
	engine: string;
	channel: string;
	profileMode: ProfileMode;
	profileDir: string;
	url: string;
	cookieDomains: string[];
	containerCookiesSkipped: number;
	warnings: string[];
	createdAt: number;
	lastActivityAt: number;
}

export const sessions = new Map<string, HeadedSession>();

export async function createSession(input: {
	browser: Browser;
	resolvedBrowser: ResolvedBrowser;
	profileMode: ProfileMode;
	profile: MaterializedProfile;
	sourceProfile?: string;
	config: EffectiveConfig;
	remote?: RemoteResources;
}): Promise<HeadedSession> {
	let id = "";
	do id = `hb-${randomBytes(3).toString("hex")}`; while (sessions.has(id));
	const session: HeadedSession = {
		id,
		browser: input.browser,
		resolvedBrowser: input.resolvedBrowser,
		profileMode: input.profileMode,
		profile: input.profile,
		sourceProfile: input.sourceProfile,
		config: input.config,
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		pages: new Map(),
		pageIds: new WeakMap(),
		selectedTabId: "",
		refs: new Map(),
		network: [],
		remote: input.remote,
		warnings: [...input.config.warnings, ...input.profile.warnings],
	};
	await syncPages(session);
	if (session.pages.size === 0) {
		const page = await session.browser.newPage();
		await registerPage(session, page);
	}
	session.selectedTabId = session.pages.keys().next().value ?? "";
	sessions.set(id, session);
	return session;
}

export function getSession(sessionId: string | undefined): HeadedSession {
	if (!sessionId) throw new Error("headed-browser: sessionId is required");
	const session = sessions.get(sessionId);
	if (!session) throw new Error(`headed-browser: unknown session ${sessionId}`);
	session.lastActivityAt = Date.now();
	return session;
}

export async function syncPages(session: HeadedSession): Promise<void> {
	const livePages = await session.browser.pages();
	const live = new Set(livePages);
	for (const [tabId, page] of session.pages) {
		if (!live.has(page)) {
			session.pages.delete(tabId);
			session.refs.delete(tabId);
		}
	}
	for (const page of livePages) if (!session.pageIds.has(page)) await registerPage(session, page);
	if (!session.pages.has(session.selectedTabId)) session.selectedTabId = session.pages.keys().next().value ?? "";
}

export async function registerPage(session: HeadedSession, page: Page): Promise<string> {
	let tabId = "";
	do tabId = `tab-${randomBytes(3).toString("hex")}`; while (session.pages.has(tabId));
	session.pages.set(tabId, page);
	session.pageIds.set(page, tabId);
	session.refs.set(tabId, new Map());
	const started = new WeakMap<object, number>();
	page.on("request", (request) => {
		started.set(request, Date.now());
		pushRing(session.network, { ts: Date.now(), method: request.method(), url: request.url() }, 1000);
	});
	page.on("response", (response) => {
		const request = response.request();
		pushRing(session.network, {
			ts: Date.now(), method: request.method(), url: response.url(), status: response.status(),
			fromCache: response.fromCache(), timingMs: Math.max(0, Date.now() - (started.get(request) ?? Date.now())),
		}, 1000);
	});
	page.on("requestfailed", (request) => {
		pushRing(session.network, {
			ts: Date.now(), method: request.method(), url: request.url(),
			failure: request.failure()?.errorText ?? "request failed",
			timingMs: Math.max(0, Date.now() - (started.get(request) ?? Date.now())),
		}, 1000);
	});
	await installConsoleCapture(page);
	return tabId;
}

export function selectedPage(session: HeadedSession): Page {
	const page = session.pages.get(session.selectedTabId);
	if (!page) throw new Error(`headed-browser: session ${session.id} has no selected tab`);
	return page;
}

export function selectTab(session: HeadedSession, tabId: string | undefined): Page {
	if (!tabId) throw new Error("headed-browser: tabId is required");
	const page = session.pages.get(tabId);
	if (!page) throw new Error(`headed-browser: unknown tab ${tabId}`);
	session.selectedTabId = tabId;
	return page;
}

export function sessionSummary(session: HeadedSession): SessionSummary {
	return {
		sessionId: session.id,
		engine: session.resolvedBrowser.engine,
		channel: session.resolvedBrowser.channel,
		profileMode: session.profileMode,
		profileDir: session.profile.profileDir,
		url: session.pages.get(session.selectedTabId)?.url() ?? "",
		cookieDomains: session.profile.cookieDomains,
		containerCookiesSkipped: session.profile.containerCookiesSkipped,
		warnings: session.warnings,
		createdAt: session.createdAt,
		lastActivityAt: session.lastActivityAt,
	};
}

export async function closeSession(sessionId: string, reason = "close"): Promise<{ deleted: string[]; reason: string }> {
	const session = getSession(sessionId);
	sessions.delete(sessionId);
	if (session.remote) await closeRemote(session.remote);
	else await session.browser.close().catch(() => undefined);
	const deleted = await removeMaterializedProfile(session.profile, session.config.keepArtifactsOnClose);
	return { deleted, reason };
}

export async function closeAllSessions(reason = "session-shutdown"): Promise<void> {
	await Promise.allSettled([...sessions.keys()].map((sessionId) => closeSession(sessionId, reason)));
}

export function installIdleSweep(
	ctx: ExtensionContext,
	onIdleClose?: (session: HeadedSession) => Promise<void>,
): void {
	ctx.setInterval(async () => {
		const now = Date.now();
		for (const session of [...sessions.values()]) {
			if (now - session.lastActivityAt <= session.config.idleCloseSec * 1000) continue;
			await onIdleClose?.(session);
			await closeSession(session.id, "idle-close");
		}
	}, 30_000);
}

export async function listArtifacts(session: HeadedSession): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
	const output: Array<{ path: string; size: number; mtimeMs: number }> = [];
	const pending = [session.profile.sessionDir];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) break;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) {
				const metadata = await stat(path);
				output.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
			}
		}
	}
	return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function installConsoleCapture(page: Page): Promise<void> {
	await page.evaluateOnNewDocument(`(() => {
		const ring = [];
		Object.defineProperty(window, "__ompHeadedConsole", { value: ring, configurable: false });
		const push = (level, args) => { ring.push({ ts: Date.now(), level, args: args.map(value => {
			try { return typeof value === "string" ? value : JSON.parse(JSON.stringify(value)); } catch { return String(value); }
		}) }); if (ring.length > 500) ring.splice(0, ring.length - 500); };
		for (const level of ["log", "info", "warn", "error", "debug"]) {
			const original = console[level].bind(console);
			console[level] = (...args) => { push(level, args); original(...args); };
		}
		window.addEventListener("error", event => push("error", [event.message]));
		window.addEventListener("unhandledrejection", event => push("error", [String(event.reason)]));
	})()`);
}

function pushRing<T>(ring: T[], value: T, limit: number): void {
	ring.push(value);
	if (ring.length > limit) ring.splice(0, ring.length - limit);
}
