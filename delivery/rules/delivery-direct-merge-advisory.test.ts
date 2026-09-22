/**
 * Corpus for the advisory-only direct-merge rule.
 *
 * The rule carries `scope: "tool:bash"`, so the only stream it sees is a bash
 * tool call's arguments while they stream in. The bash tool exposes no
 * `matcherDigest`, so OMP appends each provider argument delta to a per-toolcall
 * buffer and re-tests the whole accumulated buffer. That buffer is the argument
 * JSON — `{"command":"…","i":"…"}` — not shell text: the `i` (intent) argument
 * and the `env` argument land in it too, every `"` arrives as `\"`, and a real
 * newline or tab arrives as the two characters `\` `n` or `\` `t`.
 *
 * Every case is therefore scored in both encodings a live buffer can hold: the
 * argument JSON, and the bare command (what a first partial delta and
 * `omp ttsr test --source tool --tool bash` both look like). A condition that
 * behaves in one encoding only behaves by accident.
 *
 * Scope decision (omp-plugins-9ej3.27, upgrading .13): this is advice about a
 * routine command, so per skill://authoring-ttsr-rules it is advisory only and
 * bounded false negatives beat advisory noise. The condition matches the
 * top-level command of the call and nothing else. Chained commands, control
 * structures, nested shells, substitutions, and heredoc bodies are therefore
 * must-not-fire cases here, not misses: the rule body documents each one as a
 * deliberate exclusion, and this corpus pins them so a later widening has to be
 * an explicit decision.
 *
 * Streaming contract (omp-plugins-9ej3.22 round 4): the buffer grows and a fire
 * cannot be retracted, so a buffer that ends inside the command is not allowed
 * to match on the strength of text that may still change. `git merge` can still
 * become `git merge-base` or `git merge --abort`, so the condition waits for
 * whitespace plus a settled first argument. Where the two encodings legitimately
 * disagree — a flag-terminal buffer is complete in the argument JSON, because
 * the closing quote of the `command` member proves it, and incomplete as a bare
 * delta — the case lives in the raw-buffer lists below instead of the paired
 * matrix, which requires both encodings to agree.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "delivery-direct-merge-advisory.md");
const source = fs.readFileSync(RULE, "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
if (!frontmatter) throw new Error("missing frontmatter");
const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
if (!line) throw new Error("missing condition");
const patterns = JSON.parse(line.slice("condition:".length).trim()) as string[];
const CONDITIONS = patterns.map(pattern => {
	const inline = /^\(\?([ims]+)\)/.exec(pattern);
	return inline ? new RegExp(pattern.slice(inline[0].length), inline[1] as string) : new RegExp(pattern);
});

interface Case { id: string; command: string; intent?: string; env?: Record<string, string>; why: string }
/** The two encodings a live buffer can hold for one bash call. Both must agree. */
function buffers(c: Case): string[] {
	const args: Record<string, unknown> = { command: c.command };
	if (c.intent !== undefined) args.i = c.intent;
	if (c.env !== undefined) args.env = c.env;
	return [JSON.stringify(args), c.command];
}
function fires(buffer: string): boolean {
	return CONDITIONS.some(re => { re.lastIndex = 0; return re.test(buffer); });
}

