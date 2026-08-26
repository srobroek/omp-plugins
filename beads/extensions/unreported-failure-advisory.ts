/**
 * Failing checks an agent saw and never recorded.
 *
 * `beads-preexisting-triage` catches an agent that *says* it is leaving a
 * pre-existing problem alone: the rule matches the disclaimer. The expensive case
 * says nothing at all -- it runs the suite, reads `3 fail`, and moves on. There is
 * no text to match, so the tool result is the only evidence the observation ever
 * happened, which is why this is an extension and not a rule.
 *
 * So it watches results instead of prose. A check command whose output reported a
 * failure is remembered, and at session close the bug beads are read back. A
 * failure whose file or symbol appears on no bug bead was never recorded, and that
 * earns exactly one message. Where the repository has no `.beads/`, filing is
 * unavailable and this stays silent -- nagging about an impossible action is noise.
 *
 * Never blocks a tool call, never writes to the database, and fails silent: an
 * advisory that can take down a session is worse than no advisory at all.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { extractCommand } from "./bd-actor-gate.ts";
import { beadsDir, envelopeData, parseTrailingJson } from "./session-beads-lifecycle.ts";

/**
 * `session_shutdown` handlers are capped at 2s by the extension runner, and a
 * held-up teardown is worse than a missed advisory. A local `bd list` measures
 * under 500ms, so this leaves room for the read plus the message.
 */
const BD_TIMEOUT_MS = 1200;

/** Signals kept per result, and listed per advisory. This is a detector, not a report. */
const MAX_SIGNALS = 6;

/** Session cap. Beyond this the point is made, and state must stay bounded. */
const MAX_TRACKED = 24;

/** Longest signal kept, so one runaway line cannot fill the advisory. */
const MAX_SIGNAL_CHARS = 120;

/**
 * Command lines that run a check.
 *
 * This gate is what keeps the classifier honest: a `cat build.log` or a `git log`
 * would otherwise report every `FAILED` line in output the agent merely read.
 */
const CHECK_RE =
	/\b(?:(?:bun|npm|pnpm|yarn|deno|node)\s+(?:run\s+)?(?:test|typecheck|type-check|lint|check|build)|bunx\s+\S+|npx\s+\S+|tsc\b|biome\b|eslint\b|oxlint\b|vitest\b|jest\b|mocha\b|slopvac\b|pytest\b|ruff\b|mypy\b|pyright\b|tox\b|cargo\s+(?:test|clippy|check|build|fmt)|go\s+(?:test|vet|build)|golangci-lint\b|just\s+\S+|make\b|mise\s+run\s+\S+|moon\s+run\s+\S+|uv\s+run\s+\S+|poetry\s+run\s+\S+|pre-commit\s+run)/i;

/**
 * A log record the program under test printed, rather than the runner's own
 * tally. `ERROR:root:retry 1 of 3 failed` inside a green suite is not three
 * failing tests, and no runner puts its summary behind a log level.
 */
const LOG_RECORD_RE = /^\s*\[?(?:DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL|FATAL|TRACE)\]?[:\s]/i;

/** The whole line a match sits on, for rules that need its context. */
function matchLine(match: RegExpMatchArray): string {
	const text = match.input ?? "";
	const index = match.index ?? 0;
	const end = text.indexOf("\n", index);
	return text.slice(text.lastIndexOf("\n", index) + 1, end === -1 ? undefined : end);
}

/** A count that stands for a real failure: non-zero, and not inside a log record. */
function countedFailure(match: RegExpMatchArray, label: (count: string) => string): string | undefined {
	if (Number(match[1]) === 0 || LOG_RECORD_RE.test(matchLine(match))) return undefined;
	return label(match[1]!);
}

interface Rule {
	readonly re: RegExp;
	/** The signal this match stands for, or nothing when the match proves success. */
	readonly signal: (match: RegExpMatchArray) => string | undefined;
}

/**
 * Failure shapes, most specific first: the cap is spent on signals that name a
 * file or a symbol before the bare counts that name nothing.
 */
