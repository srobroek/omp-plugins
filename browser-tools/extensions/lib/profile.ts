import { Database } from "bun:sqlite";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { Page } from "puppeteer-core";
import type { Channel, CopyStrategy, EffectiveConfig, Engine, ProfileMode } from "./config.ts";
import { splitDomains } from "./config.ts";

const EXCLUDED_DIRS = [
	"cache2",
	"startupCache",
	"shader-cache",
	"jumpListCache",
	"thumbnails",
	"minidumps",
	"crashes",
	"saved-telemetry-pings",
	"datareporting",
	"security_state",
	"sessionstore-backups",
	"storage/temporary",
	"weave",
	"updates",
] as const;

const EXCLUDED_FILES = ["lock", ".parentlock", "parent.lock", ".migrated", "sessionstore.jsonlz4"] as const;
const LOGIN_FILES = ["logins.json", "key4.db", "signons.sqlite"] as const;

export interface MaterializedProfile {
	sessionDir: string;
	profileDir: string;
	downloadsDir: string;
	artifactsDir: string;
	persistentProfile: boolean;
	warnings: string[];
	containerCookiesSkipped: number;
	cookieDomains: string[];
	copyStrategy: Exclude<CopyStrategy, "auto">;
}

export interface MaterializeOptions {
	engine: Engine;
	channel: Exclude<Channel, "auto">;
	profileMode: ProfileMode;
	sourceProfile?: string;
	agentDir: string;
	config: EffectiveConfig;
}

export async function materializeProfile(options: MaterializeOptions): Promise<MaterializedProfile> {
	const { config, channel, engine } = options;
	const warnings: string[] = [];
	const tempRoot = config.ephemeralRoot || tmpdir();
	await mkdir(tempRoot, { recursive: true, mode: 0o700 });
	const sessionDir = await mkdtemp(join(tempRoot, `omp-headed-${channel}-${randomBytes(4).toString("hex")}-`));
	const downloadsDir = join(sessionDir, "downloads");
	const artifactsDir = join(sessionDir, "artifacts");
	await Promise.all([mkdir(downloadsDir, { recursive: true, mode: 0o700 }), mkdir(artifactsDir, { recursive: true, mode: 0o700 })]);

	const persistentProfile = options.profileMode === "persistent-dedicated";
	const profileDir = persistentProfile
		? join(options.agentDir, "headed-browser-profiles", channel)
		: join(sessionDir, "profile");
	await mkdir(profileDir, { recursive: true, mode: 0o700 });

	if (options.sourceProfile && options.profileMode === "ephemeral-clone") {
		await assertProfileIsolation(options.sourceProfile, profileDir);
		await copyProfile(options.sourceProfile, profileDir, config.copyStrategy, config.copyFirefoxLogins, warnings);
	}

	let containerCookiesSkipped = 0;
	const cookieDomains = splitDomains(config.cookieDomains);
	if (engine === "firefox" && options.profileMode === "ephemeral-clone") {
		const scoped = await scopeFirefoxCookies(join(profileDir, "cookies.sqlite"), cookieDomains);
		containerCookiesSkipped = scoped.containerCookiesSkipped;
		warnings.push(...scoped.warnings);
	}
	await writeFirefoxUserJs(profileDir, downloadsDir, config.allowDownloads);

	return {
		sessionDir,
		profileDir,
		downloadsDir,
		artifactsDir,
		persistentProfile,
		warnings,
		containerCookiesSkipped,
		cookieDomains,
		copyStrategy: resolvedCopyStrategy(config.copyStrategy),
	};
}
export async function assertProfileIsolation(source: string, destination: string): Promise<void> {
	const [sourceReal, destinationReal] = await Promise.all([realpath(source), realpath(destination)]);
	if (sourceReal === destinationReal) {
		throw new Error("headed-browser: refusing to launch against the live profile; set profileMode or profileRootOverride");
	}
}


export function shouldCopy(relativePath: string, copyFirefoxLogins: boolean): boolean {
	const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized) return true;
	for (const excluded of EXCLUDED_DIRS) {
		if (normalized === excluded || normalized.startsWith(`${excluded}/`)) return false;
	}
	const name = basename(normalized);
	if (EXCLUDED_FILES.includes(name as (typeof EXCLUDED_FILES)[number])) return false;
	if (/^Telemetry\./.test(name)) return false;
	if (!copyFirefoxLogins && LOGIN_FILES.includes(name as (typeof LOGIN_FILES)[number])) return false;
	return true;
}

