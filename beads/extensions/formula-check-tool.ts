import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import { invocationFromArgv } from "./bd-actor-gate.ts";
import { withEmbeddedWriteLock, writesStore } from "./bd-embedded-write-lock.ts";
import { envelopeData, parseTrailingJson } from "./session-beads-lifecycle.ts";

const BEADS_PRESENT = Symbol.for("com.srobroek.beads.present.v1");
(globalThis as Record<symbol, unknown>)[BEADS_PRESENT] = { version: pkg.version };

/** Up to five sequential bd calls fit a 30,000 ms tool_call budget. */
const TIMEOUT_MS = 5_000;
const FORMULA_TIMEOUT_MS = 25_000;

export const VALID_GATE_TYPES = ["human", "timer", "gh:run", "gh:pr"] as const;

export type FormulaCheckParams = {
	formula: string;
	varargs?: string[];
	deep?: boolean;
	workspace?: string;
	expectSteps?: number;
	expectGates?: number;
};

export type SpawnResult = {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
};

export type BdSpawn = (cmd: string[], cwd: string | undefined, env: NodeJS.ProcessEnv) => Promise<SpawnResult>;

let injectedSpawn: BdSpawn | null = null;

/** Replace the `bd` seam. Pass `null` to restore the real one. */
export function setBdSpawnForTests(fn: BdSpawn | null): void {
	injectedSpawn = fn;
}

/**
 * Run bd, serialising a mutating argv on the embedded store's write lock.
 *
 * The decision lives here rather than at the writing callsites, so a verb this
 * repository classifies as a write can never reach an embedded store unserialised
 * by being spawned from a new callsite. `holder` joins an enclosing hold: without
 * it, a run nested inside `deepAssert`'s hold would queue behind itself.
 *
 * Fails closed: a lock this process cannot take means bd is never spawned, and the
 * refusal is reported as the run's own error.
 */
export async function runBd(
    cmd: string[],
    cwd?: string,
    holder?: string,
    env: NodeJS.ProcessEnv = process.env,
    deadline?: number,
): Promise<SpawnResult> {
    if (!writesStore(invocationFromArgv(cmd))) return spawnBd(cmd, cwd, env);
    const locked = await withEmbeddedWriteLock(cwd ?? process.cwd(), holder ?? `bd-formula-check-${process.pid}-${runs++}`, () => spawnBd(cmd, cwd, env), env, deadline ?? Date.now() + TIMEOUT_MS);
    if (locked.kind === "failed") return { ok: false, exitCode: null, stdout: "", stderr: "", error: locked.reason };
    return locked.value;
}

let runs = 0;

/**
 * Spawn bd without blocking the event loop.
 *
 * `Bun.spawnSync` would block it for the whole command -- up to this module's
 * two-minute timeout -- and the write lock renews its lease on an event-loop timer.
 * A blocked loop cannot renew, so a synchronous spawn could let a hold this process
 * is actively using lapse and be taken over by another writer.
 */
async function spawnBd(cmd: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
    if (injectedSpawn !== null) return injectedSpawn(cmd, cwd, env);
    try {
        const proc = Bun.spawn(["bd", ...cmd], {
            cwd,
            env,
            stdout: "pipe",
            stderr: "pipe",
            timeout: TIMEOUT_MS,
            killSignal: "SIGKILL",
        });
        const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const exitCode = await proc.exited;
        const timedOut = exitCode === null;
        return { ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr, ...(timedOut ? { error: `bd command timed out after ${TIMEOUT_MS}ms` } : {}) };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, exitCode: null, stdout: "", stderr: "", error: message };
    }
}

export async function cookCheck(formula: string, varargs: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env, deadline?: number): Promise<string[]> {
    const result = await runBd(["cook", formula, "--dry-run", ...varargs], cwd, undefined, env, deadline);
    if (result.error) return [`cook failed to spawn: ${result.error}`];
    if (!result.ok) {
        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return [`cook failed — the real error:\n${out}`];
    }
    return [];
}

export type DryRun = { steps: string[]; gates: string[] };

