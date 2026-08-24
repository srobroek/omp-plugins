import { createHash } from "node:crypto";
import { EventGate } from "./event-gate.js";

const PRIORITY_LABELS = new Map([
	["p0", 0],
	["priority-p0", 0],
	["priority::critical", 0],
	["priority:critical", 0],
	["p1", 1],
	["priority-p1", 1],
	["priority::high", 1],
	["priority:high", 1],
	["p2", 2],
	["priority-p2", 2],
	["priority::medium", 2],
	["priority:medium", 2],
	["p3", 3],
	["priority-p3", 3],
	["priority::low", 3],
	["priority:low", 3],
	["p4", 4],
	["priority-p4", 4],
	["priority::backlog", 4],
	["priority:backlog", 4],
]);
const MAX_LIFECYCLE_KEYS = 10_000;

function priorityFromLabels(labels) {
	const priorities = labels
		.map((label) => PRIORITY_LABELS.get(label.toLowerCase()))
		.filter((priority) => priority !== undefined);
	return priorities.length === 0 ? 2 : Math.min(...priorities);
}

function compareQueueItems(left, right) {
	return (
		left.priority - right.priority ||
		left.createdAt.localeCompare(right.createdAt) ||
		left.repository.localeCompare(right.repository) ||
		left.number - right.number
	);
}

function keyFor(repository, number) {
	return `${repository}#${number}`;
}

function isEligible(item) {
	return !item.draft && item.mergeable === true && item.checks === "pass";
}

function cloneItem(item) {
	const { checksFingerprint: _checksFingerprint, ...publicItem } = item;
	return { ...publicItem, labels: [...publicItem.labels] };
}

function lifecycleStateFingerprint(item) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				item.title,
				item.baseRef,
				item.labels,
				item.priority,
				item.draft,
				item.mergeable,
				item.checks,
				item.checksFingerprint,
				item.createdAt,
			]),
		)
		.digest("hex")
		.slice(0, 16);
}

function itemChanged(previous, current) {
	if (!previous) return true;
	return (
		[
			"title",
			"headSha",
			"baseRef",
			"draft",
			"mergeable",
			"checks",
			"checksFingerprint",
			"updatedAt",
		].some((field) => previous[field] !== current[field]) ||
		JSON.stringify(previous.labels) !== JSON.stringify(current.labels)
	);
}

export class ReleaseQueueState {
	constructor({
		maxMergeSlots = 1,
		eventGate = new EventGate(),
		now = Date.now,
		onLifecycle = () => {},
	} = {}) {
		if (!Number.isInteger(maxMergeSlots) || maxMergeSlots < 1) {
			throw new Error("maxMergeSlots must be a positive integer");
		}
		this.maxMergeSlots = maxMergeSlots;
		this.eventGate = eventGate;
		this.now = now;
		this.onLifecycle = onLifecycle;
		this.items = new Map();
		this.itemVersions = new Map();
		this.emittedLifecycleKeys = new Set();
		this.generation = 0;
	}

	reconciliationGeneration() {
		return this.generation;
	}

