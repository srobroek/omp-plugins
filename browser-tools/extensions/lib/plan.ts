import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorMessage } from "./config.ts";
import type { OperationKind, OperationParams, SafeErrorCategory } from "./operations.ts";
import {
	CancelledError,
	classifyError,
	InvalidRequestError,
	isAborted,
	runAct,
	runNav,
	runRead,
	StaleTabError,
	validateAct,
	validateNav,
	validateRead,
	withTabHold,
} from "./operations.ts";
import { type AuditWriter, redact } from "./policy.ts";
import type { HeadedSession } from "./session.ts";
import { selectedPage } from "./session.ts";

/**
 * Bounded plan executor. One outer call runs an ordered sequence of the shared
 * navigate, read, and act operations against one session and the one tab that was
 * selected when the plan started. The whole sequence is validated before the first
 * effect, the plan holds that tab's lock from its first step through its last so no
 * other caller's operation lands between two steps, and the first failure or
 * cancellation ends the plan with the later steps unexecuted.
 */

/** Steps per plan. A larger batch stops being reviewable in an approval prompt. */
export const PLAN_STEP_LIMIT = 20;

/** Inline characters one step may contribute to the result. */
export const PLAN_STEP_OUTPUT_LIMIT = 8_192;

/** Inline characters the whole plan may contribute to the result. */
export const PLAN_OUTPUT_LIMIT = 65_536;

/** Failure text kept per step; the full message stays in the extension's own log. */
export const PLAN_MESSAGE_LIMIT = 300;

const PLAN_SECRET_KEY = /^(?:cookie|set-cookie|authorization|proxy-authorization|x-api-key)$/i;

function redactPlanPayload(value: unknown, session: HeadedSession): unknown {
	if (typeof value === "string") return redact(value, session.config);
	if (Array.isArray(value)) return value.map((entry) => redactPlanPayload(entry, session));
	if (value === null || typeof value !== "object") return value;
	const redacted: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		redacted[key] = session.config.redactSecrets && PLAN_SECRET_KEY.test(key) ? "<REDACTED>" : redactPlanPayload(entry, session);
	}
	return redacted;
}

/** Longest prefix whose JSON string representation fits the emitted allowance. */
function truncateForJsonString(text: string, limit: number): string | undefined {
	if (limit < 2) return undefined;
	let encodedLength = 2; // Opening and closing quotes.
	let end = 0;
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		let width = 1;
		let nextEnd = index + 1;
		if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) width = 2;
		else if (unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff)) {
			if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
				const following = text.charCodeAt(index + 1);
				if (following >= 0xdc00 && following <= 0xdfff) {
					width = 2;
					nextEnd += 1;
				} else width = 6;
			} else width = 6;
		}
		if (encodedLength + width > limit) break;
		encodedLength += width;
		end = nextEnd;
		index = nextEnd - 1;
	}
	return text.slice(0, end);
}

export const PLAN_KINDS = ["nav", "read", "act"] as const;

/**
 * Operations a plan refuses. The tab ops would move the tab the plan fixed, and
 * `evaluate` runs page script an approval prompt cannot describe; both stay
 * available as standalone calls.
 */
const PLAN_BLOCKED_OPS: Record<string, string> = {
	newTab: "changes the session's tab set",
	selectTab: "changes the session's tab set",
	closeTab: "changes the session's tab set",
	evaluate: "runs arbitrary page script",
};

/** Accepted step fields; anything else is a typo that would be silently dropped. */
const PLAN_STEP_FIELDS: Record<string, true> = {
	kind: true, op: true, url: true, text: true, selector: true, expression: true, ref: true, key: true,
	value: true, values: true, files: true, timeoutMs: true, width: true, height: true, deviceScaleFactor: true,
	fullPage: true, clip: true, limit: true, since: true, deltaX: true, deltaY: true, accept: true, promptText: true,
};

export interface PlanStep extends OperationParams {
	kind: OperationKind;
	op: string;
}

export interface PlanStepResult {
	index: number;
	kind: OperationKind;
	op: string;
	ok: boolean;
	ms: number;
	/** Read payload, or its truncated JSON text when the payload exceeds the allowance. */
	result?: unknown;
	truncated?: boolean;
	error?: SafeErrorCategory;
	message?: string;
}

export interface PlanOutcome {
	tabId: string;
	total: number;
	executed: number;
	steps: PlanStepResult[];
	failedIndex?: number;
	error?: SafeErrorCategory;
}

/**
 * Whole-plan gate. Rejects a malformed, oversized, or unsupported plan with the same
 * messages the standalone tools use, before the executor touches the browser.
 */