export function parseDryRun(out: string): DryRun {
	const steps: string[] = [];
	const gates: string[] = [];
	const re = /^\s+- (.*?) \(from ([^)]+)\)\s*$/;
	for (const line of out.split("\n")) {
		const m = line.match(re);
		if (!m) continue;
		const title = m[1];
		const origin = m[2];
		if (title === undefined || origin === undefined) continue;
		if (title.startsWith("Gate:") && origin.includes(".gate-")) {
			gates.push(title);
		} else {
			steps.push(`${title} <- ${origin}`);
		}
	}
	return { steps, gates };
}

function jsonItem(item: unknown, gate: boolean): string | undefined {
	if (typeof item === "string") return gate && !item.startsWith("Gate:") ? `Gate: ${item}` : item;
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	const title = [record.title, record.name, record.label, record.type]
		.find((value): value is string => typeof value === "string" && value.trim() !== "");
	if (!title) return undefined;
	if (gate) return title.startsWith("Gate:") ? title : `Gate: ${title}`;
	const origin = [record.origin, record.source, record.id, record.path]
		.find((value): value is string => typeof value === "string" && value.trim() !== "");
	return origin ? `${title} <- ${origin}` : undefined;
}

export function parseDryRunJson(out: string): DryRun | undefined {
	const parsed = parseTrailingJson(out);
	if (parsed === undefined) return undefined;
	const value = envelopeData(parsed);
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const steps = record.steps;
	const gates = record.gates;
	if (!Array.isArray(steps) || !Array.isArray(gates)) return undefined;
	const normalizedSteps = steps.map((item) => jsonItem(item, false));
	const normalizedGates = gates.map((item) => jsonItem(item, true));
	if (normalizedSteps.some((item) => item === undefined) || normalizedGates.some((item) => item === undefined)) return undefined;
	return { steps: normalizedSteps as string[], gates: normalizedGates as string[] };
}

export function bodySteps(steps: string[]): string[] {
	return steps.filter((s) => {
		const origin = s.split(" <- ", 2)[1] ?? "";
		return origin.includes(".");
	});
}

export function gateTypeFailures(gates: string[]): string[] {
	const failures: string[] = [];
	for (const g of gates) {
		const t = g.replace("Gate:", "").trim();
		if (!(VALID_GATE_TYPES as readonly string[]).includes(t)) {
			failures.push(
				`gate type ${JSON.stringify(t)} is not in ${JSON.stringify([...VALID_GATE_TYPES].sort())} — it is accepted at cook, poured as an open gate, then SKIPPED by \`bd gate check\`, so the step waits forever`,
			);
		}
	}
	return failures;
}

export function unsubstitutedFailures(out: string): string[] {
	if (!out.includes("{{")) return [];
	const failures: string[] = [];
	for (const line of out.split("\n")) {
		if (line.includes("{{")) {
			failures.push(`unsubstituted {{var}} in pour output: ${line.trim()}`);
		}
	}
	return failures;
}

export type MolShow = {
	issues?: unknown;
	dependencies?: unknown;
};

export function deepAssertFromMol(mol: MolShow): string[] {
	if (!mol || typeof mol !== "object") return ["mol show returned malformed data"];
	const issues = mol.issues;
	if (!Array.isArray(issues) || issues.length === 0) {
		return ["mol show returned no `issues` array; cannot verify the anchor rule"];
	}
	if (!Array.isArray(mol.dependencies)) return ["mol show returned no `dependencies` array"];
	const titles = new Map<string, string>();
	for (const issue of issues) {
		if (!issue || typeof issue !== "object") return ["mol show returned malformed or duplicate issues"];
		const record = issue as Record<string, unknown>;
		if (typeof record.id !== "string" || !record.id || titles.has(record.id)) {
			return ["mol show returned malformed or duplicate issues"];
		}
		titles.set(record.id, typeof record.title === "string" ? record.title : record.id);
	}
	const blocked = new Set<string>();
	for (const edge of mol.dependencies) {
		if (!edge || typeof edge !== "object") return ["mol show returned malformed dependencies"];
		const record = edge as Record<string, unknown>;
		if (typeof record.issue_id !== "string" || typeof record.depends_on_id !== "string" ||
			!titles.has(record.issue_id) || !titles.has(record.depends_on_id)) {
			return ["mol show returned malformed dependencies"];
		}
		blocked.add(record.issue_id);
	}
	const zeroDep = [...titles.keys()]
		.filter((id) => !blocked.has(id))
		.map((id) => titles.get(id) ?? id);
	if (zeroDep.length !== 1) {
		return [
			`${zeroDep.length} steps have no dependency; expected exactly one entry point (more than one entry point or a cycle violates the anchor rule): ${JSON.stringify(zeroDep)}`,
		];
	}
	return [];
}

