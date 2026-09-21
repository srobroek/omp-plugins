import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { EffectiveConfig } from "./config.ts";
import type { InterceptedRequest, NavigationAuditSink } from "./policy.ts";
import { createAuditWriter, deriveDomainPolicy, interceptRequest } from "./policy.ts";
import type { HeadedSession } from "./session.ts";

const MAIN_FRAME = { frame: "main" };
const OTHER_FRAME = { frame: "child" };

type Resolution = { kind: "continue" } | { kind: "abort"; errorCode: string };

interface FakeRequest extends InterceptedRequest {
	calls: Resolution[];
}

function fakeRequest(options: {
	url?: string | (() => string);
	navigation?: boolean | (() => boolean);
	frame?: unknown;
	transport?: () => Promise<void>;
	log?: string[];
}): FakeRequest {
	const calls: Resolution[] = [];
	const send = (resolution: Resolution): Promise<void> => {
		calls.push(resolution);
		options.log?.push(resolution.kind);
		return options.transport ? options.transport() : Promise.resolve();
	};
	return {
		calls,
		url: () => (typeof options.url === "function" ? options.url() : (options.url ?? "https://example.com/page")),
		isNavigationRequest: () => (typeof options.navigation === "function" ? options.navigation() : (options.navigation ?? true)),
		frame: () => ("frame" in options ? options.frame : MAIN_FRAME),
		continue: () => send({ kind: "continue" }),
		abort: (errorCode) => send({ kind: "abort", errorCode }),
	};
}

interface AuditProbe {
	records: Array<{ decision: string; url: string; reason?: string }>;
	sink: NavigationAuditSink;
}

function auditProbe(persist?: () => Promise<void>, log?: string[]): AuditProbe {
	const records: AuditProbe["records"] = [];
	return {
		records,
		sink: (decision, url, reason) => {
			records.push({ decision, url, reason });
			log?.push("audit-start");
			return persist ? persist() : Promise.resolve();
		},
	};
}

function deferred(): { promise: Promise<void>; release: () => void; fail: (error: Error) => void } {
	let release!: () => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		release = () => resolve();
		fail = reject;
	});
	return { promise, release, fail };
}

const allowlist = deriveDomainPolicy({ allowedDomains: "example.com", deniedDomains: "" });
const denylist = deriveDomainPolicy({ allowedDomains: "", deniedDomains: "example.com" });
const unrestricted = deriveDomainPolicy({ allowedDomains: "", deniedDomains: "" });

