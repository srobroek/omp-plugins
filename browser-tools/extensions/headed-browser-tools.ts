import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Cookie, Dialog, ElementHandle, KeyInput, Page } from "puppeteer-core";
import type { Channel, ConfigOverrides, EffectiveConfig, Engine, ProfileMode } from "./lib/config.ts";
import { CHANNELS, COPY_STRATEGIES, ENGINES, PROFILE_MODES, resolveConfig, splitDomains } from "./lib/config.ts";
import type { ResolvedBrowser } from "./lib/discovery.ts";
import { assertChannelEngine, resolveBrowser, resolveSourceProfile } from "./lib/discovery.ts";
import { launchLocal, launchRemote } from "./lib/driver.ts";
import type { AuditWriter } from "./lib/policy.ts";
import { applyPagePolicy, checkNavigation, createAuditWriter, deriveDomainPolicy, redact, requireFeature, visibleCookies } from "./lib/policy.ts";
import { runPreflight } from "./lib/preflight.ts";
import { grantCookiesFromSource, materializeProfile, removeMaterializedProfile } from "./lib/profile.ts";
import type { HeadedSession, SessionSummary } from "./lib/session.ts";
import { closeAllSessions, closeSession, createSession, getSession, installIdleSweep, listArtifacts, registerPage, selectedPage, selectTab, sessionSummary, sessions, syncPages } from "./lib/session.ts";

declare global {
	/** Buffer injected into the page by the console policy; absent until then. */
	var __ompHeadedConsole: unknown[] | undefined;
}

