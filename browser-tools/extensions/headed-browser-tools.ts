import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Channel, ConfigOverrides, EffectiveConfig, Engine, ProfileMode } from "./lib/config.ts";
import { CHANNELS, COPY_STRATEGIES, CURSOR_MODES, ENGINES, PROFILE_MODES, resolveConfig, splitDomains } from "./lib/config.ts";
import type { ResolvedBrowser } from "./lib/discovery.ts";
import { assertChannelEngine, resolveBrowser, resolveSourceProfile } from "./lib/discovery.ts";
import { launchLocal, launchRemote } from "./lib/driver.ts";
import type { OperationParams } from "./lib/operations.ts";
import { ACT_OPS, classifyError, NAV_OPS, READ_OPS, requireString, runAct, runNav, runRead } from "./lib/operations.ts";
import { PLAN_KINDS, PLAN_STEP_LIMIT, runPlan, validatePlan } from "./lib/plan.ts";
import type { AuditWriter } from "./lib/policy.ts";
import { applyPagePolicy, createAuditWriter, deriveDomainPolicy, redact } from "./lib/policy.ts";
import { runPreflight } from "./lib/preflight.ts";
import { grantCookiesFromSource, materializeProfile, removeMaterializedProfile } from "./lib/profile.ts";
import type { HeadedSession, SessionSummary } from "./lib/session.ts";
import { closeAllSessions, closeSession, createSession, getSession, installIdleSweep, listArtifacts, listLeakedSessions, registerPage, selectedPage, selectTab, sessionSummary, sessions, syncPages } from "./lib/session.ts";