describe("intercepted request resolution", () => {
	test("continues a permitted main-frame navigation exactly once and audits the same decision", async () => {
		const audit = auditProbe();
		const request = fakeRequest({ url: "https://a.example.com/page" });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: allowlist, audit: audit.sink });

		expect(intercepted.decision).toBe("allow");
		expect(intercepted.governed).toBe(true);
		expect(request.calls).toEqual([{ kind: "continue" }]);
		expect(await intercepted.resolved).toBeUndefined();
		await intercepted.audited;
		expect(audit.records).toEqual([{ decision: "allow", url: "https://a.example.com/page", reason: undefined }]);
	});

	test("aborts a blocked navigation with blockedbyclient and audits the blocking reason", async () => {
		const audit = auditProbe();
		const request = fakeRequest({ url: "https://a.example.com/page" });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: denylist, audit: audit.sink });

		expect(intercepted.decision).toBe("block");
		expect(request.calls).toEqual([{ kind: "abort", errorCode: "blockedbyclient" }]);
		await intercepted.audited;
		expect(audit.records).toHaveLength(1);
		expect(audit.records[0]?.decision).toBe("block");
		expect(audit.records[0]?.url).toBe("https://a.example.com/page");
		expect(audit.records[0]?.reason).toContain("blocked by deniedDomains");
	});

	test("continues before the audit write is even started, and does not wait for it", async () => {
		const log: string[] = [];
		const gate = deferred();
		const audit = auditProbe(() => gate.promise.then(() => void log.push("audit-done")), log);
		const request = fakeRequest({ log });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: unrestricted, audit: audit.sink });

		expect(log).toEqual(["continue", "audit-start"]);
		expect(await intercepted.resolved).toBeUndefined();
		expect(log).toEqual(["continue", "audit-start"]);

		gate.release();
		await intercepted.audited;
		expect(log).toEqual(["continue", "audit-start", "audit-done"]);
	});

	test("aborts before the audit write is even started, and does not wait for it", async () => {
		const log: string[] = [];
		const gate = deferred();
		const audit = auditProbe(() => gate.promise.then(() => void log.push("audit-done")), log);
		const request = fakeRequest({ url: "https://example.com/page", log });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: denylist, audit: audit.sink });

		expect(log).toEqual(["abort", "audit-start"]);
		expect(await intercepted.resolved).toBeUndefined();
		expect(log).toEqual(["abort", "audit-start"]);

		gate.release();
		await intercepted.audited;
		expect(log).toEqual(["abort", "audit-start", "audit-done"]);
	});

	test("a rejected audit write neither re-resolves nor rejects", async () => {
		const gate = deferred();
		const audit = auditProbe(() => gate.promise);
		const request = fakeRequest({});

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: unrestricted, audit: audit.sink });
		gate.fail(new Error("audit disk full"));

		await expect(intercepted.audited).resolves.toBeUndefined();
		expect(request.calls).toEqual([{ kind: "continue" }]);
	});

	test("an audit sink that throws synchronously does not break the request", async () => {
		const request = fakeRequest({});

		const intercepted = interceptRequest(request, {
			mainFrame: MAIN_FRAME,
			policy: unrestricted,
			audit: () => {
				throw new Error("audit sink exploded");
			},
		});

		expect(request.calls).toEqual([{ kind: "continue" }]);
		await expect(intercepted.audited).resolves.toBeUndefined();
		expect(await intercepted.resolved).toBeUndefined();
	});

	test("a failed continue reports the transport error without attempting an abort", async () => {
		const audit = auditProbe();
		const request = fakeRequest({ transport: () => Promise.reject(new Error("request already handled")) });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: unrestricted, audit: audit.sink });

		expect((await intercepted.resolved)?.message).toBe("request already handled");
		expect(request.calls).toEqual([{ kind: "continue" }]);
		await intercepted.audited;
		expect(audit.records[0]?.decision).toBe("allow");
	});

	test("a failed abort reports the transport error without falling back to continue", async () => {
		const request = fakeRequest({
			url: "https://example.com/page",
			transport: () => Promise.reject(new Error("request already handled")),
		});

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: denylist });

		expect((await intercepted.resolved)?.message).toBe("request already handled");
		expect(request.calls).toEqual([{ kind: "abort", errorCode: "blockedbyclient" }]);
	});

	test("a transport that throws synchronously is reported once", async () => {
		const request = fakeRequest({
			transport: () => {
				throw new Error("detached frame");
			},
		});

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: unrestricted });

		expect((await intercepted.resolved)?.message).toBe("detached frame");
		expect(request.calls).toHaveLength(1);
	});

	test("non-navigation requests continue immediately and are never audited", async () => {
		const audit = auditProbe();
		const request = fakeRequest({ navigation: false, url: "https://blocked.test/asset.js" });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: allowlist, audit: audit.sink });

		expect(intercepted.decision).toBe("allow");
		expect(intercepted.governed).toBe(false);
		expect(request.calls).toEqual([{ kind: "continue" }]);
		await intercepted.audited;
		expect(audit.records).toEqual([]);
	});

	test("sub-frame navigations continue immediately and are never audited", async () => {
		const audit = auditProbe();
		const request = fakeRequest({ frame: OTHER_FRAME, url: "https://blocked.test/frame" });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: allowlist, audit: audit.sink });

		expect(intercepted.governed).toBe(false);
		expect(request.calls).toEqual([{ kind: "continue" }]);
		await intercepted.audited;
		expect(audit.records).toEqual([]);
	});

	test("an unreadable request is continued rather than left stalled", async () => {
		const request = fakeRequest({
			navigation: () => {
				throw new Error("request detached");
			},
		});

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: allowlist });

		expect(intercepted.governed).toBe(false);
		expect(request.calls).toEqual([{ kind: "continue" }]);
	});

	test("an unreadable navigation URL fails closed to an abort", async () => {
		const audit = auditProbe();
		const request = fakeRequest({
			url: () => {
				throw new Error("url unavailable");
			},
		});

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: allowlist, audit: audit.sink });

		expect(intercepted.decision).toBe("block");
		expect(request.calls).toEqual([{ kind: "abort", errorCode: "blockedbyclient" }]);
		await intercepted.audited;
		expect(audit.records[0]?.reason).toBe("url unavailable");
	});

	test("an unnavigable scheme is blocked", async () => {
		const request = fakeRequest({ url: "file:///etc/hosts" });

		const intercepted = interceptRequest(request, { mainFrame: MAIN_FRAME, policy: unrestricted });

		expect(intercepted.decision).toBe("block");
		expect(request.calls).toEqual([{ kind: "abort", errorCode: "blockedbyclient" }]);
	});
});

describe("audit writer failure reporting", () => {
	test("reports an unwritable audit path once across repeated writes", async () => {
		const ctx = { sessionManager: { getSessionId: () => "omp-session" } } as unknown as ExtensionContext;
		const config = { auditDir: "/dev/null/not-a-directory" } as EffectiveConfig;
		const session = {
			id: "session-1",
			resolvedBrowser: { engine: "chrome", channel: "stable" },
			profileMode: "ephemeral",
			profile: { cookieDomains: [] },
			warnings: [],
		} as unknown as HeadedSession;

		const writer = createAuditWriter(ctx, config);
		await writer.write(session, "in-page-navigation", "allow", "https://example.com/one");
		await writer.write(session, "in-page-navigation", "block", "https://example.com/two", "blocked");

		expect(session.warnings).toHaveLength(1);
		expect(session.warnings[0]).toStartWith("headed-browser: audit write failed:");
	});
});
