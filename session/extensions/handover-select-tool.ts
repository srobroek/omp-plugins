import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { DEFAULT_HANDOVER_DIR } from "./handover-tool.ts";

export type HandoverSelectParams = {
	project?: string;
	dir?: string;
	cwd?: string;
};

export type RankedHandover = {
	path: string;
	filename: string;
	project?: string;
	repoRoot?: string;
	worktree?: string;
	branch?: string;
	task?: string;
	updated?: string;
	beads: string[];
	score: number;
	rationale: string[];
	placeholder: boolean;
};

export type SelectResult = {
	ok: boolean;
	candidates: RankedHandover[];
	error?: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseFrontmatter(body: string): Record<string, string> {
	const match = FRONTMATTER_RE.exec(body);
	if (!match) return {};
	const out: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			try {
				value = JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1)}"` : value) as string;
			} catch {
				value = value.slice(1, -1);
			}
		}
		out[key] = value;
	}
	return out;
}

export function parseBeadsField(raw?: string): string[] {
	if (!raw) return [];
	return raw
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function isPlaceholder(body: string): boolean {
	const stripped = body.replace(FRONTMATTER_RE, "").trim();
	if (!stripped) return true;
	const placeholders = ["TODO", "TBD", "FILL ME", "{{", "[ ]"];
	const operative = stripped
		.split("\n")
		.filter((line) => !line.startsWith("#") && line.trim().length > 0);
	if (operative.length === 0) return true;
	return operative.every((line) => placeholders.some((p) => line.includes(p)));
}

function parseFilename(name: string): { project?: string; task?: string } {
	const stem = name.replace(/\.md$/i, "");
	const idx = stem.indexOf("__");
	if (idx <= 0) return {};
	return { project: stem.slice(0, idx), task: stem.slice(idx + 2) };
}

function scoreCandidate(opts: {
	meta: Record<string, string>;
	filename: { project?: string; task?: string };
	project?: string;
	cwd?: string;
	mtimeMs: number;
	placeholder: boolean;
	beads: string[];
}): { score: number; rationale: string[] } {
	let score = 0;
	const rationale: string[] = [];
	const want = opts.project?.toLowerCase();
	const fmProject = (opts.meta.project ?? opts.filename.project ?? "").toLowerCase();
	if (want && fmProject && fmProject === want) {
		score += 100;
		rationale.push("exact project match");
	} else if (want && fmProject && fmProject.includes(want)) {
		score += 40;
		rationale.push("partial project match");
	} else if (want && fmProject) {
		score -= 50;
		rationale.push("project mismatch");
	} else if (want && !fmProject) {
		rationale.push("no project field");
	}

	const cwd = opts.cwd;
	if (cwd && opts.meta.worktree && cwd === opts.meta.worktree) {
		score += 50;
		rationale.push("exact worktree match");
	}
	if (cwd && opts.meta.repo_root && cwd === opts.meta.repo_root) {
		score += 30;
		rationale.push("exact repo_root match");
	}

	if (opts.meta.updated) {
		const ts = Date.parse(opts.meta.updated);
		if (!Number.isNaN(ts)) {
			const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
			const recency = Math.max(0, Math.min(20, 20 - ageDays));
			score += recency;
			rationale.push(`updated ${opts.meta.updated}`);
		}
	} else {
		const ageDays = (Date.now() - opts.mtimeMs) / 86_400_000;
		score += Math.max(0, 10 - ageDays);
		rationale.push("mtime recency fallback");
	}

	if (opts.beads.length > 0) {
		score += 15;
		rationale.push(`${opts.beads.length} open bead id(s)`);
	}

	if (opts.placeholder) {
		score -= 80;
		rationale.push("placeholder-only scaffold");
	}

	return { score, rationale };
}

export function selectHandovers(params: HandoverSelectParams): SelectResult {
	try {
		const dir = (params.dir ?? DEFAULT_HANDOVER_DIR).replace(/^~(?=\/|$)/, homedir());
		if (!existsSync(dir)) {
			return { ok: true, candidates: [] };
		}
		const names = readdirSync(dir).filter((n) => n.endsWith(".md"));
		const candidates: RankedHandover[] = [];
		for (const name of names) {
			const path = join(dir, name);
			let st;
			try {
				st = statSync(path);
				if (!st.isFile()) continue;
			} catch {
				continue;
			}
			let body: string;
			try {
				body = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			const meta = parseFrontmatter(body);
			const filename = parseFilename(name);
			const beads = parseBeadsField(meta.beads);
			const placeholder = isPlaceholder(body);
			const { score, rationale } = scoreCandidate({
				meta,
				filename,
				project: params.project,
				cwd: params.cwd,
				mtimeMs: st.mtimeMs,
				placeholder,
				beads,
			});
			candidates.push({
				path,
				filename: basename(path),
				project: meta.project ?? filename.project,
				repoRoot: meta.repo_root,
				worktree: meta.worktree,
				branch: meta.branch,
				task: meta.task ?? filename.task,
				updated: meta.updated,
				beads,
				score,
				rationale,
				placeholder,
			});
		}
		candidates.sort((a, b) => b.score - a.score || (b.updated ?? "").localeCompare(a.updated ?? ""));
		return { ok: true, candidates };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, candidates: [], error: message };
	}
}

export default function handoverSelectTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "handover_select",
		label: "Rank handovers",
		description:
			"Scan the shared handover store and rank candidates by project match, worktree/repo path, recency, and open beads.",
		parameters: z.object({
			project: z.string().optional().describe("Project slug to prefer"),
			dir: z.string().optional().describe("Override handover directory (tests)"),
			cwd: z.string().optional().describe("Current checkout path for worktree/repo matching"),
		}),
		approval: "read",
		execute: async (_id, params: HandoverSelectParams) => {
			const result = selectHandovers(params);
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `error: ${result.error}` }],
					details: { ok: false, error: result.error },
				};
			}
			const lines = result.candidates.map(
				(c, i) =>
					`${i + 1}. ${c.filename} score=${c.score} project=${c.project ?? "-"} branch=${c.branch ?? "-"} task=${c.task ?? "-"} updated=${c.updated ?? "-"} beads=${c.beads.join(",") || "-"} [${c.rationale.join("; ")}]`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: lines.length ? lines.join("\n") : "no handovers found",
					},
				],
				details: { ok: true, candidates: result.candidates },
			};
		},
	});
}
