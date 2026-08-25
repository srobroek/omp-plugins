import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
	ExtensionAPI,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import { ancestors, firstPresent, readText } from "./lib";

/**
 * Advises the modern tool when a bash command reaches for the legacy one AND the
 * modern counterpart is already configured in the tree. Scoped tight on purpose:
 * with no marker file the repo has made no such choice, and advising anyway would
 * be a migration the agent was never asked for.
 */

/** A file whose presence proves the modern tool owns this tree; `contains` narrows it. */
type Marker = { file: string; contains?: string };

type ToolSwap = {
	id: string;
	legacyName: string;
	legacy: RegExp;
	/** The legacy shape, spelled by the modern tool itself (`uv pip install`). */
	exempt?: RegExp;
	markers: readonly Marker[];
	/** Files proving the legacy tool is still load-bearing here. */
	blockedBy?: readonly string[];
	modern: string;
	hint: string;
};

const UV_MARKERS: readonly Marker[] = [
	{ file: "uv.lock" },
	{ file: "pyproject.toml", contains: "[tool.uv]" },
];

const SWAPS: readonly ToolSwap[] = [
	{
		id: "npm-to-bun",
		legacyName: "npm/yarn",
		legacy: /(?:^|[\s;&|(])(?:npm|yarn)\s+(?:install|add|i)(?:\s|$)/,
		markers: [{ file: "bun.lock" }, { file: "bun.lockb" }, { file: "bunfig.toml" }],
		modern: "bun",
		hint: "bun install / bun add <package>",
	},
	{
		id: "pip-to-uv",
		legacyName: "pip",
		legacy: /(?:^|[\s;&|(])(?:python3?\s+-m\s+)?pip3?\s+install\b/,
		exempt: /\buv\s+pip\b/,
		markers: UV_MARKERS,
		modern: "uv",
		hint: "uv add <package> / uv sync",
	},
	{
		id: "poetry-to-uv",
		legacyName: "poetry",
		legacy: /(?:^|[\s;&|(])poetry\s+[a-z]/,
		markers: UV_MARKERS,
		modern: "uv",
		hint: "uv add / uv sync / uv run",
	},
	{
		id: "version-manager-to-mise",
		legacyName: "nvm/pyenv",
		legacy: /(?:^|[\s;&|(])(?:nvm|pyenv)\s+[a-z]/,
		markers: [{ file: "mise.toml" }, { file: ".mise.toml" }],
		modern: "mise",
		hint: "mise use <tool>@<version> / mise install",
	},
	{
		id: "make-to-just",
		legacyName: "make",
		legacy: /(?:^|[\s;&|(])make(?:\s|$)/,
		markers: [{ file: "justfile" }, { file: "Justfile" }, { file: ".justfile" }],
		blockedBy: ["Makefile", "makefile", "GNUmakefile"],
		modern: "just",
		hint: "just <recipe> (just --list)",
	},
];

export type SwapHit = {
	id: string;
	legacyName: string;
	modern: string;
	hint: string;
	marker: string;
};

const pending = new Map<string, SwapHit[]>();
const advised = new Set<string>();

export function resetPreferToolsAdvisoryForTests(): void {
	pending.clear();
	advised.clear();
}

/** The marker proving the modern tool owns this tree, searched from cwd upward. */
function configuredMarker(swap: ToolSwap, cwd: string): string | undefined {
	for (const dir of ancestors(cwd)) {
		if (swap.blockedBy && firstPresent(dir, swap.blockedBy)) return undefined;
		for (const marker of swap.markers) {
			const path = join(dir, marker.file);
			if (!existsSync(path)) continue;
			if (!marker.contains || (readText(path) ?? "").includes(marker.contains)) return marker.file;
		}
	}
	return undefined;
}

export function decideSwaps(command: string, cwd: string): SwapHit[] {
	const out: SwapHit[] = [];
	for (const swap of SWAPS) {
		if (!swap.legacy.test(command)) continue;
		if (swap.exempt?.test(command)) continue;
		const marker = configuredMarker(swap, cwd);
		if (!marker) continue;
		out.push({
			id: swap.id,
			legacyName: swap.legacyName,
			modern: swap.modern,
			hint: swap.hint,
			marker,
		});
	}
	return out;
}

export function formatAdvisory(hits: SwapHit[]): string {
	const lines = hits.map(
		(entry) =>
			`- ${entry.marker} is present, so this tree runs on ${entry.modern}: use \`${entry.hint}\` instead of ${entry.legacyName}.`,
	);
	return [
		"TOOLCHAIN ADVISORY: this command used a legacy tool the repo has already replaced.",
		...lines,
		"Mixing the two managers writes a second lockfile and resolves versions differently.",
	].join("\n");
}

function prepend(
	event: ExtensionToolResultEvent,
	text: string,
): { content: ExtensionToolResultEvent["content"] } {
	const banner = `<system-reminder>\n${text}\n</system-reminder>\n\n`;
	if (event.content[0]?.type === "text") {
		return {
			content: event.content.map((chunk, i) =>
				i === 0 && chunk.type === "text" ? { ...chunk, text: banner + chunk.text } : chunk,
			),
		};
	}
	return { content: [{ type: "text", text: banner }, ...event.content] };
}

export default function preferToolsAdvisory(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!command) return;
			const cwd =
				typeof event.input.cwd === "string" && event.input.cwd ? event.input.cwd : process.cwd();
			const hits = decideSwaps(command, cwd).filter((entry) => !advised.has(`${entry.id}@${cwd}`));
			if (hits.length === 0) return;
			for (const entry of hits) advised.add(`${entry.id}@${cwd}`);
			pending.set(event.toolCallId, hits);
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event: ExtensionToolResultEvent) => {
		try {
			const hits = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			// A failed run still made the tool choice, so the advisory stands either way.
			if (!hits) return;
			return prepend(event, formatAdvisory(hits));
		} catch {
			return;
		}
	});
}
