import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type LintParams = { paths: string[] };

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
	const out = [...text];
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
	if (n.endsWith(".agent.md") || basename(dirname(path)) === "agents") return "agent";
	if (n.endsWith(".instructions.md")) return "pointer";
	if (n.endsWith(".context.md")) return "context";
	return "unknown";
}

function splitOnceTripleDash(text: string): string[] {
	const first = text.indexOf("---");
	if (first !== 0) return [text];
	const second = text.indexOf("---", 3);
	if (second < 0) return [text];
	return [text.slice(0, first), text.slice(first + 3, second), text.slice(second + 3)];
}

export function splitFrontmatter(text: string): [Record<string, string>, string] {
	if (!text.startsWith("---")) return [{}, text];
	const parts = splitOnceTripleDash(text);
	if (parts.length < 3) return [{}, text];
	const fm: Record<string, string> = {};
	let key: string | null = null;
	for (const line of (parts[1] ?? "").split("\n")) {
		const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
		if (m) {
			key = m[1] ?? "";
			fm[key] = (m[2] ?? "").trim();
		} else if (key && line.startsWith(" ")) {
			fm[key] += ` ${line.trim()}`;
		}
	}
	return [fm, parts[2] ?? ""];
}

export function parseXlint(text: string): [Set<string>, string] {
	if (!text.startsWith("---")) return [new Set(), ""];
	const parts = splitOnceTripleDash(text);
	if (parts.length < 3) return [new Set(), ""];
	const fmText = parts[1] ?? "";
	const xlintM = /^x-lint:\s*$/m.exec(fmText);
	if (!xlintM || xlintM.index === undefined) return [new Set(), ""];
	const after = fmText.slice(xlintM.index + xlintM[0].length);
	const blockLines: string[] = [];
	for (const line of after.split("\n")) {
		if (line === "" || line.startsWith(" ") || line.startsWith("\t")) {
			blockLines.push(line);
		} else {
			break;
		}
	}
	const block = blockLines.join("\n");
	const codes = new Set<string>();
	const inline = /allow:\s*\[([^\]]*)\]/.exec(block);
	if (inline) {
		for (const raw of (inline[1] ?? "").split(",")) {
			const tok = raw.trim().replace(/^['"]|['"]$/g, "");
			if (tok) codes.add(tok);
		}
	} else {
		const afterAllow = /allow:\s*\n((?:\s+-\s+\S+\n?)*)/.exec(block);
		if (afterAllow) {
			for (const tok of (afterAllow[1] ?? "").matchAll(/-\s+(\S+)/g)) {
				codes.add((tok[1] ?? "").replace(/^['"]|['"]$/g, ""));
			}
		}
	}
	const reasonM = /reason:\s*["']?(.+?)["']?\s*$/m.exec(block);
	const reason = reasonM ? (reasonM[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
	return [codes, reason];
}

export function hasRulesContract(path: string, fm: Record<string, string>): boolean {
	const name = (fm.name ?? "").trim() || (basename(path).split(".")[0] ?? "");
	const rulesDir = join(dirname(dirname(path)), "rules");
	const candidates = [name];
	const tier = /^(.*)-(low|medium|high|xhigh)$/.exec(name);
	if (tier?.[1]) candidates.push(tier[1]);
	for (const cand of candidates) {
		try {
			const data = JSON.parse(
				readFileSync(join(rulesDir, `${cand}.rules.json`), "utf8"),
			) as { completion?: unknown; authority?: unknown };
			return Boolean(data.completion) || Boolean(data.authority);
		} catch {
			continue;
		}
	}
	return false;
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
	const [fm, body] = splitFrontmatter(text);
	const lines = body.split("\n");

	const [allowedCodes, overrideReason] = parseXlint(text);
	if (allowedCodes.size > 0 && !overrideReason) {
		raw.push(["ERROR", "E9", "x-lint.allow declared without a reason field"]);
	}

	if (kind === "skill" || kind === "agent" || kind === "pointer") {
		const desc = fm.description ?? "";
		if (!desc) {
			err("E1", "missing frontmatter description");
		} else {
			const cap = kind === "pointer" ? 15 : 25;
			const wc = words(desc);
			if (wc > cap) err("E1", `description ${wc}w > ${cap}w cap for ${kind}`);
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
					`line ${idx + 1}: hedge '${m[0]}' — replace with an observable condition`,
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
					`line ${idx + 1}: model name '${m[0]}' in prose — route via steering-subagent-routing`,
				);
			}
		});
	}

	if (kind === "agent") {
		if (!hasRulesContract(path, fm)) {
			if (!/^#+\s*Output|^OUTPUT/m.test(body)) {
				err(
					"E5",
					"agent has no Output contract section (and no .apm/rules/<name>.rules.json)",
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
	}

	const nLines = lines.filter((line) => line.trim()).length;
	const caps: Record<string, number> = {
		skill: 70,
		context: 60,
		pointer: 10,
		agent: 90,
	};
	if (kind in caps && nLines > (caps[kind] ?? 0)) {
		warn("W6", `${nLines} non-empty lines > ${caps[kind]} target for ${kind}`);
	}

	if (kind === "pointer") {
		if (!/\]\(\.\.\/context\/.*\.context\.md\)/.test(body)) {
			err("E7", "pointer does not link a ../context/*.context.md file");
		}
	}

	for (const m of blankCodeSpans(body).matchAll(/\]\((?!https?:\/\/)([^)#]+)\)/g)) {
		const rel = m[1] ?? "";
		const target = resolve(dirname(path), rel);
		if (!existsSync(target)) err("E8", `broken link: ${rel}`);
	}

	const seen: Record<string, number> = {};
	lines.forEach((ln, idx) => {
		const key = ln.toLowerCase().replace(/\W+/g, " ").trim();
		if (
			key.length > 30 &&
			(KEYWORD_LINE.test(ln) || SIGIL_LINE.test(ln) || ln.trim().startsWith("-"))
		) {
			if (key in seen) warn("W9", `line ${idx + 1} duplicates line ${seen[key]}`);
			else seen[key] = idx + 1;
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
		if (allowedCodes.has(code) && overrideReason) {
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
	let st;
	try {
		st = statSync(entry);
	} catch {
		return [entry];
	}
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
			continue;
		}
		for (const name of ents) {
			const p = join(dir, name);
			let child;
			try {
				child = statSync(p);
			} catch {
				continue;
			}
			if (child.isDirectory()) stack.push(p);
			else if (name.endsWith(".md")) out.push(p);
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
		}),
		approval: "read",
		execute: async (_toolCallId, params: LintParams) => {
			const files = params.paths.flatMap(collectFiles);
			if (files.length === 0) {
				return {
					content: [{ type: "text", text: "agentic_lint: no markdown files in paths" }],
					details: { ok: false, error: "no files", paths: params.paths },
				};
			}
			try {
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
