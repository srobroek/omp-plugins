import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginSettingSchema } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export const PLUGIN_PACKAGE = "@srobroek/browser-tools";

export const ENGINES = ["firefox", "chrome"] as const;
export type Engine = (typeof ENGINES)[number];

export const CHANNELS = [
	"auto",
	"zen",
	"firefox",
	"firefox-esr",
	"firefox-developer",
	"firefox-nightly",
	"librewolf",
	"waterfox",
	"chrome",
	"chrome-canary",
	"chromium",
	"edge",
	"brave",
	"vivaldi",
	"custom",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const PROFILE_MODES = ["ephemeral-clone", "persistent-dedicated", "clean"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

export const COPY_STRATEGIES = ["auto", "clonefile", "reflink", "robocopy", "node"] as const;
export type CopyStrategy = (typeof COPY_STRATEGIES)[number];

export const SETTING_SCHEMA = {
	defaultEngine: setting("enum", "firefox", "HEADED_BROWSER_DEFAULT_ENGINE", ENGINES),
	defaultBrowserChannel: setting(
		"enum",
		"auto",
		"HEADED_BROWSER_DEFAULT_BROWSER_CHANNEL",
		CHANNELS,
	),
	defaultHeadless: setting("boolean", false, "HEADED_BROWSER_DEFAULT_HEADLESS"),
	executablePath: setting("string", "", "HEADED_BROWSER_EXECUTABLE_PATH"),
	profileMode: setting("enum", "ephemeral-clone", "HEADED_BROWSER_PROFILE_MODE", PROFILE_MODES),
	sourceProfileName: setting("string", "", "HEADED_BROWSER_SOURCE_PROFILE_NAME"),
	profileRootOverride: setting("string", "", "HEADED_BROWSER_PROFILE_ROOT_OVERRIDE"),
	ephemeralRoot: setting("string", "", "HEADED_BROWSER_EPHEMERAL_ROOT"),
	copyStrategy: setting("enum", "auto", "HEADED_BROWSER_COPY_STRATEGY", COPY_STRATEGIES),
	defaultCookieDomains: setting("string", "", "HEADED_BROWSER_DEFAULT_COOKIE_DOMAINS"),
	copyFirefoxLogins: setting("boolean", false, "HEADED_BROWSER_COPY_FIREFOX_LOGINS"),
	noRemote: setting("boolean", true, "HEADED_BROWSER_NO_REMOTE"),
	allowedDomains: setting("string", "", "HEADED_BROWSER_ALLOWED_DOMAINS"),
	deniedDomains: setting("string", "", "HEADED_BROWSER_DENIED_DOMAINS"),
	allowDownloads: setting("boolean", true, "HEADED_BROWSER_ALLOW_DOWNLOADS"),
	allowFormSubmit: setting("boolean", true, "HEADED_BROWSER_ALLOW_FORM_SUBMIT"),
	allowPasswordEntry: setting("boolean", true, "HEADED_BROWSER_ALLOW_PASSWORD_ENTRY"),
	allowFileUpload: setting("boolean", false, "HEADED_BROWSER_ALLOW_FILE_UPLOAD"),
	allowEvaluate: setting("boolean", true, "HEADED_BROWSER_ALLOW_EVALUATE"),
	exposeCookieValues: setting("boolean", false, "HEADED_BROWSER_EXPOSE_COOKIE_VALUES"),
	redactSecrets: setting("boolean", true, "HEADED_BROWSER_REDACT_SECRETS"),
	auditDir: setting("string", "", "HEADED_BROWSER_AUDIT_DIR"),
	keepArtifactsOnClose: setting("boolean", false, "HEADED_BROWSER_KEEP_ARTIFACTS_ON_CLOSE"),
	idleCloseSec: numberSetting(7200, "HEADED_BROWSER_IDLE_CLOSE_SEC", 120, 86400, 60),
	navigationTimeoutMs: numberSetting(
		30000,
		"HEADED_BROWSER_NAVIGATION_TIMEOUT_MS",
		1000,
		300000,
		1000,
	),
	driverModulePath: setting("string", "", "HEADED_BROWSER_DRIVER_MODULE_PATH"),
} as const satisfies Record<string, PluginSettingSchema>;

export type SettingKey = keyof typeof SETTING_SCHEMA;

export interface EffectiveConfig {
	defaultEngine: Engine;
	defaultBrowserChannel: Channel;
	defaultHeadless: boolean;
	executablePath: string;
	profileMode: ProfileMode;
	sourceProfileName: string;
	profileRootOverride: string;
	ephemeralRoot: string;
	copyStrategy: CopyStrategy;
	defaultCookieDomains: string;
	copyFirefoxLogins: boolean;
	noRemote: boolean;
	allowedDomains: string;
	deniedDomains: string;
	allowDownloads: boolean;
	allowFormSubmit: boolean;
	allowPasswordEntry: boolean;
	allowFileUpload: boolean;
	allowEvaluate: boolean;
	exposeCookieValues: boolean;
	redactSecrets: boolean;
	auditDir: string;
	keepArtifactsOnClose: boolean;
	idleCloseSec: number;
	navigationTimeoutMs: number;
	driverModulePath: string;
	engine: Engine;
	browserChannel: Channel;
	headless: boolean;
	cookieDomains: string;
	warnings: string[];
	settingsSource: string;
}

export type ConfigOverrides = Partial<Record<SettingKey, unknown>> & {
	engine?: unknown;
	browserChannel?: unknown;
	headless?: unknown;
	cookieDomains?: unknown;
};

export interface StoredSettings {
	values: Record<string, unknown>;
	source: string;
	warnings: string[];
}

function setting<T extends "string" | "boolean">(
	type: T,
	defaultValue: T extends "string" ? string : boolean,
	env: string,
): PluginSettingSchema;
function setting(
	type: "enum",
	defaultValue: string,
	env: string,
	values: readonly string[],
): PluginSettingSchema;
function setting(
	type: "string" | "boolean" | "enum",
	defaultValue: string | boolean,
	env: string,
	values?: readonly string[],
): PluginSettingSchema {
	if (type === "enum") return { type, default: String(defaultValue), env, values: [...(values ?? [])] };
	if (type === "boolean") return { type, default: Boolean(defaultValue), env };
	return { type, default: String(defaultValue), env };
}

function numberSetting(
	defaultValue: number,
	env: string,
	min: number,
	max: number,
	step: number,
): PluginSettingSchema {
	return { type: "number", default: defaultValue, env, min, max, step };
}

async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as {
		settings?: Record<string, Record<string, unknown>>;
	};
	return parsed.settings?.[PLUGIN_PACKAGE] ?? {};
}

/** The public plugin-settings API, imported lazily so the fallback stays testable. */
type PluginSettingsModule = {
	getPluginSettings(pkg: string, cwd: string): Promise<Record<string, unknown> | undefined>;
};

export async function loadStoredSettings(
	cwd: string,
	importPluginSettings: () => Promise<PluginSettingsModule> = () =>
		import("@oh-my-pi/pi-coding-agent/extensibility/plugins"),
): Promise<StoredSettings> {
	try {
		const module = await importPluginSettings();
		const values = await module.getPluginSettings(PLUGIN_PACKAGE, cwd);
		return { values: values ?? {}, source: "public-api", warnings: [] };
	} catch (error) {
		const warnings = [
			`headed-browser: plugin settings public API unavailable; using lock-file fallback (${errorMessage(error)})`,
		];
		const pluginsDir = process.env.PI_CODING_AGENT_DIR
			? join(dirname(process.env.PI_CODING_AGENT_DIR), "plugins")
			: join(homedir(), ".omp", "plugins");
		const lockPath = join(pluginsDir, "omp-plugins.lock.json");
		const overridePath = join(cwd, ".omp", "plugin-overrides.json");
		let values: Record<string, unknown> = {};
		const sources: string[] = [];
		for (const path of [lockPath, overridePath]) {
			try {
				values = { ...values, ...(await readSettingsFile(path)) };
				sources.push(path);
			} catch (readError) {
				if (!isMissingFile(readError)) {
					warnings.push(`headed-browser: cannot read settings from ${path}: ${errorMessage(readError)}`);
				}
			}
		}
		return {
			values,
			source: sources.length > 0 ? `lock-file:${sources.join(",")}` : "schema-and-env-only",
			warnings,
		};
	}
}

export async function resolveConfig(
	cwd: string,
	overrides: ConfigOverrides = {},
	storedLoader: (cwd: string) => Promise<StoredSettings> = loadStoredSettings,
): Promise<EffectiveConfig> {
	const stored = await storedLoader(cwd);
	const warnings = [...stored.warnings];
	const values: Record<string, unknown> = {};

	for (const [key, schema] of Object.entries(SETTING_SCHEMA)) {
		let value: unknown = schema.default;
		const envValue = schema.env ? process.env[schema.env] : undefined;
		if (envValue !== undefined) value = coerce(key, envValue, schema, value, warnings);
		if (Object.hasOwn(stored.values, key)) {
			value = coerce(key, stored.values[key], schema, value, warnings);
		}
		if (Object.hasOwn(overrides, key)) {
			value = coerce(key, overrides[key as SettingKey], schema, value, warnings);
		}
		values[key] = value;
	}

	const mappedOverrides: Array<[SettingKey, keyof ConfigOverrides]> = [
		["defaultEngine", "engine"],
		["defaultBrowserChannel", "browserChannel"],
		["defaultHeadless", "headless"],
		["defaultCookieDomains", "cookieDomains"],
	];
	for (const [settingKey, overrideKey] of mappedOverrides) {
		if (!Object.hasOwn(overrides, overrideKey)) continue;
		values[settingKey] = coerce(
			settingKey,
			overrides[overrideKey],
			SETTING_SCHEMA[settingKey],
			values[settingKey],
			warnings,
		);
	}

	return {
		...(values as Omit<
			EffectiveConfig,
			"engine" | "browserChannel" | "headless" | "cookieDomains" | "warnings" | "settingsSource"
		>),
		engine: values.defaultEngine as Engine,
		browserChannel: values.defaultBrowserChannel as Channel,
		headless: values.defaultHeadless as boolean,
		cookieDomains: values.defaultCookieDomains as string,
		warnings,
		settingsSource: stored.source,
	};
}

function coerce(
	key: string,
	candidate: unknown,
	schema: PluginSettingSchema,
	fallback: unknown,
	warnings: string[],
): unknown {
	let value: unknown;
	if (schema.type === "string") value = typeof candidate === "string" ? candidate : undefined;
	if (schema.type === "boolean") {
		if (typeof candidate === "boolean") value = candidate;
		else if (typeof candidate === "string" && /^(true|1|yes|on)$/i.test(candidate)) value = true;
		else if (typeof candidate === "string" && /^(false|0|no|off)$/i.test(candidate)) value = false;
	}
	if (schema.type === "number") {
		const parsed = typeof candidate === "number" ? candidate : Number(candidate);
		if (Number.isFinite(parsed) && (schema.min === undefined || parsed >= schema.min) && (schema.max === undefined || parsed <= schema.max)) {
			value = parsed;
		}
	}
	if (schema.type === "enum" && typeof candidate === "string" && schema.values.includes(candidate)) {
		value = candidate;
	}
	if (value === undefined) {
		warnings.push(`headed-browser: rejected invalid ${key} value ${JSON.stringify(candidate)}; kept ${JSON.stringify(fallback)}`);
		return fallback;
	}
	return value;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function splitDomains(value: string): string[] {
	return [...new Set(value.split(",").map((part) => part.trim().toLowerCase().replace(/^\.+/, "")).filter(Boolean))];
}
