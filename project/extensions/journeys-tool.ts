import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STEP_HEADING = /^### (S\d+[a-z]?) — .+ \{#(S\d+[a-z]?)\}\s*$/;
const DELTA_ENTRY = /^- \*\*Δ(\d+)\*\* (\d{4}-\d{2}-\d{2}) · (.+?) · behavior-change\s*$/;
const JOURNEY_ID = /^J\d+$/;
const STEP_REF = /\+?(S\d+[a-z]?)/g;
const RESULTS: Record<string, true> = { pass: true, fail: true, blocked: true, skipped: true };
const STATUSES: Record<string, true> = { draft: true, active: true, deprecated: true };
const REQUIRED_KEYS = ["id", "title", "version", "status", "last_reviewed"] as const;

export type Frontmatter = Record<string, string | string[] | Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * True when a block opened with `---` and never closed.
 *
 * A file with no block at all is a different condition: nothing was declared, so
 * nothing was lost. An unterminated block means fields ARE present in the file and
 * the parser discarded them, which is worth naming.
 */
export function frontmatterIsUnterminated(text: string): boolean {
	const lines = text.split("\n");
	if (!lines.length || lines[0]?.trim() !== "---") return false;
	return lines.slice(1).every((line) => line.trim() !== "---");
}

/**
 * Returns null when the block is absent or unterminated, and {} only for a block
 * that terminated with nothing in it.
 *
 * An empty object used to mean both, so a caller probing truthiness could not tell
 * a malformed file from an empty one - `index` rendered a truncated run as `? ?`
 * and reported nothing.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
	const lines = text.split("\n");
	if (!lines.length || lines[0]?.trim() !== "---") return null;
	const fm: Frontmatter = {};
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") return fm;
		if (!line.trim() || line.trimStart().startsWith("#") || !line.includes(":")) continue;
		const idx = line.indexOf(":");
		const key = line.slice(0, idx).trim();
		const raw = line.slice(idx + 1).split(" #")[0]?.trim() ?? "";
		if (raw.startsWith("[") && raw.endsWith("]")) {
			const inner = raw.slice(1, -1).trim();
			fm[key] = inner ? inner.split(",").map((v) => v.trim()).filter(Boolean) : [];
		} else if (raw.startsWith("{") && raw.endsWith("}")) {
			const entries: Record<string, string> = {};
			const inner = raw.slice(1, -1).trim();
			for (const part of inner.split(",").map((p) => p.trim()).filter(Boolean)) {
				const c = part.indexOf(":");
				if (c === -1) continue;
				entries[part.slice(0, c).trim()] = part.slice(c + 1).trim();
			}
			fm[key] = entries;
		} else {
			fm[key] = raw;
		}
	}
	// Loop exhausted without a closing `---`: fields were present and are being
	// discarded, which is not the same as a file that declared nothing.
	return null;
}

/**
 * Refuse a symlink at or below `base`, and refuse a path that escapes it.
 *
 * Only the managed tree is attacker-shaped: a journeys directory's own contents,
 * or the `.beads/formulas` directory a copy writes into. Components ABOVE `base`
 * are the user's own filesystem layout, and walking those made the tool unusable
 * wherever any ancestor is a symlink. On macOS both `/tmp` and `/var` are, so
 * every temp directory was refused outright, and a symlinked home or work
 * directory is common enough to hit real users.
 *
 * `base` MUST already be physically resolved by the caller -- see `managedRoot`.
 * Resolving it is what keeps the checked path and the operated path the same one:
 * a lexical `resolve()` collapses `link/..` to the parent of the symlink, so the
 * walk inspects `/top/managed` while the filesystem writes to `/outside/managed`.
 * The candidate is then only normalised lexically, because it is built from that
 * resolved root and its own components must stay unresolved for `lstat` to see a
 * symlink at all.
 */