export type PourHelp = { json: boolean } | { error: string };

const UNRECOGNISED_POUR_OUTPUT = "formula-check: unrecognised pour output; run the command manually";

export function parsePourHelp(stdout: string, stderr = ""): PourHelp {
	const text = [stdout, stderr].filter(Boolean).join("\n").trim();
	if (/\B--json\b/.test(text) && /\bmol\s+pour\b/i.test(text)) return { json: true };
	if (/\b(?:usage|options|flags)\b/i.test(text) && /\bmol\s+pour\b/i.test(text)) return { json: false };
	return { error: UNRECOGNISED_POUR_OUTPUT };
}
/**
 * Pour for real, then read back what it made.
 *
 * A real pour is a mutating `bd`, so on an embedded store it runs inside the same
 * per-store lock the bash boundary and the lease stamp use. The hold is taken once
 * here and its holder id passed to both runs, so the read-back sees exactly what
 * the pour made -- no other writer can change the molecule between the two calls --
 * and the inner mutating run joins this hold rather than queueing behind it. A lock
 * that cannot be taken means the pour never ran, which is a cleaner outcome than a
 * half-poured workspace and is reported as such.
 */
export async function deepAssert(
    formula: string,
    varargs: string[],
    toolCallId: string,
    workspace?: string,
    env: NodeJS.ProcessEnv = process.env,
    deadline = Date.now() + FORMULA_TIMEOUT_MS,
): Promise<string[]> {
    const locked = await withEmbeddedWriteLock(workspace ?? process.cwd(), toolCallId, async () => {
        const poured = await runBd(["mol", "pour", formula, ...varargs], workspace, toolCallId, env, deadline);
        const combined = [poured.stdout, poured.stderr].join("\n");
        const root = combined.match(/Root issue: (\S+)/)?.[1];
        const recovery = root
            ? `Created root ${root} remains in ${workspace ?? "the current workspace"}; inspect with bd mol show ${root}. No cleanup was attempted.`
            : "Pour may have created state, but no root id was recovered. Inspect the workspace before retrying; no cleanup was attempted.";
        if (poured.error || !poured.ok) return [`real pour failed: ${poured.error ?? combined}\n${recovery}`];
        if (!root) return [recovery];
        const shown = await runBd(["mol", "show", root, "--json"], workspace, toolCallId, env, deadline);
        if (shown.error || !shown.ok) return [`mol show failed: ${shown.error ?? [shown.stdout, shown.stderr].join("\n")}\n${recovery}`];
        const mol = envelopeData(parseTrailingJson(shown.stdout));
        const failures = deepAssertFromMol(mol as MolShow);
        return failures.map((failure) => `${failure}\n${recovery}`);
    }, env, deadline);
    if (locked.kind === "failed") return [`real pour was not attempted: ${locked.reason}`];
    return locked.value;
}
export async function assertFormula(
    params: FormulaCheckParams,
    toolCallId: string,
): Promise<{
    ok: boolean;
    text: string;
    failures: string[];
    steps: number;
    gates: number;
}> {
    const deadline = Date.now() + FORMULA_TIMEOUT_MS;
    const varargs: string[] = [];
    for (const v of params.varargs ?? []) varargs.push("--var", v);
    const cwd = params.workspace;
    const failures: string[] = [];
    const cookFails = await cookCheck(params.formula, varargs, cwd, process.env, deadline);
    if (cookFails.length) {
        const text = cookFails.map((f) => `FAIL ${f}`).join("\n");
        return { ok: false, text, failures: cookFails, steps: 0, gates: 0 };
    }
    const help = await runBd(["mol", "pour", "--help"], cwd, undefined, process.env, deadline);
    const capability = parsePourHelp(help.stdout, help.stderr);
    if (help.error || !help.ok || "error" in capability) {
        const failure = help.error ?? ("error" in capability ? capability.error : "bd mol pour --help failed");
        return { ok: false, text: `FAIL ${failure}`, failures: [failure], steps: 0, gates: 0 };
    }
    const dryArgs = ["mol", "pour", params.formula, "--dry-run", ...(capability.json ? ["--json"] : []), ...varargs];
    const dry = await runBd(dryArgs, cwd, undefined, process.env, deadline);
    if (dry.error || !dry.ok) {
        const out = dry.error ?? [dry.stdout, dry.stderr].filter(Boolean).join("\n").trim();
        const fail = `pour --dry-run failed:\n${out}`;
        return { ok: false, text: `FAIL ${fail}`, failures: [fail], steps: 0, gates: 0 };
    }
    const listing = [dry.stdout, dry.stderr].filter(Boolean).join("\n");
    const parsed = capability.json ? parseDryRunJson(listing) : parseDryRun(listing);
    if (!parsed || (!capability.json && parsed.steps.length === 0 && parsed.gates.length === 0)) return { ok: false, text: `FAIL ${UNRECOGNISED_POUR_OUTPUT}`, failures: [UNRECOGNISED_POUR_OUTPUT], steps: 0, gates: 0 };
    const body = bodySteps(parsed.steps);
    if (body.length === 0) failures.push("pour --dry-run returned no recognized body steps; cannot verify this formula");
    const lines: string[] = [`selection: ${(params.varargs ?? []).join(" ") || "(defaults)"}`, `  steps poured: ${body.length}   gates: ${parsed.gates.length}`];
    if (params.expectSteps !== undefined && body.length !== params.expectSteps) failures.push(`step count ${body.length} != expected ${params.expectSteps}`);
    if (params.expectGates !== undefined && parsed.gates.length !== params.expectGates) failures.push(`gate count ${parsed.gates.length} != expected ${params.expectGates}`);
    failures.push(...gateTypeFailures(parsed.gates));
    failures.push(...unsubstitutedFailures(listing));
    if (params.deep && failures.length === 0) failures.push(...(await deepAssert(params.formula, varargs, toolCallId, cwd, process.env, deadline)));
    for (const f of failures) lines.push(`FAIL ${f}`);
    if (!failures.length) lines.push("  OK");
    return { ok: failures.length === 0, text: lines.join("\n"), failures, steps: body.length, gates: parsed.gates.length };
}


