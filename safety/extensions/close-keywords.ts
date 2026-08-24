import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * Rewrite `gh pr create|edit --body` so GitHub close-keywords apply to every
 * issue in a comma list. Advisory-only in Claude; here we rewrite the command
 * input (fail-open) because OMP has no PreToolUse additionalContext channel.
 *
 * The pre-commit commit-msg rewriter is omitted: OMP has no git commit-msg hook.
 */

const KEYWORDS = new Set([
	"close",
	"closes",
	"closed",
	"fix",
	"fixes",
	"fixed",
	"resolve",
	"resolves",
	"resolved",
]);

const REF = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[0-9]+|GH-[0-9]+/i;
const WORD = /^[A-Za-z]+/;
const SPACE = /^[^\S\n]+/;
const SEPARATORS = [
	/^[^\S\n]*,[^\S\n]+and[^\S\n]+/,
	/^[^\S\n]+and[^\S\n]+/,
	/^[^\S\n]*,[^\S\n]*/,
];

const GH_PR = /(?:^[^\S\n]*|[;&|][^\S\n]*)gh[^\S\n]+pr[^\S\n]+(?:create|edit)(?:\s|$)/m;
const MAX_COMMAND_LENGTH = 64_000;
const OPERATORS = new Set([";", "&&", "||", "&", "|", "\n"]);

function matchAt(pattern: RegExp, text: string, pos: string | number): string | null {
	const slice = typeof pos === "number" ? text.slice(pos) : pos;
	const m = pattern.exec(slice);
	return m && m.index === 0 ? m[0] : null;
}

function separatorAt(text: string, pos: number): string | null {
	const slice = text.slice(pos);
	for (const pattern of SEPARATORS) {
		const found = matchAt(pattern, slice, 0);
		if (found) return found;
	}
	return null;
}

function normalizeLine(line: string): string {
	const out: string[] = [];
	let pos = 0;
	const end = line.length;
	while (pos < end) {
		const last = out.length ? out[out.length - 1] : "";
		const atBoundary = !last || !( /[A-Za-z0-9_]$/.test(last) );
		const word = atBoundary ? matchAt(WORD, line, pos) : null;
		if (word === null) {
			out.push(line[pos]);
			pos += 1;
			continue;
		}
		if (!KEYWORDS.has(word.toLowerCase())) {
			out.push(word);
			pos += word.length;
			continue;
		}
		const afterWord = pos + word.length;
		const space = matchAt(SPACE, line, afterWord) ?? "";
		const firstRef = matchAt(REF, line, afterWord + space.length);
		if (firstRef === null) {
			out.push(word);
			pos += word.length;
			continue;
		}
		const keyword = word.toLowerCase();
		out.push(word + space + firstRef);
		pos = afterWord + space.length + firstRef.length;
		while (true) {
			const separator = separatorAt(line, pos);
			if (separator === null) break;
			const ref = matchAt(REF, line, pos + separator.length);
			if (ref === null) break;
			out.push(`${separator}${keyword} ${ref}`);
			pos += separator.length + ref.length;
		}
	}
	return out.join("");
}

function normalize(text: string): string {
	return text.split("\n").map(normalizeLine).join("\n");
}

function shellSegments(command: string): string[][] {
	const segments: string[][] = [[]];
	let current = "";
	let quote: "'" | '"' | null = null;
	const flushToken = () => {
		if (current !== "") {
			segments[segments.length - 1].push(current);
			current = "";
		}
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[++i];
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			flushToken();
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			flushToken();
			let op = ch;
			if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
				op += command[++i];
			}
			if (OPERATORS.has(op) || [...op].every((c) => ";&|\n".includes(c))) {
				segments.push([]);
			}
			continue;
		}
		current += ch;
	}
	flushToken();
	return segments;
}

function extractBody(command: string): string {
	let body = "";
	for (const segment of shellSegments(command)) {
		let commandStart = 0;
		while (commandStart < segment.length && segment[commandStart].includes("=")) {
			const name = segment[commandStart].split("=", 1)[0];
			if (!name || !( /[A-Za-z_]/.test(name[0]) )) break;
			if (![...name].every((c) => /[A-Za-z0-9_]/.test(c))) break;
			commandStart += 1;
		}
		if (segment[commandStart] !== "gh" || segment[commandStart + 1] !== "pr") continue;
		if (segment[commandStart + 2] !== "create" && segment[commandStart + 2] !== "edit") continue;
		const tokens = segment.slice(commandStart + 3);
		let candidate = "";
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			if (token === "--") break;
			if (token === "--body" || token === "-b") {
				candidate = index + 1 < tokens.length ? tokens[index + 1] : "";
			} else if (token.startsWith("--body=")) {
				candidate = token.slice("--body=".length);
			} else if (token.startsWith("-b=")) {
				candidate = token.slice("-b=".length);
			} else if (token.startsWith("-b") && !token.startsWith("--")) {
				candidate = token.slice(2);
			}
		}
		body = candidate;
	}
	return body;
}

function replaceLastBody(command: string, next: string): string | null {
	const flags = [/\s--body=/, /\s-b=/, /\s--body\s+/, /\s-b\s+/, /\s-b(?=["'])/];
	let last = -1;
	let kind = "";
	for (const flag of flags) {
		const re = new RegExp(flag.source, "g");
		let m: RegExpExecArray | null;
		while ((m = re.exec(command))) {
			last = m.index + m[0].length;
			kind = m[0];
		}
	}
	if (last < 0) return null;
	// Replace the value token after the last flag. Conservative: only rewrite
	// when the original body is a contiguous quoted or unquoted span we can find.
	const rest = command.slice(last);
	const quoted = rest.match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/);
	if (!quoted) return null;
	const escaped = next.includes("'")
		? `"${next.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
		: `'${next}'`;
	return command.slice(0, last) + escaped + rest.slice(quoted[0].length);
}

function commandOf(event: ExtensionToolCallEvent): string {
	const raw = event.input;
	if (typeof raw.command === "string") return raw.command;
	return "";
}

export default function closeKeywords(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		try {
			if (event.toolName !== "bash") return;
			const command = commandOf(event);
			if (!command || command.length > MAX_COMMAND_LENGTH) return;
			if (!command.includes("gh") || !command.includes("pr")) return;
			if (!GH_PR.test(command)) return;
			const body = extractBody(command);
			if (!body) return;
			const fixed = normalize(body);
			if (fixed === body) return;
			const rewritten = replaceLastBody(command, fixed);
			if (!rewritten) return;
			return { input: { ...event.input, command: rewritten } };
		} catch {
			return;
		}
	});
}
