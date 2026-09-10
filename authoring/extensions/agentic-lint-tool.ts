import { existsSync, lstatSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type LintParams = { paths: string[] };

/** The two shapes `agentic_lint` reports: an early refusal, or a completed run. */
type LintDetails =
	| { ok: boolean; error: string; paths: string[] }
	| {
			ok: boolean;
			exitCode: number;
			errors: number;
			warns: number;
			files: string[];
			findings: Finding[];
			stdout: string;
	  };

export type Finding = {
	path: string;
	kind?: string;
	severity: string;
	code?: string;
	message: string;
};

export type Triple = [string, string, string];

const HEDGES = new RegExp(
	String.raw`\b(when (practical|appropriate|possible|needed|available)|consider|` +
	String.raw`generally|usually|normally|if necessary|as needed|try to|ideally|` +
	String.raw`where possible|genuinely|materially|substantial(ly)?|reasonabl[ye]|` +
	String.raw`clearly|obvious(ly)?|large enough|significant(ly)?)\b`,
	"i",
);
const MODEL_NAMES = /\b(opus|sonnet|haiku|fable|gpt-\d)\b/i;
const KEYWORD_LINE = /^\s*(MUST|DEFAULT|ASK|NOT)\s+\S/;
const SIGIL_LINE = /^\s*[!~?−-]\s+\S/;
const CAPS_ENUM = /\b[A-Z][A-Z-]{2,}(\|[A-Z][A-Z-]{2,})+\b/;
const OVER_CONSTRAINED_THRESHOLD = 15;
const TRIGGER_PATTERN = new RegExp(
	String.raw`\b(?:should\s+be\s+)?used?\s+(?:this\s+skill\s+)?(?:immediately\s+)?` +
	String.raw`(?:when|after|before|whenever|for|to)\b` +
	String.raw`|\buse\s+proactively\b` +
	String.raw`|\btrigger(?:s)?\s+(?:when|on)\b` +
	String.raw`|\bauto[-\s]?loads?\s+(?:when|on)\b` +
	String.raw`|\binvoke\b`,
	"i",
);
const BLOATED_LINE_THRESHOLD = 800;
const YAML_SCALAR_PREFIX = /^[>|][>|-]?\s*/;

const USAGE = `Lint agentic assets (skills, steering, agents) against the write-agentic
format contract.

Usage: lint <file> [<file>...]
Exit: 0 clean, 1 any ERROR (WARNs alone stay 0).`;

export function words(s: string): number {
	return s.split(/\s+/).filter(Boolean).length;
}

export function blankCodeSpans(text: string): string {
	const out = text.split("");
	const blank = (start: number, end: number): void => {
		const stop = Math.min(end, out.length);
		for (let i = start; i < stop; i++) {
			if (out[i] !== "\n") out[i] = " ";
		}
	};
	const fence = /^[ \t]*(```+|~~~+)[^\n]*\n.*?^[ \t]*\1[^\n]*$/gms;
	for (const m of text.matchAll(fence)) {
		if (m.index !== undefined) blank(m.index, m.index + m[0].length);
	}
	const joined = out.join("");
	const inline = /(`+)(?:(?!\1).)*?\1/gs;
	for (const m of joined.matchAll(inline)) {
		if (m.index !== undefined) blank(m.index, m.index + m[0].length);
	}
	return out.join("");
}

export function detectKind(path: string): string {
	const n = basename(path);
	if (n.startsWith("template-")) return "template";
	if (n === "SKILL.md") return "skill";
	if (basename(dirname(path)) === "agents") return "agent";
	if (basename(dirname(path)) === "rules" || n === "RULES.md") return "rule";
	return "unknown";
}

function splitOnceTripleDash(text: string): string[] {
	const opening = /^---[ \t]*\r?\n/.exec(text);
	if (!opening) return [text];
	const rest = text.slice(opening[0].length);
	const closing = /^---[ \t]*(?=\r?\n|$)/m.exec(rest);
	if (!closing) return [text];
	return ["", rest.slice(0, closing.index), rest.slice(closing.index + closing[0].length)];
}

export type ParsedFrontmatter = {
	values: Record<string, string>;
	parsed: Record<string, unknown> | undefined;
	body: string;
	bodyLineOffset: number;
	frontmatterDefects: Triple[];
	xLintAllowedCodes: Set<string>;
	xLintOverrideReason: string;
};

export function parseFrontmatter(text: string): ParsedFrontmatter {
	const empty = {
		values: {},
		parsed: undefined,
		body: text,
		bodyLineOffset: 0,
		frontmatterDefects: [],
		xLintAllowedCodes: new Set<string>(),
		xLintOverrideReason: "",
	};
	if (!/^---[ \t]*(?:\r?\n|$)/.test(text)) return empty;

	const parts = splitOnceTripleDash(text);
	const block = parts[1];
	if (parts.length < 3 || block === undefined) {
		return { ...empty, frontmatterDefects: [["ERROR", "E13", "unclosed frontmatter"]] };
	}

	const body = parts[2] ?? "";
	const bodyLineOffset = text.slice(0, text.length - body.length).split(/\r?\n/).length - 1;
	const values: Record<string, string> = {};
	let key: string | null = null;
	for (const line of block.split("\n")) {
		const match = /^(\w[\w-]*):\s*(.*)$/.exec(line);
		if (match) {
			key = match[1] ?? "";
			values[key] = (match[2] ?? "").trim();
		} else if (key && line.startsWith(" ")) {
			values[key] += ` ${line.trim()}`;
		}
	}

	try {
		const document = Bun.YAML.parse(block);
		const parsed = document && typeof document === "object" && !Array.isArray(document)
			? document as Record<string, unknown>
			: undefined;
		const xLint = parsed?.["x-lint"];
		const xLintRecord = xLint && typeof xLint === "object" && !Array.isArray(xLint)
			? xLint as Record<string, unknown>
			: undefined;
		const allowed = Array.isArray(xLintRecord?.allow)
			? new Set(xLintRecord.allow.filter((code): code is string => typeof code === "string"))
			: new Set<string>();
		const reason = typeof xLintRecord?.reason === "string" ? xLintRecord.reason.trim() : "";
		return {
			values,
			parsed,
			body,
			bodyLineOffset,
			frontmatterDefects: [],
			xLintAllowedCodes: allowed,
			xLintOverrideReason: reason,
		};
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
		return {
			...empty,
			values,
			body,
			bodyLineOffset,
			frontmatterDefects: [["ERROR", "E13", `invalid frontmatter (${reason})`]],
		};
	}
}

export function splitFrontmatter(text: string): [Record<string, string>, string] {
	const result = parseFrontmatter(text);
	return [result.values, result.body];
}

/** Strict consumers must not silently drop malformed frontmatter. */
export function frontmatterDefects(text: string): Triple[] {
	return parseFrontmatter(text).frontmatterDefects;
}

/**
 * Filesystem paths that only resolve on the machine that wrote them.
 *
 * Not every absolute path is a defect. `/tmp/...`, `/dev/null` and `/usr/bin/env`
 * are absolute by necessity and correct on any host, so flagging "absolute" would
 * reject portable shell snippets. The defect is a MACHINE-SPECIFIC root:
 *
 * - a home directory on any OS, so `/home/...` and `C:\Users\...` count as much as
 *   the macOS `/Users/...`
 * - any Windows drive path, since the drive letter is a property of one machine
 *
 * `~/` stays allowed: it is the portable way to say the same thing.
 */
export function hostSpecificPaths(body: string): string[] {
	const homes = /(?<![\w.:/~-])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g;
	const rootHome = /(?<![\w.:/~-])\/root\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g;
	const windows = /\b[A-Za-z]:[\\/](?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]*/g;
	const hits = [...body.matchAll(homes), ...body.matchAll(rootHome), ...body.matchAll(windows)].map(m => m[0]);
	return [...new Set(hits)];
}

export function parseXlint(text: string): [Set<string>, string] {
	const result = parseFrontmatter(text);
	return [result.xLintAllowedCodes, result.xLintOverrideReason];
}


export function lint(path: string): Triple[] {
	const raw: Triple[] = [];
	const err = (c: string, m: string): void => {
		raw.push(["ERROR", c, m]);
	};
	const warn = (c: string, m: string): void => {
		raw.push(["WARN", c, m]);
	};

	const text = readFileSync(path, "utf8");
	const kind = detectKind(path);
	if (kind === "template") return [];
	const frontmatter = parseFrontmatter(text);
	const { values: fm, body, bodyLineOffset, xLintAllowedCodes: allowedCodes, xLintOverrideReason: overrideReason } = frontmatter;
	const lines = body.split("\n");

	if (allowedCodes.size > 0 && !overrideReason) {
		raw.push(["ERROR", "E9", "x-lint.allow declared without a reason field"]);
	}

	// Applies to every kind, rules included: a dropped condition breaks any of them.
	raw.push(...frontmatter.frontmatterDefects);
	if (["rule", "skill", "agent"].includes(kind) && !raw.some(([, code]) => code === "E13")) {
		const parsed = frontmatter.parsed;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			err("E14", `${kind} frontmatter must be a mapping`);
		} else {
			const meta = parsed as Record<string, unknown>;
			if (kind === "skill" || kind === "agent") {
				for (const key of ["name", "description"]) {
					if (typeof meta[key] !== "string" || !(meta[key] as string).trim()) {
						err("E14", `${kind} ${key} must be a nonempty string`);
					}
				}
			}
			let triggered = false;
			for (const key of kind === "rule" ? ["condition", "astCondition"] : []) {
				const triggerKey = key === "condition"
					? ["condition", "ttsr_trigger", "ttsrTrigger"].find(candidate => Object.hasOwn(meta, candidate))
					: Object.hasOwn(meta, key) ? key : undefined;
				if (triggerKey === undefined) continue;
				const value = meta[triggerKey];
				const patterns = typeof value === "string" ? [value] : value;
				if (!Array.isArray(patterns) || patterns.some(p => typeof p !== "string" || !p.trim())) {
					err("E14", `${key} must be a string or list of nonempty strings`);
					continue;
				}
				triggered ||= patterns.length > 0;
				if (key === "astCondition") continue;
				for (const pattern of patterns) {
					// The host accepts file-glob shorthand and leading inline flags.
					if (!/[\\^$+|()]/.test(pattern) && /[?*[\]{}]/.test(pattern) &&
						(pattern.includes("/") || /^\*\.[^\s/]+$/.test(pattern))) continue;
					const flags = /^\(\?([ims]+)\)/.exec(pattern);
					try { new RegExp(flags ? pattern.slice(flags[0].length) : pattern, flags ? [...new Set(flags[1])].join("") : undefined); }
					catch { err("E14", `invalid ${key} regex: ${pattern}`); }
				}
			}
			if (kind === "rule" && !triggered && meta.enabled !== false && meta.alwaysApply !== true && basename(path) !== "RULES.md" &&
				!(typeof meta.description === "string" && meta.description.trim())) {
				err("E14", "rule has no description, alwaysApply, or TTSR trigger; it is not discoverable");
			}
		}
	}

	if (kind === "skill" || kind === "agent") {
		const desc = fm.description ?? "";
		if (!desc) {
			err("E1", "missing frontmatter description");
		} else {
			const wc = words(desc);
			if (wc > 25) err("E1", `description ${wc}w > 25w cap for ${kind}`);
			const descContent = desc.replace(YAML_SCALAR_PREFIX, "").trim();
			if (descContent && descContent.length < 20) {
				err("E1", `description too short (${descContent.length} chars < 20 minimum)`);
			}
		}
	}

	lines.forEach((ln, idx) => {
		if (KEYWORD_LINE.test(ln)) {
			const m = HEDGES.exec(ln);
			if (m) {
				err(
					"E2",
					`line ${idx + bodyLineOffset + 1}: hedge '${m[0]}' — replace with an observable condition`,
				);
			}
		}
	});

	if (!String(path).includes("subagent-routing") && kind !== "agent") {
		lines.forEach((ln, idx) => {
			if (ln.trim().startsWith("#") || ln.trim().startsWith("LEGEND")) return;
			const m = MODEL_NAMES.exec(ln);
			if (m) {
				err(
					"E3",
					`line ${idx + bodyLineOffset + 1}: model name '${m[0]}' in prose — route via steering-subagent-routing`,
				);
			}
		});
	}

	if (kind === "agent") {
		if (!/^#+\s*Output|^OUTPUT/m.test(body)) {
			err(
				"E5",
				"agent has no Output contract section",
			);
		} else {
			if (!CAPS_ENUM.test(body)) {
				warn("W5", "no CAPS verdict enum (PASS|FAIL style) found in output contract");
			}
			if (!/\bCAP\b|\b\d+\s*w(ords)?\b|≤\s*\d+/.test(body)) {
				err("E5", "output contract has no word cap");
			}
			if (!/never reprint|paths? only|path:line/i.test(body)) {
				warn("W5", "no no-reprint rule in output contract");
			}
		}
	}

	const nLines = lines.filter((line) => line.trim()).length;
	const caps: Record<string, number> = {
		skill: 70,
		agent: 90,
	};
	if (kind in caps && nLines > (caps[kind] ?? 0)) {
		warn("W6", `${nLines} non-empty lines > ${caps[kind]} target for ${kind}`);
	}


	for (const m of blankCodeSpans(body).matchAll(/\]\((?!https?:\/\/)([^)#]+)\)/g)) {
		const rel = m[1] ?? "";
		const target = resolve(dirname(path), rel);
		if (!existsSync(target)) err("E8", `broken link: ${rel}`);
	}

	// Deliberately NOT blankCodeSpans: a baked host path is normally cited inside
	// backticks, which is exactly where it must still be caught.
	for (const m of hostSpecificPaths(body)) {
		err("E12", `machine-specific path '${m}' — cite assets as skill://<name>/<path> or use ~/, this dies on another machine`);
	}

	const seen: Record<string, number> = {};
	lines.forEach((ln, idx) => {
		const key = ln.toLowerCase().replace(/\W+/g, " ").trim();
		if (
			key.length > 30 &&
			(KEYWORD_LINE.test(ln) || SIGIL_LINE.test(ln) || ln.trim().startsWith("-"))
		) {
			if (key in seen) warn("W9", `line ${idx + bodyLineOffset + 1} duplicates line ${seen[key]}`);
			else seen[key] = idx + bodyLineOffset + 1;
		}
	});

	if (kind === "skill") {
		const mnaCount = (text.match(/\b(MUST|NEVER|ALWAYS)\b/g) ?? []).length;
		if (mnaCount > OVER_CONSTRAINED_THRESHOLD) {
			warn(
				"W10",
				`${mnaCount} MUST/NEVER/ALWAYS directives > ${OVER_CONSTRAINED_THRESHOLD} threshold — overly prescriptive instructions reduce model flexibility`,
			);
		}
		const desc = fm.description ?? "";
		const descContent = desc.replace(YAML_SCALAR_PREFIX, "").trim();
		if (descContent && descContent.length >= 20 && !TRIGGER_PATTERN.test(descContent)) {
			warn(
				"W11",
				'skill description lacks a trigger phrase (e.g. "Use when …", "Use for …", "Triggers on …") — without one the model cannot determine when to invoke it',
			);
		}
		const nTotal = text.split("\n").filter((line) => line.trim()).length;
		const hasRefs = existsSync(join(dirname(path), "references"));
		if (nTotal > BLOATED_LINE_THRESHOLD && !hasRefs) {
			warn(
				"W12",
				`${nTotal} non-empty lines without a references/ directory — large skills should offload supporting material to references/`,
			);
		}
	}

	if (allowedCodes.size === 0) return raw;
	const out: Triple[] = [];
	for (const [sev, code, msg] of raw) {
		if (allowedCodes.has(code) && overrideReason && code !== "E13" && code !== "E14") {
			out.push(["OVERRIDDEN", code, `${msg} (reason: ${overrideReason})`]);
		} else {
			out.push([sev, code, msg]);
		}
	}
	return out;
}

export function main(argv: string[]): { exitCode: number; stdout: string } {
	if (argv.length === 0) return { exitCode: 2, stdout: `${USAGE}\n` };
	let worst = 0;
	const lines: string[] = [];
	for (const arg of argv) {
		let isFile = false;
		try {
			isFile = statSync(arg).isFile();
		} catch {
			isFile = false;
		}
		if (!isFile) {
			lines.push(`${arg}: not a file`);
			worst = 1;
			continue;
		}
		const kind = detectKind(arg);
		const findings = lint(arg);
		const visible = findings.filter((f) => f[0] !== "OVERRIDDEN");
		const overridden = findings.filter((f) => f[0] === "OVERRIDDEN");
		if (findings.length === 0) {
			lines.push(`${arg} [${kind}]: OK`);
			continue;
		}
		if (visible.length === 0 && overridden.length > 0) {
			lines.push(`${arg} [${kind}]: OK (with overrides)`);
		}
		for (const [sev, code, msg] of findings) {
			lines.push(`${arg} [${kind}] ${sev} ${code}: ${msg}`);
			if (sev === "ERROR") worst = 1;
		}
	}
	return { exitCode: worst, stdout: `${lines.join("\n")}\n` };
}

function collectFiles(entry: string): string[] {
	let st: Stats;
	try {
		st = lstatSync(entry);
	} catch {
		return [entry];
	}
	if (st.isSymbolicLink()) throw new Error(`symbolic link is outside lint traversal: ${entry}`);
	if (st.isFile()) return [entry];
	if (!st.isDirectory()) return [entry];
	const out: string[] = [];
	const stack = [entry];
	while (stack.length > 0) {
		const dir = stack.pop() ?? "";
		let ents: string[] = [];
		try {
			ents = readdirSync(dir);
		} catch {
			out.push(dir);
			continue;
		}
		for (const name of ents) {
			const p = join(dir, name);
			let child: Stats;
			try {
				child = lstatSync(p);
			} catch {
				out.push(p);
				continue;
			}
			if (child.isSymbolicLink()) continue;
			if (child.isDirectory()) stack.push(p);
			else if (name.endsWith(".md") || name.endsWith(".mdc")) out.push(p);
		}
	}
	return out;
}

function parseFindings(stdout: string): Finding[] {
	const findings: Finding[] = [];
	for (const line of stdout.split("\n")) {
		const ok = line.match(/^(.+) \[([^\]]+)\]: OK(?: \(with overrides\))?$/);
		if (ok) {
			findings.push({ path: ok[1] ?? "", kind: ok[2], severity: "OK", message: line });
			continue;
		}
		const hit = line.match(
			/^(.+) \[([^\]]+)\] (ERROR|WARN|OVERRIDDEN) ([A-Z]\d+): (.+)$/,
		);
		if (hit) {
			findings.push({
				path: hit[1] ?? "",
				kind: hit[2],
				severity: hit[3] ?? "",
				code: hit[4],
				message: hit[5] ?? "",
			});
			continue;
		}
		const missing = line.match(/^(.+): not a file$/);
		if (missing) {
			findings.push({
				path: missing[1] ?? "",
				severity: "ERROR",
				message: "not a file",
			});
		}
	}
	return findings;
}

