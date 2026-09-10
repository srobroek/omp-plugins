import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Resume a turn that ended on a provider quota notice.
 *
 * The bedrock-mantle gateway surfaces `You have N weighted tokens left` (or
 * `You have N tokens left`) inside the model's response while a request bucket
 * drains. When that line is the whole final message, the run has stopped on
 * noise. The `srobroek-quota-notice-continue` TTSR rule covers most cases, but
 * TTSR repeat gating (`ttsr.repeatMode: after-gap`) can skip a second notice that
 * arrives within the gap. This hook re-prompts on every terminal notice, bounded
 * per session so a drained bucket cannot loop forever.
 */

export const NOTICE = /^\s*You have \d[\d,]* (?:weighted )?tokens left\.?\s*$/i;
export const MAX_RESUMES = 5;
export const CUSTOM_TYPE = "quota-notice-resume";

const RESUME_TEXT =
	"The previous line was a provider quota notice, not a result. Continue the task from where you were: " +
	"issue the next tool call, or finish the answer you were composing. If the next request fails with a " +
	"rate-limit or credential error, report that error verbatim.";

interface ContentBlock {
	type?: string;
	text?: string;
}

interface MessageLike {
	role?: string;
	stopReason?: string;
	content?: ContentBlock[] | string;
}

/** Return the notice text when the last assistant message is only a quota notice, else null. */
export function terminalNotice(messages: readonly MessageLike[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason && message.stopReason !== "stop") return null;
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
		if (blocks.some(block => block.type === "toolCall")) return null;
		const text = blocks
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n")
			.trim();
		return NOTICE.test(text) ? text : null;
	}
	return null;
}

export default function quotaNoticeResume(pi: ExtensionAPI): void {
	let resumes = 0;
	pi.on("agent_end", event => {
		if (event.willContinue) return;
		const notice = terminalNotice(event.messages as readonly MessageLike[]);
		if (!notice) return;
		if (resumes >= MAX_RESUMES) return;
		resumes += 1;
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: RESUME_TEXT,
				display: true,
				details: { notice, resume: resumes },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