export default function formulaCheckTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "bd_formula_check",
		label: "Assert bd formula pour",
        description:
            "Cook-validate a bd formula, parse `bd mol pour --dry-run`, check gates and unsubstituted braces. " +
            "Each call shares a 25 s deadline inside the 30 s tool_call budget. Default is dry-run (read); " +
            "deep=true performs a bounded real pour and reports any recovered root for safe inspection if interrupted.",
        parameters: z.object({
            formula: z.string().describe("Formula stem to assert"),
            varargs: z.array(z.string()).optional().describe("Selection vars as k=v pairs (passed as --var)"),
            deep: z.boolean().optional().describe("If true, pour for real and assert a single entry point (mutates workspace; exec approval)"),
            workspace: z.string().optional().describe("Repo cwd for bd; defaults to the current working directory"),
            expectSteps: z.number().optional().describe("Expected body step count"),
            expectGates: z.number().optional().describe("Expected gate count"),
        }) as unknown as TSchema,
        approval: (toolCall) => {
            let input: unknown;
            if (typeof toolCall === "object" && toolCall !== null && "input" in toolCall) input = toolCall.input;
            const deep = typeof input === "object" && input !== null && "deep" in input && Boolean(input.deep);
            return deep ? "exec" : "read";
        },
        execute: async (toolCallId, params: FormulaCheckParams) => {
            const result = await assertFormula(params, toolCallId);
            return {
                content: [{ type: "text", text: result.text }],
                details: {
                    ok: result.ok,
                    formula: params.formula,
                    varargs: params.varargs ?? [],
                    deep: Boolean(params.deep),
                    steps: result.steps,
                    gates: result.gates,
                    failures: result.failures,
                },
            };
        },
	});
}
