import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { commandInvocations } from "./lib.ts";

/** Native claim timestamp is the single clock source for branch age. */
function claimStartedAt(bead: { started_at?: unknown }): number | undefined {
	if (typeof bead.started_at !== "string" || !validStartedAt(bead.started_at)) return;
	const time = Date.parse(bead.started_at);
	return Number.isFinite(time) ? time : undefined;
}

const DEFAULT_STALE_HOURS = 48;
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;
const RUNNER_WAIT_MS = 5_000;
const WRITE_TIMEOUT_MS = 180_000;
const FLAG_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RUNNER_NAME = "bd-embedded-write-runner";

type CleanupLinks = { branch?: string; url?: string };
type CleanupDecision = { command: string; flag: string };
type CommandResult = { exitCode: number; stdout: string; timedOut?: true };
export type Runner = { interpreter: string; script: string };
export type CommandRunner = (cmd: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, killOnTimeout?: boolean) => Promise<CommandResult | undefined>;

function cleanText(value: unknown): string {
	return typeof value === "string" ? value.split(/[\r\n\t]/, 1)[0]?.trim() ?? "" : "";
}

/** Invalid overrides intentionally fall back to the stable default. */
export function staleThresholdHours(value: string | undefined): number {
	if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_STALE_HOURS;
	const hours = Number(value);
	return Number.isSafeInteger(hours) && hours > 0 ? hours : DEFAULT_STALE_HOURS;
}

function validStartedAt(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
	if (match === null || (match[7] !== undefined && Number(match[7]) >= 1_000_000_000)) return false;
	const [, year, month, day, hour, minute, second] = match;
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
	return date.getUTCFullYear() === Number(year)
		&& date.getUTCMonth() === Number(month) - 1
		&& date.getUTCDate() === Number(day)
		&& date.getUTCHours() === Number(hour)
		&& date.getUTCMinutes() === Number(minute)
		&& date.getUTCSeconds() === Number(second);
}