export function resolvedCopyStrategy(strategy: CopyStrategy, platform: NodeJS.Platform = process.platform): Exclude<CopyStrategy, "auto"> {
	if (strategy !== "auto") return strategy;
	if (platform === "darwin") return "clonefile";
	if (platform === "linux") return "reflink";
	if (platform === "win32") return "robocopy";
	return "node";
}

export async function copyProfile(
	source: string,
	destination: string,
	strategy: CopyStrategy,
	copyFirefoxLogins: boolean,
	warnings: string[],
): Promise<void> {
	const selected = resolvedCopyStrategy(strategy);
	if (selected === "node") {
		await nodeCopy(source, destination, copyFirefoxLogins);
		return;
	}
	let result: SpawnSyncReturns<string>;
	if (selected === "clonefile") {
		result = spawnSync("cp", ["-c", "-R", `${source}/.`, destination], { encoding: "utf8", timeout: 300_000 });
	} else if (selected === "reflink") {
		result = spawnSync("cp", ["-a", "--reflink=auto", `${source}/.`, destination], { encoding: "utf8", timeout: 300_000 });
	} else {
		const excludedDirs = EXCLUDED_DIRS.map((entry) => join(source, entry));
		const excludedFiles = [...EXCLUDED_FILES, ...(!copyFirefoxLogins ? LOGIN_FILES : [])];
		result = spawnSync(
			"robocopy",
			[source, destination, "/E", "/XJ", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XD", ...excludedDirs, "/XF", ...excludedFiles],
			{ encoding: "utf8", timeout: 300_000 },
		);
	}
	const successfulRobocopy = selected === "robocopy" && result.status !== null && result.status >= 0 && result.status <= 7;
	if (result.error || (!successfulRobocopy && result.status !== 0)) {
		warnings.push(`headed-browser: ${selected} profile copy failed; fell back to node (${result.error?.message ?? result.stderr ?? `exit ${result.status}`})`);
		await rm(destination, { recursive: true, force: true });
		await mkdir(destination, { recursive: true, mode: 0o700 });
		await nodeCopy(source, destination, copyFirefoxLogins);
		return;
	}
	await pruneProfile(destination, copyFirefoxLogins);
}

async function nodeCopy(source: string, destination: string, copyFirefoxLogins: boolean): Promise<void> {
	await cp(source, destination, {
		recursive: true,
		force: true,
		filter: (sourcePath) => shouldCopy(relative(source, sourcePath), copyFirefoxLogins),
	});
}

export async function pruneProfile(destination: string, copyFirefoxLogins: boolean): Promise<void> {
	for (const entry of EXCLUDED_DIRS) await rm(join(destination, entry), { recursive: true, force: true });
	for (const entry of EXCLUDED_FILES) await rm(join(destination, entry), { force: true });
	if (!copyFirefoxLogins) for (const entry of LOGIN_FILES) await rm(join(destination, entry), { force: true });
	for (const candidate of await listTelemetryFiles(destination)) await rm(candidate, { force: true });
}

async function listTelemetryFiles(directory: string): Promise<string[]> {
	try {
		const entries = await Array.fromAsync(new Bun.Glob("Telemetry.*").scan({ cwd: directory, absolute: true, onlyFiles: true }));
		return entries;
	} catch {
		return [];
	}
}

export async function scopeFirefoxCookies(
	databasePath: string,
	domains: string[],
): Promise<{ containerCookiesSkipped: number; removed: number; warnings: string[] }> {
	if (!existsSync(databasePath)) return { containerCookiesSkipped: 0, removed: 0, warnings: [] };
	const warnings: string[] = [];
	let database: Database | undefined;
	try {
		database = new Database(databasePath);
		const columns = database.query("PRAGMA table_info(moz_cookies)").all() as Array<{ name: string }>;
		const names = new Set(columns.map((column) => column.name));
		if (!names.has("host") || !names.has("originAttributes")) {
			warnings.push("headed-browser: cookies.sqlite lacks host or originAttributes; cookie scoping skipped");
			return { containerCookiesSkipped: 0, removed: 0, warnings };
		}
		const rows = database.query("SELECT id, host, originAttributes FROM moz_cookies").all() as Array<{ id: number; host: string; originAttributes: string }>;
		const remove = database.prepare("DELETE FROM moz_cookies WHERE id = ?");
		let containerCookiesSkipped = 0;
		let removed = 0;
		database.transaction(() => {
			for (const row of rows) {
				const container = row.originAttributes !== "";
				const keep = !container && domains.some((domain) => cookieHostMatches(row.host, domain));
				if (!keep) {
					remove.run(row.id);
					removed += 1;
					if (container) containerCookiesSkipped += 1;
				}
			}
		})();
		return { containerCookiesSkipped, removed, warnings };
	} catch (error) {
		warnings.push(`headed-browser: cookie scoping failed: ${error instanceof Error ? error.message : String(error)}`);
		return { containerCookiesSkipped: 0, removed: 0, warnings };
	} finally {
		database?.close();
	}
}

export function cookieHostMatches(host: string, domain: string): boolean {
	const normalizedHost = host.toLowerCase().replace(/^\./, "");
	const normalizedDomain = domain.toLowerCase().replace(/^\./, "");
	return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

export async function grantCookiesFromSource(
	page: Page,
	sourceProfile: string,
	domains: string[],
	tempRoot = tmpdir(),
): Promise<{ injected: number; containerCookiesSkipped: number; warnings: string[] }> {
	const sourceDatabase = join(sourceProfile, "cookies.sqlite");
	if (!existsSync(sourceDatabase)) return { injected: 0, containerCookiesSkipped: 0, warnings: ["headed-browser: source profile has no cookies.sqlite"] };
	const tempDir = await mkdtemp(join(tempRoot, "omp-headed-cookies-"));
	const tempDatabase = join(tempDir, "cookies.sqlite");
	for (const suffix of ["", "-wal", "-shm"]) {
		const source = `${sourceDatabase}${suffix}`;
		if (!existsSync(source)) continue;
		const destination = `${tempDatabase}${suffix}`;
		await cp(source, destination, { force: true });
		await chmod(destination, 0o600);
	}
	let database: Database | undefined;
	try {
		database = new Database(tempDatabase);
		const rows = database.query("SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies").all() as Array<Record<string, unknown>>;
		let containerCookiesSkipped = 0;
		const cookies = rows.flatMap((row) => {
			if (row.originAttributes !== "") {
				containerCookiesSkipped += 1;
				return [];
			}
			const host = String(row.host ?? "");
			if (!domains.some((domain) => cookieHostMatches(host, domain))) return [];
			return [{
				name: String(row.name ?? ""), value: String(row.value ?? ""), domain: host,
				path: String(row.path ?? "/"), expires: Number(row.expiry ?? -1),
				secure: Boolean(row.isSecure), httpOnly: Boolean(row.isHttpOnly),
				sameSite: firefoxSameSite(Number(row.sameSite ?? 0)),
			}];
		});
		if (cookies.length > 0) await page.setCookie(...cookies);
		return { injected: cookies.length, containerCookiesSkipped, warnings: [] };
	} catch (error) {
		return { injected: 0, containerCookiesSkipped: 0, warnings: [`headed-browser: grantCookies failed: ${error instanceof Error ? error.message : String(error)}`] };
	} finally {
		database?.close();
		await rm(tempDir, { recursive: true, force: true });
	}
}

function firefoxSameSite(value: number): "Strict" | "Lax" | "None" | undefined {
	if (value === 2) return "Strict";
	if (value === 1) return "Lax";
	if (value === 0) return "None";
	return undefined;
}

async function writeFirefoxUserJs(profileDir: string, downloadsDir: string, allowDownloads: boolean): Promise<void> {
	const preferences: Record<string, boolean | number | string> = {
		"app.update.auto": false,
		"app.update.enabled": false,
		"datareporting.healthreport.uploadEnabled": false,
		"toolkit.telemetry.enabled": false,
		"browser.shell.checkDefaultBrowser": false,
		"browser.sessionstore.resume_from_crash": false,
		"browser.download.folderList": 2,
		"browser.download.dir": downloadsDir,
		"browser.download.useDownloadDir": true,
	};
	if (!allowDownloads) preferences["browser.download.start_downloads_in_tmp_dir"] = true;
	const text = Object.entries(preferences).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n") + "\n";
	await writeFile(join(profileDir, "user.js"), text, { mode: 0o600 });
}

export async function directorySize(path: string): Promise<number> {
	let total = 0;
	for await (const entry of new Bun.Glob("**/*").scan({ cwd: path, absolute: true, onlyFiles: true })) {
		try { total += (await stat(entry)).size; } catch {}
	}
	return total;
}

export async function removeMaterializedProfile(profile: MaterializedProfile, keepArtifacts: boolean): Promise<string[]> {
	if (keepArtifacts) return [];
	const deleted = [profile.sessionDir];
	await rm(profile.sessionDir, { recursive: true, force: true });
	return deleted;
}
