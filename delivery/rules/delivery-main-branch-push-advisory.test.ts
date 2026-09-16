/**
 * Corpus for the protected-branch push advisory.
 *
 * The rule carries `scope: "tool:bash"`, so the only stream it sees is a bash
 * tool call's arguments while they stream in. The bash tool exposes no
 * `matcherDigest`, so OMP appends each provider argument delta to a per-toolcall
 * buffer and re-tests the whole accumulated buffer. That buffer is the argument
 * JSON — `{"command":"…","i":"…"}` — not shell text: the `i` (intent) argument is
 * matched too, every `"` arrives as `\"`, and a real newline or tab arrives as the
 * two characters `\` `n` or `\` `t`.
 *
 * Every case is therefore scored in both encodings a live buffer can hold: the
 * argument JSON, and the bare command (what a first partial delta and
 * `omp ttsr test --source tool --tool bash` both look like). A condition that
 * behaves in one encoding only behaves by accident. This mirrors
 * `safety/rules/srobroek-bash-guards.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "delivery-main-branch-push-advisory.md");

interface Case {
	/** Stable id, used as the test name. */
	id: string;
	/** The bash tool's `command` argument, verbatim. */
	command: string;
	/** The bash tool's `i` (intent) argument; it lands in the same buffer. */
	intent?: string;
	/** Structured environment data; it lands in the JSON buffer but is never shell source. */
	env?: Record<string, string>;
	/** Why this case is in the corpus. */
	why: string;
}

/** Leading PCRE-style inline flag group, mirroring `compileRuleCondition`. */
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
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error(`${RULE}: no frontmatter`);
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error(`${RULE}: no condition`);
	const raw = line.slice("condition:".length).trim();
	// The estate writes `condition:` as a YAML flow sequence of double-quoted
	// scalars, which is JSON. Any other shape is one this corpus cannot read
	// faithfully, so fail loudly rather than test a guess.
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.startsWith("[") ? raw : `[${raw}]`);
	} catch {
		throw new Error(`${RULE}: condition is not a JSON-compatible flow sequence: ${raw}`);
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(p => typeof p !== "string")) {
		throw new Error(`${RULE}: condition is not a list of patterns`);
	}
	return (parsed as string[]).map(compileCondition);
}

const CONDITIONS = conditions();

/** The two encodings a live buffer can hold for one bash call. Both must agree. */
function buffers(c: Case): string[] {
	const args: { command: string; env?: Record<string, string>; i?: string } = { command: c.command };
	if (c.env !== undefined) args.env = c.env;
	if (c.intent !== undefined) args.i = c.intent;
	return [JSON.stringify(args), c.command];
}

function fires(buffer: string): boolean {
	return CONDITIONS.some(re => {
		re.lastIndex = 0;
		return re.test(buffer);
	});
}

