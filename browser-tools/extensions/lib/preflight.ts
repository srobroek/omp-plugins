import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { access, mkdir, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ConfigOverrides, EffectiveConfig, Engine } from "./config.ts";
import { resolveConfig } from "./config.ts";
import type { BrowserInventoryEntry } from "./discovery.ts";
import { AUTO_ORDER, inventory, resolveBrowser, resolveSourceProfile } from "./discovery.ts";
import { loadPuppeteer } from "./driver.ts";
import { createAuditWriter, deriveDomainPolicy } from "./policy.ts";
import { directorySize, resolvedCopyStrategy } from "./profile.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface PreflightCheck {
	name: string;
	status: CheckStatus;
	observed: unknown;
	remedy?: string;
}

export interface PreflightResult {
	ok: boolean;
	checks: PreflightCheck[];
	config: EffectiveConfig;
	inventory: BrowserInventoryEntry[];
	warnings: string[];
}

export async function runPreflight(
	cwd: string,
	ctx: ExtensionContext,
	overrides: ConfigOverrides = {},
): Promise<PreflightResult> {
	const config = await resolveConfig(cwd, overrides);
	const checks: PreflightCheck[] = [];
	try {
		await loadPuppeteer(config);
		checks.push({ name: "driver", status: "ok", observed: config.driverModulePath || "puppeteer-core package resolution" });
	} catch (error) {
		checks.push({ name: "driver", status: "fail", observed: error instanceof Error ? error.message : String(error), remedy: "Set driverModulePath to the host puppeteer-core entry module." });
	}
	const installed = inventory();
	checks.push({ name: "browser-inventory", status: installed.length > 0 ? "ok" : "warn", observed: installed, remedy: installed.length > 0 ? undefined : "Install Firefox-family or Chrome-family browser." });
	for (const engine of ["firefox", "chrome"] as const satisfies readonly Engine[]) {
		try {
			const browser = resolveBrowser(engine, "auto");
			checks.push({ name: `auto-${engine}`, status: "ok", observed: { channel: browser.channel, path: browser.path } });
		} catch (error) {
			checks.push({ name: `auto-${engine}`, status: "warn", observed: error instanceof Error ? error.message : String(error), remedy: `Install one of: ${AUTO_ORDER[engine].join(", ")}.` });
		}
	}
	for (const entry of installed.filter((candidate) => candidate.engine === "firefox")) {
		checks.push({
			name: `gecko-${entry.channel}`,
			status: entry.bidiCapable ? "ok" : "warn",
			observed: entry.geckoMilestone ?? "unknown",
			remedy: entry.bidiCapable ? undefined : "Upgrade to Gecko 129 or newer.",
		});
	}
	try {
		const browser = resolveBrowser(config.engine, config.browserChannel, config.executablePath);
		const profile = browser.channel === "custom"
			? { warnings: ["headed-browser: custom channel profile must be supplied through profileRootOverride"], cleanFallback: true }
			: resolveSourceProfile(config.engine, browser.channel, config.sourceProfileName, config.profileRootOverride);
		let size: number | undefined;
		if ("profilePath" in profile && profile.profilePath) size = await directorySize(profile.profilePath);
		checks.push({ name: "source-profile", status: profile.cleanFallback ? "warn" : "ok", observed: { ...profile, size }, remedy: profile.cleanFallback ? "A clean profile will be used." : undefined });
	} catch (error) {
		checks.push({ name: "source-profile", status: "warn", observed: error instanceof Error ? error.message : String(error), remedy: "A clean profile will be used." });
	}
	const ephemeralRoot = config.ephemeralRoot || tmpdir();
	try {
		await mkdir(ephemeralRoot, { recursive: true, mode: 0o700 });
		const space = await statfs(ephemeralRoot);
		checks.push({ name: "ephemeral-space", status: "ok", observed: { path: ephemeralRoot, freeBytes: space.bavail * space.bsize } });
	} catch (error) {
		checks.push({ name: "ephemeral-space", status: "fail", observed: error instanceof Error ? error.message : String(error), remedy: "Set ephemeralRoot to a writable filesystem." });
	}
	checks.push({ name: "copy-strategy", status: "ok", observed: resolvedCopyStrategy(config.copyStrategy) });
	try {
		const database = new Database(":memory:");
		database.run("CREATE TABLE moz_cookies (host TEXT, originAttributes TEXT)");
		const columns = database.query("PRAGMA table_info(moz_cookies)").all() as Array<{ name: string }>;
		database.close();
		checks.push({ name: "bun-sqlite", status: "ok", observed: columns.map((column) => column.name) });
	} catch (error) {
		checks.push({ name: "bun-sqlite", status: "fail", observed: error instanceof Error ? error.message : String(error), remedy: "Run the extension under Bun with bun:sqlite available." });
	}
	const audit = createAuditWriter(ctx, config);
	try {
		await mkdir(dirname(audit.path), { recursive: true, mode: 0o700 });
		await access(dirname(audit.path), constants.W_OK);
		checks.push({ name: "audit", status: "ok", observed: audit.path });
	} catch (error) {
		checks.push({ name: "audit", status: "warn", observed: error instanceof Error ? error.message : String(error), remedy: "Set auditDir to a writable directory." });
	}
	checks.push({ name: "settings-source", status: "ok", observed: config.settingsSource });
	try {
		const policy = deriveDomainPolicy(config);
		checks.push({ name: "policy", status: "ok", observed: { domainMode: policy.mode, disabledFeatures: ["allowDownloads", "allowFormSubmit", "allowPasswordEntry", "allowFileUpload", "allowEvaluate"].filter((key) => config[key as keyof EffectiveConfig] === false) } });
	} catch (error) {
		checks.push({ name: "policy", status: "fail", observed: error instanceof Error ? error.message : String(error), remedy: "Clear allowedDomains or deniedDomains." });
	}
	return { ok: checks.every((check) => check.status !== "fail"), checks, config, inventory: installed, warnings: config.warnings };
}
