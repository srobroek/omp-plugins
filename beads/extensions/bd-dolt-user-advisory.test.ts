import { afterEach, describe, expect, test } from "bun:test";

import bdDoltUserAdvisory, {
	DOLT_USER_ADVISORY,
	decideBdDoltUser,
	resetBdDoltUserAdvisoryForTests,
} from "./bd-dolt-user-advisory.ts";

afterEach(() => resetBdDoltUserAdvisoryForTests());

describe("decideBdDoltUser", () => {
	test("advises when bd lacks the Dolt user variable", () => {
		expect(decideBdDoltUser("bd status", {})).toBe(DOLT_USER_ADVISORY);
	});

	test("stays silent when the variable is present", () => {
		expect(decideBdDoltUser("bd status", { BEADS_DOLT_SERVER_USER: "beads" })).toBeUndefined();
		expect(decideBdDoltUser("BEADS_DOLT_SERVER_USER=beads bd status", {})).toBeUndefined();
	});

	test("ignores mentions outside command position", () => {
		for (const command of [
			"echo 'bd status'",
			"git log --grep='bd status'",
			"cat <<'EOF'\nbd status\nEOF",
		]) {
			expect(decideBdDoltUser(command, {})).toBeUndefined();
		}
	});
});

describe("integration", () => {
	type Sent = { payload: Record<string, unknown> };

	function register(): { handler: (event: unknown) => unknown; sent: Sent[] } {
		const sent: Sent[] = [];
		let handler: ((event: unknown) => unknown) | undefined;
		const fakePi = {
			zod: {},
			registerTool: () => {},
			sendMessage: (payload: Record<string, unknown>) => sent.push({ payload }),
			on: (event: string, callback: (event: unknown) => unknown) => {
				if (event === "tool_call") handler = callback;
			},
		};
		bdDoltUserAdvisory(fakePi as never);
		return { handler: handler as (event: unknown) => unknown, sent };
	}

	test("sends one non-blocking advisory per process", () => {
		const { handler, sent } = register();
		expect(handler({ toolName: "bash", input: { command: "bd status", env: { BEADS_DOLT_SERVER_USER: "" } } })).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.payload).toEqual(expect.objectContaining({
			customType: "com.srobroek.beads.dolt-user-advisory",
			content: DOLT_USER_ADVISORY,
			display: true,
			attribution: "user",
		}));
		expect(handler({ toolName: "bash", input: { command: "bd status", env: { BEADS_DOLT_SERVER_USER: "" } } })).toBeUndefined();
		expect(sent).toHaveLength(1);
	});
});