interface ToolParams extends ConfigOverrides, OperationParams {
	/** Absent only on `headed_plan`, whose steps each carry their own operation. */
	op?: string;
	sessionId?: string;
	domains?: string;
	remoteHost?: string;
	remoteBrowserPath?: string;
	sshOptions?: string;
	steps?: unknown;
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
		cursorMode: z.enum(CURSOR_MODES).optional(),
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
				const leakedSessions = await listLeakedSessions();
				return resultEnvelope({ sessions: summaries, leakedSessions }, { warnings: leakedSessions.length > 0 ? ["headed-browser: previous session teardown is still pending or leaked; inspect leakedSessions before reusing those profiles."] : [] });
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
			op: z.enum(NAV_OPS),
			sessionId: z.string().optional(), url: z.string().optional(), text: z.string().optional(), selector: z.string().optional(),
			timeoutMs: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
			deviceScaleFactor: z.number().optional(), tabId: z.string().optional(),
		}),
		approval: "write",
		execute: async (_id, params: ToolParams, _signal, _onUpdate, ctx) => safeResult(params, async () => {
			if (!ctx) throw new Error("headed-browser: extension context unavailable");
			const session = getSession(params.sessionId);
			const audit = audits.get(session.id) ?? createAuditWriter(ctx, session.config);
			await runNav({ session, ctx, audit }, requireString(params.op, "op"), params);
			return resultEnvelope({ op: params.op }, sessionSummary(session));
		}),
	});

	pi.registerTool({
		name: "headed_read",
		label: "Read headed browser",
		description: "Read DOM snapshots, screenshots, metadata-only network logs, metrics, cookies, HTML, and PDF artifacts from a Firefox-family BiDi session. BiDi has no accessibility tree, coverage, tracing, or response bodies; use the design accessibility scanner for WCAG and the built-in browser tool for Chromium diagnostics. Session artifacts disappear on close.",
		parameters: z.object({
			op: z.enum(READ_OPS),
			sessionId: z.string().optional(), selector: z.string().optional(), expression: z.string().optional(),
			fullPage: z.boolean().optional(), clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
			limit: z.number().optional(), since: z.number().optional(), timeoutMs: z.number().optional(),
		}),
		approval: "read",
		execute: async (_id, params: ToolParams, _signal, _onUpdate, ctx) => safeResult(params, async () => {
			if (!ctx) throw new Error("headed-browser: extension context unavailable");
			const session = getSession(params.sessionId);
			const payload = await runRead({ session, ctx }, requireString(params.op, "op"), params);
			return resultEnvelope(payload, sessionSummary(session));
		}),
	});

	pi.registerTool({
		name: "headed_act",
		label: "Act in headed browser",
		description: "Click, type, press, scroll, select, upload, handle dialogs, clear, hover, or focus in a headed BiDi session. Drag is unavailable over BiDi. Session data is ephemeral and disappears on close.",
		parameters: z.object({
			op: z.enum(ACT_OPS),
			sessionId: z.string().optional(), ref: z.string().optional(), selector: z.string().optional(), text: z.string().optional(),
			key: z.string().optional(), value: z.string().optional(), values: z.array(z.string()).optional(), files: z.array(z.string()).optional(),
			deltaX: z.number().optional(), deltaY: z.number().optional(), accept: z.boolean().optional(), promptText: z.string().optional(), timeoutMs: z.number().optional(),
		}),
		approval: "write",
		execute: async (_id, params: ToolParams, signal, _onUpdate, ctx) => safeResult(params, async () => {
			if (!ctx) throw new Error("headed-browser: extension context unavailable");
			const session = getSession(params.sessionId);
			await runAct({ session, ctx, signal }, requireString(params.op, "op"), params);
			return resultEnvelope({ op: params.op }, sessionSummary(session));
		}),
	});

	pi.registerTool({
		name: "headed_plan",
		label: "Run a headed browser plan",
		description: `Run up to ${PLAN_STEP_LIMIT} ordered navigate, read, and act steps against one existing session and the tab it already has selected, in one call. The whole plan is validated before the first step runs; the first failing step or a cancellation ends the plan and no later step runs. Tab creation, tab switching, page evaluation, and session lifecycle stay in headed_nav, headed_read, and headed_session.`,
		parameters: z.object({
			sessionId: z.string().optional(),
			steps: z.array(z.object({
				kind: z.enum(PLAN_KINDS), op: z.string(), url: z.string().optional(), text: z.string().optional(),
				selector: z.string().optional(), ref: z.string().optional(), key: z.string().optional(), value: z.string().optional(),
				values: z.array(z.string()).optional(), files: z.array(z.string()).optional(), timeoutMs: z.number().optional(),
				width: z.number().optional(), height: z.number().optional(), deviceScaleFactor: z.number().optional(),
				fullPage: z.boolean().optional(), clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
				limit: z.number().optional(), since: z.number().optional(), deltaX: z.number().optional(), deltaY: z.number().optional(),
				accept: z.boolean().optional(), promptText: z.string().optional(),
			}).passthrough()),
		}),
		approval: "write",
		execute: async (_id, params: ToolParams, signal, _onUpdate, ctx) => safeResult(params, async () => {
			if (!ctx) throw new Error("headed-browser: extension context unavailable");
			// Validated before the session is resolved, so a rejected plan performs no operation.
			const steps = validatePlan(params.steps);
			const session = getSession(params.sessionId);
			const audit = audits.get(session.id) ?? createAuditWriter(ctx, session.config);
			const outcome = await runPlan({ session, ctx, steps, audit, signal });
			const failure = outcome.error === undefined ? {} : { ok: false, error: outcome.error, failedIndex: outcome.failedIndex };
			return resultEnvelope(outcome, { ...sessionSummary(session), ...failure });
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
		const report = await closeAllSessions();
		if (report.leaked.length > 0) console.error(`headed-browser: ${report.leaked.length} session teardown(s) exceeded the shutdown budget; inspect headed_session status for leakedSessions`);
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
		console.error(`headed-browser: ${message}`);
		return {
			content: [{ type: "text", text: redact(message, session?.config ?? { redactSecrets: true }) }],
			details: { ok: false, sessionId: params.sessionId, error: classifyError(params.op ?? "", error) },
		};
	}
}
