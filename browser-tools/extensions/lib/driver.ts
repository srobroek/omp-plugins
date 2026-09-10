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
	try {
		// Runtime-selected driver paths support host installations without adding a bundled dependency.
		const module = config.driverModulePath
			? await import(pathToFileURL(config.driverModulePath).href)
			: await import("puppeteer-core");
		if (typeof module.launch !== "function" || typeof module.connect !== "function") throw new Error("module has no launch/connect exports");
		return module as PuppeteerModule;
	} catch {
		throw new Error(
			"headed-browser: puppeteer-core not resolvable; set the driverModulePath setting to <omp install>/node_modules/.mise/puppeteer-core@<version>/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js",
		);
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
		protocol: request.engine === "chrome" ? "webDriverBiDi" : undefined,
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
	const remoteProfileDir = await sshCapture(sshArgs, request.remoteHost, ["mktemp", "-d", "/tmp/omp-headed-firefox-XXXXXXXX"], request.navigationTimeoutMs);
	validateRemotePath(remoteProfileDir, "remote profile directory");
	await sshCapture(sshArgs, request.remoteHost, ["mkdir", "-p", `${remoteProfileDir}/downloads`], request.navigationTimeoutMs);
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
		endpoint = await readBidiEndpoint(browserProcess.stderr, request.navigationTimeoutMs);
	} catch (error) {
		browserProcess.kill();
		await sshCapture(sshArgs, request.remoteHost, ["rm", "-rf", remoteProfileDir], request.navigationTimeoutMs).catch(() => undefined);
		throw error;
	}
	const remotePort = new URL(endpoint).port;
	const localPort = await reserveLocalPort();
	const tunnelProcess = Bun.spawn(
		["ssh", ...sshArgs, "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, request.remoteHost],
		{ stdout: "ignore", stderr: "pipe" },
	);
	await Bun.sleep(250);
	if (tunnelProcess.exitCode !== null) {
		browserProcess.kill();
		throw new Error(`headed-browser: SSH tunnel exited with ${tunnelProcess.exitCode}`);
	}
	try {
		const puppeteer = await loadPuppeteer(config);
		const browser = await puppeteer.connect({
			browserWSEndpoint: `ws://127.0.0.1:${localPort}/session`,
			protocol: "webDriverBiDi",
			downloadBehavior: config.allowDownloads
				? { policy: "allow", downloadPath: `${remoteProfileDir}/downloads` }
				: { policy: "deny" },
		});
		return { browser, browserProcess, tunnelProcess, remoteProfileDir, remoteHost: request.remoteHost, sshArgs, timeoutMs: request.navigationTimeoutMs };
	} catch {
		tunnelProcess.kill();
		browserProcess.kill();
		await sshCapture(sshArgs, request.remoteHost, ["rm", "-rf", remoteProfileDir], request.navigationTimeoutMs).catch(() => undefined);
		throw new Error("headed-browser: remote BiDi connect unsupported by puppeteer-core; use a local session");
	}
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

async function readBidiEndpoint(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now());
		const result = await Promise.race([
			reader.read(),
			Bun.sleep(remaining).then(() => ({ done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>)),
		]);
		if (result.done) break;
		buffer += decoder.decode(result.value, { stream: true });
		const match = buffer.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+(?:\/\S*)?)/);
		if (match?.[1]) return match[1];
		if (buffer.length > 16_384) buffer = buffer.slice(-8192);
	}
	throw new Error(`headed-browser: remote Firefox did not publish a WebDriver BiDi endpoint: ${buffer.trim().slice(-500)}`);
}

async function sshCapture(sshArgs: string[], host: string, command: string[], timeoutMs = 15_000): Promise<string> {
	const process = Bun.spawn(["ssh", ...sshArgs, host, ...command], { stdout: "pipe", stderr: "pipe" });
	const stdoutPromise = new Response(process.stdout).text();
	const stderrPromise = new Response(process.stderr).text();
	const timedOut = Symbol("ssh-timeout");
	const exitCode = await Promise.race([
		process.exited,
		// The return annotation keeps the `unique symbol` from widening to `symbol`,
		// so the identity check below narrows `exitCode` to a number.
		Bun.sleep(timeoutMs).then((): typeof timedOut => { process.kill(); return timedOut; }),
	]);
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	if (exitCode === timedOut) throw new Error(`headed-browser: ssh ${host} timed out after ${timeoutMs} ms`);
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
