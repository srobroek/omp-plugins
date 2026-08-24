import { homedir } from "node:os";
import { join } from "node:path";
import { readGhToken, startGhWebhookForwarder } from "./gh-webhook.js";
import { errorMessage } from "./error-message.js";
import { ReleaseQueueState } from "./queue-state.js";
import { PollingReconciler } from "./reconciler.js";
import { OctokitRestAdapter } from "./rest-adapter.js";
import { loadOrCreateWebhookSecret } from "./secret-store.js";
import { createWebhookReceiver } from "./webhook-receiver.js";

function integer(
	value,
	name,
	{ minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {},
) {
	const parsed = Number(value);
	if (
		typeof value !== "string" ||
		!/^\d+$/.test(value) ||
		!Number.isSafeInteger(parsed) ||
		parsed < minimum ||
		parsed > maximum
	) {
		throw new Error(
			`${name} must be an integer from ${minimum} through ${maximum}`,
		);
	}
	return parsed;
}

function readOption(argv, index) {
	const [name, inline] = argv[index].split("=", 2);
	if (inline !== undefined) return { name, value: inline, consumed: 1 };
	if (argv[index + 1] === undefined)
		throw new Error(`${name} requires a value`);
	return { name, value: argv[index + 1], consumed: 2 };
}

export function parseArgs(argv, env = process.env) {
	const options = {
		host: "127.0.0.1",
		port: 0,
		maxMergeSlots: 1,
		pollIntervalMs: 60_000,
	};
	for (let index = 0; index < argv.length; ) {
		if (argv[index] === "--") {
			index += 1;
			continue;
		}
		if (argv[index] === "--help" || argv[index] === "-h") {
			options.help = true;
			index += 1;
			continue;
		}
		const option = readOption(argv, index);
		if (option.name === "--repo") options.repository = option.value;
		else if (option.name === "--host") options.host = option.value;
		else if (option.name === "--port") {
			options.port = integer(option.value, "port", { maximum: 65_535 });
		} else if (option.name === "--slots") {
			options.maxMergeSlots = integer(option.value, "slots", { minimum: 1 });
		} else if (option.name === "--poll-interval-ms") {
			options.pollIntervalMs = integer(option.value, "poll-interval-ms", {
				minimum: 1_000,
			});
		} else if (option.name === "--state-dir") options.stateDir = option.value;
		else throw new Error(`unknown option: ${option.name}`);
		index += option.consumed;
	}
	if (options.help) return options;
	if (!options.repository || !/^[^/]+\/[^/]+$/.test(options.repository)) {
		throw new Error("--repo must be an owner/name repository");
	}
	const stateRoot = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	options.stateDir ??= join(
		stateRoot,
		"release-queue-watch",
		options.repository.replace("/", "--"),
	);
	return options;
}

export async function startReleaseQueueRuntime(options, dependencies = {}) {
	const logger = dependencies.logger ?? console;
	const wakeDispatcher = dependencies.wakeDispatcher;
	const publish = (record, error = false) => {
		logger[error ? "error" : "log"](JSON.stringify(record));
		void wakeDispatcher?.enqueue(record).catch((wakeError) =>
			logger.error(
				JSON.stringify({
					type: "wake-error",
					message: errorMessage(wakeError),
				}),
			),
		);
	};
	const secretRecord = await loadOrCreateWebhookSecret(
		options.stateDir,
		dependencies.secretOptions,
	);
	const token = await (dependencies.readToken ?? readGhToken)({
		env: dependencies.env,
	});
	const onLifecycle =
		dependencies.onLifecycle ??
		((record) => publish(record));
	const queue =
		dependencies.queue ??
		new ReleaseQueueState({
			maxMergeSlots: options.maxMergeSlots,
			onLifecycle,
		});
	const adapter = dependencies.adapter ?? new OctokitRestAdapter({ token });
	const onDispatch =
		dependencies.onDispatch ??
		((item) => publish({ type: "dispatch", pullRequest: item }));
	const reconciler = new PollingReconciler({
		repositories: [options.repository],
		adapter,
		queue,
		intervalMs: options.pollIntervalMs,
		onDispatch,
		onError: (error, repository) =>
			publish(
				{
					type: "reconcile-error",
					repository,
					message: error.message,
				},
				true,
			),
	});
	const receiver = await createWebhookReceiver({
		secret: secretRecord.secret,
		queue,
		host: options.host,
		port: options.port,
		onRepositoryDirty: (repository) => reconciler.request(repository),
		onEvent: dependencies.onEvent,
		onError: (error) =>
			publish(
				{ type: "webhook-error", message: error.message },
				true,
			),
	});

	await reconciler.reconcileAll();
	reconciler.start();
	let forwarder;
	try {
		forwarder = await (dependencies.startForwarder ?? startGhWebhookForwarder)({
			dataDir: join(options.stateDir, "gh-data"),
			repository: options.repository,
			secret: secretRecord.secret,
			url: receiver.url,
			env: dependencies.env,
		});
	} catch (error) {
		reconciler.stop();
		await receiver.close();
		await reconciler.drain();
		await wakeDispatcher?.drain();
		throw error;
	}
	publish({
		type: "watcher-active",
		repository: options.repository,
		receiver: receiver.url,
		secretPath: secretRecord.path,
		pollIntervalMs: options.pollIntervalMs,
		maxMergeSlots: options.maxMergeSlots,
	});

	let reconcilerStopped = false;
	let forwarderStopped = false;
	let receiverClosed = false;
	let stopInFlight;
	const stop = async () => {
		const errors = [];
		if (!reconcilerStopped) {
			try {
				reconciler.stop();
				reconcilerStopped = true;
			} catch (error) {
				errors.push(error);
			}
		}
		if (!forwarderStopped) {
			try {
				await forwarder.stop();
				forwarderStopped = true;
			} catch (error) {
				errors.push(error);
			}
		}
		if (!receiverClosed) {
			try {
				await receiver.close();
				receiverClosed = true;
			} catch (error) {
				errors.push(error);
			}
		}
		if (reconcilerStopped && receiverClosed) {
			await reconciler.drain();
			await wakeDispatcher?.drain();
		}
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				"release queue shutdown did not complete",
			);
		}
	};
	return {
		adapter,
		forwarder,
		queue,
		receiver,
		reconciler,
		wakeDispatcher,
		secretPath: secretRecord.path,
		stop() {
			if (reconcilerStopped && forwarderStopped && receiverClosed)
				return Promise.resolve();
			stopInFlight ??= stop().finally(() => {
				stopInFlight = undefined;
			});
			return stopInFlight;
		},
	};
}

