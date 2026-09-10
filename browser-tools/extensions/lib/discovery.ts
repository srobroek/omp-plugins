import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Channel, Engine } from "./config.ts";

export type ConcreteChannel = Exclude<Channel, "auto" | "custom">;

export const CHANNEL_ENGINE: Record<ConcreteChannel, Engine> = {
	zen: "firefox",
	firefox: "firefox",
	"firefox-esr": "firefox",
	"firefox-developer": "firefox",
	"firefox-nightly": "firefox",
	librewolf: "firefox",
	waterfox: "firefox",
	chrome: "chrome",
	"chrome-canary": "chrome",
	chromium: "chrome",
	edge: "chrome",
	brave: "chrome",
	vivaldi: "chrome",
};

export const AUTO_ORDER: Record<Engine, ConcreteChannel[]> = {
	firefox: ["zen", "firefox", "firefox-developer", "firefox-esr", "firefox-nightly", "librewolf", "waterfox"],
	chrome: ["chrome", "chromium", "edge", "brave", "vivaldi", "chrome-canary"],
};

export interface DiscoveryOptions {
	platform?: NodeJS.Platform;
	home?: string;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	pathEntries?: string[];
}

export interface ResolvedBrowser {
	engine: Engine;
	channel: Exclude<Channel, "auto">;
	path: string;
	probedPaths: string[];
}

export interface BrowserInventoryEntry extends ResolvedBrowser {
	version?: string;
	geckoMilestone?: string;
	bidiCapable: boolean;
}

export interface FirefoxProfile {
	name: string;
	path: string;
	isRelative: boolean;
	isDefault: boolean;
}

export interface ProfileResolution {
	profileRoot?: string;
	profilePath?: string;
	profileName?: string;
	warnings: string[];
	cleanFallback: boolean;
}

const DARWIN_CANDIDATES: Record<ConcreteChannel, string[]> = {
	zen: ["/Applications/Zen.app/Contents/MacOS/zen", "~/Applications/Zen.app/Contents/MacOS/zen"],
	firefox: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
	"firefox-esr": ["/Applications/Firefox ESR.app/Contents/MacOS/firefox"],
	"firefox-developer": ["/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"],
	"firefox-nightly": ["/Applications/Firefox Nightly.app/Contents/MacOS/firefox"],
	librewolf: ["/Applications/LibreWolf.app/Contents/MacOS/librewolf"],
	waterfox: ["/Applications/Waterfox.app/Contents/MacOS/waterfox"],
	chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
	"chrome-canary": ["/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"],
	chromium: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
	edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
	brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
	vivaldi: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
};

const LINUX_NAMES: Record<ConcreteChannel, string[]> = {
	zen: ["zen", "zen-browser"],
	firefox: ["firefox"],
	"firefox-esr": ["firefox-esr"],
	"firefox-developer": ["firefox-developer-edition"],
	"firefox-nightly": ["firefox-nightly"],
	librewolf: ["librewolf"],
	waterfox: ["waterfox"],
	chrome: ["google-chrome"],
	"chrome-canary": ["google-chrome-unstable"],
	chromium: ["chromium", "chromium-browser"],
	edge: ["microsoft-edge"],
	brave: ["brave-browser"],
	vivaldi: ["vivaldi-stable"],
};

const FLATPAK_IDS: Partial<Record<ConcreteChannel, string[]>> = {
	zen: ["app.zen_browser.zen"],
	firefox: ["org.mozilla.firefox"],
	librewolf: ["io.gitlab.librewolf-community"],
	chrome: ["com.google.Chrome"],
	brave: ["com.brave.Browser"],
	edge: ["com.microsoft.Edge"],
};

const WINDOWS_CANDIDATES: Record<ConcreteChannel, string[]> = {
	zen: ["%ProgramFiles%/Zen Browser/zen.exe", "%LOCALAPPDATA%/Programs/Zen Browser/zen.exe"],
	firefox: ["%ProgramFiles%/Mozilla Firefox/firefox.exe", "%ProgramFiles(x86)%/Mozilla Firefox/firefox.exe"],
	"firefox-esr": ["%ProgramFiles%/Mozilla Firefox ESR/firefox.exe"],
	"firefox-developer": ["%ProgramFiles%/Firefox Developer Edition/firefox.exe"],
	"firefox-nightly": ["%ProgramFiles%/Firefox Nightly/firefox.exe"],
	librewolf: ["%ProgramFiles%/LibreWolf/librewolf.exe"],
	waterfox: ["%ProgramFiles%/Waterfox/waterfox.exe"],
	chrome: ["%ProgramFiles%/Google/Chrome/Application/chrome.exe"],
	"chrome-canary": ["%LOCALAPPDATA%/Google/Chrome SxS/Application/chrome.exe"],
	chromium: ["%ProgramFiles%/Chromium/Application/chrome.exe"],
	edge: ["%ProgramFiles(x86)%/Microsoft/Edge/Application/msedge.exe"],
	brave: ["%ProgramFiles%/BraveSoftware/Brave-Browser/Application/brave.exe"],
	vivaldi: ["%ProgramFiles%/Vivaldi/Application/vivaldi.exe"],
};