function safePath(path: string, base: string): void {
	const root = base;
	const absolute = resolve(isAbsolute(path) ? path : join(process.cwd(), path));
	const inside = relative(root, absolute);
	// Component-aware, not `startsWith("..")`: an ordinary entry named `..metadata`
	// is inside the root, and rejecting it diverged from the Python port.
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
		throw new Error(`outside the managed root: ${absolute}`);
	}
	let current = root;
	if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`unsafe symlink: ${current}`);
	}
	for (const part of inside.split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean)) {
		current = join(current, part);
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`unsafe symlink: ${current}`);
		}
	}
}

/**
 * The physical directory a command operates in, or `null` when it cannot be one.
 *
 * A `..` component is refused outright rather than normalised. `..` is the only
 * way a root can traverse a symlink: `/top/link/../managed` normalises lexically
 * to `/top/managed` while the filesystem resolves it to whatever `link` points
 * at, so the guard would inspect one tree and the writes would land in another.
 * Refusing the component is precise -- comparing the lexical form against the
 * physical one is NOT usable here, because a plain `/tmp/x` legitimately differs
 * from `/private/tmp/x` on macOS, which is the breakage this whole change fixes.
 *
 * Everything else resolves physically, so the tree walked is the tree written.
 */
function managedRoot(dir: string): string | null {
	const absolute = resolve(isAbsolute(dir) ? dir : join(process.cwd(), dir));
	if (dir.split(sep === "\\" ? /[\\/]/ : "/").includes("..")) return null;
	try {
		return realpathSync(absolute);
	} catch {
		return null;
	}
}

function safeJourneyPaths(root: string): void {
	safePath(root, root);
	safePath(join(root, "INDEX.md"), root);
	safePath(join(root, "TRACKER.md"), root);
	for (const name of readdirSync(root)) {
		const dir = join(root, name);
		safePath(dir, root);
		if (!lstatSync(dir).isDirectory()) continue;
		safePath(join(dir, "journey.md"), root);
		const runs = join(dir, "runs");
		safePath(runs, root);
		if (!existsSync(runs)) continue;
		const runsStat = lstatSync(runs);
		if (!runsStat.isDirectory()) throw new Error(`runs is not a directory: ${runs}`);
		for (const run of readdirSync(runs).filter((n) => n.endsWith(".md"))) {
			safePath(join(runs, run), root);
			if (!lstatSync(join(runs, run)).isFile()) throw new Error(`not a run file: ${run}`);
		}
	}
}

export function journeyDirs(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.map((name) => join(root, name))
		.filter((d) => {
			try {
				return statSync(d).isDirectory() && existsSync(join(d, "journey.md"));
			} catch {
				return false;
			}
		})
		.sort();
}

export function latestRun(jdir: string): Frontmatter | null {
	const runsDir = join(jdir, "runs");
	if (!existsSync(runsDir)) return null;
	const runs = readdirSync(runsDir)
		.filter((n) => n.endsWith(".md"))
		.sort()
		.map((n) => join(runsDir, n));
	const last = runs.at(-1);
	if (!last) return null;
	const text = readFileSync(last, "utf8");
	const fm = parseFrontmatter(text);
	if (!fm) {
		// A truncated block had fields the parser threw away, so callers must be able
		// to say so. A run with no block at all declared nothing and keeps its previous
		// rendering - that is a lint concern, not a lost-data one.
		if (frontmatterIsUnterminated(text)) return { _file: basename(last), _malformed: "1" };
		return { _file: basename(last) };
	}
	fm._file = basename(last);
	return fm;
}

export function openFindings(root: string): Record<string, number> {
	const tracker = join(root, "TRACKER.md");
	const counts: Record<string, number> = {};
	if (!existsSync(tracker)) return counts;
	const text = readFileSync(tracker, "utf8");
	const chunks = text.split("<!-- journey-finding").slice(1);
	for (const chunk of chunks) {
		const jid = chunk.slice(0, 400).match(/journey:\s*(\S+)/);
		const status = chunk.slice(0, 800).match(/status:\s*(\w+)/);
		const journeyId = jid?.[1];
		const journeyStatus = status?.[1];
		if (journeyId && (!status || journeyStatus === "open")) {
			counts[journeyId] = (counts[journeyId] ?? 0) + 1;
		}
	}

	return counts;
}