export const HELP = `Usage: release-queue-watch --repo OWNER/NAME [options]

Options:
  --repo OWNER/NAME          Repository to watch (required)
  --slots NUMBER             Concurrent agent-owned merge slots (default: 1)
  --poll-interval-ms NUMBER  Reconciliation interval (default: 60000)
  --host HOST                Local receiver host (default: 127.0.0.1)
  --port NUMBER              Local receiver port; 0 selects a free port (default: 0)
  --state-dir PATH           Persistent secret and isolated gh extension directory
`;

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const runtime = await startReleaseQueueRuntime(options);
	let stopRequested = false;
	const stop = async () => {
		stopRequested = true;
		try {
			await runtime.stop();
		} catch (firstError) {
			try {
				await runtime.stop();
			} catch (retryError) {
				throw new AggregateError(
					[firstError, retryError],
					"release queue shutdown failed twice",
				);
			}
		}
	};
	const stopAfterSignal = () => {
		void stop().catch((error) => {
			process.exitCode = 1;
			process.stderr.write(`${error.stack ?? error.message}\n`);
		});
	};
	process.once("SIGINT", stopAfterSignal);
	process.once("SIGTERM", stopAfterSignal);
	let exit;
	let exitError;
	try {
		exit = await runtime.forwarder.exit;
	} catch (error) {
		exitError = error;
	}
	const forwarderExitedUnexpectedly = !stopRequested;
	await stop();
	if (exitError) throw exitError;
	if (forwarderExitedUnexpectedly && exit.code !== 0) {
		throw new Error(
			`gh webhook forward exited with code ${exit.code} signal ${exit.signal}`,
		);
	}
}
