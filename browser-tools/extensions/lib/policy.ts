import type { Cookie, Page } from "puppeteer-core";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EffectiveConfig, Engine, ProfileMode } from "./config.ts";
import { splitDomains } from "./config.ts";
import type { HeadedSession } from "./session.ts";

export type DomainMode = "allowlist" | "denylist" | "none";

export interface DomainPolicy {
	mode: DomainMode;
	allowed: string[];
	denied: string[];
}

export interface AuditRecord {
	ts: string;
	ompSessionId: string;
	sessionId: string;
	op: string;
	url?: string;
	decision: "allow" | "block";
	reason?: string;
	engine: Engine;
	channel: string;
	profileMode: ProfileMode;
	cookieDomains: string[];
}

export interface AuditWriter {
	path: string;
	write(session: HeadedSession, op: string, decision: "allow" | "block", url?: string, reason?: string): Promise<void>;
}

export function deriveDomainPolicy(config: Pick<EffectiveConfig, "allowedDomains" | "deniedDomains">): DomainPolicy {
	const allowed = splitDomains(config.allowedDomains);
	const denied = splitDomains(config.deniedDomains);
	if (allowed.length > 0 && denied.length > 0) {
		throw new Error("headed-browser: allowedDomains and deniedDomains are mutually exclusive; clear one");
	}
	return { mode: allowed.length > 0 ? "allowlist" : denied.length > 0 ? "denylist" : "none", allowed, denied };
}

export function checkNavigation(url: string, policy: DomainPolicy): URL {
	let parsed: URL;
	try { parsed = new URL(url); } catch { throw new Error(`headed-browser: invalid URL ${url}`); }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`headed-browser: scheme ${parsed.protocol.replace(/:$/, "")} is not navigable`);
	}
	const host = parsed.hostname.toLowerCase();
	if (policy.mode === "allowlist" && !policy.allowed.some((domain) => hostMatches(host, domain))) {
		throw new Error(`headed-browser: navigation to ${host} blocked by allowedDomains`);
	}
	if (policy.mode === "denylist" && policy.denied.some((domain) => hostMatches(host, domain))) {
		throw new Error(`headed-browser: navigation to ${host} blocked by deniedDomains`);
	}
	return parsed;
}

export function hostMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

export function requireFeature(config: EffectiveConfig, feature: "Downloads" | "FormSubmit" | "PasswordEntry" | "FileUpload" | "Evaluate"): void {
	const key = `allow${feature}` as keyof EffectiveConfig;
	if (config[key] !== true) throw new Error(`headed-browser: ${feature} is disabled; set ${key}=true to allow it`);
}

export function redact(text: string, config: Pick<EffectiveConfig, "redactSecrets">): string {
	if (!config.redactSecrets) return text;
	return text
		.replace(/\b(Cookie|Set-Cookie|Authorization|Proxy-Authorization|X-Api-Key)\s*:\s*[^\r\n]+/gi, "$1: <REDACTED>")
		.replace(/\b(document\.cookie\s*(?:=|:)?\s*)[^\r\n,;}]+/gi, "$1<REDACTED>")
		.replace(/(type=["']?password["']?[^>]*\bvalue=["'])[^"']*(["'])/gi, "$1<REDACTED>$2")
		.replace(/ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<REDACTED>")
		.replace(/\b(?:sk|pk|ghp|gho|xox[abps])[-_][A-Za-z0-9]{16,}\b/g, "<REDACTED>");
}

export function visibleCookies(
	cookies: Cookie[],
	config: Pick<EffectiveConfig, "exposeCookieValues">,
): Array<Record<string, unknown>> {
	return cookies.map((cookie) => ({
		name: cookie.name,
		...(config.exposeCookieValues ? { value: cookie.value } : {}),
		domain: cookie.domain,
		path: cookie.path,
		expires: cookie.expires,
		httpOnly: cookie.httpOnly,
		secure: cookie.secure,
		sameSite: cookie.sameSite,
	}));
}

export async function applyPagePolicy(page: Page, session: HeadedSession, audit: AuditWriter): Promise<void> {
	const domainPolicy = deriveDomainPolicy(session.config);
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		void (async () => {
			if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
				await request.continue().catch(() => undefined);
				return;
			}
			try {
				checkNavigation(request.url(), domainPolicy);
				await audit.write(session, "in-page-navigation", "allow", request.url());
				await request.continue();
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				await audit.write(session, "in-page-navigation", "block", request.url(), reason);
				await request.abort("blockedbyclient");
			}
		})().catch(() => undefined);
	});
	if (!session.config.allowDownloads) {
		page.on("response", (response) => {
			const disposition = response.headers()["content-disposition"] ?? "";
			if (/\battachment\b/i.test(disposition)) {
				void audit.write(session, "download", "block", response.url(), "allowDownloads=false");
			}
		});
	}
	if (!session.config.allowFormSubmit) {
		await page.evaluateOnNewDocument(`(() => {
			document.addEventListener("submit", event => event.preventDefault(), true);
			Object.defineProperty(HTMLFormElement.prototype, "submit", { configurable: false, value() { throw new Error("headed-browser: form submission blocked by allowFormSubmit=false"); } });
		})()`);
	}
}

export function createAuditWriter(ctx: ExtensionContext, config: EffectiveConfig): AuditWriter {
	const ompSessionId = ctx.sessionManager.getSessionId?.() ?? String(process.pid);
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const directory = config.auditDir || join(agentDir, "headed-browser-audit");
	const date = new Date().toISOString().slice(0, 10);
	const path = join(directory, `${date}-${ompSessionId}.jsonl`);
	return {
		path,
		async write(session, op, decision, url, reason) {
			const record: AuditRecord = {
				ts: new Date().toISOString(), ompSessionId, sessionId: session.id, op, url, decision, reason,
				engine: session.resolvedBrowser.engine, channel: session.resolvedBrowser.channel,
				profileMode: session.profileMode, cookieDomains: session.profile.cookieDomains,
			};
			try {
				await mkdir(directory, { recursive: true, mode: 0o700 });
				await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
				await chmod(path, 0o600);
			} catch (error) {
				const warning = `headed-browser: audit write failed: ${error instanceof Error ? error.message : String(error)}`;
				if (!session.warnings.includes(warning)) session.warnings.push(warning);
			}
		},
	};
}