const MUST_FIRE: Case[] = [
	{ id: "ordinary", command: "git merge feature/x", intent: "Integrating the feature", why: "the plain local integration" },
	{ id: "quoted ref", command: "git merge \"feature/x\"", why: "a quoted ref settles the first argument just as a bare one does" },
	{ id: "attached option value", command: "git merge --strategy-option=ours topic", why: "an attached option value closes the option token" },
	{ id: "no-ff", command: "git merge --no-ff omp/agent/example-bead", why: "an integrating mode" },
	{ id: "squash", command: "git merge --squash topic", why: "an integrating mode" },
	{ id: "indented", command: "  git merge topic", why: "leading shell whitespace before the command" },
	{ id: "tab", command: "git merge\ttopic", why: "a tab arrives as the two characters backslash t in the JSON encoding" },
	{ id: "directory", command: "git -C /some/path merge origin/main", why: "the -C global option with a bare value" },
	{ id: "quoted directory", command: "git -C '/some path/repo' merge origin/main", why: "a single-quoted -C value" },
	{ id: "double quoted directory", command: "git -C \"/some path/repo\" merge origin/main", why: "a double-quoted -C value, which arrives escaped in the JSON encoding" },
	{ id: "attached git-dir", command: "git --git-dir=/some/path/.git merge topic", why: "an attached global option value" },
	{ id: "config", command: "git -c merge.ff=false merge topic", why: "a -c key=value whose key contains the verb" },
	{ id: "short pager", command: "git -P merge topic", why: "-P is a single-dash global option, not --P" },
	{ id: "long globals", command: "git --no-replace-objects --no-pager --literal-pathspecs merge topic", why: "several long global options in a row" },
	{ id: "absolute", command: "/usr/bin/git merge topic", why: "an absolute path to the executable" },
	{ id: "relative", command: "./vendor/git merge topic", why: "a relative path to the executable" },
	{ id: "quoted executable", command: "\"/usr/local/bin/git\" merge topic", why: "a quoted executable path" },
	{ id: "assignment", command: "GIT_EDITOR=true git merge topic", why: "an environment assignment prefix" },
	{ id: "quoted assignment", command: "GIT_EDITOR=\"vim -f\" git merge topic", why: "a double-quoted assignment value" },
	{ id: "single quoted assignment", command: "GIT_EDITOR='vim -f' git merge topic", why: "a single-quoted assignment value" },
	{ id: "two assignments", command: "GIT_EDITOR=true GIT_PAGER=cat git merge topic", why: "several assignments before the executable" },
	{ id: "sudo", command: "sudo git merge topic", why: "a sudo prefix" },
	{ id: "sudo options", command: "sudo -E -u git git merge topic", why: "sudo options and a user value before the executable" },
	{ id: "env wrapper", command: "env GIT_EDITOR=true git merge topic", why: "the env wrapper with an assignment" },
	{ id: "prefix and globals", command: "sudo GIT_EDITOR=true /usr/bin/git -C /some/path --no-pager merge topic", why: "every supported prefix shape at once" },
];

