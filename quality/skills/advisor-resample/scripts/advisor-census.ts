#!/usr/bin/env bun
// Advisor note census and stratified labeling sheet for the advisor-resample skill.
// Reads <agent dir>/sessions/** only. Writes nothing except the labeling sheet under --out.

import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

export const THRESHOLDS = {
	keepStrictPrecision: 0.25,
	maxNoFindingShare: 0.05,
	minLabeledSubstantive: 10,
	dupJaccard: 0.3,
	largeBatch: 10,
} as const;

export const LABELS = ["useful", "partial", "stale", "duplicate", "false-positive", "no-finding"] as const;
export const REACTIONS = ["acted", "dismissed", "never-seen"] as const;
export type Label = (typeof LABELS)[number];
export type Reaction = (typeof REACTIONS)[number];

const LABEL_ALIASES: Record<string, Label> = {
	u: "useful",
	useful: "useful",
	p: "partial",
	partial: "partial",
	st: "stale",
	stale: "stale",
	dup: "duplicate",
	duplicate: "duplicate",
	fp: "false-positive",
	"false-positive": "false-positive",
	n: "no-finding",
	"no-finding": "no-finding",
};
const REACTION_ALIASES: Record<string, Reaction> = {
	a: "acted",
	acted: "acted",
	d: "dismissed",
	dismissed: "dismissed",
	ns: "never-seen",
	never: "never-seen",
	"never-seen": "never-seen",
};

// ---------------------------------------------------------------------------
// Classifiers

const NONE_VALUE = /^(?:none(?!\s+of\b)|nothing|n\/a)\b/i;
const NO_X_VALUE = /^no\s+(?:[\w/-]+\s+){0,3}?(?:defects?|findings?|issues?|problems?|concerns?|actions?)\b/i;
const NO_X_PREFIX = /^no\s+(?:[\w/-]+\s+){0,3}?(?:findings?|defects?|concerns?|issues?)\b/i;
const CONTENT_FREE: Record<string, true> = {
	silence: true,
	lgtm: true,
	"no issues": true,
	"looks good": true,
	"nothing to report": true,
};