export function cmdIndex(root: string): { ok: boolean; text: string; count: number } {
	safeJourneyPaths(root);
	const findings = openFindings(root);
	const rows: string[] = [];
	const unreadable: string[] = [];
	for (const jdir of journeyDirs(root)) {
		const journeyText = readFileSync(join(jdir, "journey.md"), "utf8");
		const parsed = parseFrontmatter(journeyText);
		let fm: Frontmatter = parsed ?? {};
		if (!parsed && frontmatterIsUnterminated(journeyText)) {
			// Fields were present and discarded; say so rather than rendering every
			// column as `?`, which reads as a journey that simply omitted them.
			unreadable.push(`${basename(jdir)}/journey.md`);
			fm = { title: "**unreadable frontmatter**" };
		}
		const run = latestRun(jdir);
		let last = "never";
		if (run?._malformed) {
			unreadable.push(`${basename(jdir)}/runs/${String(run._file)}`);
			last = `**unreadable** (${String(run._file)})`;
		} else if (run) {
			const mode = String(run.mode ?? "full").split("(")[0];
			last = `${run.date ?? "?"} ${run.result ?? "?"} (${mode})`;
		}
		const id = typeof fm.id === "string" ? fm.id : "";
		const nOpen = findings[id] ?? 0;
		const surfaces = Array.isArray(fm.surfaces) ? fm.surfaces.join(", ") : "—";
		const ifc = Array.isArray(fm.interfaces) ? fm.interfaces.join(", ") : "—";
		rows.push(
			`| [${fm.id ?? "?"}](${basename(jdir)}/journey.md) | ${fm.title ?? "?"} | ${fm.status ?? "?"} | v${fm.version ?? "?"} | ${surfaces} | ${ifc} | ${fm.last_reviewed ?? "?"} | ${last} | ${nOpen ? String(nOpen) : "—"} |`,
		);
	}
	const body = [
		"# Journey index",
		"",
		"Generated by `journeys.py index` — do not hand-edit.",
		"",
		"| id | title | status | version | surfaces | interfaces | last_reviewed | last run | open findings |",
		"|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
	].join("\n");
	writeFileSync(join(root, "INDEX.md"), body, "utf8");
	// Named in the result and marked in the row, which is what the defect needed: the
	// old code reported nothing at all. `ok` stays true because index generates and
	// lint validates - lint reports the same file as an error.
	const notes = unreadable.map((rel) => `\nERROR ${rel}: unreadable frontmatter, rendered as unreadable`).join("");
	return { ok: true, text: `INDEX.md: ${rows.length} journeys${notes}`, count: rows.length };
}

