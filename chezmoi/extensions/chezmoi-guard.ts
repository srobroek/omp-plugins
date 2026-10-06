import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { type ShellToken, tokenizeShell } from "./shell-tokenizer.ts";

/**
 * Refuses writes to a chezmoi-managed live target: the next `chezmoi apply`
 * overwrites the target from source, so the edit is lost. The refusal names the
 * source path to edit instead.
 *
 * Coverage is literal and static, never a shell sandbox:
 * - `edit`/`write`/`apply_patch`: top-level `path`/`file_path`/`paths`, hashline
 *   `[PATH#TAG]` section headers and `MV DEST`, and apply_patch
 *   `*** Add|Update|Delete|Edit File:` / `*** Move to:` headers.
 * - `bash`: `>`/`>>`/`>|` redirects, `tee`, `cp`/`mv` destinations, `sed -i`/`gsed -i`
 *   and `perl -i`, behind `sudo`/`doas`/`env`/`command`/`exec`/`nohup`/`time` and
 *   assignment prefixes. Relative paths resolve against a literal `cd DIR` earlier
 *   in the same command; after a non-literal `cd` they are skipped.
 */

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true };
const SUBPROCESS_TIMEOUT_MS = 2000;
/** `chezmoi add`/`forget` from another terminal change the managed set without any call this guard sees. */
export const MANAGED_TTL_MS = 5000;

