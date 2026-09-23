import { describe, expect, test } from "bun:test";
import { isUntargetedWait, WAIT_REFUSAL } from "./wait-discipline";

describe("isUntargetedWait", () => {
	test("refuses a bare wait, the shape that measured 61.8% waste", () => {
		expect(isUntargetedWait({ op: "wait", i: "waiting" })).toBe(true);
	});

	test("allows a wait that names the job it depends on", () => {
		expect(isUntargetedWait({ op: "wait", ids: ["ImplE3"] })).toBe(false);
	});

	test("allows a wait that names the peer it depends on", () => {
		expect(isUntargetedWait({ op: "wait", from: "Shepherd" })).toBe(false);
	});

	test("an empty ids array is still a poll, not a dependency", () => {
		expect(isUntargetedWait({ op: "wait", ids: [] })).toBe(true);
	});

	test("a blank from is still a poll", () => {
		expect(isUntargetedWait({ op: "wait", from: "   " })).toBe(true);
	});

	test("leaves every other hub op alone", () => {
		for (const op of ["send", "inbox", "list", "jobs", "cancel", "start", "logs", "stop"]) {
			expect(isUntargetedWait({ op })).toBe(false);
		}
	});

	test("survives malformed payloads without blocking", () => {
		for (const input of [null, undefined, 42, "wait", [], [{ op: "wait" }], {}]) {
			expect(isUntargetedWait(input)).toBe(false);
		}
	});

	test("refusal names the free alternative and both targeted forms", () => {
		expect(WAIT_REFUSAL).toContain("END YOUR TURN");
		expect(WAIT_REFUSAL).toContain("`ids`");
		expect(WAIT_REFUSAL).toContain("`from`");
	});
});
