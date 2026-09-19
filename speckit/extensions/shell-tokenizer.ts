/**
 * Static shell tokenization shared by the guards in this repository.
 *
 * Plugins are bundled in isolation: `scripts/build-extensions.py` copies one
 * plugin tree and resolves imports inside it. Keep this file byte-identical in
 * each plugin that consumes it; `scripts/check-shared-detector.py` enforces
 * that contract. This is deliberately a lexer, never a shell evaluator.
 *
 * A here-document is queued when its redirection is read. At the following
 * newline, a quoted delimiter makes the body inert data; an unquoted delimiter
 * feeds the body back through this same lexer. That mirrors the shell rule
 * that only an unquoted here-document expands substitutions, without ever
 * expanding or executing one here.
 */

export type ShellToken = {
	value: string;
	/** The token began inside a quote (the shell-command consumer needs this). */
	startsQuoted: boolean;
	/** Any part of the token was quoted (the speckit consumer needs this). */
	sawQuote: boolean;
};

export type TokenizeOptions = {
	/** Keep escapes visible for consumers that reject shell indirection. */
	preserveBackslashes?: boolean;
};

type HereDocument = {
	delimiter: string;
	stripTabs: boolean;
	quoted: boolean;
	end: number;
};

type HereDocumentBody = {
	bodyEnd: number;
	terminatorEnd: number;
};

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);

function token(value: string, startsQuoted = false, sawQuote = false): ShellToken {
	return { value, startsQuoted, sawQuote };
}

/** Tokenize command-shaped source without invoking a shell. */
export function tokenizeShell(command: string, options: TokenizeOptions = {}): ShellToken[] {
	const out: ShellToken[] = [];
	let current = "";
	let started = false;
	let startsQuoted = false;
	let sawQuote = false;
	let quote: '"' | "'" | null = null;
	const pending: HereDocument[] = [];

	const flush = (): void => {
		if (!started) return;
		out.push(token(current, startsQuoted, sawQuote));
		current = "";
		started = false;
		startsQuoted = false;
		sawQuote = false;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote !== null) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			started = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			if (!started) startsQuoted = true;
			started = true;
			sawQuote = true;
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			if (options.preserveBackslashes) current += ch;
			current += command[++i] as string;
			started = true;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			flush();
			out.push(token("$("));
			i++;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
			flush();
			out.push(token("<<<"));
			i += 2;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<") {
			const operator = hereDocumentOperator(command, i);
			if (operator !== null) {
				flush();
				pending.push(operator);
				i = operator.end - 1;
				continue;
			}
		}
		if (ch === "\n") {
			flush();
			out.push(token(ch));
			let bodyStart = i + 1;
			while (pending.length > 0) {
				const document = pending.shift();
				if (document === undefined) break;
				const body = hereDocumentBody(command, bodyStart, document);
				if (!document.quoted) {
					out.push(...tokenizeShell(command.slice(bodyStart, body.bodyEnd), options));
				}
				i = body.terminatorEnd;
				bodyStart = i + 1;
			}
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (SEPARATORS.has(ch)) {
			flush();
			out.push(token(ch));
			continue;
		}
		current += ch;
		started = true;
	}
	flush();
	return out;
}

/** Whether the source ends outside a single- or double-quoted word. */
export function shellQuoteBalanced(command: string): boolean {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote !== null) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "\\") i++;
	}
	return quote === null;
}

function hereDocumentOperator(command: string, start: number): HereDocument | null {
	let i = start + 2;
	const stripTabs = command[i] === "-";
	if (stripTabs) i++;
	while (command[i] === " " || command[i] === "\t") i++;

	let delimiter = "";
	let quoted = false;
	let quote: '"' | "'" | null = null;
	while (i < command.length) {
		const ch = command[i] as string;
		if (quote !== null) {
			if (ch === quote) {
				quote = null;
				i++;
				continue;
			}
			delimiter += ch;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quoted = true;
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			quoted = true;
			delimiter += command[i + 1] as string;
			i += 2;
			continue;
		}
		if (/\s|[;&|<>()]/.test(ch)) break;
		delimiter += ch;
		i++;
	}
	if (quote !== null || delimiter.length === 0) return null;
	return { delimiter, stripTabs, quoted, end: i };
}

function hereDocumentBody(command: string, from: number, document: HereDocument): HereDocumentBody {
	let cursor = from;
	while (cursor < command.length) {
		let next = command.indexOf("\n", cursor);
		if (next === -1) next = command.length;
		let line = command.slice(cursor, next);
		if (document.stripTabs) line = line.replace(/^\t+/, "");
		if (line === document.delimiter) return { bodyEnd: cursor, terminatorEnd: next };
		if (next === command.length) break;
		cursor = next + 1;
	}
	return { bodyEnd: command.length, terminatorEnd: command.length };
}
