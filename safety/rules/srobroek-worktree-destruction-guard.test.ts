/**
 * Corpus for the worktree-destruction guard.
 *
 * Mechanism, read from the installed OMP source rather than inferred, and shared
 * with `srobroek-bash-guards.test.ts`:
 *
 *  - `scope: "tool:bash"` means the rule only ever sees a bash tool call's
 *    arguments streaming in, never assistant prose or thinking.
 *  - The bash tool exposes no `matcherDigest`, so `TtsrManager.checkDelta` appends
 *    raw provider argument deltas to a per-toolcall buffer and re-tests the whole
 *    buffer after each delta. The buffer holds argument JSON -- `{"command":"…",
 *    "i":"…"}` -- so `"` arrives as `\"`, a real newline arrives as the two
 *    characters `\` `n`, and the `i` (intent) argument is matched too.
 *  - Only a leading inline flag group is translated; the rest is a plain JS
 *    RegExp tested with `.test()`.
 *
 * Every case is scored in both encodings a live buffer can hold: the argument
 * JSON, and the bare command. A condition that behaves in only one of the two
 * behaves by accident.
 *
 * Why this guard exists: three subagents in one session removed the same two
 * worktrees, the third with `--force-delete`, each reporting an authorization that
 * did not exist. `srobroek-bash-indirection-guard` passed all three calls because
 * their targets were literal paths, which is exactly what it is designed to allow.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE_FILE = "srobroek-worktree-destruction-guard.md";

interface Case {
	id: string;
	command: string;
	intent?: string;
	/** True when the guard MUST fire on this call. */
	fire: boolean;
	why: string;
}

const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/;
const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/;

function compileCondition(pattern: string): RegExp {
	const match = INLINE_FLAG_PREFIX.exec(pattern);
	if (match && TRANSLATABLE_INLINE_FLAGS.test(match[1] as string)) {
		const flags = Array.from(new Set(match[1] as string)).join("");
		return new RegExp(pattern.slice(match[0].length), flags);
	}
	return new RegExp(pattern);
}

function conditions(): RegExp[] {
	const file = path.join(process.env.GUARD_RULE_DIR ?? import.meta.dir, RULE_FILE);
	const text = fs.readFileSync(file, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error(`${file}: no frontmatter`);
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error(`${file}: no condition`);
	const raw = line.slice("condition:".length).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.startsWith("[") ? raw : `[${raw}]`);
	} catch {
		throw new Error(`${file}: condition is not a JSON-compatible flow sequence: ${raw}`);
	}
	if (!Array.isArray(parsed) || parsed.some(p => typeof p !== "string")) {
		throw new Error(`${file}: condition is not a list of patterns`);
	}
	return (parsed as string[]).map(compileCondition);
}

const CONDITIONS = conditions();

function buffers(c: Case): string[] {
	const args = c.intent === undefined ? { command: c.command } : { command: c.command, i: c.intent };
	return [JSON.stringify(args), c.command];
}

function fires(buffer: string): boolean {
	return CONDITIONS.some(re => {
		re.lastIndex = 0;
		return re.test(buffer);
	});
}

const MUST_FIRE: Case[] = [
	{
		id: "wt-remove-force-no-delete-branch",
		command: "wt -y -C /repo remove --force --no-delete-branch --foreground omp/agent/chezmoi-rrm9",
		fire: true,
		why: "the second incident: discards a dirty worktree while keeping the branch",
	},
	{
		id: "wt-remove-force-delete",
		command: "wt -y remove --force --force-delete --foreground omp/agent/chezmoi-j584.7",
		fire: true,
		why: "the third incident: discards the worktree and the branch tip",
	},
	{
		id: "git-worktree-remove",
		command: "git -C /Users/sjors/.local/share/chezmoi worktree remove /tmp/worktrees/x",
		fire: true,
		why: "the plain git spelling of the same destruction",
	},
	{
		id: "git-worktree-remove-force",
		command: "git worktree remove --force /tmp/worktrees/x",
		fire: true,
		why: "force removal discards uncommitted changes without a prompt",
	},
	{
		id: "git-branch-force-delete",
		command: "git -C /repo branch -D omp/agent/chezmoi-rrm9",
		fire: true,
		why: "deletes an unmerged branch tip",
	},
	{
		id: "git-branch-delete-long",
		command: "git branch --delete --force omp/agent/feature",
		fire: true,
		why: "long-form spelling of the same deletion",
	},
	{
		id: "git-stash-drop",
		command: "git -C /repo stash drop stash@{0}",
		fire: true,
		why: "a stash entry is often the only copy of preserved work",
	},
	{
		id: "git-stash-clear",
		command: "git stash clear",
		fire: true,
		why: "discards every stash entry at once",
	},
	{
		id: "git-reset-hard",
		command: "git -C /repo reset --hard origin/main",
		fire: true,
		why: "discards the index and working tree",
	},
	{
		id: "chained-after-status",
		command: "git status --short && git worktree remove --force /tmp/x",
		fire: true,
		why: "destruction in a later command position is still destruction",
	},
	{
		id: "reflog-expire",
		command: "git reflog expire --expire=now --all",
		fire: true,
		why: "removes the last recovery path for a deleted tip",
	},
];

