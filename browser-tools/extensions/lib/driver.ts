import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import type { Browser, ConnectOptions, LaunchOptions } from "puppeteer-core";
import type { EffectiveConfig, Engine } from "./config.ts";

export interface PuppeteerModule {
	launch(options: LaunchOptions): Promise<Browser>;
	connect(options: ConnectOptions): Promise<Browser>;
}

export interface LocalLaunchRequest {
	engine: Engine;
	executablePath: string;
	profileDir: string;
	downloadsDir: string;
	config: EffectiveConfig;
}

export interface RemoteLaunchRequest {
	remoteHost: string;
	remoteBrowserPath: string;
	sshOptions?: string;
	allowDownloads: boolean;
	navigationTimeoutMs: number;
	/** Host cancellation: stops the running stage and cleans up what earlier stages started. */
	signal?: AbortSignal;
}

export interface RemoteResources {
	browser: Browser;
	browserProcess: Bun.Subprocess;
	tunnelProcess: Bun.Subprocess;
	remoteProfileDir: string;
	remoteHost: string;
	sshArgs: string[];
	timeoutMs: number;
}

export async function loadPuppeteer(config: Pick<EffectiveConfig, "driverModulePath">): Promise<PuppeteerModule> {
	const override = config.driverModulePath;
	try {
		// An explicit path is authoritative; the empty setting selects the bundled static import.
		const module = override
			? await import(pathToFileURL(override).href)
			: await import("puppeteer-core");
		if (typeof module.launch !== "function" || typeof module.connect !== "function") {
			throw new Error("module has no launch/connect exports");
		}
		return module as PuppeteerModule;
	} catch (cause) {
		if (override) {
			throw new Error(`headed-browser: driverModulePath override is invalid: ${override}`, { cause });
		}
		throw new Error("headed-browser: bundled puppeteer-core driver is corrupt or unavailable", { cause });
	}
}

export async function launchLocal(request: LocalLaunchRequest): Promise<Browser> {
	const puppeteer = await loadPuppeteer(request.config);
	const args: string[] = [];
	if (request.config.noRemote && request.engine === "firefox") args.push("--no-remote");
	if (process.platform === "darwin" && !request.config.headless) args.push("--foreground");
	const options: LaunchOptions = {
		browser: request.engine,
		executablePath: request.executablePath,
		headless: request.config.headless,
		userDataDir: request.profileDir,
		protocol: undefined,
		downloadBehavior: request.config.allowDownloads
			? { policy: "allow", downloadPath: request.downloadsDir }
			: { policy: "deny" },
		timeout: request.config.navigationTimeoutMs,
		args,
	};
	return puppeteer.launch(options);
}