	applyPullRequestEvent(event) {
		const gate = this.eventGate.accept({
			deliveryId: event.deliveryId,
			fingerprint: [
				event.repository,
				event.number,
				event.action,
				event.webhookAction ?? event.transition,
				event.headSha,
				event.updatedAt,
			].join(":"),
			receivedAt: event.receivedAt,
		});
		if (!gate.accepted) return { ...gate, dispatches: [] };

		const key = keyFor(event.repository, event.number);
		this.generation += 1;
		if (event.action === "closed") {
			const current = this.items.get(key);
			const previousVersion = this.itemVersions.get(key);
			this.itemVersions.set(key, {
				generation: this.generation,
				headSha:
					event.headSha ?? current?.headSha ?? previousVersion?.headSha ?? "",
				updatedAt:
					event.updatedAt ??
					current?.updatedAt ??
					previousVersion?.updatedAt ??
					new Date(event.receivedAt ?? this.now()).toISOString(),
				closed: true,
			});
			this.items.delete(key);
			const closedItem = this.#closedItem(event, current);
			this.#emitLifecycle(event.transition ?? "closed", "webhook", closedItem, {
				deliveryId: event.deliveryId,
				webhookAction: event.webhookAction,
			});
		} else {
			const previous = this.items.get(key);
			this.#upsert(event, event.receivedAt ?? this.now());
			const current = this.items.get(key);
			this.itemVersions.set(key, {
				generation: this.generation,
				headSha: current.headSha,
				updatedAt: current.updatedAt,
				closed: false,
			});
			this.#emitLifecycle(
				event.transition ?? (previous ? "updated" : "opened"),
				"webhook",
				current,
				{
					deliveryId: event.deliveryId,
					webhookAction: event.webhookAction,
				},
			);
		}
		return { ...gate, dispatches: this.dispatchAvailable() };
	}

	reconcileRepository(
		repository,
		pullRequests,
		observedAt = this.now(),
		requestGeneration = this.reconciliationGeneration(),
	) {
		const seen = new Set();
		for (const pullRequest of pullRequests) {
			const key = keyFor(repository, pullRequest.number);
			seen.add(key);
			const version = this.itemVersions.get(key);
			if ((version?.generation ?? 0) > requestGeneration) continue;
			if (
				version?.closed &&
				(!pullRequest.updatedAt || pullRequest.updatedAt <= version.updatedAt)
			) {
				continue;
			}
			const current = this.items.get(key);
			if (
				current &&
				pullRequest.headSha !== current.headSha &&
				(!pullRequest.updatedAt || pullRequest.updatedAt <= current.updatedAt)
			) {
				continue;
			}
			this.#upsert({ ...pullRequest, repository }, observedAt);
			const reconciled = this.items.get(key);
			this.itemVersions.set(key, {
				generation: requestGeneration,
				headSha: reconciled.headSha,
				updatedAt: reconciled.updatedAt,
				closed: false,
			});
			if (!current) {
				this.#emitLifecycle("opened", "reconciliation", reconciled);
				if (reconciled.checks === "fail") {
					this.#emitLifecycle("failed", "reconciliation", reconciled, {
						reason: "checks-failed",
					});
				}
			} else if (
				reconciled.checks === "fail" &&
				(current.checks !== "fail" ||
					current.checksFingerprint !== reconciled.checksFingerprint)
			) {
				this.#emitLifecycle("failed", "reconciliation", reconciled, {
					reason: "checks-failed",
				});
			} else if (itemChanged(current, reconciled)) {
				this.#emitLifecycle("updated", "reconciliation", reconciled);
			}
		}
		for (const [key, version] of this.itemVersions) {
			if (
				!key.startsWith(`${repository}#`) ||
				seen.has(key) ||
				version.generation > requestGeneration
			) {
				continue;
			}
			const current = this.items.get(key);
			this.items.delete(key);
			if (current) {
				this.#emitLifecycle(
					"closed",
					"reconciliation",
					this.#closedItem({}, current),
					{
						reason: "absent-from-open-pulls",
					},
				);
			}
			if (!version.closed) this.itemVersions.delete(key);
		}
		return this.dispatchAvailable();
	}

	releaseSlot(repository, number) {
		const item = this.items.get(keyFor(repository, number));
		if (!item || item.state !== "active") return [];
		item.state = isEligible(item) ? "queued" : "blocked";
		item.activeSince = null;
		return this.dispatchAvailable();
	}

	dispatchAvailable() {
		const activeCount = [...this.items.values()].filter(
			(item) => item.state === "active",
		).length;
		const available = this.maxMergeSlots - activeCount;
		if (available <= 0) return [];

		const candidates = [...this.items.values()]
			.filter((item) => item.state === "queued" && isEligible(item))
			.sort(compareQueueItems)
			.slice(0, available);
		const activatedAt = new Date(this.now()).toISOString();
		for (const item of candidates) {
			item.state = "active";
			item.activeSince = activatedAt;
		}
		return candidates.map(cloneItem);
	}

	snapshot() {
		return [...this.items.values()].sort(compareQueueItems).map(cloneItem);
	}

	#closedItem(event, current) {
		const labels = event.labels ?? current?.labels ?? [];
		return {
			repository: event.repository ?? current?.repository,
			number: event.number ?? current?.number,
			title: event.title ?? current?.title ?? "",
			headSha: event.headSha ?? current?.headSha ?? "",
			baseRef: event.baseRef ?? current?.baseRef ?? "main",
			labels: labels.map((label) =>
				typeof label === "string" ? label : label.name,
			),
			priority: current?.priority ?? priorityFromLabels(labels),
			draft: event.draft ?? current?.draft ?? false,
			mergeable: event.mergeable ?? current?.mergeable ?? null,
			checks: current?.checks ?? "pending",
			checksFingerprint:
				event.checksFingerprint ?? current?.checksFingerprint ?? null,
			createdAt:
				event.createdAt ??
				current?.createdAt ??
				new Date(event.receivedAt ?? this.now()).toISOString(),
			updatedAt:
				event.updatedAt ??
				current?.updatedAt ??
				new Date(event.receivedAt ?? this.now()).toISOString(),
			state: "closed",
			activeSince: null,
		};
	}

	#emitLifecycle(transition, source, item, details = {}) {
		const pullRequest = cloneItem(item);
		const lifecycleKey = [
			pullRequest.repository,
			pullRequest.number,
			pullRequest.headSha,
			transition,
			pullRequest.updatedAt,
			lifecycleStateFingerprint(item),
		].join("#");
		if (this.emittedLifecycleKeys.has(lifecycleKey)) return;
		this.emittedLifecycleKeys.add(lifecycleKey);
		if (this.emittedLifecycleKeys.size > MAX_LIFECYCLE_KEYS) {
			this.emittedLifecycleKeys.delete(
				this.emittedLifecycleKeys.values().next().value,
			);
		}
		this.onLifecycle({
			type: "pr-lifecycle",
			transition,
			source,
			lifecycleKey,
			pullRequest,
			...details,
		});
	}

	#upsert(input, observedAt) {
		const key = keyFor(input.repository, input.number);
		const previous = this.items.get(key);
		const headChanged =
			previous !== undefined &&
			input.headSha !== undefined &&
			input.headSha !== previous.headSha;
		const labels = (input.labels ?? previous?.labels ?? []).map((label) =>
			typeof label === "string" ? label : label.name,
		);
		const item = {
			repository: input.repository,
			number: input.number,
			title: input.title ?? previous?.title ?? "",
			headSha: input.headSha ?? previous?.headSha ?? "",
			baseRef: input.baseRef ?? previous?.baseRef ?? "main",
			labels,
			priority: input.priority ?? priorityFromLabels(labels),
			draft: input.draft ?? previous?.draft ?? false,
			mergeable:
				input.mergeable ?? (headChanged ? null : previous?.mergeable) ?? null,
			checks:
				input.checks ??
				(headChanged ? "pending" : previous?.checks) ??
				"pending",
			checksFingerprint:
				input.checksFingerprint ??
				(headChanged ? null : previous?.checksFingerprint) ??
				null,
			createdAt:
				input.createdAt ??
				previous?.createdAt ??
				new Date(observedAt).toISOString(),
			updatedAt: input.updatedAt ?? new Date(observedAt).toISOString(),
			state: headChanged ? "blocked" : (previous?.state ?? "blocked"),
			activeSince: headChanged ? null : (previous?.activeSince ?? null),
		};

		if (!isEligible(item)) {
			item.state = "blocked";
			item.activeSince = null;
		} else if (item.state !== "active") {
			item.state = "queued";
		}
		this.items.set(key, item);
	}
}