const MUST_FIRE: Case[] = [
	{ id: "remote and main", command: "git push origin main", intent: "Publishing the release", why: "the ordinary explicit destination" },
	{ id: "remote and master", command: "git push origin master", why: "master is protected on the same terms as main" },
	{ id: "attached repo option", command: "git push --repo=origin main", why: "an attached repository option still leaves main as the explicit destination" },
	{ id: "attached repo with force before main", command: "git push --force --repo=origin main", why: "a supported push option before the attached repository option must not hide main" },
	{ id: "attached repo with force before master", command: "git push --force --repo=origin master", why: "the same placement protects master" },
	{ id: "attached repo with force after main", command: "git push --repo=origin --force main", why: "a supported push option after the attached repository option must not hide main" },
	{ id: "attached repo with force after master", command: "git push --repo=origin --force master", why: "the same placement protects master" },
	{ id: "attached repo under global option main", command: "git -C repo push --repo=origin main", why: "a supported global option before push must not hide main" },
	{ id: "attached repo under global option master", command: "git -C repo push --repo=origin master", why: "the same global placement protects master" },
	{ id: "uppercase branch", command: "git push origin MAIN", why: "the condition is case-insensitive, as its (?i) prefix claims" },
	{ id: "force before remote", command: "git push --force origin main", why: "an option between push and the remote must not hide the destination" },
	{ id: "force after remote", command: "git push origin --force master", why: "an option between the remote and the branch must not hide it either" },
	{ id: "set upstream short", command: "git push -u origin main", why: "-u takes no value, so origin is still the remote" },
	{ id: "set upstream long", command: "git push --set-upstream origin main", why: "the long spelling behaves the same" },
	{ id: "delete flag", command: "git push --delete origin main", why: "deleting the protected branch is a protected-branch write" },
	{ id: "delete flag short", command: "git push -d origin master", why: "-d is the same deletion" },
	{ id: "delete flag after remote", command: "git push origin -d main", why: "-d may follow the remote" },
	{ id: "trailing option", command: "git push origin main --force-with-lease", why: "the destination may be followed by more options" },
	{ id: "head refspec", command: "git push origin HEAD:master", why: "HEAD:master names the destination on the right of the colon" },
	{ id: "head refspec under -C", command: "git -C repo push origin HEAD:main", why: "-C <path> is a global option, not the remote" },
	{ id: "full ref", command: "git push origin refs/heads/main", why: "refs/heads/main is the same destination spelled out" },
	{ id: "head to full ref", command: "git push origin HEAD:refs/heads/master", why: "both refspec halves may be fully qualified" },
	{ id: "branch to branch", command: "git push origin feature:main", why: "a feature source with a protected destination still publishes to main" },
	{ id: "branch to full ref", command: "git push origin feature:refs/heads/main", why: "the same with a qualified destination" },
	{ id: "same name refspec", command: "git push origin master:master", why: "an explicit self-named refspec" },
	{ id: "deletion refspec", command: "git push origin :main", why: "an empty source deletes the destination branch" },
	{ id: "deletion refspec qualified", command: "git push origin :refs/heads/main", why: "the qualified deletion form" },
	{ id: "forced refspec", command: "git push origin +HEAD:main", why: "a leading + forces the update non-fast-forward" },
	{ id: "forced refspec qualified", command: "git push origin +refs/heads/main", why: "the qualified forced form" },
	{ id: "non-origin remote", command: "git push upstream main", why: "the remote is not required to be named origin" },
	{ id: "repeated -C", command: "git -C /a -C /b push origin main", why: "git accepts -C more than once; the last one wins and push still follows" },
	{ id: "-c config", command: "git -c push.default=simple push origin main", why: "-c <name>=<value> is a global option with a separate value" },
	{ id: "--no-pager", command: "git --no-pager push origin main", why: "a valueless global option" },
	{ id: "--git-dir", command: "git --git-dir=/a/.git push origin main", why: "an attached-value global option" },
	{ id: "-C absolute path", command: "git -C /Users/x/dev/repo push origin refs/heads/master", why: "a real -C invocation with a qualified destination" },
	{ id: "env prefix", command: "GIT_SSH_COMMAND=ssh git push origin main", why: "an environment assignment before git" },
	{ id: "sudo prefix", command: "sudo git push origin main", why: "a command word before git" },
	{ id: "after and-and", command: "echo ok && git push origin main", why: "a shell separator starts a new command position" },
	{ id: "after pipe", command: "true | git push origin main", why: "a pipe does the same" },
	{ id: "second push fires", command: "git push origin feature && git push origin main", why: "a safe first command must not mask the second" },
	{ id: "after raw newline", command: "cd repo\ngit push origin main", why: "a newline is a command separator in both encodings (raw, and \\n in JSON)" },
	{ id: "after closed double quoted data", command: 'bd create x -d "don\'t"\ngit push origin main', why: "the push is executable once the double-quoted argv value closes" },
	{ id: "after closed single quoted data", command: "bd create x -d 'say \"hello\"'\ngit push origin main", why: "the push is executable once the single-quoted argv value closes" },
	{ id: "after closed escaped double quote data", command: 'bd create x -d "say \\"hello\\""\ngit push origin main', why: "escaped double quotes do not hide a push after the value closes" },
	{ id: "after closed POSIX single quoted data", command: "bd create x -d 'don'\\''t'\ngit push origin main", why: "the push is executable after the concatenated escaped apostrophe and reopened single-quoted segment close" },
	{ id: "newline mid script", command: "git status\ngit push origin main", why: "the same where the first line is also a git call" },
	{ id: "command substitution", command: "$(git push origin main)", why: "an open paren starts a command position" },
	{ id: "bd command substitution", command: 'bd create "t" -d "$(git push origin main)"', why: "a substitution inside bd data still executes its own command" },
	{ id: "mise exec wrapper", command: "mise exec -- git push origin main", why: "mise executes git from the argv after --" },
	{ id: "shell command wrapper", command: 'bash -c "git push origin main"', why: "the shell executes its command-string argument" },
	{ id: "subshell group", command: "(git push origin main)", why: "the closing paren must still count as a word boundary" },
	{ id: "if context", command: "if ! git push origin main; then echo no; fi", why: "if and ! precede the command word" },
	{ id: "then context", command: "git fetch; then git push origin main", why: "then precedes the command word" },
	{ id: "do context", command: "for r in a b; do git push origin main; done", why: "do precedes the command word" },
	{ id: "while context", command: "while true; do git push origin main; done", why: "the same inside a while loop" },
	{ id: "double quoted destination", command: 'git push origin "main"', why: "quoting the destination is still naming it, in both encodings" },
	{ id: "single quoted destination", command: "git push origin 'master'", why: "the same with single quotes" },
	{ id: "extra spaces", command: "git   push   origin   main", why: "runs of spaces separate the same words" },
	{ id: "tab separated", command: "git push\torigin\tmain", why: "a tab reaches the buffer as \\t in JSON and must behave as a separator there too" },
	{ id: "heredoc body", command: "bash <<'EOF'\ngit push origin main\nEOF", why: "a heredoc body is not excluded: it can feed a shell as readily as a file" },
	{ id: "attached repo option value before destination", command: "git push --repo=origin --push-option main origin main", why: "an option value may precede a later explicit main destination" },
];