const MUST_NOT_FIRE: Case[] = [
	// Buffers that end inside the command. A fire cannot be retracted, so none of
	// these may match on text the next delta can still change.
	{ id: "verb only", command: "git merge", why: "the buffer can still become git merge-base" },
	{ id: "verb and space", command: "git merge ", why: "no argument has arrived yet" },
	{ id: "verb and tab", command: "git merge\t", why: "no argument has arrived yet" },
	{ id: "open dash", command: "git merge -", why: "the option can still become -h" },
	{ id: "open double dash", command: "git merge --", why: "the option can still become --abort" },
	{ id: "open verb", command: "git merg", why: "the verb itself is still streaming" },
	// Recovery and help, at any spacing and quoting.
	{ id: "abort", command: "git merge --abort", why: "recovery, not an integration" },
	{ id: "abort spaced", command: "git merge   --abort", why: "recovery stays recovery at any spacing" },
	{ id: "continue tabbed", command: "git merge\t--continue", why: "recovery behind an escaped tab" },
	{ id: "quit", command: "git merge --quit", why: "recovery, not an integration" },
	{ id: "help", command: "git merge --help", why: "help, not an integration" },
	{ id: "short help", command: "git merge -h", why: "help, not an integration" },
	{ id: "quoted abort", command: "git merge '--abort'", why: "a quoted recovery flag is still recovery" },
	{ id: "directory abort", command: "git -C /some/path merge --abort", why: "recovery behind a global option" },
	// Different verbs and the sanctioned path.
	{ id: "merge base", command: "git merge-base origin/main HEAD", why: "a different verb that shares the prefix" },
	{ id: "mergetool", command: "git mergetool", why: "a different verb that shares the prefix" },
	{ id: "rebase", command: "git rebase topic", why: "a different verb" },
	{ id: "grep", command: "git log --grep=merge", why: "an option value that merely contains the word" },
	{ id: "strategy option", command: "git rebase --strategy-option=ours topic", why: "an option value that merely contains the word" },
	{ id: "forge github", command: "gh pr merge 12 --squash", why: "the sanctioned GitHub landing path" },
	{ id: "forge gitlab", command: "glab mr merge 12", why: "the sanctioned GitLab landing path" },
	{ id: "delivery tool", command: "git config --global alias.m merge", why: "configuration, not an integration" },
	// Quoted and structured data.
	{ id: "echo prose", command: "echo 'note ; git merge topic'", why: "quoted data, not a command" },
	{ id: "commit prose", command: "git commit -m 'note ; git merge topic'", why: "a commit message is not state" },
	{ id: "heredoc prose", command: "cat <<'EOF'\ngit merge topic\nEOF", why: "a heredoc body is data even when it feeds a shell" },
	{ id: "heredoc to shell", command: "bash <<'EOF'\ngit merge topic\nEOF", why: "a shell-fed heredoc body is out of scope by design" },
	{ id: "env data", command: "git status", env: { NOTE: "note ; git merge topic" }, why: "the env argument is structured data" },
	{ id: "intent data", command: "git status", intent: "note ; git merge topic", why: "the intent argument is structured data" },
	{ id: "long intent data", command: "git status", intent: `${"x".repeat(300)} ; git merge topic`, why: "a long intent argument must not leak past the root command member" },
	// Chained, nested, and substituted shell: documented exclusions.
	{ id: "and chain", command: "git status && git merge topic", why: "a chained command is out of scope by design" },
	{ id: "semicolon chain", command: "cd repo; git merge topic", why: "a chained command is out of scope by design" },
	{ id: "pipe chain", command: "git status | git merge topic", why: "a chained command is out of scope by design" },
	{ id: "newline chain", command: "git status\ngit merge topic", why: "a second line is out of scope by design" },
	{ id: "control flow", command: "if ! git merge topic; then echo no; fi", why: "a control structure is out of scope by design" },
	{ id: "loop body", command: "for x in topic; do git merge \"$x\"; done", why: "a loop body is out of scope by design" },
	{ id: "nested shell", command: "bash -lc \"git merge topic\"", why: "nested shell source is out of scope by design" },
	{ id: "substitution", command: "echo $(git merge topic)", why: "command substitution is out of scope by design" },
	{ id: "backticks", command: "echo `git merge topic`", why: "backtick substitution is out of scope by design" },
	{ id: "wrapper", command: "mise exec -- git merge topic", why: "an unrecognized wrapper is out of scope by design" },
	{ id: "xargs", command: "echo topic | xargs git merge", why: "an unrecognized wrapper is out of scope by design" },
];

/**
 * Buffers a case pair cannot express: raw argument JSON, and deltas that are
 * complete in one encoding only. These pin the root anchor — the rule reads the
 * call's own `command` member and nothing that imitates it — and the streaming
 * boundary, where an unterminated `command` member is exactly what a live
 * partial delta looks like.
 */
const RAW_FIRE: Array<{ id: string; buffer: string; why: string }> = [
	{ id: "intent before command", buffer: JSON.stringify({ i: "Integrating the feature", command: "git merge topic" }), why: "a provider may serialize the intent argument first" },
	{ id: "scalar arguments before command", buffer: JSON.stringify({ i: "Integrating", timeout: 120, quiet: false, command: "git merge topic" }), why: "bounded scalar members before command are still the root object" },
	{ id: "partial delta", buffer: '{"command":"git merge to', why: "the buffer is re-tested while the argument JSON still streams" },
	{ id: "completed flag-terminal command", buffer: JSON.stringify({ command: "git merge --no-ff" }), why: "the closing quote of the command member proves the option token ended" },
	{ id: "completed squash", buffer: JSON.stringify({ command: "git merge --squash" }), why: "the same boundary for the other integrating mode" },
	{ id: "settled ref mid-stream", buffer: '{"command":"git merge fea', why: "a ref character cannot retract into a recovery flag" },
];

