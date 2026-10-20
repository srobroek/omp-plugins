import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parse, parsedInvocations } from "./shell-command.ts";

const BINARY_MAGICS = [
	[0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe],
	[0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe],
	[0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca],
	[0xca, 0xfe, 0xba, 0xbf], [0xbf, 0xba, 0xfe, 0xca],
	[0x7f, 0x45, 0x4c, 0x46],
] as const;
const SAMPLE_BYTES = 4096;
const GLOBAL_VALUE_FLAGS = new Set(["--actor", "--database", "--db", "-C", "--directory", "--dolt-auto-commit", "--mem-profile"]);
const SEPARATORS = new Set([";", "&", "|", "&&", "||", "(", ")", "{", "}", "\n"]);

type GitResult = { status: number | null; stdout: string };
type GitRunner = (cwd: string, args: string[]) => GitResult;
type CommandChunk = { start: number; end: number };
type WordSpan = { value: string; start: number; end: number };

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1000 });
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout.trim() };
}

function hooksDirectory(cwd: string, git: GitRunner): string | undefined {
	const result = git(cwd, ["rev-parse", "--git-path", "hooks"]);
	if (result.status === 0 && result.stdout !== "") return isAbsolute(result.stdout) ? result.stdout : resolve(cwd, result.stdout);
	// `bd init` can run before Git has initialised the checkout. In that case the
	// inherited system/global hooksPath is still the hook directory bd preserves.
	const configured = git(cwd, ["config", "--path", "--get", "core.hooksPath"]);
	if (configured.status === 0 && configured.stdout !== "") {
		return isAbsolute(configured.stdout) ? configured.stdout : resolve(cwd, configured.stdout);
	}
	const conventional = join(cwd, ".git", "hooks");
	return existsSync(conventional) ? conventional : undefined;
}

function fileHasMarker(path: string, magicsOnly = false): boolean {
	const fd = openSync(path, "r");
	try {
		const bytes = Buffer.alloc(SAMPLE_BYTES);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		const sample = bytes.subarray(0, count);
		if (!magicsOnly && sample.includes(0)) return true;
		return BINARY_MAGICS.some(magic => sample.length >= magic.length && magic.every((byte, index) => sample[index] === byte));
	} finally {
		closeSync(fd);
	}
}

/** True when Git's effective hook directory contains a regular non-text executable. */
export function hasBinaryHooks(cwd: string, git: GitRunner = runGit): boolean {
	try {
		const directory = hooksDirectory(cwd, git);
		if (directory === undefined) return false;
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			if (statSync(path).isFile() && fileHasMarker(path)) return true;
		}
		return false;
	} catch {
		// This preventive gate is advisory on probe failures; never break unrelated bd use.
		return false;
	}
}

/** Split at shell operators outside quotes, preserving source offsets. */
function commandChunks(command: string): CommandChunk[] {
	const chunks: CommandChunk[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < command.length; index++) {
		const character = command[index] ?? "";
		if (quote !== null) {
			if (character === quote) quote = null;
			else if (quote === '"' && character === "\\") index++;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; continue; }
		if (character === "\\") { index++; continue; }
		if (SEPARATORS.has(character)) {
			chunks.push({ start, end: index });
			if ((character === "&" || character === "|") && command[index + 1] === character) index++;
			start = index + 1;
		}
	}
	chunks.push({ start, end: command.length });
	return chunks;
}

/** Offsets for shell words in a separator-free command fragment. */
function wordSpans(source: string): WordSpan[] {
	const words: WordSpan[] = [];
	let index = 0;
	while (index < source.length) {
		while (index < source.length && /\s/.test(source[index] ?? "")) index++;
		if (index >= source.length) break;
		const start = index;
		let value = "";
		let quote: "'" | '"' | null = null;
		while (index < source.length) {
			const character = source[index] ?? "";
			if (quote !== null) {
				if (character === quote) quote = null;
				else if (quote === '"' && character === "\\" && index + 1 < source.length) value += source[++index] ?? "";
				else value += character;
				index++;
				continue;
			}
			if (character === "'" || character === '"') { quote = character; index++; continue; }
			if (character === "\\" && index + 1 < source.length) {
				value += source[index + 1] ?? "";
				index += 2;
				continue;
			}
			if (/\s/.test(character) || SEPARATORS.has(character)) break;
			value += character;
			index++;
		}
		if (index === start) index++;
		else words.push({ value, start, end: index });
	}
	return words;
}

function initVerbIndex(words: WordSpan[]): number | undefined {
	let index = words.findIndex(word => (word.value.split("/").pop() ?? word.value) === "bd");
	if (index < 0) return undefined;
	index++;
	while (index < words.length) {
		const flag = words[index]?.value ?? "";
		if (!flag.startsWith("-")) return flag === "init" ? index : undefined;
		if (flag === "--") return undefined;
		if (GLOBAL_VALUE_FLAGS.has(flag) && !flag.includes("=")) index++;
		index++;
	}
	return undefined;
}

