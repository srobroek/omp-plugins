import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
 

/**
 * This small shell lexer follows the quote/separator model in
 * `toolchain/extensions/shell-tokenizer.ts`. It is local because plugin bundles
 * are isolated and may not import helpers from another plugin. Keep the parser
 * conservative: it recognizes literal command words and never evaluates shell.
 */
export type ShellToken = { value: string; startsQuoted: boolean; sawQuote: boolean };

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);

export function tokenizeShell(command: unknown): ShellToken[] {
	if (typeof command !== "string") return [];
	const tokens: ShellToken[] = [];
	let value = "";
	let started = false;
	let startsQuoted = false;
	let sawQuote = false;
	let quote: "'" | '"' | null = null;
	const flush = () => {
		if (!started) return;
		tokens.push({ value, startsQuoted, sawQuote });
		value = "";
		started = false;
		startsQuoted = false;
		sawQuote = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote !== null) {
			if (ch === quote) quote = null;
			else value += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			if (!started) startsQuoted = true;
			started = true;
			sawQuote = true;
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			value += command[++i] as string;
			started = true;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			flush();
			tokens.push({ value: "$(", startsQuoted: false, sawQuote: false });
			i++;
			continue;
		}
		if (ch === "\n" || /\s/.test(ch)) {
			flush();
			if (ch === "\n") tokens.push({ value: ch, startsQuoted: false, sawQuote: false });
			continue;
		}
		if (SEPARATORS.has(ch)) {
			flush();
			tokens.push({ value: ch, startsQuoted: false, sawQuote: false });
			continue;
		}
		value += ch;
		started = true;
	}
	flush();
	return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_WITH_VALUE = new Set(["-C", "--chdir", "-u", "--unset"]);
const RESERVED = new Set(["!", "if", "then", "elif", "else", "while", "until", "do", "{"]);

export type Invocation = {
	argv: readonly string[];
	cwd: string;
	environment: ReadonlyMap<string, string>;
};

/** Parse literal command words, assignments and `env` prefixes from every shell segment. */
export function commandInvocations(command: string, cwd: string): Invocation[] {
	const out: Invocation[] = [];
	let segment: ShellToken[] = [];
	const flush = () => {
		const invocation = parseInvocation(segment, cwd);
		if (invocation) out.push(invocation);
		segment = [];
	};
	for (const token of tokenizeShell(command)) {
		if (!token.sawQuote && SEPARATORS.has(token.value)) flush();
		else segment.push(token);
	}
	flush();
	return out;
}

function parseInvocation(tokens: readonly ShellToken[], initialCwd: string): Invocation | undefined {
	const environment = new Map<string, string>();
	let cwd = initialCwd;
	let i = 0;
	while (i < tokens.length && !tokens[i]?.sawQuote && RESERVED.has(tokens[i]?.value ?? "")) i++;
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token || token.sawQuote || !ASSIGNMENT.test(token.value)) break;
		const eq = token.value.indexOf("=");
		environment.set(token.value.slice(0, eq), token.value.slice(eq + 1));
		i++;
	}
	while (i < tokens.length && !tokens[i]?.sawQuote && basename(tokens[i]?.value ?? "") === "env") {
		i++;
		while (i < tokens.length) {
			const token = tokens[i];
			if (!token || token.sawQuote) return undefined;
			const value = token.value;
			if (value === "--") { i++; break; }
			if (ASSIGNMENT.test(value)) {
				const eq = value.indexOf("=");
				environment.set(value.slice(0, eq), value.slice(eq + 1));
				i++;
				continue;
			}
			if (value === "-i" || value === "--ignore-environment") { i++; continue; }
			if (ENV_WITH_VALUE.has(value)) {
				const operand = tokens[i + 1];
				if (!operand || operand.sawQuote) return undefined;
				if (value === "-C" || value === "--chdir") cwd = resolve(cwd, operand.value);
				i += 2;
				continue;
			}
			if (value.startsWith("--unset=") || (value.startsWith("-u") && value.length > 2)) { i++; continue; }
			if (value.startsWith("-")) return undefined;
			break;
		}
	}
	const head = tokens[i];
	if (!head || head.sawQuote || head.value.startsWith("$")) return undefined;
	const argv = tokens.slice(i).map((token) => token.value);
	if (argv.length === 0) return undefined;
	argv[0] = basename(argv[0] as string);
	return { argv, cwd, environment };
}

const GIT_GLOBAL_FLAGS = new Set([
	"--no-pager", "--paginate", "--no-optional-locks", "--no-replace-objects", "--literal-pathspecs",
	"--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-advice", "--bare", "--git-dir",
]);

export type GitInvocation = Invocation & { subcommand: string; args: readonly string[] };

/** Resolve a literal git/dgit subcommand and its `-C` directory, or leave uncertain forms alone. */
export function parseGitInvocation(invocation: Invocation): GitInvocation | undefined {
	const executable = invocation.argv[0];
	if (executable !== "git" && executable !== "dgit") return undefined;
	let cwd = invocation.cwd;
	let i = 1;
	while (i < invocation.argv.length) {
		const value = invocation.argv[i] as string;
		if (value === "-C" || value === "-c" || value === "--config-env" || value === "--git-dir" || value === "--work-tree") {
			const operand = invocation.argv[i + 1];
			if (!operand) return undefined;
			if (value === "-C") cwd = resolve(cwd, operand);
			i += 2;
			continue;
		}
		if (value.startsWith("-C") && value.length > 2) {
			cwd = resolve(cwd, value.slice(2));
			i++;
			continue;
		}
		if (GIT_GLOBAL_FLAGS.has(value)) { i++; continue; }
		if (value.startsWith("-")) return undefined;
		return { ...invocation, cwd, subcommand: value, args: invocation.argv.slice(i + 1) };
	}
	return undefined;
}

export function isAssignmentOverride(invocation: Invocation, name: string, processEnv: Readonly<Record<string, string | undefined>>): boolean {
	return processEnv[name] === "1" || invocation.environment.get(name) === "1";
}

export type GitRunner = (args: readonly string[], cwd: string) => string | null;
export type ReleaseMarkerOptions = {
	git: GitRunner;
	exists?: (path: string) => boolean;
	readFile?: (path: string) => string | null;
};

const RELEASE_MARKERS = [
	".releaserc", ".releaserc.json", ".releaserc.yml", ".releaserc.yaml", ".releaserc.js", ".releaserc.cjs", ".releaserc.mjs",
	"release.config.js", "release.config.cjs", "release.config.mjs", "release-please-config.json", ".release-please-manifest.json",
] as const;

function diskExists(path: string): boolean {
	try { return existsSync(path); } catch { return false; }
}

function diskRead(path: string): string | null {
	try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** True only when a supported release-from-commits marker exists at the repository root. */
export function isReleaseRepository(cwd: string, options: ReleaseMarkerOptions): boolean {
	try {
		const rootText = options.git(["rev-parse", "--show-toplevel"], cwd)?.trim();
		if (!rootText) return false;
		const root = resolve(rootText);
		const exists = options.exists ?? diskExists;
		const read = options.readFile ?? diskRead;
		for (const marker of RELEASE_MARKERS) if (exists(resolve(root, marker))) return true;
		const packageJson = resolve(root, "package.json");
		if (exists(packageJson)) {
			const parsed: unknown = JSON.parse(read(packageJson) ?? "");
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "release" in parsed) return true;
		}
		for (const name of readdirSync(root)) {
			if (/^(?:\.commitlintrc.*|commitlint\.config\..+)$/.test(name) && exists(resolve(root, name))) return true;
		}
		return false;
	} catch { return false; }
}