const RULES: readonly Rule[] = [
	{
		// tsc, in both spellings it prints:
		//   `src/foo.ts(12,5): error TS2345: ...`
		//   `src/foo.ts:12:5 - error TS2345: ...`
		// The file is the subject a bug bead can be matched on, so it is kept when the
		// line carries one and the bare code is the fallback.
		re: /^[^\n]*\berror[ \t]+(TS\d{4,5})\b[^\n]*$/gim,
		signal: match => {
			const file = match[0].match(/(\S+?)(?:\(\d+,\d+\)|:\d+:\d+)/);
			return file === null ? `error ${match[1]}` : `${file[1]} error ${match[1]}`;
		},
	},
	{
		// `FAIL src/foo.test.ts` (jest/vitest), `FAILED tests/test_x.py::test_y`
		// (pytest), `--- FAIL: TestThing` (go), `ERROR: ...`.
		//
		// Uppercase, and at the head of a line: that pair is what keeps the word
		// "fail" in prose from firing. The `[:.]\S` lookahead drops `ERROR:root:...`,
		// which is Python logging from a test that may well have passed. Whitespace in
		// the decoration class excludes the newline, so a match cannot start on one
		// line and land on another.
		re: /^[ \t>|*+-]{0,8}(?:[[(✗×][ \t]*)?(FAIL(?:ED)?|FAILURES?|ERRORS?)\b(?![:.]\S)[^\n]*/gm,
		signal: match => match[0].trim(),
	},
	{
		// `3 fail` (bun), `3 failed, 5 passed` (pytest), `Tests: 2 failed` (jest),
		// `2 failing` (mocha). A zero count is a clean run and proves the opposite.
		//
		// The separator excludes the newline on purpose: `got 3 want 4\nFAIL` is a
		// diff line above a verdict line, not four failing tests.
		re: /\b(\d+)[ \t]+fail(?:ed|ing|ures?|s)?\b/gi,
		signal: match => countedFailure(match, count => `${count} failed`),
	},
	{
		// The reversed spelling: `Failures: 2`, `failures="3"`.
		re: /\bfail(?:ures?|ed|s)[ \t]*[:=][ \t]*"?(\d+)/gi,
		signal: match => countedFailure(match, count => `${count} failed`),
	},
	{
		// `Found 3 errors in 2 files.` -- tsc's summary, which survives when the
		// per-error lines above it were cut by the harness output cap.
		re: /\bfound[ \t]+(\d+)[ \t]+errors?\b/gi,
		signal: match => countedFailure(match, count => `found ${count} errors`),
	},
	{
		// `Command exited with code 1`, which omp's own bash and eval tools append,
		// plus the `exit code: 1` and `exit status 1` spellings a script prints.
		re: /\bexit(?:ed)?[ \t]*(?:with[ \t]*)?(?:code|status)[ \t]*[:=]?[ \t]*(-?\d+)/gi,
		signal: match => (Number(match[1]) === 0 ? undefined : `exit code ${match[1]}`),
	},
];

/** What each session saw: session id -> failure signal -> the check that produced it. */
const observed = new Map<string, Map<string, string>>();

export function resetUnreportedFailureAdvisoryForTests(): void {
	observed.clear();
}

/**
 * The check a command line runs, or nothing when it runs no check.
 *
 * The label is the matched fragment rather than the whole line, so a signal can be
 * attributed without quoting a pipeline back at the agent.
 */
export function checkLabel(command: string): string | undefined {
	const match = command.match(CHECK_RE);
	return match === null ? undefined : match[0].replace(/\s+/g, " ").toLowerCase();
}

/**
 * The failures this output reports, deduplicated and in the order the rules rank
 * them. Empty means the output proves nothing -- including a clean run, whose
 * `0 fail` and `exit code 0` are matched and then rejected on their count.
 */
export function failureSignals(text: string): string[] {
	const signals: string[] = [];
	const seen = new Set<string>();
	for (const rule of RULES) {
		// `matchAll` clones the regex, so these module-level literals hold no state.
		for (const match of text.matchAll(rule.re)) {
			const raw = rule.signal(match);
			if (raw === undefined) continue;
			const signal = raw.replace(/\s+/g, " ").trim().slice(0, MAX_SIGNAL_CHARS);
			if (signal.length === 0 || seen.has(signal)) continue;
			seen.add(signal);
			signals.push(signal);
			if (signals.length >= MAX_SIGNALS) return signals;
		}
	}
	return signals;
}

/**
 * The parts of a signal a bug bead could name: a path, its basename, a test
 * symbol, a diagnostic code. Both the path and its basename count, because a bead
 * titled `foo.test.ts is red` records the same failure as `src/foo.test.ts`.
 *
 * `exit code 1` and `3 failed` yield none, which is exactly what makes them
 * unmatchable on their own.
 */
export function signalSubjects(signal: string): string[] {
	const subjects = new Set<string>();
	for (const token of signal.match(/[\w./\\-]+/g) ?? []) {
		if (/^TS\d{4,5}$/.test(token) || /^(?:Test|test_)[\w-]+$/.test(token)) {
			subjects.add(token.toLowerCase());
			continue;
		}
		// A path is a stem plus a short alphabetic extension: `src/foo.test.ts`,
		// `tests/test_x.py`. `1.2` and `e.g` are neither.
		if (!/[A-Za-z_]\.[A-Za-z]{1,4}$/.test(token) || token.length < 5) continue;
		subjects.add(token.toLowerCase());
		const base = token.slice(token.lastIndexOf("/") + 1);
		if (base.length >= 5) subjects.add(base.toLowerCase());
	}
	return [...subjects];
}

/**
 * The observed failures no filed bead accounts for.
 *
 * `beadsFiledThisSession` is the searchable text of the bug beads the repository
 * holds -- title and description per bead. A failure counts as recorded when one of
 * its subjects appears in one of them.
 *
 * A subject-less signal (`exit code 1`, `3 failed`) has nothing a bead could be
 * matched on, so any filed bug is taken as its carrier. Nagging once a bead exists
 * is the noisy failure, and it is the omission this is here to catch.
 */
export function unreportedFailures(observedSignals: readonly string[], beadsFiledThisSession: readonly string[]): string[] {
	const filed = beadsFiledThisSession.map(text => text.trim().toLowerCase()).filter(text => text.length > 0);
	const unreported: string[] = [];
	const seen = new Set<string>();
	for (const signal of observedSignals) {
		if (seen.has(signal)) continue;
		seen.add(signal);
		if (filed.length === 0) {
			unreported.push(signal);
			continue;
		}
		const subjects = signalSubjects(signal);
		if (subjects.length === 0) continue;
		if (subjects.some(subject => filed.some(text => text.includes(subject)))) continue;
		unreported.push(signal);
	}
	return unreported;
}

/**
 * Searchable text per bug bead, or nothing when the store could not be read.
 *
 * The distinction carries the whole fail-quiet contract: an empty list means the
 * repository holds no bugs, while an unreadable store means this cannot tell and
 * must not accuse.
 */
export function bugTexts(stdout: string): string[] | undefined {
	const data = envelopeData(parseTrailingJson(stdout));
	if (!Array.isArray(data)) return undefined;
	const texts: string[] = [];
	for (const row of data) {
		if (row === null || typeof row !== "object") continue;
		const record = row as Record<string, unknown>;
		const text = [record.title, record.description].filter((part): part is string => typeof part === "string").join(" ");
		if (text.length > 0) texts.push(text);
	}
	return texts;
}

export function formatUnreportedAdvisory(unreported: readonly string[], checks: ReadonlyMap<string, string>): string {
	const lines = ["Failing checks ran this session and no bug bead names them:"];
	for (const signal of unreported.slice(0, MAX_SIGNALS)) {
		const check = checks.get(signal);
		lines.push(`- ${signal}${check === undefined ? "" : ` (${check})`}`);
	}
	if (unreported.length > MAX_SIGNALS) lines.push(`- ...and ${unreported.length - MAX_SIGNALS} more`);
	lines.push(
		'MUST record what you saw: `bd create "<what fails, where>" -t bug`. Leave it unassigned and do not block your own bead on it.',
	);
	lines.push("DEFAULT The bead is the carrier -- a line in a summary dies with this session.");
	lines.push("NOT needed if you already fixed it, or already filed it under a title that names the file.");
	return lines.join("\n");
}

/** Text blocks of a tool result, joined. */
function resultText(event: ExtensionToolResultEvent): string {
	let text = "";
	for (const block of event.content ?? []) {
		if (block !== null && typeof block === "object" && (block as { type?: string }).type === "text") {
			text += (block as { text?: string }).text ?? "";
		}
	}
	return text;
}

/**
 * The exit line the classifier reads, from `details` rather than the text.
 *
 * omp's bash tool sets `details.exitCode` only for a non-zero exit, and its own
 * `Command exited with code N` notice can be cut when the output is capped or
 * spilled to an artifact. The structured field cannot be.
 */
function exitLine(event: ExtensionToolResultEvent): string {
	const details: unknown = event.details;
	if (details === null || typeof details !== "object") return "";
	const code = (details as { exitCode?: unknown }).exitCode;
	return typeof code === "number" && code !== 0 ? `Command exited with code ${code}\n` : "";
}

/** The session this event belongs to. Subagents share the process, not the state. */
function sessionKey(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): string {
	return ctx?.sessionManager?.getSessionId?.() ?? "default";
}

/** Every bug bead, open or closed: a closed bead still records the observation. */
async function listBugs(cwd: string): Promise<string> {
	try {
		const proc = Bun.spawn(["bd", "list", "--type", "bug", "--all", "--limit", "0", "--json"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_JSON_ENVELOPE: "1" },
			timeout: BD_TIMEOUT_MS,
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return out;
	} catch {
		return "";
	}
}

export default function unreportedFailureAdvisory(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		observed.delete(sessionKey(ctx));
	});

	pi.on("tool_result", (event: ExtensionToolResultEvent, ctx: ExtensionContext) => {
		try {
			// A shell-style tool is one whose input carries a command line. Naming tools
			// instead would miss every shell an MCP server or plugin adds.
			const command = extractCommand(event.input ?? {});
			if (!command) return;
			const label = checkLabel(command);
			if (label === undefined) return;
			const signals = failureSignals(exitLine(event) + resultText(event));
			if (signals.length === 0) return;
			const key = sessionKey(ctx);
			let seen = observed.get(key);
			if (seen === undefined) {
				seen = new Map();
				observed.set(key, seen);
			}
			for (const signal of signals) {
				if (seen.size >= MAX_TRACKED && !seen.has(signal)) return;
				seen.set(signal, label);
			}
		} catch {
			// An advisory must never disturb a tool result. Returning nothing leaves the
			// result exactly as it was.
		}
	});

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		const key = sessionKey(ctx);
		const seen = observed.get(key);
		observed.delete(key);
		try {
			if (seen === undefined || seen.size === 0) return;
			const cwd = ctx?.cwd ?? process.cwd();
			// No beads: filing is unavailable, so there is nothing to ask for.
			if (beadsDir(cwd) === undefined) return;
			const bugs = bugTexts(await listBugs(cwd));
			// Unreadable store. Silence beats accusing an agent that did file.
			if (bugs === undefined) return;
			const unreported = unreportedFailures([...seen.keys()], bugs);
			if (unreported.length === 0) return;
			pi.sendMessage({
				customType: "com.srobroek.beads.unreported-failure",
				content: formatUnreportedAdvisory(unreported, seen),
				display: true,
				attribution: "user",
				triggerTurn: false,
			});
		} catch (error) {
			pi.logger.error("beads unreported-failure check failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
