import {
	execFile as execFileCallback,
	spawn as spawnProcess,
} from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const DEFAULT_WEBHOOK_EVENTS = [
	"pull_request",
	"check_run",
	"check_suite",
	"status",
	"workflow_run",
];

function runtimeEnv(dataDir, env) {
	return {
		...env,
		GH_NO_UPDATE_NOTIFIER: "1",
		XDG_DATA_HOME: dataDir,
	};
}

async function settleWithin(promise, timeoutMs) {
	let timer;
	const result = await Promise.race([
		promise.then((value) => ({ settled: true, value })),
		new Promise((resolve) => {
			timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
		}),
	]);
	clearTimeout(timer);
	return result;
}

export async function ensureGhWebhookExtension({
	dataDir,
	env = process.env,
	execFileFn = execFile,
} = {}) {
	if (!dataDir) throw new Error("dataDir is required");
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const childEnv = runtimeEnv(dataDir, env);
	const { stdout } = await execFileFn("gh", ["extension", "list"], {
		env: childEnv,
	});
	const installed = stdout
		.split("\n")
		.some((line) => line.split("\t").slice(0, 2).includes("cli/gh-webhook"));
	if (!installed) {
		await execFileFn("gh", ["extension", "install", "cli/gh-webhook"], {
			env: childEnv,
		});
	}
	return childEnv;
}

export function buildForwardArgs({
	repository,
	organization,
	events,
	secret,
	url,
}) {
	if (Boolean(repository) === Boolean(organization)) {
		throw new Error("exactly one of repository or organization is required");
	}
	if (!secret) throw new Error("secret is required");
	if (!url) throw new Error("url is required");
	const scope = repository ? `--repo=${repository}` : `--org=${organization}`;
	// cli/gh-webhook v0.2.0 accepts its signing secret only as an argument, so this
	// development transport is restricted to a trusted single-user process boundary.
	return [
		"webhook",
		"forward",
		scope,
		`--events=${(events ?? DEFAULT_WEBHOOK_EVENTS).join(",")}`,
		`--secret=${secret}`,
		`--url=${url}`,
	];
}

export async function startGhWebhookForwarder({
	dataDir,
	repository,
	organization,
	events = DEFAULT_WEBHOOK_EVENTS,
	secret,
	url,
	env = process.env,
	execFileFn = execFile,
	spawnFn = spawnProcess,
	stdout = process.stdout,
	stderr = process.stderr,
}) {
	const childEnv = await ensureGhWebhookExtension({ dataDir, env, execFileFn });
	const args = buildForwardArgs({
		repository,
		organization,
		events,
		secret,
		url,
	});
	const child = spawnFn("gh", args, {
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.pipe(stdout);
	child.stderr?.pipe(stderr);

	const exit = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});

	return {
		child,
		exit,
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return exit;
			child.kill("SIGINT");
			let result = await settleWithin(exit, 10_000);
			if (result.settled) return result.value;
			child.kill("SIGTERM");
			result = await settleWithin(exit, 5_000);
			if (result.settled) return result.value;
			child.kill("SIGKILL");
			return exit;
		},
	};
}

export async function readGhToken({
	env = process.env,
	execFileFn = execFile,
} = {}) {
	if (env.GH_TOKEN) return env.GH_TOKEN;
	if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
	const { stdout } = await execFileFn("gh", ["auth", "token"], { env });
	const token = stdout.trim();
	if (!token) throw new Error("gh auth token returned an empty token");
	return token;
}
