import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 10_000;

export const DENY_REASON =
	"blocked by speckit (task state lives in beads, tasks.md is never authored): this repo has an active beads workspace, so specs/*/tasks.md is read-only legacy and must not be written or created. Create implementation tasks as beads under the feature molecule's implement step instead: bd create \"T00N <title>\" --parent <implement-step-id> --spec-id <NNN-slug> -t task; wire ordering with bd dep add <later-id> <earlier-id>; bulk-create with bd create -f <tmpfile>.md (write the temp file OUTSIDE specs/). Then work the tasks via bd ready -> bd update <id> --claim -> bd close <id> --reason. Find the implement step with bd mol current <molecule-root-id>. IF A SKILL DEMANDED tasks.md: skip check-prerequisites.sh --require-tasks and read bd list --spec <NNN-slug>. Do not create tasks.md to get past the check.";

const TASKS_PATH = /(?:^|\/)specs\/[^/\s'"]+\/tasks\.md(?:$|[/\s'"])/;

const WRITE_REDIRECT = /[0-9]*&?>>?\s*['"]?[^|;&]*specs\/[^|;&]*\/tasks\.md/;
const WRITE_UTILS = [
	/\btee\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\bsed\b\s+[^|;&]*-i[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\btruncate\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\bdd\b[^|;&]*\bof=[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\binstall\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\bcp\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\bmv\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\bpython3?\b[^|;&]*-c[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\bperl\b[^|;&]*-[a-z]*e[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\bawk\b[^|;&]*>[^|;&]*specs\/[^|;&]*\/tasks\.md/,
	/\btouch\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
];

let testBeadsActive: boolean | null = null;
let testSpawnBd: ((args: string[]) => number) | null = null;

export function setBeadsActiveForTests(value: boolean | null): void {
	testBeadsActive = value;
}

export function setBdWhereSpawnForTests(fn: ((args: string[]) => number) | null): void {
	testSpawnBd = fn;
}

export function isTasksMd(path: string): boolean {
	const n = path.replaceAll("\\", "/");
	return TASKS_PATH.test(n) || /(?:^|\/)specs\/[^/]+\/tasks\.md$/.test(n);
}

export function writesTasksMd(command: string): boolean {
	if (WRITE_REDIRECT.test(command)) return true;
	return WRITE_UTILS.some((re) => re.test(command));
}

export function commandMentionsTasksMd(command: string): boolean {
	return /specs\/.*\/tasks\.md/s.test(command);
}

export function beadsActive(cwd: string): boolean {
	if (testBeadsActive !== null) return testBeadsActive;
	try {
		if (testSpawnBd) return testSpawnBd(["where"]) === 0;
		const proc = Bun.spawnSync(["bd", "-C", cwd, "where"], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

export function pathFromInput(input: Record<string, unknown>): string {
	for (const key of ["file_path", "path"] as const) {
		const v = input[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return "";
}

export function commandFromInput(input: Record<string, unknown>): string {
	const v = input.command;
	return typeof v === "string" ? v : "";
}

export function decideToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): { block: true; reason: string } | undefined {
	if (toolName === "edit" || toolName === "write") {
		const path = pathFromInput(input);
		if (!path || !isTasksMd(path)) return;
		if (!beadsActive(cwd)) return;
		return { block: true, reason: DENY_REASON };
	}
	if (toolName === "bash") {
		const command = commandFromInput(input);
		if (!command || !commandMentionsTasksMd(command)) return;
		if (!beadsActive(cwd)) return;
		if (writesTasksMd(command)) return { block: true, reason: DENY_REASON };
	}
	return;
}

export default function tasksGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			const cwd =
				typeof event.input.cwd === "string" && event.input.cwd
					? event.input.cwd
					: process.cwd();
			return decideToolCall(event.toolName, event.input, cwd);
		} catch {
			return;
		}
	});
}