const RAW_IGNORE: Array<{ id: string; buffer: string; why: string }> = [
	{ id: "nested command key", buffer: JSON.stringify({ i: "Recording a plan", payload: { command: "git merge topic" } }), why: "a nested object's command key is data, not this call's command" },
	{ id: "nested command key first", buffer: JSON.stringify({ payload: { command: "git merge topic" } }), why: "the anchor is the root command member only" },
	{ id: "faked command member", buffer: JSON.stringify({ i: 'x","command":"git merge topic', command: "git status" }), why: "an intent argument that spells the root key stays inside its own escaped scalar" },
	{ id: "object argument before command", buffer: JSON.stringify({ env: { NOTE: "x" }, command: "git merge topic" }), why: "a structured member before command is a documented false negative, not a fire" },
	// Streaming prefixes. An unterminated command member is what a live partial
	// delta looks like; nothing here may fire, because the next delta can still
	// turn it into git merge-base or git merge --abort.
	{ id: "streaming verb", buffer: '{"command":"git merge', why: "the verb may still continue into merge-base" },
	{ id: "streaming space", buffer: '{"command":"git merge ', why: "no argument has arrived yet" },
	{ id: "streaming open option", buffer: '{"command":"git merge --ab', why: "the option may still become --abort" },
	{ id: "streaming almost recovery", buffer: '{"command":"git merge --abor', why: "one character short of --abort" },
	{ id: "streaming recovery", buffer: '{"command":"git merge --abort', why: "recovery, and not yet delimited either" },
	{ id: "streaming option behind a global", buffer: '{"command":"git -C /some/path merge --ab', why: "a global option does not settle the option that follows the verb" },
	{ id: "bare open option", buffer: "git merge --ab", why: "the same boundary in the bare encoding" },
	{ id: "bare almost recovery", buffer: "git merge --abor", why: "the same boundary in the bare encoding" },
	{ id: "bare flag-terminal delta", buffer: "git merge --no-ff", why: "an undelimited option in a bare delta is a documented false negative" },
];

describe("direct merge advisory fires", () => {
	for (const c of MUST_FIRE) test(`${c.id} fires — ${c.why}`, () => {
		for (const buffer of buffers(c)) expect(fires(buffer)).toBe(true);
	});
	for (const c of RAW_FIRE) test(`${c.id} fires as a raw buffer — ${c.why}`, () => {
		expect(fires(c.buffer)).toBe(true);
	});
});

describe("direct merge advisory does not fire", () => {
	for (const c of MUST_NOT_FIRE) test(`${c.id} does not fire — ${c.why}`, () => {
		for (const buffer of buffers(c)) expect(fires(buffer)).toBe(false);
	});
	for (const c of RAW_IGNORE) test(`${c.id} does not fire as a raw buffer — ${c.why}`, () => {
		expect(fires(c.buffer)).toBe(false);
	});
});

test("advisory contract", () => {
	expect(source).toContain('scope: "tool:bash"');
	expect(source).toContain("interruptMode: never");
	expect(source).toContain("delivery_land");
	expect(source).toContain("delivery_cleanup");
	expect(source).not.toMatch(/dispatch|suggest.*reaper|worktree-reaper/i);
});

test("the body documents the exclusions this corpus pins", () => {
	expect(source).toContain("out of scope by design");
	for (const marker of ["heredoc", "substitution", "nested JSON", "gh pr merge", "glab mr merge", "--abort", "`git merge --ab`", "cannot be retracted"]) {
		expect(source).toContain(marker);
	}
});

test("matrix is substantive", () => {
	expect(MUST_FIRE.length).toBeGreaterThan(10);
	expect(MUST_NOT_FIRE.length).toBeGreaterThan(10);
	expect(RAW_FIRE.length + RAW_IGNORE.length).toBeGreaterThan(12);
});