export default function agenticLintTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "agentic_lint",
		label: "Lint agentic assets",
		description:
			"Lint skill/rule/agent markdown against the write-agentic format contract. Pass files or directories.",
		parameters: z.object({
			paths: z
				.array(z.string())
				.describe("Skill, rule, or agent markdown files or directories"),
		}) as unknown as TSchema, // pi.zod and the host TypeBox schema types differ.
		approval: "read",
		execute: async (
			_toolCallId,
			params: LintParams,
		): Promise<AgentToolResult<LintDetails>> => {
			try {
				const files = params.paths.flatMap(collectFiles);
				if (files.length === 0) {
					return {
						content: [{ type: "text", text: "agentic_lint: no markdown files in paths" }],
						details: { ok: false, error: "no files", paths: params.paths },
					};
				}
				const result = main(files);
				const findings = parseFindings(result.stdout);
				const errors = findings.filter((f) => f.severity === "ERROR").length;
				const warns = findings.filter((f) => f.severity === "WARN").length;
				const summary =
					result.stdout.trim() ||
					`agentic_lint exit ${result.exitCode} (errors=${errors} warns=${warns})`;
				return {
					content: [{ type: "text", text: summary }],
					details: {
						ok: result.exitCode === 0,
						exitCode: result.exitCode,
						errors,
						warns,
						files,
						findings,
						stdout: result.stdout,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `agentic_lint failed: ${message}` }],
					details: { ok: false, error: message, paths: params.paths },
				};
			}
		},
	});
}

if (import.meta.main) {
	const result = main(Bun.argv.slice(2));
	process.stdout.write(result.stdout);
	process.exit(result.exitCode);
}
