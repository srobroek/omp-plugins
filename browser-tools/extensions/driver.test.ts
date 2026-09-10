import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveConfig } from "./lib/config.ts";
import type { RemoteResources } from "./lib/driver.ts";
import { closeRemote, launchLocal, validateRemoteTarget, validateSshOptions } from "./lib/driver.ts";

const temps: string[] = [];

afterEach(async () => {
	delete (globalThis as { __headedLaunchOptions?: unknown }).__headedLaunchOptions;
	await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeDriver(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "headed-driver-test-"));
	temps.push(directory);
	const path = join(directory, "driver.mjs");
	await writeFile(path, `export async function launch(options) { globalThis.__headedLaunchOptions = options; return { close() {} }; }\nexport async function connect() { return { close() {} }; }\n`);
	return path;
}

function config(driverModulePath: string, allowDownloads: boolean): EffectiveConfig {
	return {
		driverModulePath,
		allowDownloads,
		noRemote: true,
		headless: true,
		navigationTimeoutMs: 30000,
	} as EffectiveConfig;
}

describe("headed browser driver", () => {
	test("denies downloads at the BiDi browser boundary", async () => {
		await launchLocal({ engine: "firefox", executablePath: "/browser", profileDir: "/profile", downloadsDir: "/downloads", config: config(await fakeDriver(), false) });
		const options = (globalThis as { __headedLaunchOptions?: { downloadBehavior?: { policy?: string } } }).__headedLaunchOptions;
		expect(options?.downloadBehavior).toEqual({ policy: "deny" });
	});

	test("routes allowed downloads into the session directory", async () => {
		await launchLocal({ engine: "chrome", executablePath: "/browser", profileDir: "/profile", downloadsDir: "/downloads", config: config(await fakeDriver(), true) });
		const options = (globalThis as { __headedLaunchOptions?: { downloadBehavior?: { policy?: string; downloadPath?: string }; protocol?: string } }).__headedLaunchOptions;
		expect(options?.downloadBehavior).toEqual({ policy: "allow", downloadPath: "/downloads" });
		expect(options?.protocol).toBe("webDriverBiDi");
	});
	test("rejects remote values that can alter the SSH command", () => {
		expect(() => validateRemoteTarget("ci@runner.example.com", "/usr/bin/firefox")).not.toThrow();
		expect(() => validateRemoteTarget("-oProxyCommand=touch/tmp/pwned", "/usr/bin/firefox")).toThrow("remoteHost contains unsupported SSH characters");
		expect(() => validateRemoteTarget("runner.example.com", "/usr/bin/firefox;touch/tmp/pwned")).toThrow("absolute shell-safe POSIX path");
		expect(() => validateRemoteTarget("runner.example.com", "/opt/Firefox Nightly/firefox")).toThrow("absolute shell-safe POSIX path");
		expect(() => validateRemoteTarget("runner.example.com", "/usr/../bin/firefox")).toThrow("absolute shell-safe POSIX path");
	});

	test("allowlists SSH options that cannot execute or redirect commands", () => {
		expect(() => validateSshOptions(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-p", "22"])).not.toThrow();
		expect(() => validateSshOptions(["-o", "ProxyCommand=touch /tmp/pwned"])).toThrow("unsupported SSH option");
		expect(() => validateSshOptions(["-F", "/tmp/config"])).toThrow("unsupported SSH option -F");
		expect(() => validateSshOptions(["-L", "8080:localhost:80"])).toThrow("unsupported SSH option -L");
		expect(() => validateSshOptions(["-o", "constructor=evil"])).toThrow("unsupported SSH option");
		expect(() => validateSshOptions(["-o", "__proto__=evil"])).toThrow("unsupported SSH option");
		expect(() => validateSshOptions(["constructor"])).toThrow("unsupported SSH option constructor");
		expect(() => validateSshOptions(["__proto__"])).toThrow("unsupported SSH option __proto__");
	});

	test("bounds a stalled browser close and passes the timeout to SSH cleanup", async () => {
		let cleanupTimeout = 0;
		let killed = 0;
		const processState = { kill: () => { killed += 1; } };
		const browserState = { close: () => new Promise<void>(() => undefined) };
		// RemoteResources is represented by the cleanup contract exercised by closeRemote.
		const resources = {
			browser: browserState,
			browserProcess: processState,
			tunnelProcess: processState,
			remoteProfileDir: "/tmp/omp-headed-firefox-test",
			remoteHost: "runner.example.com",
			sshArgs: ["-o", "BatchMode=yes"],
			timeoutMs: 17,
		} as unknown as RemoteResources;
		await closeRemote(resources, async (_sshArgs, _host, _command, timeoutMs) => {
			cleanupTimeout = timeoutMs;
			return "";
		});
		expect(cleanupTimeout).toBe(17);
		expect(killed).toBe(2);
	});

});
