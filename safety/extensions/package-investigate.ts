import type { ExtensionAPI, ExtensionToolCallEvent, ExtensionToolResultEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * Nudge before/after package-manager add or change. Original PreToolUse
 * additionalContext has no OMP equivalent, so the advice is prepended to the
 * bash tool_result (after the command). Fail-open on any parse error.
 */

const MANAGER_TOKENS = [
	"pnpm",
	"npm",
	"yarn",
	"bun",
	"uv",
	"pip",
	"poetry",
	"cargo",
	"go",
	"gem",
	"bundle",
	"composer",
];

const ADD_SUFFIX =
	/^(pnpm\s+(add|install)|npm\s+(install|i|add)|yarn\s+add|bun\s+add|uv\s+(add|pip\s+install)|pip3?\s+install|poetry\s+add|cargo\s+add|go\s+get|go\s+install|gem\s+install|bundle\s+add|composer\s+require)(\s|$)/;

const CHANGE_SUFFIX =
	/^(pnpm\s+(update|up|remove)|npm\s+(update|upgrade|uninstall|remove|rm)|yarn\s+(up|upgrade|remove)|bun\s+(update|remove)|uv\s+(remove|lock|sync)|pip3?\s+uninstall|poetry\s+(update|remove)|cargo\s+(update|upgrade|remove)|go\s+mod\s+tidy|bundle\s+(update|remove)|composer\s+(update|remove))(\s|$)/;

const ADD_ADVICE =
	"Before adding this dependency, screen it: reputable author/org, no " +
	"typosquat, not abandoned/deprecated. Use the package registry / web / " +
	"context7 to check current facts -- training data can predate a compromise " +
	"or deprecation. If it's clearly fine, say so in one line and proceed; if " +
	"there's a concern, raise it before installing.";

const CHANGE_ADVICE =
	"Dependency change (update/upgrade/remove): confirm it's intended and check " +
	"for breaking changes / changelog notes for the new version, and that " +
	"nothing still depends on anything being removed. Prefer the latest " +
	"compatible version. No need to re-vet a package already in use unless the " +
	"major version changes.";

function commandSegments(command: string): string[] {
	const out: string[] = [];
	let start = 0;
	let quote = "";
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = "";
			continue;
		}
		if (quote === '"') {
			if (char === "\\") escaped = true;
			else if (char === '"') quote = "";
			continue;
		}
		if (char === "\\") escaped = true;
		else if (char === "'" || char === '"') quote = char;
		else if (char === ";" || char === "&" || char === "|" || char === "\n") {
			out.push(command.slice(start, index));
			start = index + 1;
		}
	}
	out.push(command.slice(start));
	return out;
}

function classify(command: string): string | null {
	const lc = command.toLowerCase();
	const segments = commandSegments(lc).map((s) => s.replace(/^\s+/, ""));
	if (segments.some((segment) => ADD_SUFFIX.test(segment))) return ADD_ADVICE;
	if (segments.some((segment) => CHANGE_SUFFIX.test(segment))) return CHANGE_ADVICE;
	return null;
}

const pending = new Map<string, string>();

function commandOf(event: ExtensionToolCallEvent): string {
	return typeof event.input.command === "string" ? event.input.command : "";
}

function prependText(
	event: ExtensionToolResultEvent,
	advice: string,
): { content: ExtensionToolResultEvent["content"] } | undefined {
	const banner = `<system-reminder>\n${advice}\n</system-reminder>\n\n`;
	const content = event.content.map((chunk, i) => {
		if (i === 0 && chunk.type === "text") {
			return { ...chunk, text: banner + chunk.text };
		}
		return chunk;
	});
	if (content.length === 0 || content[0]?.type !== "text") {
		return { content: [{ type: "text", text: banner }, ...event.content] };
	}
	return { content };
}

export default function packageInvestigate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		try {
			if (event.toolName !== "bash") return;
			const command = commandOf(event);
			if (!command) return;
			if (!MANAGER_TOKENS.some((t) => command.includes(t))) return;
			const advice = classify(command);
			if (!advice) return;
			pending.set(event.toolCallId, advice);
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event) => {
		try {
			if (event.toolName !== "bash") return;
			const advice = pending.get(event.toolCallId);
			if (!advice) return;
			pending.delete(event.toolCallId);
			return prependText(event, advice);
		} catch {
			return;
		}
	});
}
