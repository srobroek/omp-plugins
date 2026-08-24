import { createServer } from "node:http";
import { createNodeMiddleware, Webhooks } from "@octokit/webhooks";
import { EventGate } from "./event-gate.js";

function pullRequestEvent(id, payload, receivedAt) {
	const pull = payload.pull_request;
	const transition =
		payload.action === "closed"
			? pull.merged
				? "merged"
				: "closed"
			: ["opened", "reopened"].includes(payload.action)
				? "opened"
				: "updated";
	return {
		deliveryId: id,
		receivedAt,
		action: payload.action === "closed" ? "closed" : "upsert",
		transition,
		webhookAction: payload.action,
		repository: payload.repository.full_name,
		number: pull.number,
		title: pull.title,
		headSha: pull.head.sha,
		baseRef: pull.base.ref,
		labels: pull.labels.map((label) => label.name),
		draft: pull.draft ?? false,
		mergeable: pull.mergeable ?? null,
		createdAt: pull.created_at,
		updatedAt: pull.updated_at,
	};
}

export async function createWebhookReceiver({
	secret,
	queue,
	host = "127.0.0.1",
	port = 0,
	path = "/webhooks/github",
	onRepositoryDirty = () => {},
	onEvent = () => {},
	onError = () => {},
	eventGate = new EventGate(),
	now = Date.now,
}) {
	const webhooks = new Webhooks({ secret });
	webhooks.on("pull_request", ({ id, payload }) => {
		const event = pullRequestEvent(id, payload, now());
		const result = queue.applyPullRequestEvent(event);
		onEvent({ event, result });
		onRepositoryDirty(payload.repository.full_name);
	});
	for (const name of ["check_run", "check_suite", "status", "workflow_run"]) {
		webhooks.on(name, ({ id, payload }) => {
			const receivedAt = now();
			const repository = payload.repository.full_name;
			const subject =
				payload.check_run ??
				payload.check_suite ??
				payload.workflow_run ??
				payload;
			const gate = eventGate.accept({
				deliveryId: id,
				fingerprint: JSON.stringify([
					name,
					repository,
					subject.id ?? subject.sha,
					subject.status ?? subject.state,
					subject.conclusion,
				]),
				receivedAt,
			});
			if (!gate.accepted) return;
			const event = {
				deliveryId: id,
				name,
				repository,
				receivedAt,
			};
			onEvent({ event, result: { ...gate, dispatches: [] } });
			onRepositoryDirty(event.repository);
		});
	}
	webhooks.onError(onError);

	const middleware = createNodeMiddleware(webhooks, {
		path,
		log: {
			debug() {},
			info() {},
			warn() {},
			error: onError,
		},
	});
	const server = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/healthz") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"status":"ok"}');
			return;
		}
		try {
			if (await middleware(request, response)) return;
			response.writeHead(404);
			response.end();
		} catch (error) {
			onError(error);
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	const address = server.address();
	const url = `http://${host}:${address.port}${path}`;
	return {
		server,
		url,
		webhooks,
		async close() {
			await new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
