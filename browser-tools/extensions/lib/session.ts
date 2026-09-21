import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Browser, Page } from "puppeteer-core";
import type { EffectiveConfig, ProfileMode } from "./config.ts";
import type { ResolvedBrowser } from "./discovery.ts";
import type { RemoteResources } from "./driver.ts";
import { closeRemote } from "./driver.ts";
import type { MaterializedProfile } from "./profile.ts";
import { removeMaterializedProfile } from "./profile.ts";

/** Leave a margin below the 2s session_shutdown handler budget. */
export const SESSION_SHUTDOWN_BUDGET_MS = 1_000;
const LEAK_MANIFEST_NAME = "headed-browser-leaks.json";

export type LeakedSessionStatus = "pending" | "leaked";

export interface LeakedSession {
	sessionId: string;
	status: LeakedSessionStatus;
	reason: string;
	detectedAt: number;
	sessionDir: string;
	profileDir: string;
	remoteHost?: string;
	remoteProfileDir?: string;
}

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
	else {
		let closed = false;
		await Promise.race([
			session.browser.close().then(() => { closed = true; }).catch(() => undefined),
			Bun.sleep(5_000),
		]);
		if (!closed) session.browser.process()?.kill();
	}
	const deleted = await removeMaterializedProfile(session.profile, session.config.keepArtifactsOnClose);
	return { deleted, reason };
}

export interface CloseAllSessionsOptions {
	/** Test seam and a hook for callers that need to own teardown scheduling. */
	close?: (sessionId: string, reason: string) => Promise<unknown>;
	budgetMs?: number;
}

export interface CloseAllSessionsReport {
	started: number;
	completed: number;
	leaked: string[];
}

/**
 * Start complete teardown, but never make session_shutdown wait for browser or SSH
 * cleanup. A pending manifest entry survives an extension kill; status can report it
 * on the next session, and a detached teardown removes it when it eventually finishes.
 */
export async function closeAllSessions(
	reason = "session-shutdown",
	options: CloseAllSessionsOptions = {},
): Promise<CloseAllSessionsReport> {
	const snapshot = [...sessions.values()];
	if (snapshot.length === 0) return { started: 0, completed: 0, leaked: [] };
	const close = options.close ?? closeSession;
	const records = snapshot.map((session) => leakRecord(session, reason, "pending"));
	await updateLeakManifest((current) => [
		...current.filter((record) => !records.some((next) => next.sessionId === record.sessionId)),
		...records,
	]).catch((error) => console.error(`headed-browser: could not record session shutdown: ${String(error)}`));

	let timedOut = false;
	const settled = new Set<string>();
	const outcomes = new Map<string, { ok: boolean; error?: string }>();
	const tasks = snapshot.map((session) => (async () => {
		try {
			await close(session.id, reason);
			outcomes.set(session.id, { ok: true });
		} catch (error) {
			outcomes.set(session.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			settled.add(session.id);
		}
	})());
	const all = Promise.all(tasks);
	const completed = await Promise.race([
		all.then(() => true),
		Bun.sleep(options.budgetMs ?? SESSION_SHUTDOWN_BUDGET_MS).then(() => false),
	]);
	if (completed) {
		const leaked = snapshot.filter((session) => !outcomes.get(session.id)?.ok).map((session) => session.id);
		await updateLeakManifest((current) => current.flatMap((record) => {
			const session = snapshot.find((candidate) => candidate.id === record.sessionId);
			if (!session) return [record];
			const outcome = outcomes.get(record.sessionId);
			if (outcome?.ok) return [];
			return [{ ...record, status: "leaked" as const, reason: outcome?.error ?? reason }];
		}));
		return { started: snapshot.length, completed: snapshot.length - leaked.length, leaked };
	}

	timedOut = true;
	const leaked = snapshot.filter((session) => !settled.has(session.id) || !outcomes.get(session.id)?.ok).map((session) => session.id);
	await updateLeakManifest((current) => current.map((record) => {
		if (!snapshot.some((session) => session.id === record.sessionId)) return record;
		const outcome = outcomes.get(record.sessionId);
		if (outcome?.ok) return record;
		return { ...record, status: "leaked" as const, reason: outcome?.error ?? `${reason} exceeded ${options.budgetMs ?? SESSION_SHUTDOWN_BUDGET_MS} ms` };
	}));
	for (const [index, task] of tasks.entries()) {
		const session = snapshot[index];
		if (!session) continue;
		void task.then(() => {
			if (!timedOut) return;
			const outcome = outcomes.get(session.id);
			const update = outcome?.ok
				? (current: LeakedSession[]) => current.filter((record) => record.sessionId !== session.id)
				: (current: LeakedSession[]) => current.map((record) => record.sessionId === session.id
					? { ...record, status: "leaked" as const, reason: outcome?.error ?? reason }
					: record);
			void updateLeakManifest(update).catch((error) => console.error(`headed-browser: could not update leak record ${session.id}: ${String(error)}`));
		});
	}
	return { started: snapshot.length, completed: snapshot.length - leaked.length, leaked };
}

export function leakedSessionsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	return join(agentDir, LEAK_MANIFEST_NAME);
}

export async function listLeakedSessions(): Promise<LeakedSession[]> {
	await leakManifestQueue.catch(() => undefined);
	return readLeakManifest();
}

async function readLeakManifest(): Promise<LeakedSession[]> {
	try {
		const value: unknown = JSON.parse(await readFile(leakedSessionsPath(), "utf8"));
		if (!Array.isArray(value)) return [];
		return value.filter(isLeakedSession);
	} catch {
		return [];
	}
}

function leakRecord(session: HeadedSession, reason: string, status: LeakedSessionStatus): LeakedSession {
	return {
		sessionId: session.id,
		status,
		reason,
		detectedAt: Date.now(),
		sessionDir: session.profile.sessionDir,
		profileDir: session.profile.profileDir,
		...(session.remote ? { remoteHost: session.remote.remoteHost, remoteProfileDir: session.remote.remoteProfileDir } : {}),
	};
}

function isLeakedSession(value: unknown): value is LeakedSession {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<LeakedSession>;
	return typeof record.sessionId === "string" && (record.status === "pending" || record.status === "leaked")
		&& typeof record.reason === "string" && typeof record.detectedAt === "number"
		&& typeof record.sessionDir === "string" && typeof record.profileDir === "string";
}

let leakManifestQueue: Promise<void> = Promise.resolve();

function updateLeakManifest(mutator: (records: LeakedSession[]) => LeakedSession[]): Promise<void> {
	const update = leakManifestQueue.then(async () => {
		const current = await readLeakManifest();
		const next = mutator(current);
		const path = leakedSessionsPath();
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	});
	leakManifestQueue = update.catch(() => undefined);
	return update;
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
