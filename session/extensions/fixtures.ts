/**
 * Fixture builders for session-store tests.
 *
 * Real transcripts are private, so tests synthesize their own. Every record
 * shape here was derived from the live store and is documented in
 * ../skills/resume-session/references/transcript-format.md; if the harness
 * changes a shape, these builders are the single place to update.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let counter = 0;
const nextId = () => `id${(counter += 1).toString(16).padStart(4, "0")}`;

export interface FixtureTool {
	name: string;
	args?: Record<string, unknown>;
	intent?: string;
	result?: string;
	isError?: boolean;
}

export type FixtureEntry =
	| { kind: "user"; text: string; at?: string }
	| { kind: "assistant"; text?: string; thinking?: string; tools?: FixtureTool[]; at?: string }
	| { kind: "todo"; phases: { name: string; tasks: { content: string; status: string }[] }[]; at?: string }
	| { kind: "compaction"; shortSummary: string; at?: string }
	| { kind: "exit"; reason: string; exitKind: string; at?: string };

export interface FixtureSession {
	/** `<timestamp>_<uuid>` — the store's filename stem. */
	stem: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
	startedAt?: string;
	previousSessionFiles?: string[];
	entries: FixtureEntry[];
}

/** Serialize one session to the store's compact one-record-per-line form. */
export function renderSession(session: FixtureSession): string {
	const uuid = session.stem.split("_").slice(1).join("_") || session.stem;
	const lines: string[] = [
		JSON.stringify({
			type: "title",
			v: 1,
			title: session.title ?? "",
			source: "auto",
			updatedAt: session.updatedAt ?? "2026-08-24T12:00:00.000Z",
			pad: " ".repeat(64),
		}),
		JSON.stringify({
			type: "session",
			version: 3,
			id: uuid,
			timestamp: session.startedAt ?? "2026-08-24T10:00:00.000Z",
			cwd: session.cwd,
			...(session.previousSessionFiles ? { previousSessionFiles: session.previousSessionFiles } : {}),
		}),
	];

	session.entries.forEach((entry, index) => {
		const timestamp = entry.at ?? `2026-08-24T1${Math.min(index, 9)}:00:0${index % 10}.000Z`;
		if (entry.kind === "user") {
			lines.push(
				JSON.stringify({
					type: "message",
					id: nextId(),
					parentId: null,
					timestamp,
					message: { role: "user", timestamp, content: [{ type: "text", text: entry.text }] },
				}),
			);
			return;
		}
		if (entry.kind === "compaction") {
			lines.push(
				JSON.stringify({
					type: "compaction",
					id: nextId(),
					parentId: null,
					timestamp,
					method: "auto",
					shortSummary: entry.shortSummary,
					summary: entry.shortSummary,
					tokensBefore: 100_000,
					tokensAfter: 20_000,
				}),
			);
			return;
		}
		if (entry.kind === "exit") {
			lines.push(
				JSON.stringify({
					type: "custom",
					customType: "session_exit",
					id: nextId(),
					parentId: null,
					timestamp,
					data: { reason: entry.reason, kind: entry.exitKind, recordedAt: timestamp },
				}),
			);
			return;
		}
		if (entry.kind === "todo") {
			const callId = `tool_${nextId()}`;
			lines.push(
				JSON.stringify({
					type: "message",
					id: nextId(),
					parentId: null,
					timestamp,
					message: {
						role: "assistant",
						timestamp,
						content: [{ type: "toolCall", id: callId, name: "todo", arguments: { i: "board", op: "done" } }],
					},
				}),
				JSON.stringify({
					type: "message",
					id: nextId(),
					parentId: null,
					timestamp,
					message: {
						role: "toolResult",
						toolCallId: callId,
						toolName: "todo",
						isError: false,
						timestamp,
						content: [{ type: "text", text: "board updated" }],
						details: { op: "done", phases: entry.phases, storage: "session" },
					},
				}),
			);
			return;
		}

		const content: Record<string, unknown>[] = [];
		if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking, thinkingSignature: "sig" });
		if (entry.text) content.push({ type: "text", text: entry.text });
		const results: string[] = [];
		for (const tool of entry.tools ?? []) {
			const callId = `tool_${nextId()}`;
			content.push({
				type: "toolCall",
				id: callId,
				name: tool.name,
				arguments: tool.args ?? {},
				...(tool.intent ? { intent: tool.intent } : {}),
			});
			if (tool.result !== undefined) {
				results.push(
					JSON.stringify({
						type: "message",
						id: nextId(),
						parentId: null,
						timestamp,
						message: {
							role: "toolResult",
							toolCallId: callId,
							toolName: tool.name,
							isError: tool.isError === true,
							timestamp,
							content: [{ type: "text", text: tool.result }],
							details: {},
						},
					}),
				);
			}
		}
		lines.push(
			JSON.stringify({
				type: "message",
				id: nextId(),
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					timestamp,
					model: "test/model",
					provider: "test",
					stopReason: "endTurn",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
					content,
				},
			}),
			...results,
		);
	});

	return `${lines.join("\n")}\n`;
}

/**
 * Write sessions into a store root, one directory per escaped cwd. The escaping
 * only has to be *distinct* per cwd: lookups match the recorded `cwd`, never the
 * directory name.
 */
export function writeStore(root: string, sessions: FixtureSession[]): void {
	for (const session of sessions) {
		const dir = join(root, session.cwd.replace(/\//g, "-"));
		const file = join(dir, `${session.stem}.jsonl`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, renderSession(session));
	}
}

/** A spilled-tool-output directory beside a transcript, which must be ignored. */
export function writeSpillDir(root: string, cwd: string, stem: string): void {
	const dir = join(root, cwd.replace(/\//g, "-"), stem);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "12.read.log"), "spilled tool output, not a transcript\n");
}