export async function launchRemote(
	request: RemoteLaunchRequest,
	config: Pick<EffectiveConfig, "driverModulePath" | "allowDownloads">,
): Promise<RemoteResources> {
	validateRemoteTarget(request.remoteHost, request.remoteBrowserPath);
	const sshArgs = parseSshOptions(request.sshOptions ?? "-o BatchMode=yes -o StrictHostKeyChecking=yes");
	validateSshOptions(sshArgs);
	// Every stage gets the configured navigation timeout, which the config already bounds to
	// 1-300 s; a registered tool has no harness deadline that would cut it shorter.
	const stageTimeoutMs = request.navigationTimeoutMs;
	const { signal } = request;
	const remoteProfileDir = await sshCapture(sshArgs, request.remoteHost, ["mktemp", "-d", "/tmp/omp-headed-firefox-XXXXXXXX"], stageTimeoutMs, signal);
	validateRemotePath(remoteProfileDir, "remote profile directory");
	await sshCapture(sshArgs, request.remoteHost, ["mkdir", "-p", `${remoteProfileDir}/downloads`], stageTimeoutMs, signal);
	const browserProcess = Bun.spawn(
		[
			"ssh",
			...sshArgs,
			request.remoteHost,
			request.remoteBrowserPath,
			"--headless",
			"--no-remote",
			"--profile",
			remoteProfileDir,
			"--remote-debugging-port",
			"0",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	let endpoint: string;
	try {
		endpoint = await readBidiEndpoint(browserProcess.stderr, stageTimeoutMs, signal);
	} catch (error) {
		browserProcess.kill();
		await sshCapture(sshArgs, request.remoteHost, ["rm", "-rf", remoteProfileDir], stageTimeoutMs).catch(() => undefined);
		throw error;
	}
	const remotePort = new URL(endpoint).port;
	const localPort = await reserveLocalPort();
	const tunnelProcess = Bun.spawn(
		["ssh", ...sshArgs, "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, request.remoteHost],
		{ stdout: "ignore", stderr: "pipe" },
	);
	if (tunnelProcess.exitCode !== null) {
		browserProcess.kill();
		await sshCapture(sshArgs, request.remoteHost, ["rm", "-rf", remoteProfileDir], stageTimeoutMs).catch(() => undefined);
		throw new Error(`headed-browser: SSH tunnel exited with ${tunnelProcess.exitCode}`);
	}
	const connectStage = stageSignals(stageTimeoutMs, signal);
	try {
		const puppeteer = await loadPuppeteer(config);
		// Puppeteer connect has no reliable BiDi timeout, so this stage carries its own.
		const browser = await Promise.race([
			puppeteer.connect({
				browserWSEndpoint: `ws://127.0.0.1:${localPort}/session`,
				protocol: "webDriverBiDi",
				downloadBehavior: config.allowDownloads
					? { policy: "allow", downloadPath: `${remoteProfileDir}/downloads` }
					: { policy: "deny" },
			}),
			whenStopped(connectStage.stop),
		]);
		return { browser, browserProcess, tunnelProcess, remoteProfileDir, remoteHost: request.remoteHost, sshArgs, timeoutMs: request.navigationTimeoutMs };
	} catch {
		// Read before cleanup, which can outlast the stage timer: a stopped stage is a timeout
		// or a cancellation, never a capability gap.
		const stopped = signal?.aborted ? "cancelled" : connectStage.timeout.aborted ? `timed out after ${stageTimeoutMs} ms` : undefined;
		tunnelProcess.kill();
		browserProcess.kill();
		await sshCapture(sshArgs, request.remoteHost, ["rm", "-rf", remoteProfileDir], stageTimeoutMs).catch(() => undefined);
		if (stopped) throw new Error(`headed-browser: remote BiDi connect ${stopped}`);
		throw new Error("headed-browser: remote BiDi connect unsupported by puppeteer-core; use a local session");
	}
}

/**
 * One remote launch stage's stop signal: its timeout or the host's cancellation, whichever
 * comes first. `AbortSignal.timeout` holds no reference on the event loop, so a long
 * configured timeout never keeps the process alive after the stage has settled.
 */
function stageSignals(timeoutMs: number, signal: AbortSignal | undefined): { timeout: AbortSignal; stop: AbortSignal } {
	const timeout = AbortSignal.timeout(timeoutMs);
	return { timeout, stop: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

/** Never resolves; rejects once `stop` aborts. */
function whenStopped(stop: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (stop.aborted) reject(stop.reason);
		else stop.addEventListener("abort", () => reject(stop.reason), { once: true });
	});
}

export async function closeRemote(
	resources: RemoteResources,
	capture: typeof sshCapture = sshCapture,
): Promise<void> {
	await Promise.race([
		resources.browser.close().catch(() => undefined),
		Bun.sleep(resources.timeoutMs),
	]);
	resources.tunnelProcess.kill();
	resources.browserProcess.kill();
	await capture(resources.sshArgs, resources.remoteHost, ["rm", "-rf", resources.remoteProfileDir], resources.timeoutMs).catch(() => undefined);
}

export function validateRemoteTarget(host: string, browserPath: string): void {
	if (!host || host.startsWith("-") || !/^[A-Za-z0-9._@:\-]+$/.test(host)) {
		throw new Error("headed-browser: remoteHost contains unsupported SSH characters");
	}
	validateRemotePath(browserPath, "remoteBrowserPath");
}

function validateRemotePath(path: string, label: string): void {
	if (!/^\/[A-Za-z0-9._/+\-:]+$/.test(path) || path.split("/").includes("..")) {
		throw new Error(`headed-browser: ${label} must be an absolute shell-safe POSIX path`);
	}
}

export function parseSshOptions(input: string): string[] {
	const values: string[] = [];
	let current = "";
	let quote = "";
	let escaped = false;
	for (const character of input) {
		if (escaped) { current += character; escaped = false; continue; }
		if (character === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) {
			if (character === quote) quote = "";
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; continue; }
		if (/\s/.test(character)) {
			if (current) { values.push(current); current = ""; }
			continue;
		}
		current += character;
	}
	if (quote || escaped) throw new Error("headed-browser: malformed sshOptions");
	if (current) values.push(current);
	return values;
}

export function validateSshOptions(options: string[]): void {
	const valueOptions: Record<string, true> = { "-i": true, "-l": true, "-p": true };
	const booleanOptions: Record<string, true> = { "-4": true, "-6": true };
	const allowedConfig: Record<string, true> = {
		BatchMode: true, ConnectTimeout: true, IdentitiesOnly: true,
		ServerAliveCountMax: true, ServerAliveInterval: true, StrictHostKeyChecking: true,
	};
	for (let index = 0; index < options.length; index += 1) {
		const option = options[index]!;
		if (Object.prototype.hasOwnProperty.call(booleanOptions, option)) continue;
		if (Object.prototype.hasOwnProperty.call(valueOptions, option)) {
			const value = options[++index];
			if (!value || value.startsWith("-")) throw new Error(`headed-browser: ${option} requires a value`);
			if (option === "-p" && !/^\d{1,5}$/.test(value)) throw new Error("headed-browser: SSH port must be numeric");
			continue;
		}
		if (option === "-o") {
			const assignment = options[++index];
			const separator = assignment?.indexOf("=") ?? -1;
			const key = separator > 0 ? assignment!.slice(0, separator) : "";
			if (!Object.prototype.hasOwnProperty.call(allowedConfig, key)) throw new Error(`headed-browser: unsupported SSH option ${assignment ?? "<missing>"}`);
			continue;
		}
		throw new Error(`headed-browser: unsupported SSH option ${option}`);
	}
}

async function readBidiEndpoint(stream: ReadableStream<Uint8Array>, timeoutMs: number, signal?: AbortSignal): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const ended = { done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>;
	const stopped = whenStopped(stageSignals(timeoutMs, signal).stop).catch(() => ended);
	for (;;) {
		const result = await Promise.race([reader.read(), stopped]);
		if (result.done) break;
		buffer += decoder.decode(result.value, { stream: true });
		const match = buffer.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+(?:\/\S*)?)/);
		if (match?.[1]) return match[1];
		if (buffer.length > 16_384) buffer = buffer.slice(-8192);
	}
	if (signal?.aborted) throw new Error("headed-browser: remote Firefox launch cancelled");
	throw new Error(`headed-browser: remote Firefox did not publish a WebDriver BiDi endpoint: ${buffer.trim().slice(-500)}`);
}

async function sshCapture(sshArgs: string[], host: string, command: string[], timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
	const { timeout, stop } = stageSignals(timeoutMs, signal);
	// The stop signal kills ssh, so a timed-out or cancelled stage leaves no process behind.
	const process = Bun.spawn(["ssh", ...sshArgs, host, ...command], { stdout: "pipe", stderr: "pipe", signal: stop });
	const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
	if (signal?.aborted) throw new Error(`headed-browser: ssh ${host} cancelled`);
	if (timeout.aborted) throw new Error(`headed-browser: ssh ${host} timed out after ${timeoutMs} ms`);
	if (exitCode !== 0) throw new Error(`headed-browser: ssh ${host} failed: ${stderr.trim() || `exit ${exitCode}`}`);
	return stdout.trim();
}

async function reserveLocalPort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("headed-browser: cannot allocate local SSH tunnel port"));
				return;
			}
			const port = address.port;
			server.close((error) => error ? reject(error) : resolvePort(port));
		});
	});
}
