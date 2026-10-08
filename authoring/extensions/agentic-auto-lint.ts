import { relative } from "node:path";

import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { lint } from "./agentic-lint-tool.ts";
import { writtenPaths } from "./written-paths.ts";

/**
 * Lint an agentic asset the agent just wrote, in-process, and prepend its ERROR
 * findings to the write's result. Silent when the file is clean or has only WARNs;
 * `agentic_lint` reports those on request.
 *
 * `tool_result`, never `tool_call`: the lint is advisory, and a throwing
 * `tool_call` handler blocks the tool (`skill://omp-extension-safety`). Acting on
 * the result also means only edits that landed are linted -- a rejected patch
 * leaves nothing to lint.
 */

/**
 * Path segments whose subtrees hold copies the agent did not author: vendored
 * dependencies and the OMP marketplace sync (`~/.omp/agent/managed-skills`).
 * Linting one reports findings against a file whose source lives elsewhere.
 * Membership is tested with `Object.hasOwn`, never a bare index: a directory
 * named `constructor` must not read as excluded.
 */
const EXCLUDED_SEGMENTS: Record<string, true> = {
	".git": true,
	"managed-skills": true,
	node_modules: true,
};

/** OMP's plugin cache (`~/.omp/plugins/cache/…`) holds installed copies, not sources. */
function inPluginCache(parts: string[]): boolean {
	for (let i = 0; i + 2 < parts.length; i++) {
		if (parts[i] === ".omp" && parts[i + 1] === "plugins" && parts[i + 2] === "cache") return true;
	}
	return false;
}

/**
 * Classify a path by where it sits, mirroring the install shapes in
 * `skill://write-agentic`: `skills/<name>/SKILL.md`, `rules/<name>.md`,
 * `agents/<name>.md`, plus the `AGENTS.md` and `RULES.md` steering files OMP
 * loads by name. Returns null when the path is not an agentic asset.
 */
export function assetKind(path: string): "skill" | "rule" | "agent" | "steering" | null {
	const parts = path.split(/[/\\]/).filter(Boolean);
	const file = parts.at(-1);
	if (!file?.endsWith(".md")) return null;
	for (const part of parts) {
		if (Object.hasOwn(EXCLUDED_SEGMENTS, part)) return null;
	}
	if (inPluginCache(parts)) return null;
	if (file === "AGENTS.md" || file === "RULES.md") return "steering";
	if (file === "SKILL.md") return parts.at(-3) === "skills" ? "skill" : null;
	const dir = parts.at(-2);
	// `docs/rules/` documents rules; OMP loads none from it.
	if (dir === "rules") return parts.at(-3) === "docs" ? null : "rule";
	if (dir === "agents") return "agent";
	return null;
}

export type LintReport = { path: string; errors: string[] };

/**
 * Lint each written asset and return the ERROR reports not already shown.
 *
 * `reported` maps a path to the errors last shown for it, so an edit that leaves
 * them unchanged stays silent. A clean file leaves the map, so a later regression
 * is reported again.
 */
export function pendingReports(paths: string[], reported: Map<string, string>): LintReport[] {
	const out: LintReport[] = [];
	for (const path of new Set(paths)) {
		if (assetKind(path) === null) continue;
		let errors: string[];
		try {
			errors = lint(path)
				.filter(([severity]) => severity === "ERROR")
				.map(([, code, message]) => `${code}: ${message}`);
		} catch {
			// Unreadable after the write landed (removed, permissions): nothing to report.
			continue;
		}
		if (errors.length === 0) {
			reported.delete(path);
			continue;
		}
		const shown = errors.join("\n");
		if (reported.get(path) === shown) continue;
		reported.set(path, shown);
		out.push({ path, errors });
	}
	return out;
}

export function formatReports(reports: LintReport[], cwd: string): string {
	const sections = reports.map(({ path, errors }) => {
		const rel = relative(cwd, path);
		const name = rel === "" || rel.startsWith("..") ? path : rel;
		return [`${name}:`, ...errors.map((error) => `  ERROR ${error}`)].join("\n");
	});
	return `agentic_lint found errors in the asset just written. Fix every ERROR before yielding.\n${sections.join("\n")}`;
}

export default function agenticAutoLint(pi: ExtensionAPI): void {
	// Child sessions reuse this module but bind the factory afresh, so state
	// declared here belongs to one session; module scope would be shared by all.
	const reported = new Map<string, string>();

	pi.on("session_start", () => {
		reported.clear();
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx: { cwd?: string }) => {
		try {
			const cwd = ctx?.cwd || process.cwd();
			const reports = pendingReports(writtenPaths(event, cwd), reported);
			if (reports.length === 0) return;
			const prefix = { type: "text" as const, text: `${formatReports(reports, cwd)}\n\n` };
			return { content: [prefix, ...(event.content ?? [])] };
		} catch {
			// A lint report is worth less than the result it rides on.
			return;
		}
	});
}
