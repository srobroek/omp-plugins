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
} from "./operations.ts";
import type { AuditWriter } from "./policy.ts";
import type { HeadedSession } from "./session.ts";
import { selectedPage } from "./session.ts";

/**
 * Bounded plan executor. One outer call runs an ordered sequence of the shared
 * navigate, read, and act operations against one session and the one tab that was
 * selected when the plan started. The whole sequence is validated before the first
 * effect, every step is serialized through the same per-tab lock standalone tools
 * use, and the first failure or cancellation ends the plan with the later steps
 * unexecuted.
 */

/** Steps per plan. A larger batch stops being reviewable in an approval prompt. */
export const PLAN_STEP_LIMIT = 20;

/** Inline characters one step may contribute to the result. */
export const PLAN_STEP_OUTPUT_LIMIT = 8_192;

/** Inline characters the whole plan may contribute to the result. */
export const PLAN_OUTPUT_LIMIT = 65_536;

/** Failure text kept per step; the full message stays in the extension's own log. */
const PLAN_MESSAGE_LIMIT = 300;

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
	const results: PlanStepResult[] = [];
	const outcome: PlanOutcome = { tabId, total: steps.length, executed: 0, steps: results };
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
			const context = { session, ctx, audit, signal, expectedTab: { id: tabId, page: tab } };
			if (step.kind === "nav") await runNav(context, step.op, step);
			else if (step.kind === "act") await runAct(context, step.op, step);
			else {
				const payload = await runRead(context, step.op, step, { inlineBinary: false });
				const text = JSON.stringify(payload) ?? "null";
				const allowance = Math.max(0, Math.min(PLAN_STEP_OUTPUT_LIMIT, PLAN_OUTPUT_LIMIT - used));
				if (text.length <= allowance) record.result = payload;
				else {
					record.result = text.slice(0, allowance);
					record.truncated = true;
				}
				used += Math.min(text.length, allowance);
			}
			record.ok = true;
			record.ms = Date.now() - startedAt;
			outcome.executed += 1;
		} catch (error) {
			record.ms = Date.now() - startedAt;
			record.error = classifyError(step.op, error);
			record.message = errorMessage(error).slice(0, PLAN_MESSAGE_LIMIT);
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
}