/** Internal URIs (`xd://ast_edit`, `local://…`) are not filesystem paths. */
const NON_FILE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HASHLINE_HEADER = /^\s*\[([^#\r\n]+)#[0-9a-fA-F]{4}\]\s*$/;
const HASHLINE_MOVE = /^\s*MV\s+(.+?)\s*$/;
const PATCH_HEADER = /^\*\*\* (?:(?:Add|Update|Delete|Edit) File|Move to):\s*(.+?)\s*$/;
/** Separator tokens from `tokenizeShell`; `&&`/`||` arrive as two tokens each. */
const SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "$(": true };
/** Words that run the next word as the command. */
const PASSTHROUGH: Record<string, true> = { command: true, exec: true, nohup: true, time: true, "--": true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `chezmoi` as a command word: its subcommands (`add`, `forget`, …) change the managed set. */
const CHEZMOI_RUN = /(?:^|[\s;&|(/])chezmoi(?:\s|$)/;

type Cache = {
	managed: Set<string> | null;
	managedAt: number;
	sourceDir: string | null;
	sourceDirResolved: boolean;
};

const cache: Cache = {
	managed: null,
	managedAt: 0,
	sourceDir: null,
	sourceDirResolved: false,
};

let testSpawn: ((args: string[]) => string | null) | null = null;

export function spawnChezmoi(args: string[]): string | null {
	if (testSpawn) return testSpawn(args);
	try {
		const proc = Bun.spawnSync(["chezmoi", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: SUBPROCESS_TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return null;
		return new TextDecoder().decode(proc.stdout);
	} catch {
		return null;
	}
}

export function setChezmoiSpawnForTests(fn: ((args: string[]) => string | null) | null): void {
	testSpawn = fn;
}

export function resetChezmoiGuardForTests(): void {
	cache.managed = null;
	cache.managedAt = 0;
	cache.sourceDir = null;
	cache.sourceDirResolved = false;
	testSpawn = null;
}

export function seedChezmoiCacheForTests(managed: Set<string> | null, sourceDir: string | null): void {
	cache.managed = managed;
	cache.managedAt = Date.now();
	cache.sourceDir = sourceDir;
	cache.sourceDirResolved = true;
}

export function lexicalAbs(target: string, cwd: string): string {
	let expanded = target.startsWith("~") ? homedir() + target.slice(1) : target;
	if (!isAbsolute(expanded)) expanded = resolve(cwd, expanded);
	const parts: string[] = [];
	for (const segment of expanded.split(/[/\\]/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return "/" + parts.join("/");
}

export function under(child: string, parent: string): boolean {
	if (!parent) return false;
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function unquote(path: string): string {
	const first = path[0];
	if (path.length > 1 && (first === '"' || first === "'") && path.endsWith(first)) return path.slice(1, -1);
	return path;
}

/**
 * Target paths in an edit payload: hashline `[PATH#TAG]` headers and their
 * `MV DEST` ops, plus apply_patch file and move headers. Hashline body rows
 * (`+…`) are content, so a quoted header inside one is not a target.
 */
export function patchPaths(payload: string): string[] {
	const out: string[] = [];
	let inHashline = false;
	for (const raw of payload.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const header = HASHLINE_HEADER.exec(line);
		if (header) {
			inHashline = true;
			out.push(unquote((header[1] ?? "").trim()));
			continue;
		}
		const patch = PATCH_HEADER.exec(line);
		if (patch) {
			inHashline = false;
			out.push(unquote(patch[1] ?? ""));
			continue;
		}
		if (!inHashline || line.startsWith("+")) continue;
		const move = HASHLINE_MOVE.exec(line);
		if (move) out.push(unquote(move[1] ?? ""));
	}
	return out.filter((path) => path.length > 0);
}

/** Every path an `edit`/`write`/`apply_patch` call would write. */
export function editedFiles(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["path", "file_path", "_path"]) {
		const value = input[key];
		if (typeof value === "string" && value) out.push(value);
	}
	if (Array.isArray(input.paths)) {
		for (const value of input.paths) if (typeof value === "string" && value) out.push(value);
	}
	// `patch` mode: per-entry renames move the file to a new target.
	if (Array.isArray(input.edits)) {
		for (const entry of input.edits) {
			const rename = (entry as { rename?: unknown } | null)?.rename;
			if (typeof rename === "string" && rename) out.push(rename);
		}
	}
	for (const key of ["input", "_input"]) {
		const value = input[key];
		if (typeof value === "string" && value) out.push(...patchPaths(value));
	}
	return [...new Set(out)];
}

/** A write destination; `sources` set means "into this directory when it is one". */
type RawTarget = { path: string; sources?: string[]; intoDir?: boolean };

/** Drop wrappers that run the next word as the command (`sudo`, `env`, assignments, …). */
function commandWords(args: string[]): string[] {
	let i = 0;
	while (i < args.length) {
		const word = args[i] as string;
		if (ASSIGNMENT.test(word) || Object.hasOwn(PASSTHROUGH, word)) {
			i++;
		} else if (word === "env") {
			i++;
			while (i < args.length && ((args[i] as string).startsWith("-") || ASSIGNMENT.test((args[i] as string)))) {
				if (args[i] === "-u" || args[i] === "--unset" || args[i] === "-C" || args[i] === "--chdir") i++;
				i++;
			}
		} else if (word === "sudo" || word === "doas") {
			i++;
			while (i < args.length && (args[i] as string).startsWith("-")) {
				const opt = args[i] as string;
				i++;
				if (opt === "--") break;
				if (/^-[ugCDhprtTU]$/.test(opt)) i++;
			}
		} else {
			break;
		}
	}
	return args.slice(i);
}

function teePaths(args: string[]): string[] {
	const at = args.indexOf("--");
	const options = at === -1 ? args : args.slice(0, at);
	const rest = at === -1 ? [] : args.slice(at + 1);
	return [...options.filter((arg) => !arg.startsWith("-") || arg === "-"), ...rest].filter((arg) => arg !== "-");
}

function copyTargets(args: string[]): RawTarget[] {
	const positional: string[] = [];
	let targetDir: string | undefined;
	let noTargetDir = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") {
			positional.push(...args.slice(i + 1));
			break;
		}
		if (arg === "-t" || arg === "--target-directory") targetDir = args[++i];
		else if (arg.startsWith("--target-directory=")) targetDir = arg.slice("--target-directory=".length);
		else if (/^-t./.test(arg)) targetDir = arg.slice(2);
		else if (arg === "-T" || arg === "--no-target-directory") noTargetDir = true;
		else if (arg === "-S") i++;
		else if (!arg.startsWith("-") || arg === "-") positional.push(arg);
	}
	if (targetDir) return [{ path: targetDir, sources: positional, intoDir: true }];
	if (positional.length < 2) return [];
	const dest = positional[positional.length - 1] as string;
	return [noTargetDir ? { path: dest } : { path: dest, sources: positional.slice(0, -1) }];
}

function sedPaths(args: string[]): string[] {
	let inplace = false;
	let script = false;
	const paths: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i] as string;
		if (token === "--") {
			paths.push(...args.slice(i + 1 + (script ? 0 : 1)));
			break;
		}
		if (token === "-e" || token === "-f" || token === "--expression" || token === "--file") {
			script = true;
			i++;
		} else if (/^--(?:expression|file)=/.test(token) || /^-[ef].+/.test(token)) {
			script = true;
		} else if (/^--in-place(?:=|$)/.test(token) || /^-[a-zA-Z]*i/.test(token)) {
			inplace = true;
			if (token === "-i" && args[i + 1] === "") i++;
		} else if (!token.startsWith("-")) {
			// BSD `-i .bak` reads its suffix as a word; counting it as the script makes
			// the real script a candidate path, which only over-includes.
			if (!script) script = true;
			else paths.push(token);
		}
	}
	return inplace ? paths : [];
}

function perlPaths(args: string[]): string[] {
	let inplace = false;
	let script = false;
	let positional = false;
	const files: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (!positional && arg === "--") {
			positional = true;
			continue;
		}
		if (!positional && arg.startsWith("-") && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				const flag = arg[j] as string;
				if (flag === "e" || flag === "E") {
					script = true;
					if (j === arg.length - 1) i++;
					break;
				}
				if (flag === "i") {
					inplace = true;
					break;
				}
				// These take the rest of the bundle as their argument.
				if ("MmIdDxlo0C".includes(flag)) break;
			}
			continue;
		}
		positional = true;
		if (!script) script = true;
		else files.push(arg);
	}
	return inplace ? files : [];
}

/** Redirect targets plus the write destinations of one simple command. */
function simpleCommandTargets(words: ShellToken[]): RawTarget[] {
	const out: RawTarget[] = [];
	const args: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as ShellToken;
		const value = word.value;
		if (word.sawQuote) {
			args.push(value);
			continue;
		}
		if (value.startsWith("<")) {
			// Input redirect or here-string: the next word is read, not written.
			if (value === "<" || value === "<<<") i++;
			continue;
		}
		const at = value.indexOf(">");
		if (at === -1) {
			args.push(value);
			continue;
		}
		const before = value.slice(0, at);
		if (before && !/^\d+$/.test(before)) args.push(before);
		let target = value.slice(at + 1);
		if (target.startsWith(">") || target.startsWith("|")) target = target.slice(1);
		if (!target) target = words[++i]?.value ?? "";
		if (target) out.push({ path: target });
	}
	const argv = commandWords(args);
	const name = basename(argv[0] ?? "");
	const rest = argv.slice(1);
	if (name === "tee") out.push(...teePaths(rest).map((path) => ({ path })));
	else if (name === "cp" || name === "mv") out.push(...copyTargets(rest));
	else if (name === "sed" || name === "gsed") out.push(...sedPaths(rest).map((path) => ({ path })));
	else if (name === "perl") out.push(...perlPaths(rest).map((path) => ({ path })));
	return out;
}

/** `$HOME`/`~` expand; any other expansion is unknowable statically. */
function literalPath(raw: string, cwd: string | null): string | undefined {
	const path = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir());
	if (/[$`]/.test(path)) return undefined;
	if (path.startsWith("~") || isAbsolute(path)) return lexicalAbs(path, "/");
	return cwd === null ? undefined : lexicalAbs(path, cwd);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The directory a `cd` word list leaves the shell in, or `null` when not literal. */
function cdTarget(args: string[], cwd: string | null): string | null {
	const dirs = args.filter((arg) => !/^-[LPe@]+$/.test(arg));
	if (dirs.length === 0) return homedir();
	const dir = dirs[0] as string;
	if (dir === "-") return null;
	return literalPath(dir, cwd) ?? null;
}

/**
 * Absolute paths a bash command would write, by static reading of literal words.
 * `cd` inside `( … )` or `$( … )` applies only until the group closes.
 */
export function bashWriteTargets(command: string, cwd: string): string[] {
	const out: string[] = [];
	let dir: string | null = cwd;
	const saved: (string | null)[] = [];
	let words: ShellToken[] = [];
	const finish = (): void => {
		const segment = words;
		words = [];
		if (segment.length === 0) return;
		const argv = commandWords(segment.map((word) => word.value));
		if (argv[0] === "cd") {
			dir = cdTarget(argv.slice(1), dir);
			return;
		}
		for (const target of simpleCommandTargets(segment)) {
			const abs = literalPath(target.path, dir);
			if (abs === undefined) continue;
			const intoDir = target.intoDir || (target.sources && (target.path.endsWith("/") || isDirectory(abs)));
			if (intoDir && target.sources) {
				for (const source of target.sources) out.push(join(abs, basename(source)));
			} else {
				out.push(abs);
			}
		}
	};
	for (const token of tokenizeShell(command)) {
		if (token.sawQuote || !Object.hasOwn(SEPARATORS, token.value)) {
			words.push(token);
			continue;
		}
		finish();
		if (token.value === "(" || token.value === "$(") saved.push(dir);
		else if (token.value === ")" && saved.length > 0) dir = saved.pop() ?? null;
	}
	finish();
	return [...new Set(out)];
}

function normalized(path: string): string {
	try { return realpathSync(path); } catch { return path; }
}

export function shouldInspect(abs: string, _cwd: string): boolean {
	return under(abs, homedir()) || under(normalized(abs), normalized(homedir()));
}

export function loadManaged(): Set<string> | null {
	if (cache.managed && Date.now() - cache.managedAt < MANAGED_TTL_MS) return cache.managed;
	const out = spawnChezmoi(["managed", "--path-style=absolute"]);
	if (out === null) return null;
	const set = new Set<string>();
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (t) set.add(t);
	}
	cache.managed = set;
	cache.managedAt = Date.now();
	return set;
}

export function loadSourceDir(): string | null {
	if (cache.sourceDirResolved) return cache.sourceDir;
	const out = spawnChezmoi(["source-path"]);
	cache.sourceDirResolved = true;
	if (out === null) {
		cache.sourceDir = null;
		return null;
	}
	const dir = out.trim();
	cache.sourceDir = dir || null;
	return cache.sourceDir;
}

function refreshIfSourceEdit(abs: string): void {
	const source = loadSourceDir();
	if (source && under(abs, source)) cache.managed = null;
}

export function considerPath(abs: string, cwd: string): { block: true; reason: string } | undefined {
	if (!shouldInspect(abs, cwd)) return;
	const sourceDir = loadSourceDir();
	if (sourceDir && under(normalized(abs), normalized(sourceDir))) {
		refreshIfSourceEdit(abs);
		return;
	}
	const managed = loadManaged();
	if (!managed) return;
	const normalizedAbs = normalized(abs);
	let target = managed.has(abs) ? abs : undefined;
	if (!target) {
		for (const path of managed) {
			if (normalized(path) === normalizedAbs) { target = path; break; }
		}
	}
	if (!target) return;
	const out = spawnChezmoi(["source-path", target]);
	const source = out?.trim() || `(run: chezmoi source-path ${abs})`;
	return {
		block: true,
		reason:
			`'${abs}' is a chezmoi-managed TARGET, not the source; the next chezmoi apply overwrites it. ` +
			`Edit the source at '${source}', then run chezmoi apply. ` +
			`Do not write the live home-directory copy.`,
	};
}

export default function chezmoiGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		try {
			// Edit payloads are read by dynamic key (`input`, `_input`, `edits`), so the
			// untyped host input is narrowed once here.
			const input = event.input as Record<string, unknown>;
			const sessionCwd = ctx?.cwd || process.cwd();
			const cwd = typeof input.cwd === "string" && input.cwd ? lexicalAbs(input.cwd, sessionCwd) : sessionCwd;
			let paths: string[];

			if (Object.hasOwn(EDIT_TOOLS, event.toolName)) {
				paths = editedFiles(input)
					.filter((path) => !NON_FILE_SCHEME.test(path))
					.map((path) => lexicalAbs(path, cwd));
			} else if (event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				if (!command) return;
				if (CHEZMOI_RUN.test(command)) cache.managed = null;
				paths = bashWriteTargets(command, cwd);
			} else {
				return;
			}

			for (const abs of paths) {
				refreshIfSourceEdit(abs);
				const decision = considerPath(abs, cwd);
				if (decision) return decision;
			}
		} catch {
			return;
		}
	});
}
