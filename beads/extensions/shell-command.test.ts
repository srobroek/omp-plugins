import { expect, test } from "bun:test";
import { type ShellScan, scanShell } from "./shell-command.ts";

/** Each item as text: an operator as itself, a command as its words. */
function outline(scan: ShellScan): string[] {
	return scan.items.map(item => (item.kind === "operator" ? item.operator : item.words.map(word => word.value).join(" ")));
}

test("reads fd redirections as redirections, not as background operators", () => {
	const scan = scanShell("bd list 2>&1 | head -40 &> log; bd prime >| out");
	expect(outline(scan)).toEqual(["bd list", "|", "head -40", ";", "bd prime"]);
	expect(scan.items.flatMap(item => (item.kind === "command" ? [item.redirects.map(word => word.value)] : []))).toEqual([["1"], ["log"], ["out"]]);
});

test("keeps quoted separators inside their word and records exact source offsets", () => {
	const source = `bd close x --reason 'a; b | c' && echo "d && e"`;
	const scan = scanShell(source);
	expect(outline(scan)).toEqual(["bd close x --reason a; b | c", "&&", "echo d && e"]);
	const first = scan.items[0];
	if (first?.kind !== "command") throw new Error("expected a command first");
	expect(first.words.map(word => source.slice(word.start, word.end))).toEqual(["bd", "close", "x", "--reason", "'a; b | c'"]);
	expect(first.words[4]?.quoted).toBe(true);
	expect(scan.complete).toBe(true);
});

test("returns every substitution for the caller to judge, wherever it expands", () => {
	const scan = scanShell("echo \"$(bd list)\" `date` <(sort f)\ncat <<EOF\n$(bd show x)\nEOF\ncat <<'EOF'\n$(inert)\nEOF\n");
	expect(scan.substitutions).toEqual(["bd list", "date", "sort f", "bd show x"]);
	expect(scan.items.flatMap(item => (item.kind === "command" ? item.hereDocuments : []))).toEqual([
		{ body: "$(bd show x)\n", quoted: false },
		{ body: "$(inert)\n", quoted: true },
	]);
});

test("marks words the shell expands later", () => {
	const scan = scanShell("bd -C $DIR close ~/x 'lit$eral' *.md");
	const first = scan.items[0];
	if (first?.kind !== "command") throw new Error("expected a command");
	expect(first.words.map(word => word.expands)).toEqual([false, false, true, false, true, false, true]);
});

test("treats braces as group words only in command position", () => {
	// The group's own redirection is a command with no words.
	expect(outline(scanShell("{ bd list; } > out; find . -exec echo {} +"))).toEqual(["{", "bd list", ";", "}", "", ";", "find . -exec echo {} +"]);
});

test("drops comments and joins continued lines", () => {
	expect(outline(scanShell("bd list \\\n  --json # then bd close x"))).toEqual(["bd list --json"]);
});

test("reports an open quote, substitution or here-document as incomplete", () => {
	for (const source of ["echo 'open", 'echo "open', "echo $(bd list", "cat <<EOF\nbody", "cat <<EOF"]) {
		expect(scanShell(source).complete).toBe(false);
	}
});