export function lintJourney(jdir: string, errors: string[], seenIds: Record<string, string>): void {
	const path = join(jdir, "journey.md");
	const text = readFileSync(path, "utf8");
	const rel = `${basename(jdir)}/journey.md`;
	const fm = parseFrontmatter(text);
	if (!fm) {
		errors.push(`${rel}: missing or unterminated frontmatter`);
		return;
	}
	for (const key of REQUIRED_KEYS) {
		if (!(key in fm)) errors.push(`${rel}: frontmatter missing \`${key}\``);
	}
	const jid = typeof fm.id === "string" ? fm.id : "";
	if (jid && !JOURNEY_ID.test(jid)) errors.push(`${rel}: id \`${jid}\` does not match J<n>`);
	// Only a declared id can collide. Journeys with no `id:` all read as "", so an
	// unguarded write made the second one report ``duplicate id ` ` `` - noise beside
	// the `missing id` error that already names the real problem.
	if (jid) {
		if (jid in seenIds) errors.push(`${rel}: duplicate id \`${jid}\` (also ${seenIds[jid]})`);
		seenIds[jid] = rel;
	}
	if (jid && !basename(jdir).startsWith(`${jid}-`)) {
		errors.push(`${rel}: directory \`${basename(jdir)}\` does not start with \`${jid}-\``);
	}
	if (typeof fm.status === "string" && !STATUSES[fm.status]) {
		errors.push(`${rel}: status \`${fm.status}\` not in ${JSON.stringify(Object.keys(STATUSES).sort())}`);
	}
	if (fm.version !== undefined && !String(fm.version).match(/^\d+$/)) {
		errors.push(`${rel}: version \`${fm.version}\` is not an integer`);
	}

	const stepIds: string[] = [];
	const lines = text.split("\n");
	lines.forEach((line, i) => {
		const n = i + 1;
		if (line.startsWith("### ") && line.includes("{#")) {
			const m = line.match(STEP_HEADING);
			if (!m) {
				errors.push(`${rel}:${n}: malformed step heading (want \`### S<id> — title {#S<id>}\`)`);
				return;
			}
			if (m[1] === undefined || m[2] === undefined) return;
			if (m[1] !== m[2]) errors.push(`${rel}:${n}: heading id ${m[1]} != anchor ${m[2]}`);
			if (stepIds.includes(m[1])) errors.push(`${rel}:${n}: duplicate step id ${m[1]}`);
			stepIds.push(m[1]);
		} else if (line.startsWith("### S")) {
			errors.push(`${rel}:${n}: step heading missing \`{#S<id>}\` anchor`);
		}
	});

	const version = String(fm.version ?? "").match(/^\d+$/) ? Number(fm.version) : null;
	lines.forEach((line, i) => {
		const n = i + 1;
		const m = line.match(DELTA_ENTRY);
		if (!m || m[1] === undefined || m[3] === undefined) return;
		if (version !== null && Number(m[1]) > version) errors.push(`${rel}:${n}: delta Δ${m[1]} exceeds journey version ${version}`);
		const refs = m[3].match(STEP_REF) ?? [];
		for (const raw of refs) {
			const ref = raw.startsWith("+") ? raw.slice(1) : raw;
			if (!stepIds.includes(ref)) errors.push(`${rel}:${n}: delta Δ${m[1]} references unknown step ${ref}`);
		}
	});

	const runsDir = join(jdir, "runs");
	if (!existsSync(runsDir)) return;
	for (const name of readdirSync(runsDir).filter((n) => n.endsWith(".md")).sort()) {
		const run = join(runsDir, name);
		const rfm = parseFrontmatter(readFileSync(run, "utf8"));
		const rrel = `${basename(jdir)}/runs/${name}`;
		if (!rfm) {
			errors.push(`${rrel}: missing or unterminated frontmatter`);
			continue;
		}
		if (rfm.journey !== jid) errors.push(`${rrel}: journey \`${rfm.journey}\` != \`${jid}\``);
		// A run's own result is narrower than a step's: `skipped` is a step outcome.
		if (rfm.result !== "pass" && rfm.result !== "fail" && rfm.result !== "blocked") {
			errors.push(`${rrel}: result \`${rfm.result}\` not pass|fail|blocked`);
		}
		const steps = rfm.steps;
		if (steps && typeof steps === "object" && !Array.isArray(steps)) {
			for (const [sid, res] of Object.entries(steps)) {
				if (typeof res !== "string" || !RESULTS[res]) errors.push(`${rrel}: step ${sid} result \`${res}\` not in ${JSON.stringify(Object.keys(RESULTS).sort())}`);
				if (!stepIds.includes(sid)) errors.push(`${rrel}: unknown step id ${sid}`);
			}
		}
	}
}

export function cmdLint(root: string): { ok: boolean; text: string; errors: string[] } {
	safeJourneyPaths(root);
	const errors: string[] = [];
	const seen: Record<string, string> = {};
	const dirs = journeyDirs(root);
	const lines: string[] = [];
	if (!dirs.length) lines.push(`no journeys found under ${root}`);
	for (const jdir of dirs) lintJourney(jdir, errors, seen);
	for (const err of errors) lines.push(`ERROR ${err}`);
	lines.push(`structural lint: ${dirs.length} journeys, ${errors.length} errors; semantic readiness not assessed`);
	return { ok: errors.length === 0, text: lines.join("\n"), errors };
}