export function validatePlan(steps: unknown): PlanStep[] {
	if (!Array.isArray(steps) || steps.length === 0) throw new InvalidRequestError("headed-browser: steps is required and holds at least one step");
	if (steps.length > PLAN_STEP_LIMIT) {
		throw new InvalidRequestError(`headed-browser: a plan holds at most ${PLAN_STEP_LIMIT} steps; received ${steps.length}`);
	}
	return steps.map((raw, index) => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new InvalidRequestError(`headed-browser: plan step ${index} is not an object`);
		const fields = raw as Record<string, unknown>;
		for (const field of Object.keys(fields)) {
			if (PLAN_STEP_FIELDS[field] !== true) throw new InvalidRequestError(`headed-browser: plan step ${index} has unknown field ${field}`);
		}
		const kind = fields.kind;
		if (kind !== "nav" && kind !== "read" && kind !== "act") {
			throw new InvalidRequestError(`headed-browser: plan step ${index} kind is required and is one of ${PLAN_KINDS.join(", ")}`);
		}
		const op = fields.op;
		if (typeof op !== "string" || op.length === 0) throw new InvalidRequestError(`headed-browser: plan step ${index} op is required`);
		const blocked = PLAN_BLOCKED_OPS[op];
		if (blocked !== undefined) throw new InvalidRequestError(`headed-browser: plan step ${index} op ${op} ${blocked}; run it as a standalone call`);
		// Every key is an accepted field and the host schema typed each one already.
		const step: PlanStep = { ...(raw as OperationParams), kind, op };
		if (kind === "nav") validateNav(op, step);
		else if (kind === "read") validateRead(op, step);
		else validateAct(op, step);
		return step;
	});
}

export async function runPlan(input: {
	session: HeadedSession;
	ctx: ExtensionContext;
	steps: readonly PlanStep[];
	audit?: AuditWriter;
	signal?: unknown;
}): Promise<PlanOutcome> {
	const { session, ctx, steps, audit, signal } = input;
	const tabId = session.selectedTabId;
	// Identity, not just the id: a replaced tab reusing the id is still a different tab.
	const tab = selectedPage(session);
	// Checked before the plan queues: a plan the host already cancelled must not make
	// another caller wait for a tab it will never touch.
	if (isAborted(signal)) throw new CancelledError("headed-browser: cancelled before the plan acquired its tab");
	// One hold for the whole sequence; each step re-enters it instead of handing the tab
	// back to a queued caller between steps.
	return withTabHold(session, ctx, tabId, async (tabHold) => {
		const results: PlanStepResult[] = [];
		const outcome: PlanOutcome = { tabId, total: steps.length, executed: 0, steps: results };
		// Rechecked with the tab in hand, ahead of the start record and every step: a plan
		// cancelled while it queued behind another caller made no decision worth auditing and
		// runs nothing. The pre-acquisition check cannot cover this — the queue wait sits
		// between the two, and that is exactly where a host cancellation lands.
		if (isAborted(signal)) {
			// The category a cancellation between two steps reports, with no step to record.
			outcome.error = "cancelled";
			return outcome;
		}
		await audit?.write(session, "plan", "allow", tab.url(), `${steps.length} steps`);
		let used = 0;
		for (const [index, step] of steps.entries()) {
			const startedAt = Date.now();
			const record: PlanStepResult = { index, kind: step.kind, op: step.op, ok: false, ms: 0 };
			results.push(record);
			try {
				if (isAborted(signal)) throw new CancelledError(`headed-browser: cancelled before plan step ${index}`);
				if (session.selectedTabId !== tabId || session.pages.get(tabId) !== tab) {
					throw new StaleTabError(`headed-browser: plan tab ${tabId} is no longer the session's selected tab`);
				}
				const context = { session, ctx, audit, signal, expectedTab: { id: tabId, page: tab }, tabHold };
				if (step.kind === "nav") await runNav(context, step.op, step);
				else if (step.kind === "act") await runAct(context, step.op, step);
				else {
					const payload = redactPlanPayload(await runRead(context, step.op, step, { inlineBinary: false }), session);
					const text = JSON.stringify(payload) ?? "null";
					const allowance = Math.max(0, Math.min(PLAN_STEP_OUTPUT_LIMIT, PLAN_OUTPUT_LIMIT - used));
					if (text.length <= allowance) {
						record.result = payload;
						used += text.length;
					} else {
						const result = truncateForJsonString(text, allowance);
						if (result !== undefined) {
							record.result = result;
							used += JSON.stringify(result).length;
						}
						record.truncated = true;
					}
				}
				record.ok = true;
				record.ms = Date.now() - startedAt;
				outcome.executed += 1;
			} catch (error) {
				record.ms = Date.now() - startedAt;
				record.error = classifyError(step.op, error);
				record.message = redact(errorMessage(error), session.config).slice(0, PLAN_MESSAGE_LIMIT);
				outcome.failedIndex = index;
				outcome.error = record.error;
				break;
			}
		}
		const summary = outcome.error === undefined
			? `${outcome.executed}/${steps.length} steps`
			: `${outcome.executed}/${steps.length} steps; step ${outcome.failedIndex} ${outcome.error}`;
		// Ordinals, operations, and categories only: no page text, payload, or artifact bytes.
		await audit?.write(session, "plan", "allow", session.pages.get(tabId)?.url(), summary);
		return outcome;
	}, signal);
}