interface ToolParams extends ConfigOverrides {
	op: string;
	sessionId?: string;
	domains?: string;
	remoteHost?: string;
	remoteBrowserPath?: string;
	sshOptions?: string;
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

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export default function headedBrowserTools(pi: ExtensionAPI): void {
	const z = pi.zod;
	const audits = new Map<string, AuditWriter>();
	const baseOverrides = {
		engine: z.enum(ENGINES).optional(),
		browserChannel: z.enum(CHANNELS).optional(),
		headless: z.boolean().optional(),
		executablePath: z.string().optional(),
		profileMode: z.enum(PROFILE_MODES).optional(),
		sourceProfileName: z.string().optional(),
		profileRootOverride: z.string().optional(),
		ephemeralRoot: z.string().optional(),
		copyStrategy: z.enum(COPY_STRATEGIES).optional(),
		cookieDomains: z.string().optional(),
		copyFirefoxLogins: z.boolean().optional(),
		noRemote: z.boolean().optional(),
		allowedDomains: z.string().optional(),
		deniedDomains: z.string().optional(),
		allowDownloads: z.boolean().optional(),
		allowFormSubmit: z.boolean().optional(),
		allowPasswordEntry: z.boolean().optional(),
		allowFileUpload: z.boolean().optional(),
		allowEvaluate: z.boolean().optional(),
		exposeCookieValues: z.boolean().optional(),
		redactSecrets: z.boolean().optional(),
		auditDir: z.string().optional(),
		keepArtifactsOnClose: z.boolean().optional(),
		idleCloseSec: z.number().optional(),
		navigationTimeoutMs: z.number().optional(),
		driverModulePath: z.string().optional(),
	};

	pi.registerTool({
		name: "headed_session",
		label: "Manage headed browser session",
		description: "Preflight, launch, inspect, grant scoped cookies to, and close long-lived headed BiDi sessions. Session data is ephemeral and disappears on close unless keepArtifactsOnClose is enabled.",
		parameters: z.object({
			op: z.enum(["preflight", "status", "launch", "close", "tabs", "artifacts", "grantCookies"]),
			sessionId: z.string().optional(), domains: z.string().optional(), remoteHost: z.string().optional(),
			remoteBrowserPath: z.string().optional(), sshOptions: z.string().optional(), ...baseOverrides,
		}),
		approval: "exec",
		execute: async (_id, params: ToolParams, _signal, _onUpdate, ctx) => safeResult(params, async () => {
			const cwd = ctx?.cwd ?? process.cwd();
			if (params.op === "preflight") {
				if (!ctx) throw new Error("headed-browser: extension context unavailable");
				const result = await runPreflight(cwd, ctx, params);
				return resultEnvelope(result, { warnings: result.warnings });
			}
			if (params.op === "status") {
				const summaries = [...sessions.values()].map(sessionSummary);
				return resultEnvelope({ sessions: summaries }, { warnings: [] });
			}
			if (params.op === "launch") {
				if (!ctx) throw new Error("headed-browser: extension context unavailable");
				const session = await launchSession(cwd, ctx, params);
				const audit = createAuditWriter(ctx, session.config);
				audits.set(session.id, audit);
				for (const page of session.pages.values()) await applyPagePolicy(page, session, audit);
				await audit.write(session, "launch", "allow", selectedPage(session).url());
				return resultEnvelope({ launched: true, auditFile: audit.path }, sessionSummary(session));
			}
			const session = getSession(params.sessionId);
			const audit = audits.get(session.id) ?? (ctx ? createAuditWriter(ctx, session.config) : undefined);
			if (params.op === "close") {
				await audit?.write(session, "close", "allow", selectedPage(session).url());
				audits.delete(session.id);
				const closed = await closeSession(session.id);
				return resultEnvelope(closed, { ...sessionSummary(session), url: "" });
			}
			if (params.op === "tabs") {
				await syncPages(session);
				const tabs = [...session.pages].map(([tabId, page]) => ({ tabId, selected: tabId === session.selectedTabId, url: page.url() }));
				return resultEnvelope({ tabs }, sessionSummary(session));
			}
			if (params.op === "artifacts") return resultEnvelope({ files: await listArtifacts(session) }, sessionSummary(session));
			if (params.op === "grantCookies") {
				if (!session.sourceProfile) throw new Error("headed-browser: grantCookies requires a cloned source profile");
				const domains = splitDomains(requireString(params.domains, "domains"));
				const granted = await grantCookiesFromSource(selectedPage(session), session.sourceProfile, domains);
				for (const domain of domains) if (!session.profile.cookieDomains.includes(domain)) session.profile.cookieDomains.push(domain);
				session.warnings.push(...granted.warnings);
				await audit?.write(session, "grantCookies", "allow", selectedPage(session).url(), `${granted.injected} injected`);
				return resultEnvelope(granted, sessionSummary(session));
			}
			throw new Error(`headed-browser: unsupported headed_session op ${params.op}`);
		}),
	});

	pi.registerTool({
		name: "headed_nav",
		label: "Navigate headed browser",
		description: "Navigate, wait, resize, and manage tabs in a headed BiDi session. Session data is ephemeral and disappears on close.",
		parameters: z.object({
			op: z.enum(["goto", "back", "forward", "reload", "wait", "viewport", "newTab", "selectTab", "closeTab"]),
			sessionId: z.string().optional(), url: z.string().optional(), text: z.string().optional(), selector: z.string().optional(),
			timeoutMs: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
			deviceScaleFactor: z.number().optional(), tabId: z.string().optional(),
		}),
		approval: "write",
		execute: async (_id, params: ToolParams, _signal, _onUpdate, ctx) => safeResult(params, async () => {
			if (!ctx) throw new Error("headed-browser: extension context unavailable");
			const session = getSession(params.sessionId);
			const audit = audits.get(session.id) ?? createAuditWriter(ctx, session.config);
			let page = selectedPage(session);
			const timeout = params.timeoutMs ?? session.config.navigationTimeoutMs;
			if (params.op === "goto") {
				const url = requireString(params.url, "url");
				try {
					checkNavigation(url, deriveDomainPolicy(session.config));
					await audit.write(session, "goto", "allow", url);
					await withPageTimeout(session, ctx, "goto", timeout, () => page.goto(url, { timeout, waitUntil: "domcontentloaded" }));
				} catch (error) {
					await audit.write(session, "goto", "block", url, error instanceof Error ? error.message : String(error));
					throw error;
				}
			} else if (params.op === "back") await withPageTimeout(session, ctx, "back", timeout, () => page.goBack({ timeout, waitUntil: "domcontentloaded" }));
			else if (params.op === "forward") await withPageTimeout(session, ctx, "forward", timeout, () => page.goForward({ timeout, waitUntil: "domcontentloaded" }));
			else if (params.op === "reload") await withPageTimeout(session, ctx, "reload", timeout, () => page.reload({ timeout, waitUntil: "domcontentloaded" }));
			else if (params.op === "wait") {
				if (params.selector) await withPageTimeout(session, ctx, "wait", timeout, () => page.waitForSelector(params.selector!, { timeout }));
				else if (params.text) {
					// Hoisted: narrowing on a mutable property does not survive into the closure.
					const needle = params.text;
					await withPageTimeout(session, ctx, "wait", timeout, () => page.waitForFunction((text) => document.body?.innerText.includes(text), { timeout }, needle));
				} else throw new Error("headed-browser: selector or text is required for wait");
			} else if (params.op === "viewport") {
				if (!params.width || !params.height) throw new Error("headed-browser: width and height are required for viewport");
				await page.setViewport({ width: params.width, height: params.height, deviceScaleFactor: params.deviceScaleFactor ?? 1 });
			} else if (params.op === "newTab") {
				page = await withPageTimeout(session, ctx, "newTab", timeout, () => session.browser.newPage());
				const tabId = await registerPage(session, page);
				session.selectedTabId = tabId;
				await applyPagePolicy(page, session, audit);
				if (params.url) {
					const url = checkNavigation(params.url, deriveDomainPolicy(session.config)).href;
					await withPageTimeout(session, ctx, "newTab navigation", timeout, () => page.goto(url, { timeout, waitUntil: "domcontentloaded" }));
				}
			} else if (params.op === "selectTab") page = selectTab(session, params.tabId);
			else if (params.op === "closeTab") {
				page = params.tabId ? selectTab(session, params.tabId) : page;
				await withPageTimeout(session, ctx, "closeTab", timeout, () => page.close());
				await syncPages(session);
			}
			return resultEnvelope({ op: params.op }, sessionSummary(session));
		}),
	});

	pi.registerTool({
		name: "headed_read",
		label: "Read headed browser",
		description: "Read DOM snapshots, screenshots, metadata-only network logs, metrics, cookies, HTML, and PDF artifacts from a headed BiDi session. BiDi has no accessibility tree, coverage, tracing, or response bodies; use the design accessibility scanner for WCAG and chrome-devtools MCP for Chromium traces. Session artifacts disappear on close.",
		parameters: z.object({
			op: z.enum(["snapshot", "screenshot", "evaluate", "cookies", "console", "network", "metrics", "pdf", "html"]),
			sessionId: z.string().optional(), selector: z.string().optional(), expression: z.string().optional(),
			fullPage: z.boolean().optional(), clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
			limit: z.number().optional(), since: z.number().optional(), timeoutMs: z.number().optional(),
		}),
		approval: "read",
		execute: async (_id, params: ToolParams, _signal, _onUpdate, ctx) => safeResult(params, async () => {
			if (!ctx) throw new Error("headed-browser: extension context unavailable");
			const session = getSession(params.sessionId);
			const page = selectedPage(session);
			const timeout = params.timeoutMs ?? session.config.navigationTimeoutMs;
			let payload: unknown;
			if (params.op === "snapshot") payload = await withPageTimeout(session, ctx, "snapshot", timeout, () => domSnapshot(session, page, params.selector));
			else if (params.op === "screenshot") {
				await mkdir(session.profile.artifactsDir, { recursive: true, mode: 0o700 });
				const path = join(session.profile.artifactsDir, `screenshot-${Date.now()}.png`);
				const data = await withPageTimeout(session, ctx, "screenshot", timeout, () => page.screenshot({ path, fullPage: params.fullPage, clip: params.clip, encoding: "binary" }));
				payload = { path, base64: Buffer.from(data).toString("base64") };
			} else if (params.op === "evaluate") {
				requireFeature(session.config, "Evaluate");
				const expression = requireString(params.expression, "expression");
				// Puppeteer evaluates a string argument as a page expression itself, so the
				// tool needs no `eval` of its own.
				const value = await withPageTimeout(session, ctx, "evaluate", timeout, () => page.evaluate(expression));
				payload = /document\.cookie/.test(expression) ? "<REDACTED>" : value;
			} else if (params.op === "cookies") payload = visibleCookies(await withPageTimeout(session, ctx, "cookies", timeout, () => page.cookies()), session.config);
			else if (params.op === "console") {
				payload = await withPageTimeout(session, ctx, "console", timeout, () => page.evaluate(() => {
					if (!("__ompHeadedConsole" in globalThis)) return [];
					const entries = globalThis.__ompHeadedConsole;
					return Array.isArray(entries) ? entries : [];
				}));
			} else if (params.op === "network") {
				const since = params.since ?? 0; const limit = params.limit ?? 100;
				payload = session.network.filter((entry) => entry.ts >= since).slice(-limit);
			} else if (params.op === "metrics") payload = await withPageTimeout(session, ctx, "metrics", timeout, () => readMetrics(page));
			else if (params.op === "pdf") {
				const path = join(session.profile.artifactsDir, `page-${Date.now()}.pdf`);
				await withPageTimeout(session, ctx, "pdf", timeout, () => page.pdf({ path, printBackground: true })); payload = { path };
			} else if (params.op === "html") {
				payload = await withPageTimeout(session, ctx, "html", timeout, () => params.selector ? page.$eval(params.selector, (element) => element.outerHTML) : page.content());
			} else throw new Error(`headed-browser: unsupported headed_read op ${params.op}`);
			return resultEnvelope(payload, sessionSummary(session));
		}),
	});

	pi.registerTool({
		name: "headed_act",
		label: "Act in headed browser",
		description: "Click, type, press, scroll, select, upload, handle dialogs, clear, hover, or focus in a headed BiDi session. Drag is unavailable over BiDi. Session data is ephemeral and disappears on close.",
		parameters: z.object({
			op: z.enum(["click", "type", "press", "scroll", "select", "upload", "dialog", "clear", "hover", "focus"]),
			sessionId: z.string().optional(), ref: z.string().optional(), selector: z.string().optional(), text: z.string().optional(),
			key: z.string().optional(), value: z.string().optional(), values: z.array(z.string()).optional(), files: z.array(z.string()).optional(),
			deltaX: z.number().optional(), deltaY: z.number().optional(), accept: z.boolean().optional(), promptText: z.string().optional(), timeoutMs: z.number().optional(),
		}),
		approval: "write",
		execute: async (_id, params: ToolParams, _signal, _onUpdate, ctx) => safeResult(params, async () => {
			if (!ctx) throw new Error("headed-browser: extension context unavailable");
			const session = getSession(params.sessionId);
			const page = selectedPage(session);
			const timeout = params.timeoutMs ?? session.config.navigationTimeoutMs;
			await withPageTimeout(session, ctx, `act ${params.op}`, timeout, async () => {
				if (params.op === "press") await page.keyboard.press(requireString(params.key, "key") as KeyInput);
				else if (params.op === "scroll") await page.mouse.wheel({ deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 });
				else if (params.op === "dialog") await handleDialog(page, params.accept !== false, params.promptText, ctx, timeout);
				else {
					const element = await targetElement(session, page, params);
					if (params.op === "click") await element.click();
					else if (params.op === "hover") await element.hover();
					else if (params.op === "focus") await element.focus();
					else if (params.op === "clear") await element.evaluate((node) => { const input = node as HTMLInputElement; input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
					else if (params.op === "type") {
						const password = await element.evaluate((node) => node instanceof HTMLInputElement && node.type === "password");
						if (password) requireFeature(session.config, "PasswordEntry");
						await element.type(requireString(params.text, "text"));
					} else if (params.op === "select") {
						const values = params.values ?? (params.value ? [params.value] : []);
						if (values.length === 0) throw new Error("headed-browser: value or values is required for select");
						await element.select(...values);
					} else if (params.op === "upload") {
						requireFeature(session.config, "FileUpload");
						if (!params.files?.length) throw new Error("headed-browser: files is required for upload");
						// `targetElement` yields `ElementHandle<Element>`; `uploadFile` is typed
						// for an input handle, and the element type is only knowable at runtime.
						await (element as ElementHandle<HTMLInputElement>).uploadFile(...params.files);
					} else throw new Error(`headed-browser: unsupported headed_act op ${params.op}`);
				}
			});
			return resultEnvelope({ op: params.op }, sessionSummary(session));
		}),
	});

	pi.on("session_start", (_event, ctx) => {
		installIdleSweep(ctx, async (session) => {
			const audit = audits.get(session.id) ?? createAuditWriter(ctx, session.config);
			await audit.write(session, "idle-close", "allow", selectedPage(session).url(), "idle timeout");
			audits.delete(session.id);
		});
	});
	pi.on("session_shutdown", async () => {
		audits.clear();
		await closeAllSessions();
	});
}

async function launchSession(cwd: string, ctx: ExtensionContext, params: ToolParams): Promise<HeadedSession> {
	const config = await resolveConfig(cwd, params);
	deriveDomainPolicy(config);
	assertChannelEngine(config.engine, config.browserChannel);
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	let resolvedBrowser: ResolvedBrowser;
	let sourceProfile: string | undefined;
	let profileMode = config.profileMode;
	if (params.remoteHost) {
		if (config.engine !== "firefox") throw new Error("headed-browser: remote mode currently supports only the Firefox engine");
		const channel = config.browserChannel === "auto" ? "firefox" : config.browserChannel;
		if (channel === "custom" && !params.remoteBrowserPath) throw new Error("headed-browser: remoteBrowserPath is required for remote launch");
		resolvedBrowser = { engine: "firefox", channel, path: requireString(params.remoteBrowserPath, "remoteBrowserPath"), probedPaths: [] };
		profileMode = "clean";
	} else {
		resolvedBrowser = resolveBrowser(config.engine, config.browserChannel, config.executablePath);
		if (resolvedBrowser.channel !== "custom") {
			const profile = resolveSourceProfile(config.engine, resolvedBrowser.channel, config.sourceProfileName, config.profileRootOverride);
			config.warnings.push(...profile.warnings);
			if (profile.cleanFallback) profileMode = "clean";
			else sourceProfile = profile.profilePath;
		}
	}
	const materialized = await materializeProfile({ engine: config.engine, channel: resolvedBrowser.channel, profileMode, sourceProfile, agentDir, config });
	try {
		if (params.remoteHost) {
			const remote = await launchRemote({ remoteHost: params.remoteHost, remoteBrowserPath: requireString(params.remoteBrowserPath, "remoteBrowserPath"), sshOptions: params.sshOptions, allowDownloads: config.allowDownloads, navigationTimeoutMs: config.navigationTimeoutMs }, config);
			return createSession({ browser: remote.browser, resolvedBrowser, profileMode, profile: materialized, config, remote });
		}
		const browser = await launchLocal({ engine: config.engine, executablePath: resolvedBrowser.path, profileDir: materialized.profileDir, downloadsDir: materialized.downloadsDir, config });
		return createSession({ browser, resolvedBrowser, profileMode, profile: materialized, sourceProfile, config });
	} catch (error) {
		await removeMaterializedProfile(materialized, false);
		throw error;
	}
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

async function targetElement(session: HeadedSession, page: Page, params: ToolParams): Promise<ElementHandle<Element>> {
	const selector = params.selector ?? (params.ref ? session.refs.get(session.selectedTabId)?.get(params.ref) : undefined);
	if (!selector) throw new Error("headed-browser: selector or valid ref is required");
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
				session.warnings.push(`headed-browser: timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			throw new Error(warning);
		}
		return result.value;
	} finally {
		ctx.clearTimer(timer);
	}
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

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`headed-browser: ${name} is required`);
	return value;
}

function resultEnvelope(payload: unknown, details: SessionSummary | Record<string, unknown>): ToolResult {
	// Spread into a fresh literal: an `interface` never gains the implicit index
	// signature that `Record<string, unknown>` needs, but an object literal does.
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: { ...details } };
}

async function safeResult(params: ToolParams, operation: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		const result = await operation();
		const session = params.sessionId ? sessions.get(params.sessionId) : undefined;
		const config = session?.config;
		if (config) result.content[0]!.text = redact(result.content[0]!.text, config);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const session = params.sessionId ? sessions.get(params.sessionId) : undefined;
		return { content: [{ type: "text", text: redact(message, session?.config ?? { redactSecrets: true }) }], details: { ok: false, error: message, sessionId: params.sessionId } };
	}
}