const MUST_NOT_FIRE: Case[] = [
	{ id: "bare push", command: "git push", why: "the destination is repository configuration this text cannot read" },
	{ id: "remote only", command: "git push origin", why: "still unqualified" },
	{ id: "remote named main", command: "git push main", intent: "Pushing the current branch", why: "the sole positional after push is the remote, not a branch" },
	{ id: "remote named main forced", command: "git push --force main", why: "an option before it does not turn the remote into a destination" },
	{ id: "remote named main with refspec", command: "git push main HEAD:feature", why: "remote main, feature destination" },
	{ id: "remote named main with -u", command: "git push -u main", why: "the same under --set-upstream" },
	{ id: "feature destination", command: "git push origin feature", intent: "Pushing feature, not main", why: "an unprotected destination, with the word main only in the intent" },
	{ id: "hyphenated feature", command: "git push origin feature-branch", why: "an unprotected destination" },
	{ id: "head to feature", command: "git push origin HEAD:feature", why: "the refspec destination is unprotected" },
	{ id: "head only", command: "git push origin HEAD", why: "HEAD resolves through repository state this text cannot read" },
	{ id: "main as source", command: "git push origin main:feature", why: "main on the left of the colon is the source; feature is what gets written" },
	{ id: "master as source", command: "git push origin master:feature", why: "the same for master" },
	{ id: "main prefix branch", command: "git push origin main-cutover", why: "a branch whose name starts with main is a different branch" },
	{ id: "mainline branch", command: "git push origin mainline", why: "the destination must match at a word boundary" },
	{ id: "main with digit", command: "git push origin main2", why: "the same" },
	{ id: "full ref with suffix", command: "git push origin refs/heads/main-x", why: "the qualified form needs the same word boundary" },
	{ id: "tag named main", command: "git push origin refs/tags/main", why: "a tag is not the protected branch" },
	{ id: "variable destination", command: 'git push origin "$BRANCH"', why: "an expansion is not a destination this text can classify" },
	{ id: "option value main", command: "git push --repo main", why: "main is the value of --repo" },
	{ id: "attached lease value", command: "git push --force-with-lease=main origin feature", why: "main is an attached option value, and the destination is feature" },
	{ id: "attached lease ref value", command: "git push --force-with-lease=refs/heads/main origin feature", why: "the same with a qualified ref in the option value" },
	{ id: "push option value", command: "git push origin feature -o main", why: "-o takes a separate value, so main is not a destination" },
	{ id: "attached repo short push option value", command: "git push --repo=origin -o main", why: "-o value main is not a destination" },
	{ id: "attached repo long push option value", command: "git push --repo=origin --push-option main", why: "--push-option value main is not a destination" },
	{ id: "attached repo short push option equals value", command: "git push --repo=origin -o=main", why: "attached -o value main is not a destination" },
	{ id: "attached repo long push option equals value", command: "git push --repo=origin --push-option=main", why: "attached --push-option value main is not a destination" },
	{ id: "echoed command", command: "echo git push origin main", why: "echo is not a command position for git" },
	{ id: "comment", command: "# git push origin main", why: "a commented mention runs nothing" },
	{ id: "single quoted search", command: "rg 'git push origin main' docs/", why: "a quoted search pattern is documentation, not a push" },
	{ id: "double quoted echo", command: 'echo "git push origin main"', why: "the same inside double quotes, which reach the buffer as \\\" in JSON" },
	{ id: "quoted prose with separator", command: 'bd create --description "then git push origin main"', why: "a separator word inside quoted prose must not open a command position" },
	{ id: "quoted prose with equals", command: 'bd update x --description="git push origin main"', why: "the same where the quote follows =" },
	{
		id: "multiline bd create description",
		command:
			"bd create \"Use a deep matinee-security module seam for secure-channel state\" --type decision --id adr-5 --force --validate --spec-id 006-identity-authorization-secure-channels -d '## Decision\nDocument the commit and push workflow before apply or install steps.\n```sh\ngit push origin main\n```\nThis is decision data.'",
		why: "the original bd decision body is argv data even when a line looks executable",
	},
	{
		id: "multiline double quoted description with apostrophe",
		command: 'bd create x -d "don\'t\ngit push origin main"',
		why: "an apostrophe does not end a double-quoted argv value",
	},
	{
		id: "multiline single quoted description with double quotes",
		command: "bd create x -d 'say \"hello\"\ngit push origin main'",
		why: "a double quote does not end a single-quoted argv value",
	},
	{
		id: "multiline double quoted description with escaped quote",
		command: 'bd create x -d "say \\"hello\\"\ngit push origin main"',
		why: "an escaped double quote does not end a double-quoted argv value",
	},
	{
		id: "multiline bd update description",
		command: "bd update adr-5 --description='commit/push/apply/install guidance:\ngit push origin main'",
		why: "update payloads have the same argv-data contract",
	},
	{
		id: "multiline bd close reason",
		command: "bd close adr-5 --reason='document before apply/install:\ngit push origin main'",
		why: "close reasons do not become shell source",
	},
	{
		id: "bd description in structured env",
		command: 'bd create "Use a deep module seam" -d "$DESC"',
		env: { DESC: "commit/push/apply/install guidance:\ngit push origin main" },
		why: "per-call environment values are data outside the command field",
	},
	{ id: "gh pr mutation body", command: "gh pr edit 326 --body='release notes:\ngit push origin main'", why: "GitHub body data is not a git push" },
	{ id: "release notes body", command: "gh release create v1 --notes='install then apply:\ngit push origin main'", why: "release notes are not shell source" },
	{ id: "commit message mention", command: "git commit -m 'document git push origin main'", why: "a commit message that documents the command" },
	{ id: "other git verb", command: "git switch main", why: "only push is classified" },
	{ id: "checkout after push", command: "git push origin feature && git checkout main", why: "a later git verb in command position is still not push" },
	{ id: "log mention", command: "git log origin/main", why: "reading history is not publishing" },
	{ id: "fetch", command: "git fetch origin main", why: "fetch writes nothing to the remote" },
	{ id: "pull", command: "git pull origin main", why: "pull writes nothing to the remote" },
	{ id: "gh merge base", command: "gh pr merge 12 --base main", why: "not a git push; the merge queue is out of scope" },
	{ id: "intent with separator", command: "git push origin feature", intent: "Push feature; main stays put", why: "a separator in the intent must not manufacture a git command" },
	{ id: "intent quotes the command", command: "git push origin feature", intent: "git push origin main is not wanted", why: "the intent argument is not a command position" },
	{ id: "next line command", command: "git push origin feature\nrm -rf main", why: "the argument scan must stop at the newline, which JSON encodes as \\n without whitespace" },
];

