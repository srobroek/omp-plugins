export class EventGate {
	constructor({
		debounceMs = 30_000,
		maxEntries = 10_000,
		now = Date.now,
	} = {}) {
		this.debounceMs = debounceMs;
		this.maxEntries = maxEntries;
		this.now = now;
		this.deliveryIds = new Map();
		this.fingerprints = new Map();
	}

	accept({ deliveryId, fingerprint, receivedAt = this.now() }) {
		if (deliveryId && this.deliveryIds.has(deliveryId)) {
			return { accepted: false, reason: "duplicate-delivery" };
		}

		const previous = fingerprint
			? this.fingerprints.get(fingerprint)
			: undefined;
		if (previous !== undefined && receivedAt - previous < this.debounceMs) {
			if (deliveryId) this.#remember(this.deliveryIds, deliveryId, receivedAt);
			return { accepted: false, reason: "debounced" };
		}

		if (deliveryId) this.#remember(this.deliveryIds, deliveryId, receivedAt);
		if (fingerprint) this.#remember(this.fingerprints, fingerprint, receivedAt);
		return { accepted: true, reason: "accepted" };
	}

	#remember(map, key, value) {
		map.delete(key);
		map.set(key, value);
		while (map.size > this.maxEntries) {
			map.delete(map.keys().next().value);
		}
	}
}
