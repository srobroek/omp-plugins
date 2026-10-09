import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

	describe("native copy bounds", () => {
		const profileModule = JSON.stringify(join(import.meta.dir, "lib", "profile.ts"));
		type CopyOutcome = { elapsed: number; ticks: number; message?: string; warnings: string[] };

		/** A source profile plus a `bin` directory whose `cp` runs `body` in place of the real copy. */
		async function nativeCopyFixture(body: string): Promise<{ bin: string; source: string; destination: string }> {
			const root = await temporary();
			const bin = join(root, "bin");
			const source = join(root, "source");
			const destination = join(root, "destination");
			await mkdir(bin);
			await mkdir(source);
			await mkdir(destination);
			await writeFile(join(source, "prefs.js"), "prefs");
			await writeFile(join(bin, "cp"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
			return { bin, source, destination };
		}

		/**
		 * Runs one clonefile copy in a child bun and reports how it ended. Bun resolves spawned
		 * commands from its startup PATH, so only a child sees the fixture `cp`. `ticks` counts
		 * a 100 ms interval, which only advances while the copy leaves the event loop free.
		 */
		function copyInChild(fixture: { bin: string; source: string; destination: string }, args: { timeoutMs?: number; abortAfterMs?: number }): CopyOutcome {
			const body = `
				import { copyProfile } from ${profileModule};
				const controller = new AbortController();
				const abortAfterMs = ${args.abortAfterMs ?? "undefined"};
				if (abortAfterMs !== undefined) setTimeout(() => controller.abort(), abortAfterMs);
				let ticks = 0;
				const ticker = setInterval(() => { ticks += 1; }, 100);
				const warnings = [];
				const started = Date.now();
				let message;
				try {
					await copyProfile(${JSON.stringify(fixture.source)}, ${JSON.stringify(fixture.destination)}, "clonefile", false, warnings, controller.signal, ${args.timeoutMs ?? "undefined"});
				} catch (error) {
					message = error.message;
				}
				clearInterval(ticker);
				console.log(JSON.stringify({ elapsed: Date.now() - started, ticks, message, warnings }));
			`;
			const child = Bun.spawnSync([process.execPath, "-e", body], {
				env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 15_000,
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			return JSON.parse(child.stdout.toString()) as CopyOutcome;
		}

		test("a copy that outlasts its bound fails clearly instead of falling back to node", async () => {
			const fixture = await nativeCopyFixture("exec sleep 8");
			const outcome = copyInChild(fixture, { timeoutMs: 2_000 });
			expect(outcome.message).toBe("headed-browser: profile copy (clonefile) exceeded 2 s; no session launched");
			expect(outcome.warnings).toEqual([]);
			expect(outcome.elapsed).toBeLessThan(6_000);
			expect(existsSync(join(fixture.destination, "prefs.js"))).toBe(false);
		}, 20_000);

		test("the host signal cancels a running copy without blocking the event loop", async () => {
			const fixture = await nativeCopyFixture("exec sleep 8");
			const outcome = copyInChild(fixture, { abortAfterMs: 2_000 });
			expect(outcome.message).toBe("headed-browser: profile copy (clonefile) cancelled; no session launched");
			expect(outcome.elapsed).toBeLessThan(6_000);
			expect(outcome.ticks).toBeGreaterThanOrEqual(10);
			expect(existsSync(fixture.destination)).toBe(false);
		}, 20_000);

		test("a failed native copy still falls back to node", async () => {
			const fixture = await nativeCopyFixture("echo 'clone unsupported' >&2; exit 3");
			const outcome = copyInChild(fixture, {});
			expect(outcome.message).toBeUndefined();
			expect(outcome.warnings).toEqual(["headed-browser: clonefile profile copy failed; fell back to node (clone unsupported)"]);
			expect(existsSync(join(fixture.destination, "prefs.js"))).toBe(true);
		}, 20_000);
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
    test("aborts when cookie schema cannot prove scoping", async () => {
        const root = await temporary();
        const path = join(root, "cookies.sqlite");
        const database = new Database(path, { create: true });
        database.run("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT)");
        database.close();
        await expect(scopeFirefoxCookies(path, ["example.com"])).rejects.toThrow("cookie isolation cannot be proven");
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