describe("must fire", () => {
	for (const c of MUST_FIRE) {
		test(`${c.id} — ${c.why}`, () => {
			for (const buffer of buffers(c)) expect(fires(buffer)).toBe(true);
		});
	}
});

describe("must not fire", () => {
	for (const c of MUST_NOT_FIRE) {
		test(`${c.id} — ${c.why}`, () => {
			for (const buffer of buffers(c)) expect(fires(buffer)).toBe(false);
		});
	}
});

test("corpus counts", () => {
	const missed = MUST_FIRE.filter(c => buffers(c).some(b => !fires(b))).map(c => c.id);
	const spurious = MUST_NOT_FIRE.filter(c => buffers(c).some(b => fires(b))).map(c => c.id);
	console.log(
		`must-fire ${String(MUST_FIRE.length - missed.length)}/${String(MUST_FIRE.length)} correct; ` +
			`must-not-fire ${String(spurious.length)}/${String(MUST_NOT_FIRE.length)} false positives`,
	);
	for (const id of missed) console.log(`  silent: ${id}`);
	for (const id of spurious) console.log(`  fired: ${id}`);
	expect(missed).toEqual([]);
	expect(spurious).toEqual([]);
	// A single-case corpus would pass every assertion above while proving nothing.
	expect(MUST_FIRE.length).toBeGreaterThan(20);
	expect(MUST_NOT_FIRE.length).toBeGreaterThan(20);
});
