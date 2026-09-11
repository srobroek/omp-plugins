import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { envelopeData, parseTrailingJson } from "./session-beads-lifecycle.ts";

const TIMEOUT_MS = 120_000;

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

export function runBd(cmd: string[], cwd?: string): SpawnResult {
	try {
		const proc = Bun.spawnSync(["bd", ...cmd], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		return {
			ok: proc.exitCode === 0,
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: message };
	}
}

export function cookCheck(formula: string, varargs: string[], cwd?: string): string[] {
	const result = runBd(["cook", formula, "--dry-run", ...varargs], cwd);
	if (result.error) return [`cook failed to spawn: ${result.error}`];
	if (!result.ok) {
		const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		return [`cook failed — the real error:\n${out}`];
	}
	return [];
}

export function parseDryRun(out: string): { steps: string[]; gates: string[] } {
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

export function deepAssert(formula: string, varargs: string[], workspace?: string): string[] {
	const poured = runBd(["mol", "pour", formula, ...varargs], workspace);
	const combined = [poured.stdout, poured.stderr].join("\n");
	const root = combined.match(/Root issue: (\S+)/)?.[1];
	const recovery = root
		? `Created root ${root} remains in ${workspace ?? "the current workspace"}; inspect with bd mol show ${root}. No cleanup was attempted.`
		: "Pour may have created state, but no root id was recovered. Inspect the workspace before retrying; no cleanup was attempted.";
	if (poured.error || !poured.ok) return [`real pour failed: ${poured.error ?? combined}\n${recovery}`];
	if (!root) return [recovery];
	const shown = runBd(["mol", "show", root, "--json"], workspace);
	if (shown.error || !shown.ok) return [`mol show failed: ${shown.error ?? [shown.stdout, shown.stderr].join("\n")}\n${recovery}`];
	const mol = envelopeData(parseTrailingJson(shown.stdout));
	const failures = deepAssertFromMol(mol as MolShow);
	return failures.map(failure => `${failure}\n${recovery}`);
}

export function assertFormula(params: FormulaCheckParams): {
	ok: boolean;
	text: string;
	failures: string[];
	steps: number;
	gates: number;
} {
	const varargs: string[] = [];
	for (const v of params.varargs ?? []) {
		varargs.push("--var", v);
	}
	const cwd = params.workspace;
	const failures: string[] = [];
	const cookFails = cookCheck(params.formula, varargs, cwd);
	if (cookFails.length) {
		const text = cookFails.map((f) => `FAIL ${f}`).join("\n");
		return { ok: false, text, failures: cookFails, steps: 0, gates: 0 };
	}
	const dry = runBd(["mol", "pour", params.formula, "--dry-run", ...varargs], cwd);
	if (dry.error || !dry.ok) {
		const out = dry.error
			? dry.error
			: [dry.stdout, dry.stderr].filter(Boolean).join("\n").trim();
		const fail = `pour --dry-run failed:\n${out}`;
		return { ok: false, text: `FAIL ${fail}`, failures: [fail], steps: 0, gates: 0 };
	}
	const listing = [dry.stdout, dry.stderr].join("\n");
	const parsed = parseDryRun(listing);
	const body = bodySteps(parsed.steps);
	if (body.length === 0) failures.push("pour --dry-run returned no recognized body steps; cannot verify this formula");
	const lines: string[] = [
		`selection: ${(params.varargs ?? []).join(" ") || "(defaults)"}`,
		`  steps poured: ${body.length}   gates: ${parsed.gates.length}`,
	];
	if (params.expectSteps !== undefined && body.length !== params.expectSteps) {
		failures.push(`step count ${body.length} != expected ${params.expectSteps}`);
	}
	if (params.expectGates !== undefined && parsed.gates.length !== params.expectGates) {
		failures.push(`gate count ${parsed.gates.length} != expected ${params.expectGates}`);
	}
	failures.push(...gateTypeFailures(parsed.gates));
	failures.push(...unsubstitutedFailures(listing));
	if (params.deep && failures.length === 0) {
		failures.push(...deepAssert(params.formula, varargs, cwd));
	}
	for (const f of failures) lines.push(`FAIL ${f}`);
	if (!failures.length) lines.push("  OK");
	return {
		ok: failures.length === 0,
		text: lines.join("\n"),
		failures,
		steps: body.length,
		gates: parsed.gates.length,
	};
}

export default function formulaCheckTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "bd_formula_check",
		label: "Assert bd formula pour",
		description:
			"Cook-validate a bd formula, parse `bd mol pour --dry-run`, check gates and unsubstituted braces. Default is dry-run (read). deep=true performs a real pour in the workspace and uses exec approval.",
		parameters: z.object({
			formula: z.string().describe("Formula stem to assert"),
			varargs: z.array(z.string()).optional().describe("Selection vars as k=v pairs (passed as --var)"),
			deep: z.boolean().optional().describe("If true, pour for real and assert a single entry point (mutates workspace; exec approval)"),
			workspace: z.string().optional().describe("Repo cwd for bd; defaults to the current working directory"),
			expectSteps: z.number().optional().describe("Expected body step count"),
			expectGates: z.number().optional().describe("Expected gate count"),
		}) as unknown as TSchema, // pi.zod and the host TypeBox schema types differ.
		approval: (toolCall) => {
			let input: unknown;
			if (typeof toolCall === "object" && toolCall !== null && "input" in toolCall) {
				input = toolCall.input;
			}
			const deep = typeof input === "object" && input !== null && "deep" in input && Boolean(input.deep);
			// The bare `exec` tier leaves the decision to the configured approval
			// policy; a literal `policy: "prompt"` would override yolo/write modes.
			return deep ? "exec" : "read";
		},
		execute: async (_toolCallId, params: FormulaCheckParams) => {
			const result = assertFormula(params);
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
