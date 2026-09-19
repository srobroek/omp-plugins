import { describe, expect, test } from "bun:test";

import { tokenize as tokenizeBeads } from "./bd-close-gate.ts";
import { tokenize as tokenizeShellCommand } from "./shell-command.ts";
import { tokenize as tokenizeSpeckit } from "../../speckit/extensions/taskstoissues-gate.ts";
import { tokenize as tokenizeWorktrunk } from "../../worktrunk/extensions/worktree-gate.ts";

type Tokenizer = (command: string) => unknown[] | null;

const tokenizers: Record<string, Tokenizer> = {
	beads: command => tokenizeBeads(command),
	worktrunk: command => tokenizeWorktrunk(command),
	speckit: command => tokenizeSpeckit(command),
	shellCommand: command => tokenizeShellCommand(command),
};

function values(result: unknown[] | null): string[] {
	if (result === null) return [];
	return result.map(token => {
		if (typeof token === "string") return token;
		if (token !== null && typeof token === "object") {
			if ("value" in token && typeof token.value === "string") return token.value;
			if ("text" in token && typeof token.text === "string") return token.text;
		}
		throw new Error(`unexpected token ${String(token)}`);
	});
}

const unquoted = [
	"env",
	"FOO=1",
	"cat",
	"|",
	"tee",
	"/tmp/out",
	"&",
	"&",
	"printf",
	"%s",
	"nested 'quotes'",
	">out",
	";",
	"echo",
	"after",
	"\n",
	"$(",
	"bd",
	"close",
	"bead-1",
	")",
	"\n",
	"echo",
	"done",
];

const command = "env FOO=1 cat <<EOF | tee /tmp/out && printf '%s' \"nested 'quotes'\" >out; echo after\n$(bd close bead-1)\nEOF\necho done";
const quotedCommand = command.replace("<<EOF", "<<'EOF'");

describe("shared shell tokenizer corpus", () => {
	test("all four isolated tokenizer paths agree on executable values", () => {
		const results = Object.fromEntries(Object.entries(tokenizers).map(([name, tokenize]) => [name, values(tokenize(command))]));
		for (const result of Object.values(results)) expect(result).toEqual(unquoted);
	});

	test("quoted heredoc bodies are inert for every tokenizer path", () => {
		for (const tokenize of Object.values(tokenizers)) {
			const result = values(tokenize(quotedCommand));
			expect(result).not.toContain("bd");
			expect(result).not.toContain("close");
			expect(result).toEqual([
				"env",
				"FOO=1",
				"cat",
				"|",
				"tee",
				"/tmp/out",
				"&",
				"&",
				"printf",
				"%s",
				"nested 'quotes'",
				">out",
				";",
				"echo",
				"after",
				"\n",
				"echo",
				"done",
			]);
		}
	});
});