const MUST_NOT_FIRE: Case[] = [
	{
		id: "wt-switch-create",
		command: "wt switch -y --create --no-cd --base origin/main --format json omp/agent/x",
		fire: false,
		why: "creating a worktree destroys nothing",
	},
	{
		id: "worktree-list",
		command: "git -C /repo worktree list",
		fire: false,
		why: "read-only inspection",
	},
	{
		id: "worktree-prune",
		command: "git -C /repo worktree prune",
		fire: false,
		why: "prune only drops metadata for directories that are already gone",
	},
	{
		id: "branch-list",
		command: "git branch --list 'omp/agent/*'",
		fire: false,
		why: "read-only inspection, and --list is not a delete flag",
	},
	{
		id: "branch-create",
		command: "git -C /repo branch omp/agent/chezmoi-rrm9 19dd015b",
		fire: false,
		why: "recreating a branch is the recovery, not the damage",
	},
	{
		id: "stash-apply",
		command: "git -C /repo stash apply a3624e1c",
		fire: false,
		why: "apply keeps the entry; only drop and clear remove it",
	},
	{
		id: "stash-list",
		command: "git stash list",
		fire: false,
		why: "read-only inspection",
	},
	{
		id: "wt-step-prune",
		command: "wt step prune",
		fire: false,
		why: "the automatic cleanup step: removes merged worktrees and branches, and must stay unblocked",
	},
	{
		id: "wt-step-prune-dry-run",
		command: "wt step prune --dry-run",
		fire: false,
		why: "its preview mode",
	},
	{
		id: "wt-step-prune-min-age",
		command: "wt -y -C /repo step prune --min-age 7d",
		fire: false,
		why: "age-limited sweep with global flags",
	},
	{
		id: "wt-remove-merged-no-force",
		command: "wt remove -y omp/agent/x",
		fire: false,
		why: "wt remove without --force refuses a dirty worktree and only deletes a merged branch",
	},
	{
		id: "wt-remove-no-delete-branch",
		command: "wt remove --no-delete-branch omp/agent/x",
		fire: false,
		why: "the safest removal form; a case-insensitive -D matched the -d inside --no-delete-branch until this case was added",
	},
	{
		id: "reset-soft",
		command: "git reset --soft HEAD~1",
		fire: false,
		why: "soft reset keeps the working tree",
	},
	{
		id: "restore-file",
		command: "git checkout -- dotfiles/dot_omp/private_agent/WATCHDOG.yml",
		fire: false,
		why: "restoring one tracked file is routine and recoverable from the index",
	},
	{
		id: "remove-in-prose-argument",
		command: "rg --fixed-strings 'worktree remove' docs/",
		fire: false,
		why: "searching for the phrase must not trip the guard",
	},
];

describe("worktree destruction guard", () => {
	test("the rule declares an always-interrupting bash scope", () => {
		const file = path.join(process.env.GUARD_RULE_DIR ?? import.meta.dir, RULE_FILE);
		const text = fs.readFileSync(file, "utf8");
		expect(text).toContain('scope: "tool:bash"');
		expect(text).toContain("interruptMode: always");
	});

	for (const c of MUST_FIRE) {
		test(`fires: ${c.id}`, () => {
			for (const buffer of buffers(c)) {
				expect(fires(buffer)).toBe(true);
			}
		});
	}

	for (const c of MUST_NOT_FIRE) {
		test(`silent: ${c.id}`, () => {
			for (const buffer of buffers(c)) {
				expect(fires(buffer)).toBe(false);
			}
		});
	}
});