export function cmdPrune(
	root: string,
	keep: number,
	yes: boolean,
	journey?: string,
): { ok: boolean; text: string; doomed: string[] } {
	if (!Number.isSafeInteger(keep) || keep < 0) {
		return { ok: false, text: "keep must be a finite nonnegative safe integer", doomed: [] };
	}
	safeJourneyPaths(root);
	const doomed: string[] = [];
	const dirs = journeyDirs(root);
	const selected = journey === undefined ? dirs : dirs.filter((dir) => basename(dir) === journey);
	if (journey !== undefined && selected.length !== 1) {
		return { ok: false, text: `unknown journey directory: ${journey}`, doomed: [] };
	}
	for (const jdir of selected) {
		const runsDir = join(jdir, "runs");
		if (!existsSync(runsDir)) continue;
		const runs = readdirSync(runsDir)
			.filter((n) => n.endsWith(".md"))
			.sort()
			.map((n) => join(runsDir, n));
		const extra = keep ? runs.slice(0, Math.max(0, runs.length - keep)) : runs;
		doomed.push(...extra);
	}
	const lines: string[] = [];
	for (const path of doomed) {
		const rel = path.slice(root.length).replace(/^\//, "");
		lines.push(`${yes ? "delete" : "would delete"} ${rel}`);
		if (yes) unlinkSync(path);
	}
	lines.push(`prune: ${doomed.length} run files ${yes ? "deleted" : "to delete (use --yes)"}`);
	return { ok: true, text: lines.join("\n"), doomed };
}

export type JourneysIndexParams = {
	command: "index" | "lint" | "prune";
	journeysDir: string;
	keep?: number;
	yes?: boolean;
	journey?: string;
};

export function runJourneys(params: JourneysIndexParams): { ok: boolean; text: string } {
	// Resolve first, then check and operate on that one directory. Passing the raw
	// argument on would let `link/..` be checked as one tree and written as another.
	const root = managedRoot(params.journeysDir);
	if (root === null) return { ok: false, text: `not a directory: ${params.journeysDir}` };
	try {
		safePath(root, root);
		if (!existsSync(root) || !statSync(root).isDirectory()) {
			return { ok: false, text: `not a directory: ${root}` };
		}
	} catch {
		return { ok: false, text: `not a directory: ${root}` };
	}
	try {
		if (params.command === "index") return cmdIndex(root);
		if (params.command === "lint") return cmdLint(root);
		return cmdPrune(root, params.keep ?? 20, Boolean(params.yes), params.journey);
	} catch (err) {
		return { ok: false, text: `ERROR ${err instanceof Error ? err.message : String(err)}` };
	}
}

const FORMULAS_DIR = new URL("../skills/journey-verify/formulas/", import.meta.url).pathname;

export function formulaSources(dir = FORMULAS_DIR): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => n.endsWith(".formula.toml"))
		.sort()
		.map((n) => join(dir, n));
}

