import { describe, expect, test } from "bun:test";
import quotaNoticeResume, { CUSTOM_TYPE, MAX_RESUMES, terminalNotice } from "./quota-notice-resume";

type Handler = (event: unknown) => unknown;

function fakePi(): { handlers: Record<string, Handler[]>; sent: Array<{ message: unknown; options: unknown }>; pi: unknown } {
	const handlers: Record<string, Handler[]> = {};
	const sent: Array<{ message: unknown; options: unknown }> = [];
	return {
		handlers,
		sent,
		pi: {
			on: (ev: string, h: Handler) => {
				(handlers[ev] ??= []).push(h);
			},
			sendMessage: (message: unknown, options: unknown) => {
				sent.push({ message, options });
			},
		},
	};
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text }],
	...extra,
});

describe("terminalNotice", () => {
	test("matches the weighted and plain whole-message forms", () => {
		expect(terminalNotice([assistant("You have 31348 weighted tokens left")])).toBe("You have 31348 weighted tokens left");
		expect(terminalNotice([assistant("You have 8020 tokens left.\n")])).toBe("You have 8020 tokens left.");
	});

	test("ignores a notice that precedes tool calls or other text", () => {
		expect(
			terminalNotice([
				{
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "text", text: "You have 863 weighted tokens left" }, { type: "toolCall", name: "read" }],
				},
			]),
		).toBeNull();
		expect(terminalNotice([assistant("Done.\nYou have 863 weighted tokens left")])).toBeNull();
		expect(terminalNotice([assistant('The gateway said "You have 31348 weighted tokens left".')])).toBeNull();
	});

	test("looks at the last assistant message only", () => {
		expect(terminalNotice([assistant("You have 8020 tokens left"), { role: "user", content: [{ type: "text", text: "go on" }] }])).toBe(
			"You have 8020 tokens left",
		);
		expect(terminalNotice([assistant("You have 8020 tokens left"), assistant("DONE")])).toBeNull();
		expect(terminalNotice([])).toBeNull();
	});
});

describe("agent_end hook", () => {
	test("re-prompts once per terminal notice with a followUp", () => {
		const { handlers, sent, pi } = fakePi();
		quotaNoticeResume(pi as never);
		expect(handlers.agent_end).toHaveLength(1);

		handlers.agent_end![0]!({ type: "agent_end", messages: [assistant("You have 8020 tokens left")] });
		expect(sent).toHaveLength(1);
		const [{ message, options }] = sent as Array<{ message: { customType: string; details: { resume: number } }; options: { deliverAs: string; triggerTurn: boolean } }>;
		expect(message.customType).toBe(CUSTOM_TYPE);
		expect(message.details.resume).toBe(1);
		expect(options.deliverAs).toBe("followUp");
		expect(options.triggerTurn).toBe(true);
	});

	test("stays silent on normal endings and scheduled continuations", () => {
		const { handlers, sent, pi } = fakePi();
		quotaNoticeResume(pi as never);
		handlers.agent_end![0]!({ type: "agent_end", messages: [assistant("DONE")] });
		handlers.agent_end![0]!({ type: "agent_end", willContinue: true, messages: [assistant("You have 8020 tokens left")] });
		expect(sent).toHaveLength(0);
	});

	test("caps resumes per session", () => {
		const { handlers, sent, pi } = fakePi();
		quotaNoticeResume(pi as never);
		for (let i = 0; i < MAX_RESUMES + 3; i++) {
			handlers.agent_end![0]!({ type: "agent_end", messages: [assistant("You have 351 weighted tokens left")] });
		}
		expect(sent).toHaveLength(MAX_RESUMES);
	});
});
