import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveConfig } from "./lib/config.ts";
import type { RemoteResources } from "./lib/driver.ts";
import { closeRemote, launchLocal, loadPuppeteer, validateRemoteTarget, validateSshOptions } from "./lib/driver.ts";
import { classifyError } from "./lib/operations.ts";

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
    await launchLocal({ engine: "firefox", executablePath: "/browser", profileDir: "/profile", downloadsDir: "/downloads", config: config(await fakeDriver(), true) });
    const options = (globalThis as { __headedLaunchOptions?: { downloadBehavior?: { policy?: string; downloadPath?: string }; protocol?: string } }).__headedLaunchOptions;
    expect(options?.downloadBehavior).toEqual({ policy: "allow", downloadPath: "/downloads" });
    expect(options?.protocol).toBeUndefined();
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
		let cleanupTimeout: number | undefined = 0;
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

	describe("driver resolution", () => {
		test("bundled default exposes launch and connect", async () => {
			const module = await loadPuppeteer(config("", true));
			expect(typeof module.launch).toBe("function");
			expect(typeof module.connect).toBe("function");
		});

		test("explicit override wins", async () => {
			const path = await fakeDriver();
			const module = await loadPuppeteer(config(path, true));
			expect(typeof module.launch).toBe("function");
		});

		test("invalid override has an override-specific error and cause", async () => {
			try {
				await loadPuppeteer(config(join(tmpdir(), "missing-driver.mjs"), true));
				throw new Error("expected loadPuppeteer to reject");
			} catch (error) {
				expect(error).toMatchObject({ message: expect.stringContaining("driverModulePath override is invalid"), cause: expect.anything() });
			}
		});
	});

	describe("remote launch bounds", () => {
		const driverModule = JSON.stringify(join(import.meta.dir, "lib", "driver.ts"));
		const toolModule = JSON.stringify(join(import.meta.dir, "headed-browser-tools.ts"));

		/**
		 * A directory holding an `ssh` that plays every remote stage locally: the profile
		 * commands succeed at once, the browser publishes its BiDi endpoint and stays up, and
		 * the tunnel stays up. Paired with a driver whose `connect` never settles, a launch
		 * reaches the connect stage within a second and then hangs there.
		 */
		async function hangingConnectFixture(): Promise<{ bin: string; driver: string }> {
			const directory = await mkdtemp(join(tmpdir(), "headed-remote-test-"));
			temps.push(directory);
			const ssh = [
				"#!/bin/sh",
				'for arg in "$@"; do',
				'\tcase "$arg" in',
				"\t\tmktemp) echo /tmp/omp-headed-firefox-fixture; exit 0 ;;",
				"\t\tmkdir|rm) exit 0 ;;",
				"\t\t--remote-debugging-port) echo 'WebDriver BiDi listening on ws://127.0.0.1:9' >&2; exec sleep 30 ;;",
				"\t\t-N) exec sleep 30 ;;",
				"\tesac",
				"done",
				"exit 1",
			].join("\n");
			await writeFile(join(directory, "ssh"), `${ssh}\n`, { mode: 0o755 });
			const driver = join(directory, "driver.mjs");
			await writeFile(driver, "export async function launch() { return { close() {} }; }\nexport function connect() { return new Promise(() => {}); }\n");
			return { bin: directory, driver };
		}

		/**
		 * Runs `body` as a module in a child bun and returns what it logs as JSON. Bun resolves
		 * spawned commands from its startup PATH, so only a child sees the fixture `ssh`.
		 */
		function inChild<T>(bin: string, body: string, env: Record<string, string> = {}): T {
			const child = Bun.spawnSync([process.execPath, "-e", body], {
				env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 15_000,
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			return JSON.parse(child.stdout.toString()) as T;
		}

		const launch = (driver: string, navigationTimeoutMs: number, abortAfterMs?: number) => `
			import { launchRemote } from ${driverModule};
			const controller = new AbortController();
			if (${abortAfterMs ?? -1} >= 0) setTimeout(() => controller.abort(), ${abortAfterMs ?? 0});
			const started = Date.now();
			let message;
			try {
				await launchRemote({ remoteHost: "fixture-host", remoteBrowserPath: "/usr/bin/firefox", allowDownloads: false, navigationTimeoutMs: ${navigationTimeoutMs}, signal: controller.signal }, { driverModulePath: ${JSON.stringify(driver)}, allowDownloads: false });
			} catch (error) {
				message = error.message;
			}
			console.log(JSON.stringify({ elapsed: Date.now() - started, message }));
		`;

		test("a connect that outlasts its stage reports a timeout, not a capability gap", async () => {
			const { bin, driver } = await hangingConnectFixture();
			const { elapsed, message } = inChild<{ elapsed: number; message: string }>(bin, launch(driver, 3_000));
			expect(message).toBe("headed-browser: remote BiDi connect timed out after 3000 ms");
			expect(classifyError("launch", new Error(message))).toBe("session timeout");
			expect(elapsed).toBeLessThan(10_000);
		}, 20_000);

		test("the host signal stops a stage running under a configured timeout above 29 s", async () => {
			const { bin, driver } = await hangingConnectFixture();
			// The stage runs under the configured 60 s, so only the signal can end it this early.
			const { elapsed, message } = inChild<{ elapsed: number; message: string }>(bin, launch(driver, 60_000, 2_000));
			expect(message).toBe("headed-browser: remote BiDi connect cancelled");
			expect(elapsed).toBeLessThan(8_000);
		}, 20_000);

		test("a cancelled launch reports cancelled through headed_session", async () => {
			const { bin, driver } = await hangingConnectFixture();
			const agentDir = await mkdtemp(join(tmpdir(), "headed-remote-agent-"));
			temps.push(agentDir);
			const body = `
				import tool from ${toolModule};
				const z = new Proxy(function () {}, { get: () => z, apply: () => z });
				let execute;
				tool({ zod: z, registerTool: (definition) => { if (definition.name === "headed_session") execute = definition.execute; }, on: () => {} });
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 2_000);
				const started = Date.now();
				const result = await execute("id", { op: "launch", engine: "firefox", remoteHost: "fixture-host", remoteBrowserPath: "/usr/bin/firefox", navigationTimeoutMs: 60_000, ephemeralRoot: ${JSON.stringify(agentDir)} }, controller.signal, undefined, { cwd: ${JSON.stringify(agentDir)} });
				console.log(JSON.stringify({ elapsed: Date.now() - started, details: result.details, text: result.content[0].text }));
			`;
			const { elapsed, details, text } = inChild<{ elapsed: number; details: { ok: boolean; error: string }; text: string }>(bin, body, {
				HEADED_BROWSER_DRIVER_MODULE_PATH: driver,
				PI_CODING_AGENT_DIR: agentDir,
			});
			expect(details).toMatchObject({ ok: false, error: "cancelled" });
			expect(text).toContain("launch cancelled; no session launched");
			expect(elapsed).toBeLessThan(8_000);
		}, 20_000);
	});
});
