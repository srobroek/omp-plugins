import { errorMessage } from "./error-message.js";

const ROUTABLE_STATUSES = new Set(["resolved", "replay"]);
const QUIET_STATUSES = new Set(["duplicate", "ignored"]);

function identityFrom(result) {
	return result.dispatchKey ?? result.lifecycleKey ?? result.eventKey;
}

function wakePayload(kind, result, record) {
	const target = kind === "orchestrate" ? result.node : result.bead;
	const identity = identityFrom(result);
	for (const [name, value] of Object.entries({
		target,
		identity,
		repository: result.repository,
		headSha: result.headSha,
	})) {
		if (typeof value !== "string" || value.length === 0) {
			throw new TypeError(`${kind} ${name} must be a non-empty string`);
		}
	}
	if (!Number.isInteger(result.number) || result.number < 1) {
		throw new TypeError(`${kind} number must be a positive integer`);
	}
	return {
		target: { kind, id: target },
		...(kind === "orchestrate"
			? { verb: "APPROVE" }
			: { action: "run-pass" }),
		eventType: result.eventType ?? record.type,
		identity,
		repository: result.repository,
		number: result.number,
		headSha: result.headSha,
		transition: result.transition,
		branch: result.branch,
		baseSha: result.baseSha,
		requiredMetadata: { ...(result.requiredMetadata ?? {}) },
	};
}

export class AdvisoryWakeDispatcher {
	constructor({
		resolveOrchestrate,
		resolveShepherd,
		wakeOrchestrate,
		wakeShepherd,
		onFallback = () => {},
	}) {
		for (const [name, dependency] of Object.entries({
			resolveOrchestrate,
			resolveShepherd,
			wakeOrchestrate,
			wakeShepherd,
		})) {
			if (typeof dependency !== "function") {
				throw new TypeError(`${name} must be a function`);
			}
		}
		this.resolveOrchestrate = resolveOrchestrate;
		this.resolveShepherd = resolveShepherd;
		this.wakeOrchestrate = wakeOrchestrate;
		this.wakeShepherd = wakeShepherd;
		this.onFallback = onFallback;
		this.tail = Promise.resolve();
	}

	enqueue(record) {
		const operation = this.tail.then(() => this.#route(record));
		this.tail = operation.catch(() => {});
		return operation;
	}

	enqueueLine(line, source = "stdout") {
		let record;
		try {
			record = JSON.parse(line);
		} catch (error) {
			return this.enqueue({
				type: "malformed-output",
				source,
				message: errorMessage(error),
			});
		}
		return this.enqueue(record);
	}

	drain() {
		return this.tail;
	}

	async #fallback(reason, record, details = {}) {
		const fallback = {
			status: "fallback",
			reason,
			recordType: record?.type,
			...details,
		};
		await this.onFallback(fallback);
		return fallback;
	}

	async #route(record) {
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			return this.#fallback("malformed-output", record);
		}
		if (record.type === "malformed-output") {
			return this.#fallback("malformed-output", record, {
				source: record.source,
				message: record.message,
			});
		}

		let orchestrate;
		try {
			orchestrate = await this.resolveOrchestrate(record);
		} catch (error) {
			return this.#fallback("orchestrate-resolution-error", record, {
				message: errorMessage(error),
			});
		}
		if (!orchestrate || typeof orchestrate.status !== "string") {
			return this.#fallback("invalid-orchestrate-result", record);
		}
		if (orchestrate.status === "fallback") {
			return this.#fallback("watcher-error", record, orchestrate);
		}
		if (ROUTABLE_STATUSES.has(orchestrate.status)) {
			if (orchestrate.wakeGatekeeper === false) {
				return { ...orchestrate, status: "observed" };
			}
			let payload;
			try {
				payload = wakePayload("orchestrate", orchestrate, record);
			} catch (error) {
				return this.#fallback("invalid-orchestrate-result", record, {
					message: errorMessage(error),
				});
			}
			await this.wakeOrchestrate(payload);
			return { status: "woken", route: "orchestrate", payload };
		}
		if (QUIET_STATUSES.has(orchestrate.status)) return orchestrate;
		if (orchestrate.status !== "unmatched") {
			return this.#fallback("orchestrate-ownership-error", record, {
				resolutionStatus: orchestrate.status,
			});
		}

		let shepherd;
		try {
			shepherd = await this.resolveShepherd(record);
		} catch (error) {
			return this.#fallback("shepherd-resolution-error", record, {
				message: errorMessage(error),
			});
		}
		if (!shepherd || typeof shepherd.status !== "string") {
			return this.#fallback("invalid-shepherd-result", record);
		}
		if (shepherd.status === "fallback") {
			return this.#fallback("watcher-error", record, shepherd);
		}
		if (ROUTABLE_STATUSES.has(shepherd.status)) {
			let payload;
			try {
				payload = wakePayload("pr-shepherd", shepherd, record);
			} catch (error) {
				return this.#fallback("invalid-shepherd-result", record, {
					message: errorMessage(error),
				});
			}
			await this.wakeShepherd(payload);
			return { status: "woken", route: "pr-shepherd", payload };
		}
		if (QUIET_STATUSES.has(shepherd.status)) return shepherd;
		return this.#fallback("unmatched-shepherd-event", record, {
			resolutionStatus: shepherd.status,
		});
	}
}