/** Select old in-progress claims, oldest first, with bounded session-start guidance. */
export function decideStaleReminder(beads: unknown, now: number, thresholdHours: number): string | undefined {
	if (!Array.isArray(beads) || !Number.isFinite(now) || !Number.isFinite(thresholdHours) || thresholdHours <= 0) return;
	const thresholdMs = thresholdHours * 60 * 60 * 1000;
	const stale = beads.flatMap((value) => {
		if (value === null || typeof value !== "object") return [];
		const bead = value as { id?: unknown; status?: unknown; started_at?: unknown; assignee?: unknown; metadata?: unknown };
		if (bead.status !== "in_progress" || !bead.metadata || typeof bead.metadata !== "object") return [];
		const branch = cleanText((bead.metadata as { branch?: unknown }).branch);
		const id = cleanText(bead.id);
		const startedAt = claimStartedAt(bead);
		if (!branch || !id || startedAt === undefined || now - startedAt <= thresholdMs) return [];
		return [{ id, branch, startedAt, assignee: cleanText(bead.assignee) || "unassigned" }];
	}).sort((left, right) => left.startedAt - right.startedAt).slice(0, 5);
	if (stale.length === 0) return;
	const rows = stale.map(({ id, branch, startedAt, assignee }) => {
		const days = ((now - startedAt) / DAY_MS).toFixed(1);
		return `- ${id}: \`${branch.replaceAll("`", "\\`")}\` (${days} days; ${assignee})`;
	});
	return `trunk-dev: stale claimed branches (older than ${thresholdHours}h):\n${rows.join("\n")}\nLand or split the branch, or release the claim and re-cut it with a fresh bead.`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function beadLink(body: string, branch: string | undefined): string | undefined {
	const branchMatch = branch?.match(/(?:^|\/)omp\/agent\/(bd-[A-Za-z0-9][A-Za-z0-9._-]{0,123}|omp-[A-Za-z0-9][A-Za-z0-9._-]{0,123})(?:\/|$)/)?.[1];
	const bodyMatch = body.match(/^Bead:\s*(bd-[A-Za-z0-9][A-Za-z0-9._-]{0,123}|omp-[A-Za-z0-9][A-Za-z0-9._-]{0,123})\s*$/im)?.[1];
	const candidate = branchMatch ?? bodyMatch;
	return candidate !== undefined && BEAD_ID.test(candidate) ? candidate : undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** Pure merge policy: return the exact gated command, never write the embedded store here. */
export function decideFlagCleanup(
	title: string,
	body: string,
	existingBeads: unknown,
	links: CleanupLinks,
): CleanupDecision | undefined {
	if (!/^feat(?:\([^\r\n)]+\))?!?:\s+\S/.test(title)) return;
	const flagCount = [...body.matchAll(/^Flag:/gm)].length;
	if (flagCount !== 1) return;
	const matches = [...body.matchAll(/^Flag:\s*(\S+)\s+\(default off; owner [^;\r\n]+; remove by (\d{4}-\d{2}-\d{2})\)\s*$/gm)];
	if (matches.length !== 1) return;
	const flag = matches[0];
	const name = flag?.[1];
	const due = flag?.[2];
	const url = cleanText(links.url);
	if (name === undefined || name.toLowerCase() === "none" || !FLAG_NAME.test(name) || due === undefined || !validDate(due) || !isHttpUrl(url)) return;
	if (Array.isArray(existingBeads) && existingBeads.some((value) => {
		if (value === null || typeof value !== "object") return false;
		const bead = value as { status?: unknown; metadata?: unknown };
		if (typeof bead.status !== "string" || bead.status.toLowerCase() === "closed" || !bead.metadata || typeof bead.metadata !== "object") return false;
		return (bead.metadata as { trunk_dev_flag?: unknown }).trunk_dev_flag === name;
	})) return;

	const titleText = `chore: remove feature flag ${name}`;
	const metadata = JSON.stringify({ trunk_dev_flag: name, pr: url });
	const description = `Remove the ${name} feature flag after rollout or abandonment. Merged PR/MR: ${url}. Close this chore with the flag-removal PR.`;
	const linkedBead = beadLink(body, links.branch);
	const command = [
		"bd create", shellQuote(titleText), "--type chore --due", due,
		"--metadata", shellQuote(metadata), "--description", shellQuote(description),
		...(linkedBead === undefined ? [] : ["--deps", `discovered-from:${linkedBead}`]),
		"--silent",
	].join(" ");
	return { command, flag: name };
}

function commandResult(result: ToolResultEvent): boolean {
	if (result.isError === true) return false;
	const details = result.details;
	if (details !== null && typeof details === "object" && "exitCode" in details && typeof details.exitCode === "number" && details.exitCode !== 0) return false;
	const output = (result.content ?? []).flatMap((item) => item !== null && typeof item === "object" && (item as { type?: string }).type === "text" ? [(item as { text?: string }).text ?? ""] : []).join("");
	return !/\bCommand exited with code -?[1-9]\d*\b/.test(output);
}

function toolCwd(input: Record<string, unknown>, sessionCwd: string): string {
	return typeof input.cwd === "string" && input.cwd ? resolve(sessionCwd, input.cwd) : sessionCwd;
}

function toolEnvironment(input: Record<string, unknown>): NodeJS.ProcessEnv {
	const supplied = input.env;
	return supplied !== null && typeof supplied === "object" && !Array.isArray(supplied)
		? { ...process.env, ...(supplied as NodeJS.ProcessEnv) }
		: { ...process.env };
}

/** `killOnTimeout: false` leaves a writer running under its lock and reports an unknown result. */
function runCommand(cmd: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, killOnTimeout = true): Promise<CommandResult | undefined> {
	return (async () => {
		let child: ReturnType<typeof Bun.spawn> | undefined;
		try {
			child = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
			const stdout = child.stdout === null || typeof child.stdout === "number" ? Promise.resolve("") : new Response(child.stdout).text();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const result = await Promise.race([
				child.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
				new Promise<{ exitCode: number; timedOut: true }>((resolveTimeout) => {
					// This raw callback only settles a promise; it cannot throw into OMP's session loop.
					timer = setTimeout(() => {
						try { resolveTimeout({ exitCode: -1, timedOut: true }); } catch { /* Timeout cleanup must remain fail-open. */ }
					}, timeoutMs);
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
			if (result.timedOut) {
				if (killOnTimeout) child.kill();
				void child.exited.catch(() => undefined);
				void stdout.catch(() => undefined);
				return killOnTimeout ? undefined : { exitCode: -1, stdout: "", timedOut: true };
			}
			return { exitCode: result.exitCode, stdout: await stdout };
		} catch {
			try { child?.kill(); } catch { /* A finished child needs no cleanup. */ }
			return;
		}
	})();
}

function isDirectory(path: string): boolean {
	try { return statSync(path).isDirectory(); } catch { return false; }
}

function selectedStore(cwd: string, root: string, commonDir: string, env: NodeJS.ProcessEnv): string | undefined {
	const commonRoot = resolve(cwd, commonDir);
	const pinned = env.BEADS_DIR ? (resolve(cwd, env.BEADS_DIR)) : undefined;
	const candidates = [pinned, join(dirname(commonRoot), ".beads"), join(root, ".beads")];
	const found = candidates.find((path): path is string => path !== undefined && isDirectory(path));
	// The lock file lives inside the store, so use the canonical path the Beads gate uses.
	if (found === undefined) return;
	try { return realpathSync(found); } catch { return found; }
}

async function repository(cwd: string, env: NodeJS.ProcessEnv): Promise<{ root: string; store: string } | undefined> {
	const [rootResult, commonResult] = await Promise.all([
		runCommand(["git", "rev-parse", "--show-toplevel"], cwd, env, GIT_TIMEOUT_MS),
		runCommand(["git", "rev-parse", "--git-common-dir"], cwd, env, GIT_TIMEOUT_MS),
	]);
	if (rootResult?.exitCode !== 0 || commonResult?.exitCode !== 0) return;
	const root = rootResult.stdout.trim();
	const commonDir = commonResult.stdout.trim();
	if (!root || !commonDir) return;
	const store = selectedStore(cwd, root, commonDir, env);
	return store === undefined ? undefined : { root, store };
}

function readEnvironment(env: NodeJS.ProcessEnv, store: string): NodeJS.ProcessEnv {
	return {
		...env,
		BEADS_DOLT_SHARED_SERVER: "",
		BEADS_DIR: store,
		BD_NO_PAGER: "1",
		BD_NON_INTERACTIVE: "1",
		BD_DOLT_AUTO_START: "false",
		PAGER: "cat",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		NO_COLOR: "1",
	};
}

function parseJson(stdout: string): unknown {
	try { return JSON.parse(stdout); } catch { return undefined; }
}

function reminderMessage(stdout: string, now: number, threshold: number): string | undefined {
	return decideStaleReminder(parseJson(stdout), now, threshold);
}

function sendReminder(pi: ExtensionAPI, cwd: string): void {
	const env = readEnvironment(process.env, "");
	void (async () => {
		const repo = await repository(cwd, env);
		if (repo === undefined) return;
		const output = await runCommand(["bd", "--readonly", "list", "--status", "in_progress", "--has-metadata-key", "branch", "--json", "--limit", "0"], repo.root, readEnvironment(env, repo.store), READ_TIMEOUT_MS);
		if (output?.exitCode !== 0) return;
		const message = reminderMessage(output.stdout, Date.now(), staleThresholdHours(process.env.TRUNK_DEV_STALE_HOURS));
		if (!message) return;
		pi.sendMessage({ customType: "com.srobroek.trunk-dev.stale-branches", content: message, display: true, attribution: "user" }, { triggerTurn: false });
	})().catch(() => undefined);
}

function validRunnerScript(path: string): boolean {
	return existsSync(path);
}

/** Resolve a sibling Beads runner without adding a cross-plugin package dependency. */
function resolveRunner(here = import.meta.dir): Runner | undefined {
	const localCandidates = [
		join(here, "..", "..", "beads", "dist", `${RUNNER_NAME}.js`),
		join(here, "..", "..", "beads", "extensions", `${RUNNER_NAME}.ts`),
		join(here, "..", "..", "..", "node_modules", "@srobroek", "beads", "dist", `${RUNNER_NAME}.js`),
	];
	let script = localCandidates.find(validRunnerScript);
	if (script === undefined) {
		const root = resolve(here, "..");
		const prefix = /^(.+___)trunk-dev___.+$/.exec(basename(root))?.[1];
		if (prefix !== undefined) {
			const cache = dirname(root);
			let entries: string[] = [];
			try { entries = readdirSync(cache); } catch { /* Cache unavailable: use the fallback command. */ }
			const candidates = entries
				.filter((entry) => entry.startsWith(`${prefix}beads___`) && VERSION.test(entry.slice(`${prefix}beads___`.length)))
				.sort((left, right) => Bun.semver.order(right.slice(`${prefix}beads___`.length), left.slice(`${prefix}beads___`.length)));
			for (const entry of candidates) {
				const found = [join(cache, entry, "dist", `${RUNNER_NAME}.js`), join(cache, entry, "extensions", `${RUNNER_NAME}.ts`)].find(validRunnerScript);
				if (found !== undefined) { script = found; break; }
			}
		}
	}
	if (script === undefined) return;
	const processName = basename(process.execPath);
	let interpreter = processName === "bun" || processName === "bun.exe" ? process.execPath : Bun.which("bun") ?? undefined;
	if (interpreter === undefined && process.env.BUN_INSTALL) {
		const candidate = join(process.env.BUN_INSTALL, "bin", "bun");
		if (existsSync(candidate)) interpreter = candidate;
	}
	return interpreter === undefined ? undefined : { interpreter, script: resolve(script) };
}

function cleanupArgs(command: string): string[] | undefined {
	const invocation = commandInvocations(command, process.cwd())[0];
	return invocation?.argv[0] === "bd" && invocation.argv[1] === "create" ? [...invocation.argv.slice(1)] : undefined;
}

function cleanupId(stdout: string): string | undefined {
	const text = stdout.trim();
	if (BEAD_ID.test(text)) return text;
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/.exec(line);
		const id = match?.[1];
		if (id !== undefined && BEAD_ID.test(id)) return id;
	}
	const json = parseJson(text);
	if (json !== null && typeof json === "object") {
		const id = (json as { id?: unknown }).id;
		if (typeof id === "string" && BEAD_ID.test(id)) return id;
	}
	return;
}

function followUp(decision: CleanupDecision): string {
	// The embedded Beads store must be written through its plugin's single-writer lock. If
	// its runner is missing or cannot take the lock, hand the agent this one Bash command.
	return `trunk-dev: create the feature-flag cleanup chore (required): ${decision.command}`;
}

export type BeadsRuntime = {
	findRunner: () => Runner | undefined;
	run: CommandRunner;
};

const productionRuntime: BeadsRuntime = { findRunner: resolveRunner, run: runCommand };

export async function createCleanup(
	decision: CleanupDecision,
	store: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	runtime: BeadsRuntime = productionRuntime,
): Promise<string> {
	const runner = runtime.findRunner();
	if (runner === undefined) return followUp(decision);
	const bdArgs = cleanupArgs(decision.command);
	if (bdArgs === undefined) return followUp(decision);
	// The runner waits at most RUNNER_WAIT_MS for the lock, then bd writes. Never kill it: a
	// killed writer defeats the lock's lifetime guarantee. A timeout only ends our wait.
	const actor = env.BEADS_ACTOR?.trim() || "trunk-dev";
	const result = await runtime.run(
		[runner.interpreter, runner.script, "--beads-store", store, "--beads-wait-ms", String(RUNNER_WAIT_MS), "--", "bd", "--json", "--actor", actor, ...bdArgs],
		cwd,
		{ ...readEnvironment(env, store), BEADS_ACTOR: actor },
		WRITE_TIMEOUT_MS,
		false,
	);
	if (result?.timedOut) {
		// The write may still land, so a retry command here could create a duplicate.
		return `trunk-dev: the feature-flag cleanup chore is still being written; before creating it by hand, check \`bd list --metadata-field trunk_dev_flag=${decision.flag} --json\`.`;
	}
	if (result === undefined || result.exitCode !== 0) return followUp(decision);
	const id = cleanupId(result.stdout);
	return id === undefined
		? `trunk-dev: cleanup chore creation completed for flag ${decision.flag}, but bd returned no readable id.`
		: `trunk-dev: created cleanup bead ${id} for flag ${decision.flag}; close it with the flag-removal PR.`;
}

function mergeCommand(invocation: ReturnType<typeof commandInvocations>[number]): { forge: "gh" | "glab"; number: string } | undefined {
	const argv = invocation.argv;
	if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
		const number = argv.slice(3).find((arg) => /^\d+$/.test(arg));
		return number === undefined ? undefined : { forge: "gh", number };
	}
	if (argv[0] === "glab" && argv[1] === "mr" && argv[2] === "merge") {
		const number = argv.slice(3).find((arg) => /^\d+$/.test(arg));
		return number === undefined ? undefined : { forge: "glab", number };
	}
	return;
}

export type ForgeMerge = { title: string; body: string; url: string; branch?: string };

/**
 * Parse `gh pr view --json` / `glab mr view --output json`. Only a completed merge counts:
 * `--auto` / `--auto-merge` merge commands succeed while the PR is still open.
 */
export function mergedForgeData(stdout: string, forge: "gh" | "glab"): ForgeMerge | undefined {
	const value = parseJson(stdout);
	if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	const state = typeof record.state === "string" ? record.state.toLowerCase() : "";
	if (state !== "merged") return;
	const title = typeof record.title === "string" ? record.title : undefined;
	const bodyValue = forge === "gh" ? record.body : record.description ?? record.body;
	const urlValue = forge === "gh" ? record.url : record.web_url ?? record.url ?? record.webUrl;
	const branchValue = forge === "gh" ? record.headRefName : record.source_branch;
	if (title === undefined || typeof bodyValue !== "string" || typeof urlValue !== "string") return;
	return { title, body: bodyValue, url: urlValue, branch: typeof branchValue === "string" && branchValue ? branchValue : undefined };
}

async function mergedFlagFollowUp(event: ToolResultEvent, sessionCwd: string): Promise<string | undefined> {
	if (event.toolName !== "bash" || !commandResult(event)) return;
	const input = (event.input ?? {}) as Record<string, unknown>;
	const cwd = toolCwd(input, sessionCwd);
	const env = toolEnvironment(input);
	const command = typeof input.command === "string" ? input.command : "";
	for (const invocation of commandInvocations(command, cwd)) {
		const merge = mergeCommand(invocation);
		if (merge === undefined) continue;
		const repo = await repository(invocation.cwd, env);
		if (repo === undefined) return;
		const readEnv = readEnvironment(env, repo.store);
		const forgeArgs = merge.forge === "gh"
			? ["gh", "pr", "view", merge.number, "--json", "title,body,url,state,headRefName"]
			: ["glab", "mr", "view", merge.number, "--output", "json"];
		const [forgeResult, existingResult] = await Promise.all([
			runCommand(forgeArgs, invocation.cwd, readEnv, READ_TIMEOUT_MS),
			runCommand(["bd", "--readonly", "list", "--all", "--json", "--limit", "0"], repo.root, readEnv, READ_TIMEOUT_MS),
		]);
		if (forgeResult?.exitCode !== 0 || existingResult?.exitCode !== 0) return;
		const forge = mergedForgeData(forgeResult.stdout, merge.forge);
		const existing = parseJson(existingResult.stdout);
		if (forge === undefined || !Array.isArray(existing)) return;
		const decision = decideFlagCleanup(forge.title, forge.body, existing, { branch: forge.branch, url: forge.url });
		if (decision === undefined) return;
		return await createCleanup(decision, repo.store, invocation.cwd, env, productionRuntime);
	}
	return;
}

export default function trunkDevBeads(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		try { sendReminder(pi, ctx.cwd ?? process.cwd()); } catch { /* Advisory probes fail open. */ }
	});
	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		try {
			const additionalContext = await mergedFlagFollowUp(event, ctx.cwd ?? process.cwd());
			return additionalContext === undefined ? undefined : { additionalContext };
		} catch {
			return;
		}
	});
}