function stripMarkup(text: string): string {
	return text.replace(/^[\s*_`>]+/, "").trim();
}

/** The DEFECT field value, or undefined when the note has no DEFECT field. */
export function defectValue(note: string): string | undefined {
	const match = /\bDEFECT:\s*([\s\S]*?)(?=\b(?:EVIDENCE|BREAKS|FIX):|$)/.exec(note);
	return match ? stripMarkup(match[1] ?? "") : undefined;
}

/**
 * True when a note carries no finding: its DEFECT is none/—/empty/"no … defect",
 * it opens with "No finding" (or "No <topic> concern"), or it is a content-free
 * placeholder such as `EVIDENCE: ...`.
 */
export function isNoFinding(note: string): boolean {
	const text = stripMarkup(note);
	if (Object.hasOwn(CONTENT_FREE, text.toLowerCase().replace(/[.!\s]+$/, ""))) return true;
	if (NO_X_PREFIX.test(text)) return true;
	if (text.replace(/\b(?:EVIDENCE|DEFECT|BREAKS|FIX):/g, "").replace(/[\s.…—–-]/g, "") === "") return true;
	const defect = defectValue(text);
	if (defect === undefined) return false;
	if (/^[\s.…—–-]*$/.test(defect)) return true;
	return NONE_VALUE.test(defect) || NO_X_VALUE.test(defect);
}

const STOP_WORDS: Record<string, true> = {
	evidence: true,
	defect: true,
	breaks: true,
	fix: true,
	the: true,
	and: true,
	none: true,
	this: true,
	that: true,
	for: true,
	with: true,
	not: true,
};

export function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (word.length > 2 && !Object.hasOwn(STOP_WORDS, word)) out.add(word);
	}
	return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared);
}

/** For each text in delivery order, the highest Jaccard similarity to any earlier text. */
export function dupScores(texts: readonly string[]): number[] {
	const seen: Set<string>[] = [];
	const scores: number[] = [];
	for (const text of texts) {
		const current = tokens(text);
		let best = 0;
		for (const earlier of seen) best = Math.max(best, jaccard(current, earlier));
		scores.push(best);
		seen.push(current);
	}
	return scores;
}

// ---------------------------------------------------------------------------
// Transcript parsing

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function parseLine(line: string | undefined): Json | undefined {
	if (!line) return undefined;
	try {
		return asObject(JSON.parse(line));
	} catch {
		return undefined;
	}
}

export interface Window {
	since?: number;
	until?: number;
}

function inWindow(timestamp: string | undefined, window: Window): boolean {
	if (window.since === undefined && window.until === undefined) return true;
	const time = timestamp ? Date.parse(timestamp) : Number.NaN;
	if (Number.isNaN(time)) return false;
	return (window.since === undefined || time >= window.since) && (window.until === undefined || time < window.until);
}

export interface RawNote {
	advisor: string;
	severity: string;
	turnsAgo: number;
	text: string;
}

function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Notes of one `customType: "advisor"` delivery: `details.notes[]`, else the `<advisory>` blocks in `content`. */
export function deliveryNotes(entry: Json): RawNote[] {
	const details = asObject(entry.details);
	if (Array.isArray(details?.notes)) {
		return details.notes.flatMap(item => {
			const note = asObject(item);
			if (!note) return [];
			return [
				{
					advisor: asString(note.advisor) ?? "default",
					severity: asString(note.severity) ?? "nit",
					turnsAgo: asNumber(note.turnsAgo) ?? 0,
					text: asString(note.note) ?? "",
				},
			];
		});
	}
	const content = asString(entry.content) ?? "";
	const notes: RawNote[] = [];
	for (const block of content.matchAll(/<advisory\b([^>]*)>([\s\S]*?)<\/advisory>/g)) {
		const attrs = block[1] ?? "";
		const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
		notes.push({
			advisor: attr("advisor") ?? "default",
			severity: attr("severity") ?? "nit",
			turnsAgo: Number(attr("turns_ago") ?? 0) || 0,
			text: unescapeXml((block[2] ?? "").trim()),
		});
	}
	return notes;
}

function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function summarizeMessage(message: Json, limit = 400): string {
	const role = asString(message.role) ?? "?";
	const parts: string[] = [];
	const content = message.content;
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const item of content) {
			const block = asObject(item);
			if (!block) continue;
			if (block.type === "text") parts.push(asString(block.text) ?? "");
			else if (block.type === "thinking") parts.push(`(thinking) ${asString(block.thinking) ?? ""}`);
			else if (block.type === "toolCall") {
				const args = asObject(block.arguments) ?? {};
				const arg = asString(args.command) ?? asString(args.path) ?? asString(args.pattern) ?? asString(args.i);
				parts.push(`→ ${asString(block.name) ?? "tool"}(${oneLine(arg ?? JSON.stringify(args), 160)})`);
			}
		}
	}
	return `[${role}] ${oneLine(parts.filter(part => part.trim()).join(" | "), limit)}`;
}

export interface Note extends RawNote {
	id: string;
	file: string;
	line: number;
	position: number;
	timestamp: string;
	batch: number;
	header: boolean;
	noFinding: boolean;
	dupScore: number;
	noFurtherTurn: boolean;
	before: string;
	next: string[];
}

const DELIVERY_MARKER = '"customType":"advisor"';
const STALE_HEADER = "The following is an aggregated review";

function walk(dir: string, out: string[] = []): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

/** Following primary turn: messages after the delivery until the first assistant/user message pair is collected. */
function followUp(lines: string[], from: number): { noFurtherTurn: boolean; next: string[] } {
	const next: string[] = [];
	let noFurtherTurn = true;
	let decided = false;
	for (let index = from + 1; index < lines.length && next.length < 2; index++) {
		const line = lines[index] ?? "";
		if (!line.includes('"type":"message"')) continue;
		const message = asObject(parseLine(line)?.message);
		const role = asString(message?.role);
		if (!message || (role !== "assistant" && role !== "user")) continue;
		if (!decided) {
			noFurtherTurn = role === "user";
			decided = true;
		}
		next.push(summarizeMessage(message, 600));
	}
	return { noFurtherTurn, next };
}

function lastUserMessage(lines: string[], from: number): string {
	for (let index = from - 1; index >= 0; index--) {
		const line = lines[index] ?? "";
		if (!line.includes('"role":"user"')) continue;
		const message = asObject(parseLine(line)?.message);
		if (message?.role === "user") return summarizeMessage(message, 300);
	}
	return "";
}

export function collectNotes(sessionsDir: string, window: Window): { files: number; deliveryFiles: number; notes: Note[] } {
	const files = walk(sessionsDir).filter(path => !basename(path).startsWith("__advisor"));
	const notes: Note[] = [];
	let deliveryFiles = 0;
	for (const path of files.sort()) {
		const text = readFileSync(path, "utf8");
		if (!text.includes(DELIVERY_MARKER)) continue;
		const lines = text.split("\n");
		let found = false;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? "";
			if (!line.includes(DELIVERY_MARKER)) continue;
			const entry = parseLine(line);
			if (entry?.type !== "custom_message" || entry.customType !== "advisor") continue;
			const timestamp = asString(entry.timestamp) ?? "";
			if (!inWindow(timestamp, window)) continue;
			const raw = deliveryNotes(entry);
			if (raw.length === 0) continue;
			found = true;
			const { noFurtherTurn, next } = followUp(lines, index);
			const before = lastUserMessage(lines, index);
			const header = (asString(entry.content) ?? "").startsWith(STALE_HEADER);
			raw.forEach((note, position) => {
				notes.push({
					...note,
					id: "",
					file: relative(sessionsDir, path),
					line: index + 1,
					position,
					timestamp,
					batch: raw.length,
					header,
					noFinding: isNoFinding(note.text),
					dupScore: 0,
					noFurtherTurn,
					before,
					next,
				});
			});
		}
		if (found) deliveryFiles++;
	}
	const groups = new Map<string, Note[]>();
	for (const note of notes) {
		const key = `${note.file}\u0000${note.advisor}`;
		const group = groups.get(key) ?? [];
		group.push(note);
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		const scores = dupScores(group.map(note => note.text));
		group.forEach((note, index) => {
			note.dupScore = Math.round((scores[index] ?? 0) * 100) / 100;
		});
	}
	notes.forEach((note, index) => {
		note.id = `N${index + 1}`;
	});
	return { files: files.length, deliveryFiles, notes };
}

export interface TranscriptStats {
	slug: string;
	files: number;
	reviews: number;
	tokens: number;
	cost: number;
	adviseCalls: number;
	severity: Record<string, number>;
	noFindingCalls: number;
	acks: Record<"queued" | "delivered" | "duplicate" | "empty" | "invalid" | "other", number>;
}

export function ackKind(text: string, isError: boolean): keyof TranscriptStats["acks"] {
	if (isError || text.startsWith("Validation failed")) return "invalid";
	if (text.startsWith("Queued")) return "queued";
	if (text.startsWith("Delivered")) return "delivered";
	if (text.startsWith("Dropped: already raised")) return "duplicate";
	if (text.startsWith("Dropped: empty")) return "empty";
	return "other";
}

export function collectTranscripts(sessionsDir: string, window: Window): Map<string, TranscriptStats> {
	const stats = new Map<string, TranscriptStats>();
	for (const path of walk(sessionsDir).sort()) {
		const name = basename(path);
		if (!name.startsWith("__advisor")) continue;
		const slug = name.replace(/^__advisor\.?/, "").replace(/\.jsonl$/, "") || "default";
		const row = stats.get(slug) ?? {
			slug,
			files: 0,
			reviews: 0,
			tokens: 0,
			cost: 0,
			adviseCalls: 0,
			severity: {},
			noFindingCalls: 0,
			acks: { queued: 0, delivered: 0, duplicate: 0, empty: 0, invalid: 0, other: 0 },
		};
		let counted = false;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const entry = parseLine(line);
			if (entry?.type !== "message" || !inWindow(asString(entry.timestamp), window)) continue;
			const message = asObject(entry.message);
			if (!message) continue;
			counted = true;
			if (message.role === "user") row.reviews++;
			else if (message.role === "assistant") {
				const usage = asObject(message.usage);
				row.tokens += asNumber(usage?.totalTokens) ?? 0;
				row.cost += asNumber(asObject(usage?.cost)?.total) ?? 0;
				for (const item of Array.isArray(message.content) ? message.content : []) {
					const block = asObject(item);
					if (block?.type !== "toolCall" || block.name !== "advise") continue;
					const args = asObject(block.arguments) ?? {};
					row.adviseCalls++;
					const severity = asString(args.severity) ?? "nit";
					row.severity[severity] = (row.severity[severity] ?? 0) + 1;
					if (isNoFinding(asString(args.note) ?? "")) row.noFindingCalls++;
				}
			} else if (message.role === "toolResult" && message.toolName === "advise") {
				const text = (Array.isArray(message.content) ? message.content : [])
					.map(item => asString(asObject(item)?.text) ?? "")
					.join(" ");
				row.acks[ackKind(text, message.isError === true)]++;
			}
		}
		if (counted) row.files++;
		stats.set(slug, row);
	}
	return stats;
}

// ---------------------------------------------------------------------------
// Sampling

export function stratumOf(note: Pick<Note, "advisor" | "severity" | "noFinding">): string {
	return `${note.advisor}/${note.severity}/${note.noFinding ? "no-finding" : "finding"}`;
}

/**
 * Allocate `size` sample slots across strata. Every stratum gets one slot;
 * no-finding strata stay at one (a classifier spot check). Next, each advisor's
 * finding strata are raised round-robin to `minLabeledSubstantive` slots (or
 * their whole population) so every advisor can reach a precision verdict; the
 * rest goes to finding strata by largest population per slot. Slots never
 * exceed population.
 */
export function allocate(populations: ReadonlyMap<string, number>, size: number): Map<string, number> {
	const keys = [...populations.keys()].sort((a, b) => (populations.get(b) ?? 0) - (populations.get(a) ?? 0) || a.localeCompare(b));
	const slots = new Map<string, number>(keys.map(key => [key, 0]));
	let left = size;
	for (const key of keys) {
		if (left === 0) break;
		if ((populations.get(key) ?? 0) > 0) {
			slots.set(key, 1);
			left--;
		}
	}
	const take = (eligible: readonly string[]): boolean => {
		let best: string | undefined;
		let bestScore = 0;
		for (const key of eligible) {
			const pop = populations.get(key) ?? 0;
			const taken = slots.get(key) ?? 0;
			if (taken >= pop) continue;
			const score = pop / (taken + 1);
			if (score > bestScore) {
				best = key;
				bestScore = score;
			}
		}
		if (!best || left === 0) return false;
		slots.set(best, (slots.get(best) ?? 0) + 1);
		left--;
		return true;
	};
	const findingKeys = keys.filter(key => !key.endsWith("/no-finding"));
	const byAdvisor = new Map<string, { keys: string[]; population: number }>();
	for (const key of findingKeys) {
		const advisor = key.split("/").slice(0, -2).join("/");
		const group = byAdvisor.get(advisor) ?? { keys: [], population: 0 };
		group.keys.push(key);
		group.population += populations.get(key) ?? 0;
		byAdvisor.set(advisor, group);
	}
	for (let progress = true; progress && left > 0; ) {
		progress = false;
		for (const group of byAdvisor.values()) {
			const taken = group.keys.reduce((total, key) => total + (slots.get(key) ?? 0), 0);
			if (taken >= Math.min(THRESHOLDS.minLabeledSubstantive, group.population)) continue;
			if (take(group.keys)) progress = true;
		}
	}
	while (take(findingKeys));
	while (take(keys));
	return slots;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function stratifiedSample(notes: readonly Note[], size: number, seed: number): Note[] {
	const byStratum = new Map<string, Note[]>();
	for (const note of notes) {
		const key = stratumOf(note);
		const list = byStratum.get(key) ?? [];
		list.push(note);
		byStratum.set(key, list);
	}
	const slots = allocate(new Map([...byStratum].map(([key, list]) => [key, list.length])), size);
	const random = mulberry32(seed);
	const sample: Note[] = [];
	for (const key of [...byStratum.keys()].sort()) {
		const list = [...(byStratum.get(key) ?? [])];
		for (let index = list.length - 1; index > 0; index--) {
			const other = Math.floor(random() * (index + 1));
			const swap = list[index] as Note;
			list[index] = list[other] as Note;
			list[other] = swap;
		}
		sample.push(...list.slice(0, slots.get(key) ?? 0));
	}
	return sample.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.position - b.position);
}

// ---------------------------------------------------------------------------
// Labeling sheet

const SHEET_COLUMNS = [
	"id",
	"advisor",
	"severity",
	"stratum",
	"stratum_population",
	"no_finding_auto",
	"dup_score",
	"turns_ago",
	"batch",
	"no_further_turn",
	"timestamp",
	"location",
	"note",
	"last_user",
	"next_1",
	"next_2",
	"label",
	"reaction",
	"comment",
] as const;

function csvCell(value: string | number | boolean): string {
	const text = String(value);
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				cell += '"';
				index++;
			} else if (char === '"') quoted = false;
			else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(cell);
			cell = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += char;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter(cells => cells.some(value => value !== ""));
}

function sheetRow(note: Note, populations: ReadonlyMap<string, number>): Record<(typeof SHEET_COLUMNS)[number], string | number | boolean> {
	const stratum = stratumOf(note);
	return {
		id: note.id,
		advisor: note.advisor,
		severity: note.severity,
		stratum,
		stratum_population: populations.get(stratum) ?? 0,
		no_finding_auto: note.noFinding,
		dup_score: note.dupScore,
		turns_ago: note.turnsAgo,
		batch: note.batch,
		no_further_turn: note.noFurtherTurn,
		timestamp: note.timestamp,
		location: `${note.file}:${note.line}#${note.position}`,
		note: note.text,
		last_user: note.before,
		next_1: note.next[0] ?? "",
		next_2: note.next[1] ?? "",
		label: "",
		reaction: "",
		comment: "",
	};
}

export function renderSheetCsv(sample: readonly Note[], populations: ReadonlyMap<string, number>): string {
	const lines = [SHEET_COLUMNS.join(",")];
	for (const note of sample) {
		const row = sheetRow(note, populations);
		lines.push(SHEET_COLUMNS.map(column => csvCell(row[column])).join(","));
	}
	return `${lines.join("\n")}\n`;
}

function renderSheetMarkdown(sample: readonly Note[], populations: ReadonlyMap<string, number>): string {
	const out = [
		"# Advisor labeling sheet",
		"",
		`Label in the CSV twin. label: ${LABELS.join(" | ")} (or U P ST DUP FP N). reaction: ${REACTIONS.join(" | ")} (or A D NS).`,
		"",
	];
	for (const note of sample) {
		const row = sheetRow(note, populations);
		out.push(
			`## ${note.id} ${note.advisor}/${note.severity} · turns_ago ${note.turnsAgo} · batch ${note.batch} · dup ${note.dupScore} · auto no-finding ${note.noFinding}`,
			"",
			`- location: \`${row.location}\` (${note.timestamp}); stratum \`${row.stratum}\` of ${row.stratum_population}`,
			`- last user: ${note.before || "—"}`,
			"",
			...note.text.split("\n").map(line => `> ${line}`),
			"",
			...(note.next.length ? note.next.map((line, index) => `- next ${index + 1}: ${line}`) : ["- next: (no later primary message)"]),
			"",
		);
	}
	return out.join("\n");
}

export interface LabeledRow {
	advisor: string;
	stratum: string;
	population: number;
	label: Label;
	reaction?: Reaction;
}

export function readLabels(text: string): LabeledRow[] {
	const [header, ...rows] = parseCsv(text);
	if (!header) return [];
	const column = (name: string) => header.indexOf(name);
	const at = (cells: string[], name: string) => (cells[column(name)] ?? "").trim();
	const labeled: LabeledRow[] = [];
	for (const cells of rows) {
		const label = LABEL_ALIASES[at(cells, "label").toLowerCase()];
		if (!label) continue;
		labeled.push({
			advisor: at(cells, "advisor"),
			stratum: at(cells, "stratum"),
			population: Number(at(cells, "stratum_population")) || 1,
			label,
			reaction: REACTION_ALIASES[at(cells, "reaction").toLowerCase()],
		});
	}
	return labeled;
}

export interface Precision {
	labeled: number;
	substantive: number;
	counts: Record<Label, number>;
	reactions: Record<Reaction, number>;
	strict?: number;
	inclusive?: number;
	weightedStrict?: number;
	falsePositiveShare?: number;
}

/** Strict = useful/(n−no-finding); inclusive adds partial; weighted reweights each stratum by its population. */
export function precision(rows: readonly LabeledRow[]): Precision {
	const counts = Object.fromEntries(LABELS.map(label => [label, 0])) as Record<Label, number>;
	const reactions = Object.fromEntries(REACTIONS.map(reaction => [reaction, 0])) as Record<Reaction, number>;
	const strata = new Map<string, { population: number; n: number; useful: number; none: number }>();
	for (const row of rows) {
		counts[row.label]++;
		if (row.reaction) reactions[row.reaction]++;
		const stratum = strata.get(row.stratum) ?? { population: row.population, n: 0, useful: 0, none: 0 };
		stratum.n++;
		if (row.label === "useful") stratum.useful++;
		if (row.label === "no-finding") stratum.none++;
		strata.set(row.stratum, stratum);
	}
	const substantive = rows.length - counts["no-finding"];
	const result: Precision = { labeled: rows.length, substantive, counts, reactions };
	if (substantive > 0) {
		result.strict = counts.useful / substantive;
		result.inclusive = (counts.useful + counts.partial) / substantive;
		result.falsePositiveShare = counts["false-positive"] / substantive;
		let usefulWeight = 0;
		let substantiveWeight = 0;
		for (const stratum of strata.values()) {
			usefulWeight += (stratum.population * stratum.useful) / stratum.n;
			substantiveWeight += (stratum.population * (stratum.n - stratum.none)) / stratum.n;
		}
		result.weightedStrict = substantiveWeight > 0 ? usefulWeight / substantiveWeight : undefined;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Report

function quantile(sorted: readonly number[], q: number): number {
	return sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) : 0;
}
function pct(part: number, whole: number): string {
	return whole ? `${Math.round((100 * part) / whole)}%` : "—";
}
function ratio(value: number | undefined): string {
	return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

export interface AdvisorRow {
	advisor: string;
	notes: number;
	severity: Record<string, number>;
	noFinding: number;
	turnsAgo: { p50: number; p90: number; max: number };
	inLargeBatch: number;
	largestBatch: number;
	noFurtherTurn: number;
	duplicate: number;
	duplicateSubstantive: number;
	transcript?: TranscriptStats;
	precision?: Precision;
	noFindingVerdict: "PASS" | "FAIL" | "NO-DATA";
	precisionVerdict: "KEEP" | "RETIRE-CANDIDATE" | "INSUFFICIENT" | "UNLABELED";
}

export function advisorRows(notes: readonly Note[], transcripts: ReadonlyMap<string, TranscriptStats>, labels?: readonly LabeledRow[]): AdvisorRow[] {
	const names = new Set(notes.map(note => note.advisor));
	const bySlug = new Map([...transcripts].map(([slug, stats]) => [slug.toLowerCase(), stats]));
	for (const slug of bySlug.keys()) if (![...names].some(name => name.toLowerCase() === slug)) names.add(slug);
	return [...names].sort().map(advisor => {
		const own = notes.filter(note => note.advisor === advisor);
		const turns = own.map(note => note.turnsAgo).sort((a, b) => a - b);
		const severity: Record<string, number> = {};
		for (const note of own) severity[note.severity] = (severity[note.severity] ?? 0) + 1;
		const transcript = bySlug.get(advisor.toLowerCase());
		const noFinding = own.filter(note => note.noFinding).length;
		const callShare = transcript?.adviseCalls ? transcript.noFindingCalls / transcript.adviseCalls : undefined;
		const deliveredShare = own.length ? noFinding / own.length : undefined;
		const shares = [deliveredShare, callShare].filter((share): share is number => share !== undefined);
		const ownLabels = labels?.filter(row => row.advisor === advisor);
		const measured = ownLabels?.length ? precision(ownLabels) : undefined;
		let precisionVerdict: AdvisorRow["precisionVerdict"] = "UNLABELED";
		if (measured) {
			if (measured.substantive < THRESHOLDS.minLabeledSubstantive || measured.weightedStrict === undefined) precisionVerdict = "INSUFFICIENT";
			else precisionVerdict = measured.weightedStrict >= THRESHOLDS.keepStrictPrecision ? "KEEP" : "RETIRE-CANDIDATE";
		}
		return {
			advisor,
			notes: own.length,
			severity,
			noFinding,
			turnsAgo: { p50: quantile(turns, 0.5), p90: quantile(turns, 0.9), max: turns.at(-1) ?? 0 },
			inLargeBatch: own.filter(note => note.batch >= THRESHOLDS.largeBatch).length,
			largestBatch: Math.max(0, ...own.map(note => note.batch)),
			noFurtherTurn: own.filter(note => note.noFurtherTurn).length,
			duplicate: own.filter(note => note.dupScore >= THRESHOLDS.dupJaccard).length,
			duplicateSubstantive: own.filter(note => !note.noFinding && note.dupScore >= THRESHOLDS.dupJaccard).length,
			transcript,
			precision: measured,
			noFindingVerdict: shares.length === 0 ? "NO-DATA" : shares.every(share => share <= THRESHOLDS.maxNoFindingShare) ? "PASS" : "FAIL",
			precisionVerdict,
		};
	});
}

function severityMix(counts: Record<string, number>): string {
	return ["nit", "concern", "blocker"].map(key => counts[key] ?? 0).join("/");
}

export interface Report {
	sessionsDir: string;
	window: { since?: string; until?: string };
	files: number;
	deliveryFiles: number;
	deliveries: number;
	notes: number;
	batch: { p50: number; p90: number; max: number; withHeader: number };
	advisors: AdvisorRow[];
	sheet?: { csv: string; markdown: string; size: number; strata: Record<string, number> };
}

export function renderReport(report: Report): string {
	const out: string[] = [];
	const span = `${report.window.since ?? "start"} .. ${report.window.until ?? "now"}`;
	out.push(`# Advisor census (${span})`, "");
	out.push(
		`${report.sessionsDir}: ${report.files} transcripts scanned, ${report.deliveryFiles} with deliveries, ${report.deliveries} delivery messages, ${report.notes} notes.`,
		`Delivery batch size p50 ${report.batch.p50} / p90 ${report.batch.p90} / max ${report.batch.max}; staleness header on ${report.batch.withHeader} of ${report.deliveries}.`,
		"",
		"## Delivered notes",
		"",
		"| Advisor | Notes | nit/concern/blocker | No-finding | turns_ago p50/p90/max | In batch ≥10 | Largest batch | No further turn | Duplicate (J≥0.3) all / substantive |",
		"|---|---|---|---|---|---|---|---|---|",
	);
	for (const row of report.advisors) {
		out.push(
			`| ${row.advisor} | ${row.notes} | ${severityMix(row.severity)} | ${row.noFinding} (${pct(row.noFinding, row.notes)}) | ${row.turnsAgo.p50}/${row.turnsAgo.p90}/${row.turnsAgo.max} | ${row.inLargeBatch} (${pct(row.inLargeBatch, row.notes)}) | ${row.largestBatch} | ${row.noFurtherTurn} (${pct(row.noFurtherTurn, row.notes)}) | ${row.duplicate} (${pct(row.duplicate, row.notes)}) / ${row.duplicateSubstantive} (${pct(row.duplicateSubstantive, row.notes - row.noFinding)}) |`,
		);
	}
	out.push(
		"",
		"## Advisor transcripts (`__advisor.<slug>.jsonl`)",
		"",
		"| Advisor | Files | Reviews | advise calls | nit/concern/blocker | No-finding calls | queued/delivered/duplicate/empty/invalid | Tokens | Cost |",
		"|---|---|---|---|---|---|---|---|---|",
	);
	for (const row of report.advisors) {
		const t = row.transcript;
		if (!t) continue;
		const acks = t.acks;
		out.push(
			`| ${row.advisor} | ${t.files} | ${t.reviews} | ${t.adviseCalls} | ${severityMix(t.severity)} | ${t.noFindingCalls} (${pct(t.noFindingCalls, t.adviseCalls)}) | ${acks.queued}/${acks.delivered}/${acks.duplicate}/${acks.empty}/${acks.invalid}${acks.other ? ` (+${acks.other} other)` : ""} | ${t.tokens.toLocaleString("en-US")} | $${t.cost.toFixed(3)} |`,
		);
	}
	out.push(
		"",
		"## Thresholds",
		"",
		`Keep an advisor at weighted strict substantive precision ≥ ${ratio(THRESHOLDS.keepStrictPrecision)} (needs ≥ ${THRESHOLDS.minLabeledSubstantive} labeled substantive notes); no-finding share ≤ ${ratio(THRESHOLDS.maxNoFindingShare)} of delivered notes and of advise calls.`,
		"",
		"| Advisor | No-finding delivered | No-finding calls | No-finding verdict | Labeled (substantive) | Strict | Weighted strict | Inclusive | FP share | acted/dismissed/never-seen | Precision verdict |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	);
	for (const row of report.advisors) {
		const p = row.precision;
		const t = row.transcript;
		out.push(
			`| ${row.advisor} | ${pct(row.noFinding, row.notes)} | ${t ? pct(t.noFindingCalls, t.adviseCalls) : "—"} | ${row.noFindingVerdict} | ${p ? `${p.labeled} (${p.substantive})` : "—"} | ${ratio(p?.strict)} | ${ratio(p?.weightedStrict)} | ${ratio(p?.inclusive)} | ${ratio(p?.falsePositiveShare)} | ${p ? `${p.reactions.acted}/${p.reactions.dismissed}/${p.reactions["never-seen"]}` : "—"} | ${row.precisionVerdict} |`,
		);
	}
	if (report.sheet) {
		const strata = Object.entries(report.sheet.strata)
			.map(([key, count]) => `${key}=${count}`)
			.join(", ");
		out.push("", "## Labeling sheet", "", `${report.sheet.size} notes (${strata})`, `- CSV: ${report.sheet.csv}`, `- Markdown: ${report.sheet.markdown}`);
	}
	return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: bun advisor-census.ts [options]
  --agent-dir DIR   agent dir whose sessions/ is scanned (default ~/.omp/agent)
  --sessions DIR    sessions dir override (default <agent dir>/sessions)
  --since DATE      include deliveries at or after DATE (ISO date or timestamp)
  --until DATE      include deliveries before DATE
  --days N          shorthand for --since <now - N days>
  --sample N        labeling sheet size (default 30; 0 skips the sheet)
  --seed N          sampling seed (default 1)
  --out DIR         sheet directory (default $TMPDIR/advisor-resample-<date>)
  --labels FILE     labeled CSV sheet; adds precision and verdicts
  --json            print the report as JSON`;

interface Options {
	sessionsDir: string;
	window: Window;
	windowText: { since?: string; until?: string };
	sample: number;
	seed: number;
	out: string;
	labels?: string;
	json: boolean;
}

function fail(message: string): never {
	console.error(`advisor-census: ${message}\n${USAGE}`);
	process.exit(2);
}

function parseDate(flag: string, value: string | undefined): number {
	const time = value ? Date.parse(value) : Number.NaN;
	if (Number.isNaN(time)) fail(`${flag} needs a date, got ${value ?? "nothing"}`);
	return time;
}

export function parseArgs(argv: readonly string[], now = Date.now()): Options {
	let agentDir = join(homedir(), ".omp", "agent");
	let sessionsDir: string | undefined;
	const window: Window = {};
	let sample = 30;
	let seed = 1;
	let out: string | undefined;
	let labels: string | undefined;
	let json = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => argv[++index] ?? fail(`${flag} needs a value`);
		const integer = () => {
			const parsed = Number(value());
			if (!Number.isInteger(parsed) || parsed < 0) fail(`${flag} needs a non-negative integer`);
			return parsed;
		};
		switch (flag) {
			case "--agent-dir":
				agentDir = value();
				break;
			case "--sessions":
				sessionsDir = value();
				break;
			case "--since":
				window.since = parseDate(flag, value());
				break;
			case "--until":
				window.until = parseDate(flag, value());
				break;
			case "--days":
				window.since = now - integer() * 86_400_000;
				break;
			case "--sample":
				sample = integer();
				break;
			case "--seed":
				seed = integer();
				break;
			case "--out":
				out = value();
				break;
			case "--labels":
				labels = value();
				break;
			case "--json":
				json = true;
				break;
			case "--help":
			case "-h":
				console.log(USAGE);
				return process.exit(0);
			default:
				fail(`unknown argument ${flag}`);
		}
	}
	const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
	return {
		sessionsDir: sessionsDir ?? join(agentDir, "sessions"),
		window,
		windowText: {
			since: window.since === undefined ? undefined : new Date(window.since).toISOString(),
			until: window.until === undefined ? undefined : new Date(window.until).toISOString(),
		},
		sample,
		seed,
		out: out ?? join(tmpdir(), `advisor-resample-${stamp}`),
		labels,
		json,
	};
}

export function main(argv: readonly string[]): void {
	const options = parseArgs(argv);
	if (!existsSync(options.sessionsDir)) fail(`sessions dir not found: ${options.sessionsDir}`);
	const { files, deliveryFiles, notes } = collectNotes(options.sessionsDir, options.window);
	const transcripts = collectTranscripts(options.sessionsDir, options.window);
	const labels = options.labels ? readLabels(readFileSync(options.labels, "utf8")) : undefined;
	const deliveries = new Map<string, Note>();
	for (const note of notes) deliveries.set(`${note.file}:${note.line}`, note);
	const sizes = [...deliveries.values()].map(note => note.batch).sort((a, b) => a - b);
	const report: Report = {
		sessionsDir: options.sessionsDir,
		window: options.windowText,
		files,
		deliveryFiles,
		deliveries: deliveries.size,
		notes: notes.length,
		batch: {
			p50: quantile(sizes, 0.5),
			p90: quantile(sizes, 0.9),
			max: sizes.at(-1) ?? 0,
			withHeader: [...deliveries.values()].filter(note => note.header).length,
		},
		advisors: advisorRows(notes, transcripts, labels),
	};
	if (options.sample > 0 && notes.length > 0) {
		const populations = new Map<string, number>();
		for (const note of notes) populations.set(stratumOf(note), (populations.get(stratumOf(note)) ?? 0) + 1);
		const sample = stratifiedSample(notes, options.sample, options.seed);
		mkdirSync(options.out, { recursive: true });
		const csv = join(options.out, "labels.csv");
		const markdown = join(options.out, "labels.md");
		writeFileSync(csv, renderSheetCsv(sample, populations));
		writeFileSync(markdown, renderSheetMarkdown(sample, populations));
		const strata: Record<string, number> = {};
		for (const note of sample) strata[stratumOf(note)] = (strata[stratumOf(note)] ?? 0) + 1;
		report.sheet = { csv, markdown, size: sample.length, strata };
	}
	process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
}

if (import.meta.main) main(process.argv.slice(2));
