import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import type { EffectiveConfig } from "./lib/config.ts";
import { assertProfileIsolation, copyProfile, grantCookiesFromSource, materializeProfile, pruneProfile, scopeFirefoxCookies, shouldCopy } from "./lib/profile.ts";

const temps: string[] = [];

afterEach(async () => {
	await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "headed-profile-test-"));
	temps.push(path);
	return path;
}

describe("headed browser profile cloning", () => {
	test("creates a clean session directory without colliding with mkdtemp", async () => {
		const root = await temporary();
		const profile = await materializeProfile({
			engine: "firefox",
			channel: "zen",
			profileMode: "clean",
			agentDir: root,
			config: { ephemeralRoot: root, cookieDomains: "", copyStrategy: "node", copyFirefoxLogins: false, allowDownloads: true } as EffectiveConfig,
		});
		expect(existsSync(profile.profileDir)).toBe(true);
		expect(existsSync(profile.downloadsDir)).toBe(true);
	});

	test("filters volatile and login state but preserves authentication support", () => {
		for (const path of ["cache2/x", "lock", ".parentlock", "logins.json", "key4.db"]) expect(shouldCopy(path, false)).toBe(false);
		for (const path of ["cert9.db", "pkcs11.txt", "extensions/addon.xpi", "storage/default/site/idb"]) expect(shouldCopy(path, false)).toBe(true);
		expect(shouldCopy("logins.json", true)).toBe(true);
	});

	test("node strategy copies a filtered fixture tree", async () => {
		const root = await temporary();
		const source = join(root, "source"); const destination = join(root, "destination");
		await mkdir(join(source, "cache2"), { recursive: true });
		await mkdir(join(source, "extensions"), { recursive: true });
		await writeFile(join(source, "prefs.js"), "prefs");
		await writeFile(join(source, "cache2", "drop"), "drop");
		await writeFile(join(source, "extensions", "keep"), "keep");
		await writeFile(join(source, "logins.json"), "secret");
		const warnings: string[] = [];
		await copyProfile(source, destination, "node", false, warnings);
		expect(existsSync(join(destination, "prefs.js"))).toBe(true);
		expect(existsSync(join(destination, "extensions", "keep"))).toBe(true);
		expect(existsSync(join(destination, "cache2"))).toBe(false);
		expect(existsSync(join(destination, "logins.json"))).toBe(false);
		expect(warnings).toEqual([]);
	});

	test("prunes exclusions after a wholesale copy", async () => {
		const root = await temporary();
		await mkdir(join(root, "cache2"), { recursive: true });
		await writeFile(join(root, "cache2", "entry"), "x");
		await writeFile(join(root, ".parentlock"), "x");
		await pruneProfile(root, false);
		expect(existsSync(join(root, "cache2"))).toBe(false);
		expect(existsSync(join(root, ".parentlock"))).toBe(false);
	});

	test("refuses a destination that resolves to the source", async () => {
		const root = await temporary();
		await expect(assertProfileIsolation(root, root)).rejects.toThrow("refusing to launch against the live profile");
	});

	test("scopes cookies to requested default-jar hosts and counts container rows", async () => {
		const root = await temporary();
		const path = join(root, "cookies.sqlite");
		const database = new Database(path, { create: true });
		database.run("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT, originAttributes TEXT, name TEXT, value TEXT)");
		database.run("INSERT INTO moz_cookies VALUES (1, '.example.com', '', 'keep', '1'), (2, 'other.com', '', 'drop', '2'), (3, '.example.com', '^userContextId=1', 'container', '3')");
		database.close();
		const result = await scopeFirefoxCookies(path, ["example.com"]);
		const check = new Database(path, { readonly: true });
		const rows = check.query("SELECT host FROM moz_cookies ORDER BY id").all();
		check.close();
		expect(rows).toEqual([{ host: ".example.com" }]);
		expect(result.containerCookiesSkipped).toBe(1);
	});

	test("an empty cookie scope deletes every row", async () => {
		const root = await temporary();
		const path = join(root, "cookies.sqlite");
		const database = new Database(path, { create: true });
		database.run("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT, originAttributes TEXT)");
		database.run("INSERT INTO moz_cookies VALUES (1, 'example.com', '')");
		database.close();
		await scopeFirefoxCookies(path, []);
		const check = new Database(path, { readonly: true });
		expect(check.query("SELECT * FROM moz_cookies").all()).toEqual([]);
		check.close();
	});

	test("copies an active WAL database before injecting scoped cookies", async () => {
		const root = await temporary();
		const source = join(root, "source");
		await mkdir(source, { recursive: true });
		const database = new Database(join(source, "cookies.sqlite"), { create: true });
		database.run("PRAGMA journal_mode=WAL");
		database.run("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)");
		database.run("INSERT INTO moz_cookies VALUES (1, 'sid', 'secret', '.assistant.vxsan.com', '/', 2000000000, 1, 1, 1, '')");
		const injected: Array<Record<string, unknown>> = [];
		const page = { async setCookie(...cookies: Array<Record<string, unknown>>) { injected.push(...cookies); } } as unknown as Page;
		const result = await grantCookiesFromSource(page, source, ["assistant.vxsan.com"], root);
		database.close();
		expect(result.warnings).toEqual([]);
		expect(result.injected).toBe(1);
		expect(injected[0]?.domain).toBe(".assistant.vxsan.com");
	});
});