/** Add --skip-hooks to direct `bd init` calls while preserving all original shell text. */
function rewriteInitCalls(command: string): string | undefined {
	const insertions: number[] = [];
	for (const chunk of commandChunks(command)) {
		const source = command.slice(chunk.start, chunk.end);
		const parsed = parse(source);
		if (parsed.unknown || parsed.commands.length !== 1) continue;
		const invocation = parsedInvocations(parsed).find(item => item.verb === "init");
		if (invocation === undefined || invocation.args.includes("--skip-hooks")) continue;
		const words = wordSpans(source);
		const verbIndex = initVerbIndex(words);
		if (verbIndex === undefined) continue;
		insertions.push(chunk.start + (words[verbIndex]?.end ?? 0));
	}
	if (insertions.length === 0) return undefined;
	let rewritten = command;
	for (const offset of insertions.sort((left, right) => right - left)) rewritten = `${rewritten.slice(0, offset)} --skip-hooks${rewritten.slice(offset)}`;
	return rewritten;
}

export type BinaryHooksDecision = { kind: "block"; reason: string } | { kind: "rewrite"; input: Record<string, unknown> } | undefined;

/** Protect `bd init` and `bd hooks install` before the embedded-write runner rewrites them. */
export function protectBinaryHookCommands(
	input: unknown,
	command: string,
	cwd: string,
	git: GitRunner = runGit,
): BinaryHooksDecision {
	try {
		const invocations = parsedInvocations(parse(command));
		const inits = invocations.filter(invocation => invocation.verb === "init");
		const installs = invocations.filter(invocation => invocation.verb === "hooks" && invocation.args[1] === "install");
		const needsInitGuard = inits.some(invocation => !invocation.args.includes("--skip-hooks"));
		if (!needsInitGuard && installs.length === 0) return undefined;
		if (!hasBinaryHooks(cwd, git)) return undefined;
		if (installs.length > 0) {
			return {
				kind: "block",
				reason: "`bd hooks install` was blocked because an existing Git hook is a binary executable that this installer could corrupt; it was blocked to keep the existing (binary) hooks intact.",
			};
		}
		if (!needsInitGuard) return undefined;
		const rewritten = rewriteInitCalls(command);
		if (rewritten === undefined) {
			return { kind: "block", reason: "`bd init` was blocked because binary Git hooks exist and the command could not be safely rewritten to add `--skip-hooks`; this keeps the existing (binary) hooks intact." };
		}
		const record = input !== null && typeof input === "object" ? input as Record<string, unknown> : undefined;
		const key = typeof record?.command === "string" ? "command" : typeof record?.cmd === "string" ? "cmd" : undefined;
		if (record === undefined || key === undefined) return undefined;
		return { kind: "rewrite", input: { ...record, [key]: rewritten } };
	} catch {
		return undefined;
	}
}

function localHookDirectory(cwd: string, git: GitRunner): string | undefined {
	const configured = git(cwd, ["config", "--local", "--get", "core.hooksPath"]);
	if (configured.status !== 0 || configured.stdout === "") return undefined;
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (root.status !== 0 || root.stdout === "") return undefined;
	return isAbsolute(configured.stdout) ? configured.stdout : resolve(root.stdout, configured.stdout);
}

function isInside(path: string, directory: string): boolean {
	const target = resolve(path);
	const base = resolve(directory);
	return target === base || target.startsWith(`${base}${sep}`);
}

/** Return repair guidance only when Beads has modified a binary hook backup. */
export function binaryHooksRepairAdvisory(cwd: string, git: GitRunner = runGit): string | undefined {
	try {
		const directory = localHookDirectory(cwd, git);
		if (directory === undefined) return undefined;
		const root = git(cwd, ["rev-parse", "--show-toplevel"]);
		if (root.status !== 0 || root.stdout === "") return undefined;
		const beadsHooks = join(root.stdout, ".beads", "hooks");
		if (!isInside(directory, beadsHooks)) return undefined;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".backup")) continue;
			const backupPath = join(directory, entry.name);
			const hookPath = join(directory, entry.name.slice(0, -".backup".length));
			try {
				if (!statSync(hookPath).isFile() || !fileHasMarker(backupPath, true)) continue;
				if (!readFileSync(backupPath).equals(readFileSync(hookPath))) {
					return "Beads appears to have modified a binary Git hook. Repair it manually with `git config --local --unset core.hooksPath` to restore the system/global hooks; optionally run `bd hooks uninstall` to remove the Beads-managed hooks. No repair was run automatically.";
				}
			} catch {
				// A missing/unreadable backup is not enough evidence for an advisory.
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