export function installFormulas(
	rawRepoRoot: string,
	force = false,
	rawSourcesDir = FORMULAS_DIR,
): { ok: boolean; text: string; copied?: number; unchanged?: number } {
	const repoRoot = managedRoot(rawRepoRoot);
	const sourcesDir = managedRoot(rawSourcesDir);
	if (repoRoot === null) return { ok: false, text: `ERROR not a Beads workspace: ${rawRepoRoot}` };
	if (sourcesDir === null) return { ok: false, text: `ERROR no formula sources: ${rawSourcesDir}` };
	try {
		safePath(repoRoot, repoRoot);
		safePath(sourcesDir, sourcesDir);
		safePath(join(repoRoot, ".beads", "formulas"), repoRoot);
	} catch (err) {
		return { ok: false, text: `ERROR ${err instanceof Error ? err.message : String(err)}` };
	}
	const beadsDir = join(repoRoot, ".beads");
	try {
		if (!existsSync(beadsDir) || !lstatSync(beadsDir).isDirectory()) {
			return { ok: false, text: `ERROR not a Beads workspace: ${repoRoot}` };
		}
	} catch {
		return { ok: false, text: `ERROR not a Beads workspace: ${repoRoot}` };
	}
	const destinationDir = join(beadsDir, "formulas");
	if (existsSync(destinationDir)) {
		const st = lstatSync(destinationDir);
		if (st.isSymbolicLink() || !st.isDirectory()) {
			return { ok: false, text: `ERROR unsafe formula destination: ${destinationDir}` };
		}
	}
	const required = ["journey-step-agentic-verification", "journey-step-human-verification"];
	for (const name of required) {
		const source = join(sourcesDir, `${name}.formula.toml`);
		const st = lstatSync(source, { throwIfNoEntry: false });
		if (!st?.isFile() || st.isSymbolicLink()) {
			return { ok: false, text: `ERROR required formula missing or unsafe: ${source}` };
		}
	}
	const sources = formulaSources(sourcesDir);
	if (!sources.length) {
		return { ok: false, text: `ERROR no formula files found in ${sourcesDir}` };
	}
	const unchanged = new Set<string>();
	const unsafe: string[] = [];
	const conflicts: string[] = [];
	for (const source of sources) {
		const sourceStat = lstatSync(source);
		if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
			return { ok: false, text: `ERROR unsafe formula source: ${source}` };
		}
		const destination = join(destinationDir, basename(source));
		const st = lstatSync(destination, { throwIfNoEntry: false });
		if (st) {
			if (st.isSymbolicLink() || !st.isFile()) {
				unsafe.push(destination);
			} else if (readFileSync(destination).equals(readFileSync(source))) {
				unchanged.add(source);
			} else {
				conflicts.push(destination);
			}
		}
	}
	if (unsafe.length) {
		return { ok: false, text: `ERROR unsafe formula destinations: ${unsafe.join(", ")}` };
	}
	if (conflicts.length && !force) {
		return {
			ok: false,
			text: `ERROR refusing to overwrite divergent formula files: ${conflicts.join(", ")}`,
		};
	}
	mkdirSync(destinationDir, { recursive: true });
	let copied = 0;
	for (const source of sources) {
		if (unchanged.has(source)) continue;
		copyFileSync(source, join(destinationDir, basename(source)));
		copied += 1;
	}
	return {
		ok: true,
		text: `formulas: ${copied} copied, ${unchanged.size} unchanged`,
		copied,
		unchanged: unchanged.size,
	};
}

export default function journeysTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "journeys_index",
		label: "Journey index/lint/prune",
		description: "Index, structurally lint (not semantic readiness), or prune a user-journeys directory. The repo-copied journeys.py provides the same checks.",
		parameters: z.object({
			command: z.enum(["index", "lint", "prune"]),
			journeysDir: z.string().describe("Path to the journeys directory"),
			keep: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe("prune: keep newest N runs (default 20)"),
			yes: z.boolean().optional().describe("prune: actually delete (default dry-run)"),
			journey: z.string().min(1).optional().describe("prune: selected journey directory name; omit only for an explicitly authorized directory-wide prune"),
		}) as unknown as TSchema,
		approval: (toolCall) => {
			const input = typeof toolCall === "object" && toolCall !== null && "input" in toolCall ? toolCall.input : undefined;
			const record = isRecord(input) ? input : {};
			const cmd = typeof record.command === "string" ? record.command : undefined;
			const yes = "yes" in record && Boolean(record.yes);
			if (cmd === "lint") return "read";
			if (cmd === "prune" && !yes) return "read";
			// The bare `exec` tier leaves the decision to the configured approval
			// policy; a literal `policy: "prompt"` would override yolo/write modes.
			return "exec";
		},
		execute: async (_id, params: JourneysIndexParams) => {
			const result = runJourneys(params);
			return { content: [{ type: "text", text: result.text }], details: { ok: result.ok, command: params.command } };
		},
	});

	pi.registerTool({
		name: "journey_install_formulas",
		label: "Install journey formulas",
		description: "Copy package-owned journey formula TOMLs into a Beads workspace .beads/formulas/.",
		parameters: z.object({
			repoRoot: z.string().describe("Repository root containing .beads/"),
			force: z.boolean().optional().describe("Overwrite divergent destination files"),
		}) as unknown as TSchema,
		execute: async (_id, params: { repoRoot: string; force?: boolean }) => {
			const result = installFormulas(params.repoRoot, Boolean(params.force));
			return { content: [{ type: "text", text: result.text }], details: { ok: result.ok, copied: result.copied, unchanged: result.unchanged } };
		},
	});
}