export function candidatesForChannel(channel: ConcreteChannel, options: DiscoveryOptions = {}): string[] {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	if (platform === "darwin") return DARWIN_CANDIDATES[channel].map((path) => expandPath(path, home, env));
	if (platform === "win32") return WINDOWS_CANDIDATES[channel].map((path) => expandPath(path, home, env));
	if (platform === "linux") {
		const pathEntries = options.pathEntries ?? (env.PATH ?? "").split(":").filter(Boolean);
		const names = LINUX_NAMES[channel];
		const candidates: string[] = [];
		for (const name of names) {
			for (const pathDir of pathEntries) candidates.push(join(pathDir, name));
			candidates.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/${name}/${name}`);
		}
		for (const id of FLATPAK_IDS[channel] ?? []) {
			candidates.push(`/var/lib/flatpak/exports/bin/${id}`, join(home, ".local/share/flatpak/exports/bin", id));
		}
		return [...new Set(candidates)];
	}
	return [];
}

export function assertChannelEngine(engine: Engine, channel: Channel): void {
	if (channel === "auto" || channel === "custom") return;
	const actual = CHANNEL_ENGINE[channel];
	if (actual !== engine) {
		throw new Error(`headed-browser: channel ${channel} belongs to engine ${actual}, not ${engine}`);
	}
}

export function resolveBrowser(
	engine: Engine,
	channel: Channel,
	executablePath = "",
	options: DiscoveryOptions = {},
): ResolvedBrowser {
	assertChannelEngine(engine, channel);
	const exists = options.exists ?? pathExists;
	if (channel === "custom") {
		if (!executablePath || !isAbsolute(executablePath)) {
			throw new Error("headed-browser: executablePath must be an absolute path when browserChannel is custom");
		}
		if (!exists(executablePath)) throw new Error(`headed-browser: custom executable not found: ${executablePath}`);
		return { engine, channel, path: executablePath, probedPaths: [executablePath] };
	}
	const channels = channel === "auto" ? AUTO_ORDER[engine] : [channel];
	const probedPaths: string[] = [];
	for (const candidateChannel of channels) {
		for (const candidatePath of candidatesForChannel(candidateChannel, options)) {
			probedPaths.push(candidatePath);
			if (exists(candidatePath)) return { engine, channel: candidateChannel, path: candidatePath, probedPaths };
		}
	}
	throw new Error(`headed-browser: no installed ${engine} browser found; probed ${probedPaths.join(", ")}`);
}

export function inventory(options: DiscoveryOptions = {}): BrowserInventoryEntry[] {
	const exists = options.exists ?? pathExists;
	const found: BrowserInventoryEntry[] = [];
	for (const channel of Object.keys(CHANNEL_ENGINE) as ConcreteChannel[]) {
		const path = candidatesForChannel(channel, options).find(exists);
		if (!path) continue;
		const engine = CHANNEL_ENGINE[channel];
		const version = engine === "firefox" ? readFirefoxMetadata(path, "application.ini", "Version") : chromeVersion(path);
		const geckoMilestone = engine === "firefox" ? readFirefoxMetadata(path, "platform.ini", "Milestone") : undefined;
		found.push({ engine, channel, path, version, geckoMilestone, bidiCapable: engine === "chrome" || Number.parseInt(geckoMilestone ?? "0", 10) >= 129, probedPaths: [path] });
	}
	return found;
}

export function parseProfilesIni(text: string): FirefoxProfile[] {
	const sections = parseIni(text);
	return Object.entries(sections)
		.filter(([name]) => /^Profile\d+$/i.test(name))
		.map(([, values]) => ({
			name: values.Name ?? "",
			path: values.Path ?? "",
			isRelative: values.IsRelative !== "0",
			isDefault: values.Default === "1",
		}))
		.filter((profile) => profile.path.length > 0);
}

export function parseInstallsIni(text: string): string[] {
	return Object.values(parseIni(text)).map((values) => values.Default).filter((value): value is string => Boolean(value));
}

export function selectFirefoxProfile(
	root: string,
	profilesText: string,
	installsText = "",
	sourceProfileName = "",
): FirefoxProfile & { resolvedPath: string } {
	const profiles = parseProfilesIni(profilesText);
	let selected: FirefoxProfile | undefined;
	if (sourceProfileName) {
		selected = profiles.find((profile) => profile.name === sourceProfileName) ?? profiles.find((profile) => profile.path === sourceProfileName);
	}
	if (!selected) {
		for (const installDefault of parseInstallsIni(installsText)) {
			selected = profiles.find((profile) => profile.path === installDefault);
			if (selected) break;
		}
	}
	selected ??= profiles.find((profile) => profile.isDefault);
	if (!selected && profiles.length === 1) selected = profiles[0];
	if (!selected) {
		throw new Error(`headed-browser: cannot select Firefox profile; available profiles: ${profiles.map((profile) => `${profile.name} (${profile.path})`).join(", ") || "none"}`);
	}
	return { ...selected, resolvedPath: selected.isRelative ? resolve(root, selected.path) : selected.path };
}

export function profileRoots(
	engine: Engine,
	channel: Exclude<Channel, "auto" | "custom">,
	options: DiscoveryOptions = {},
): string[] {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	if (engine === "firefox") {
		const name = channel === "zen" ? "zen" : channel === "librewolf" ? "LibreWolf" : channel === "waterfox" ? "Waterfox" : "Firefox";
		if (platform === "darwin") return [join(home, "Library/Application Support", name)];
		if (platform === "win32") return [join(env.APPDATA ?? join(home, "AppData/Roaming"), name === "Firefox" ? "Mozilla/Firefox" : name.toLowerCase())];
		const linux: Record<string, string[]> = {
			zen: [join(home, ".zen"), join(home, ".var/app/app.zen_browser.zen/.zen")],
			Firefox: [join(home, ".mozilla/firefox"), join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox")],
			LibreWolf: [join(home, ".librewolf")],
			Waterfox: [join(home, ".waterfox")],
		};
		return linux[name] ?? [];
	}
	const rootName: Record<string, string> = {
		chrome: "Google/Chrome",
		"chrome-canary": "Google/Chrome Canary",
		chromium: "Chromium",
		edge: "Microsoft Edge",
		brave: "BraveSoftware/Brave-Browser",
		vivaldi: "Vivaldi",
	};
	if (platform === "darwin") return [join(home, "Library/Application Support", rootName[channel] ?? channel)];
	if (platform === "win32") return [join(env.LOCALAPPDATA ?? join(home, "AppData/Local"), rootName[channel] ?? channel, channel === "edge" ? "User Data" : "")];
	const linuxRoot: Record<string, string> = {
		chrome: "google-chrome",
		"chrome-canary": "google-chrome-unstable",
		chromium: "chromium",
		edge: "microsoft-edge",
		brave: "BraveSoftware/Brave-Browser",
		vivaldi: "vivaldi",
	};
	return [join(home, ".config", linuxRoot[channel] ?? channel)];
}

export function resolveSourceProfile(
	engine: Engine,
	channel: Exclude<Channel, "auto" | "custom">,
	sourceProfileName = "",
	profileRootOverride = "",
	options: DiscoveryOptions = {},
): ProfileResolution {
	const exists = options.exists ?? pathExists;
	const roots = profileRootOverride ? [profileRootOverride] : profileRoots(engine, channel, options);
	const root = roots.find(exists);
	if (!root) return { warnings: [`headed-browser: no ${channel} profile found; launched with an empty profile`], cleanFallback: true };
	try {
		if (engine === "firefox") {
			const profilesText = readFileSync(join(root, "profiles.ini"), "utf8");
			let installsText = "";
			try { installsText = readFileSync(join(root, "installs.ini"), "utf8"); } catch {}
			const profile = selectFirefoxProfile(root, profilesText, installsText, sourceProfileName);
			if (!exists(profile.resolvedPath)) throw new Error(`profile path does not exist: ${profile.resolvedPath}`);
			return { profileRoot: root, profilePath: profile.resolvedPath, profileName: profile.name, warnings: [], cleanFallback: false };
		}
		const profileName = sourceProfileName || "Default";
		const profilePath = join(root, profileName);
		if (!exists(profilePath)) throw new Error(`profile path does not exist: ${profilePath}`);
		return { profileRoot: root, profilePath, profileName, warnings: [], cleanFallback: false };
	} catch (error) {
		return { profileRoot: root, warnings: [`headed-browser: no ${channel} profile found; launched with an empty profile (${error instanceof Error ? error.message : String(error)})`], cleanFallback: true };
	}
}

function parseIni(text: string): Record<string, Record<string, string>> {
	const sections: Record<string, Record<string, string>> = {};
	let current: Record<string, string> | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith(";") || line.startsWith("#")) continue;
		const section = line.match(/^\[([^\]]+)]$/);
		if (section) {
			current = sections[section[1] ?? ""] ??= {};
			continue;
		}
		const separator = line.indexOf("=");
		if (current && separator > 0) current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
	}
	return sections;
}

function readFirefoxMetadata(executablePath: string, filename: string, key: string): string | undefined {
	const macResources = resolve(dirname(executablePath), "../Resources", filename);
	const paths = [join(dirname(executablePath), filename), macResources];
	for (const path of paths) {
		try {
			const section = Object.values(parseIni(readFileSync(path, "utf8"))).find((values) => values[key]);
			if (section?.[key]) return section[key];
		} catch {}
	}
	return undefined;
}

function chromeVersion(executablePath: string): string | undefined {
	const result = spawnSync(executablePath, ["--version"], { encoding: "utf8", timeout: 5000 });
	const text = `${result.stdout ?? ""} ${result.stderr ?? ""}`.trim();
	return text.match(/\d+(?:\.\d+)+/)?.[0];
}

function expandPath(path: string, home: string, env: NodeJS.ProcessEnv): string {
	let expanded = path.startsWith("~/") ? join(home, path.slice(2)) : path;
	expanded = expanded.replace(/%([^%]+)%/g, (_match, key: string) => env[key] ?? `%${key}%`);
	return expanded;
}

function pathExists(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		try {
			accessSync(path, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}
}
