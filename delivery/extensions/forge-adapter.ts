/**
 * GitHub and GitLab adapters for the branch-deletion half of a landing.
 *
 * A landing has two provable halves: the pull request merged, and its source
 * branch is gone from the remote. This module owns the second half for GitHub
 * and GitLab, and owns exactly one honest answer for everything else:
 * `"unknown"`.
 *
 * Four properties hold throughout this file.
 *
 * Every command is an argv array with a bounded timeout. Nothing reaches a
 * shell, so a branch name can never become a command. The one argv-level attack
 * that survives an array — a value starting with `-` that the CLI reads as an
 * option — is rejected before the command is built.
 *
 * A setting changes only when a caller asks. {@link autoDeleteSetting} reads;
 * {@link enableAutoDelete} writes; nothing in this module calls
 * {@link enableAutoDelete}, so no read, merge, or verification path can mutate a
 * repository's configuration as a side effect.
 *
 * Absence is observed, never inferred. A merge that requested deletion, and a
 * settings field reading `"on"`, are requests and intentions. Only
 * `git ls-remote` failing to find the exact ref returns `"absent"`. A timeout, a
 * malformed response, a permission failure, and a protected or ruleset-blocked
 * deletion all stay `"unknown"`, and `"unknown"` is never promoted.
 *
 * A forge is a runtime value, not a compile-time promise. {@link Forge} arrives
 * from a receipt, a JSON payload, or another package, so every function that
 * dispatches on it narrows to the literal `"github"` or `"gitlab"` and refuses
 * anything else by name. Nothing falls through to a default provider: a
 * repository recorded as `"bitbucket"` must not be merged with `glab`.
 *
 * Per decision omp-plugins-9ej3.1 this is a library module: the delivery tools
 * import it, and it is never declared in `omp.extensions`.
 */

export type Forge = "github" | "gitlab" | "unknown";

/**
 * What one bounded CLI invocation observed.
 *
 * `ok` means the command ran to completion and its exit status was observed —
 * not that the status was zero. `git ls-remote --exit-code` reports absence with
 * exit 2, so callers must read `exitCode` themselves; collapsing the two would
 * make a meaningful non-zero exit indistinguishable from a timeout. When `ok` is
 * false, `error` says why no status exists.
 */
export type CliResult = {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
};

export type CliRunner = (
	argv: string[],
	options: { cwd?: string; timeoutMs: number; env?: Readonly<Record<string, string>> },
) => CliResult;

/**
 * Wall-clock ceiling for every command this module issues.
 *
 * A forge API call crosses the network, so the bound is generous; it exists so
 * that an unreachable remote or a credential helper waiting on a prompt degrades
 * to `"unknown"` instead of hanging a session.
 */
export const FORGE_TIMEOUT_MS = 10_000;

/** Upper bound on nested GitLab group segments plus the project (20 + 1). */
const GITLAB_MAX_PATH_SEGMENTS = 21;

/**
 * Hosts whose remotes this module can act on.
 *
 * `ssh.github.com` and `altssh.gitlab.com` are each vendor's documented
 * alternate SSH endpoint for networks that block port 22. A self-hosted instance
 * is deliberately not recognised, because its API dialect is not verified here.
 *
 * A host is attacker-influenced input. The allowlist therefore has a null
 * prototype, is frozen, and is read through an own-property descriptor rather
 * than a dynamic property access that could consult polluted prototypes.
 */
const FORGE_HOSTS: Readonly<Record<string, "github" | "gitlab">> = Object.freeze(
	Object.assign(Object.create(null) as Record<string, "github" | "gitlab">, {
		"github.com": "github",
		"ssh.github.com": "github",
		"gitlab.com": "gitlab",
		"altssh.gitlab.com": "gitlab",
	}),
);

/**
 * The only transports whose host this module will trust.
 *
 * `https` and `ssh` are what GitHub and GitLab.com actually serve. Everything
 * else is refused rather than parsed: `file://` and a local path name no host at
 * all, `git://` is unauthenticated and GitHub no longer serves it, `http://`
 * is not a transport either vendor offers, and a custom scheme is by definition
 * unverified. Each becomes `"unknown"`, which is the safe answer — a caller that
 * cannot identify the forge refuses instead of guessing one.
 */
const ALLOWED_SCHEME = /^(?:https|ssh):\/\//i;

/** Any scheme at all, used only to tell "unverified scheme" from "no scheme". */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The scp-like spelling Git accepts without a scheme: `[user@]host:path`.
 *
 * The colon must come before any slash, which is what separates
 * `git@github.com:o/r` from a bare `github.com/o/r` and from `/Users/me/repo`.
 * Both of those name no host and are deliberately not recognised.
 */
const SCP_LIKE = /^(?:[^@/:]+@)?([^@/:]+):(?!\/)/;
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Characters that disqualify a branch name.
 *
 * `~^:?*[]\` and whitespace are what `git check-ref-format` itself forbids. The
 * shell operators after them are not Git's rule and are refused anyway: a
 * refusal from this module quotes the command it could not complete, and an
 * operator inside a branch name would turn that diagnostic into working shell
 * the moment a human or an agent pasted it. Nothing here is ever executed
 * through a shell, so this is the second lock, not the first.
 */
const REF_FORBIDDEN = /[~^:?*[\]\\\s;&|<>$`(){}'"!#]/;

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Command-line protocol and helper policy for the one Git observation.
 *
 * The general deny blocks unknown remote helpers; the explicit allows retain
 * the three non-executable transports this observation needs. The `ext` deny
 * overrides a repository-local allow. The remaining pins neutralise executable
 * helper choices from repository config: an upload-pack override, an SSH command,
 * an askpass program, or a credential helper must not turn a read into code
 * execution controlled by the checkout.
 */
const LS_REMOTE_PROTOCOL_POLICY = [
	"-c", "protocol.allow=never",
	"-c", "protocol.file.allow=always",
	"-c", "protocol.https.allow=always",
	"-c", "protocol.ssh.allow=always",
	"-c", "protocol.ext.allow=never",
	"-c", "core.sshCommand=ssh",
	"-c", "core.askPass=",
	"-c", "credential.helper=",
	"-c", "credential.interactive=never",
] as const;

/**
 * A clean environment for Git's remote observation.
 *
 * Git's `GIT_SSH*`, `GIT_PROXY_COMMAND`, `GIT_EXEC_PATH`, and environment-backed
 * config variables all select executables without appearing in argv. Preserve
 * ordinary process state, discard every inherited `GIT_*` control plus SSH's
 * askpass hook, then add back only the non-executable protocol allowlist and the
 * non-interactive prompt setting this operation owns.
 */
function gitObservationEnvironment(): Readonly<Record<string, string>> {
	const env = Object.create(null) as Record<string, string>;
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("GIT_") || key === "SSH_ASKPASS" || key === "SSH_ASKPASS_REQUIRE") continue;
		env[key] = value;
	}
	env.GIT_ALLOW_PROTOCOL = "file:https:ssh";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

/** Git object ids emitted by `ls-remote`: SHA-1 or SHA-256, in canonical case. */
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Control characters, checked by code point rather than by a regex class so the
 * literal stays free of the control bytes it is meant to reject.
 */
function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Whether a value is safe to pass as one argv element.
 *
 * Quoting is not the concern — an argv array has no shell to quote for. What
 * remains is option injection: a remote named `--upload-pack=...` is read by Git
 * as a flag no matter how carefully it was passed. Empty strings and control
 * characters are refused for the same reason: neither can name a real remote.
 */
function isSafeArgument(value: string): boolean {
	return value !== "" && !value.startsWith("-") && !hasControlCharacter(value);
}

/**
 * Whether `branch` is a Git branch name this module will build a ref from.
 *
 * The subset of `git check-ref-format` that matters here. It is applied before
 * any command is built, so a hostile name such as `x; rm -rf .` — which is not a
 * valid ref, because refs cannot contain whitespace — never reaches a command
 * line at all.
 */
function isValidBranchName(branch: string): boolean {
	if (!isSafeArgument(branch)) return false;
	if (REF_FORBIDDEN.test(branch)) return false;
	if (branch === "@" || branch.includes("..") || branch.includes("@{")) return false;
	for (const component of branch.split("/")) {
		if (component === "" || component.startsWith(".")) return false;
		if (component.endsWith(".") || component.endsWith(".lock")) return false;
	}
	return true;
}

/**
 * Validate an `owner/name` (or nested `group/.../project`) path.
 *
 * Returns the normalised path, or null when it cannot be one. A `.` or `..`
 * segment is refused because it would walk the forge API path the caller asked
 * for into a different resource.
 */
function normalizeRepoPath(repo: string, maxSegments: number): string | null {
	const segments = repo.trim().split("/");
	if (segments.length < 2 || segments.length > maxSegments) return null;
	for (const segment of segments) {
		if (!REPO_SEGMENT.test(segment)) return null;
		if (segment === "." || segment === ".." || segment.startsWith("-")) return null;
	}
	return segments.join("/");
}

/**
 * Host of a Git remote URL, lowercased, or null when the spelling names none
 * this module is willing to trust.
 *
 * Exactly three spellings are recognised: `https://[user[:pass]@]host[:port]/p`,
 * `ssh://[user@]host[:port]/p`, and the scp-like `[user@]host:p`. An unverified
 * scheme, a bare `host/p` with no scheme, a relative path, and an absolute path
 * all yield null. Recognising fewer spellings than Git accepts is deliberate:
 * the cost is an `"unknown"` a caller refuses on, and the alternative is
 * classifying a string nobody verified as a forge remote.
 *
 * The two URL forms are parsed with `URL`, not by scanning for delimiters. A
 * hand-rolled scan has to know that the authority ends at the first `/`, `?`, or
 * `#`, and that userinfo only counts inside it. Miss the `?` and `#` and
 * `https://evil.example?@github.com/` reads as GitHub, because the `@` in the
 * query looks like userinfo. `URL` implements the grammar, and also handles
 * IPv6 literals, ports, percent-encoding, and IDN-to-punycode, so a homoglyph
 * host becomes `xn--...` and simply fails the allowlist.
 *
 * A backslash anywhere is refused before parsing. WHATWG `URL` folds `\` to `/`
 * for special schemes, so it reads `https://github.com\@evil.example/` as host
 * `github.com`, while RFC 3986 — which is what curl and therefore Git follow —
 * reads the authority as `github.com\@evil.example`, host `evil.example`. Where
 * two parsers disagree about which host will be contacted, there is no safe
 * answer to give, and no legitimate remote to either forge contains one.
 */
function hostOf(remoteUrl: string): string | null {
	const url = remoteUrl.trim();
	if (url === "" || url.includes("\\")) return null;
	if (ALLOWED_SCHEME.test(url)) {
		try {
			const host = new URL(url).hostname.toLowerCase();
			return host === "" ? null : host;
		} catch {
			return null;
		}
	}
	// A scheme that is not allowlisted is rejected outright, never re-parsed as
	// though it were scp-like: `git://github.com:9418/o/r` has a colon before a
	// slash and would otherwise pass for GitHub.
	if (ANY_SCHEME.test(url)) return null;
	const scpHost = SCP_LIKE.exec(url)?.[1];
	return scpHost === undefined || scpHost === "" ? null : scpHost.toLowerCase();
}

/**
 * The real runner: one bounded child process, argv array, no shell.
 *
 * Every failure mode collapses into the {@link CliResult} contract rather than
 * throwing, so a missing CLI and a hung network are indistinguishable from the
 * caller's point of view — both are simply not an observation.
 */
export const runCli: CliRunner = (argv, options) => {
	if (argv.length === 0) {
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: "no command to run" };
	}
	const timeout = Math.max(1, Math.trunc(options.timeoutMs));
	try {
		const proc = Bun.spawnSync(argv, {
			cwd: options.cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout,
			env: options.env,
		});
		const stdout = proc.stdout.toString();
		const stderr = proc.stderr.toString();
		const exitCode = typeof proc.exitCode === "number" ? proc.exitCode : null;
		const signal = proc.signalCode ?? null;
		if (signal !== null || exitCode === null) {
			const error = signal === null
				? `${argv[0]} produced no exit status within ${timeout}ms`
				: `${argv[0]} was terminated by ${signal} (timeout ${timeout}ms)`;
			return { ok: false, exitCode, stdout, stderr, error };
		}
		return { ok: true, exitCode, stdout, stderr };
	} catch (cause) {
		const error = cause instanceof Error ? cause.message : String(cause);
		return { ok: false, exitCode: null, stdout: "", stderr: "", error };
	}
};

/**
 * Classify a remote URL. Anything not verified is `"unknown"`, which callers
 * must treat as "no adapter", never as a default forge.
 */
export function detectForge(remoteUrl: string | null): Forge {
	if (remoteUrl === null) return "unknown";
	const host = hostOf(remoteUrl);
	if (host === null) return "unknown";
	const descriptor = Object.getOwnPropertyDescriptor(FORGE_HOSTS, host);
	if (descriptor === undefined || !("value" in descriptor)) return "unknown";
	const forge: unknown = descriptor.value;
	return forge === "github" || forge === "gitlab" ? forge : "unknown";
}

/**
 * Render a failed invocation as a refusal reason.
 *
 * The joined argv is a human-readable label, never a command: it is only ever
 * interpolated into prose. Naming the observed and the expected exit status is
 * required by decision omp-plugins-9ej3.1, so a refusal can be acted on without
 * re-running anything.
 */
function describeFailure(argv: string[], result: CliResult): string {
	const label = argv.join(" ");
	if (result.error !== undefined) return `${label} did not complete: ${result.error}`;
	const observed = result.exitCode === null ? "no exit status" : `exit ${result.exitCode}`;
	const stderr = result.stderr.trim();
	const detail = stderr === "" ? "" : `; stderr: ${stderr.slice(0, 400)}`;
	return `${label} observed ${observed}, expected exit 0${detail}`;
}

/**
 * The forge this module has an adapter for, or null.
 *
 * The single gate every dispatching function passes through, and the reason they
 * can dispatch at all. `Forge` is a compile-time promise that a runtime value
 * crossing a package or receipt boundary does not keep, so membership is tested
 * positively against the two literals. A negative test — `forge !== "unknown"` —
 * would let `"bitbucket"` through to whichever provider happened to sit in the
 * `else` branch.
 */
function supportedForge(forge: Forge): "github" | "gitlab" | null {
	return forge === "github" || forge === "gitlab" ? forge : null;
}

/**
 * Read GitLab's boolean out of the project object `glab api` returns.
 *
 * `glab api` has no `--jq` — its flag set offers `--output json|ndjson` and
 * nothing else — so the project is fetched whole and the one field is read here.
 *
 * The field must be an **own data property** holding a boolean. Three narrower
 * checks than they look:
 *
 * An array is refused outright. `typeof [] === "object"` and an array is not
 * null, so a JSON array would otherwise reach the property read; a GitLab project
 * is an object, and a list is a different response shape that must not be
 * interpreted as one.
 *
 * `Object.getOwnPropertyDescriptor` is used rather than `in` or a plain read,
 * because both consult the prototype chain. If anything in the process has set
 * `Object.prototype.remove_source_branch_after_merge = true` — prototype
 * pollution, from any dependency in the session — then `in` finds it and a plain
 * read returns a boolean, and this function would report `"on"` for a project
 * that never had the setting. Reporting a deletion setting as configured when it
 * is not is exactly the promotion of `"unknown"` this module exists to prevent.
 *
 * A descriptor with no `value` key is an accessor, and an accessor is refused
 * rather than invoked: a getter is attacker-supplied code, and reading a
 * repository setting must not execute anything.
 */
function removeSourceBranchAfterMerge(payload: unknown): boolean | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const descriptor = Object.getOwnPropertyDescriptor(payload, "remove_source_branch_after_merge");
	if (descriptor === undefined || !("value" in descriptor)) return null;
	const value: unknown = descriptor.value;
	return typeof value === "boolean" ? value : null;
}

/**
 * Read the forge's own source-branch-deletion-on-merge setting.
 *
 * GitHub calls it `delete_branch_on_merge` and `gh api` can project the field
 * server-side with `--jq`, so the response is the bare boolean. GitLab calls it
 * `remove_source_branch_after_merge` and `glab api` has no `--jq`, so the whole
 * project object comes back and the field is read in TypeScript. Both are reads:
 * this function issues no mutating argv on any path.
 *
 * `"unknown"` covers every case where the field was not read as a boolean — a
 * forge with no adapter, an unusable repository path, a missing CLI, a timeout, a
 * non-zero exit, and any response that is not a boolean in the expected place. It
 * is not a default; a caller that needs the setting to be `"on"` refuses on
 * `"unknown"`.
 *
 * `run` receives no `cwd`: both reads name the repository in the request path.
 * A caller that needs one binds it by wrapping the runner.
 */
export function autoDeleteSetting(forge: Forge, repo: string, run: CliRunner = runCli): "on" | "off" | "unknown" {
	const supported = supportedForge(forge);
	if (supported === null) return "unknown";
	const path = normalizeRepoPath(repo, supported === "github" ? 2 : GITLAB_MAX_PATH_SEGMENTS);
	if (path === null) return "unknown";
	const argv = supported === "github"
		? ["gh", "api", `repos/${path}`, "--jq", ".delete_branch_on_merge"]
		: ["glab", "api", `projects/${encodeURIComponent(path)}`];
	const result = run(argv, { timeoutMs: FORGE_TIMEOUT_MS });
	if (!result.ok || result.exitCode !== 0 || result.error !== undefined) return "unknown";
	const text = result.stdout.trim();
	if (text === "") return "unknown";
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "unknown";
	}
	const value = supported === "github" ? parsed : removeSourceBranchAfterMerge(parsed);
	if (value === true) return "on";
	if (value === false) return "off";
	return "unknown";
}

/**
 * Turn the forge's deletion-on-merge setting on. A setup action only.
 *
 * Nothing in this module calls this function, and nothing should call it except
 * a caller acting on an explicit setup request: changing a repository's
 * configuration as a side effect of landing one branch would alter every future
 * merge by every contributor.
 *
 * Both endpoints take a boolean, so both writes use the typed field flag — `-F`
 * on `gh` and on `glab`, where `-f`/`--raw-field` would send the string
 * `"true"`. `glab`'s `-F` also defaults the method to POST, which is why `-X PUT`
 * is passed explicitly rather than relied upon.
 *
 * `ok: true` means the forge accepted the request, which is still not proof that
 * the setting is on. A caller that needs proof re-reads with
 * {@link autoDeleteSetting}.
 */
export function enableAutoDelete(forge: Forge, repo: string, run: CliRunner = runCli): { ok: boolean; reason?: string } {
	const supported = supportedForge(forge);
	if (supported === null) {
		return {
			ok: false,
			reason: `forge is ${JSON.stringify(forge)}, expected "github" or "gitlab": no settings API is known for this remote`,
		};
	}
	const path = normalizeRepoPath(repo, supported === "github" ? 2 : GITLAB_MAX_PATH_SEGMENTS);
	if (path === null) {
		const expected = supported === "github" ? '"<owner>/<name>"' : '"<group>/<project>", optionally with nested groups';
		return { ok: false, reason: `repo is ${JSON.stringify(repo)}, expected ${expected}` };
	}
	const argv = supported === "github"
		? ["gh", "api", "-X", "PATCH", `repos/${path}`, "-F", "delete_branch_on_merge=true"]
		: ["glab", "api", "-X", "PUT", `projects/${encodeURIComponent(path)}`, "-F", "remove_source_branch_after_merge=true"];
	const result = run(argv, { timeoutMs: FORGE_TIMEOUT_MS });
	if (!result.ok || result.exitCode !== 0 || result.error !== undefined) {
		return { ok: false, reason: describeFailure(argv, result) };
	}
	return { ok: true };
}

export type MergeOptions = {
	/**
	 * Ask the forge to delete the source branch as part of the merge. Default
	 * true. Set false when the branch is protected or held by a ruleset: the
	 * request would fail the merge, and the branch is then cleaned separately.
	 */
	deleteBranch?: boolean;
};

/**
 * Resolve the deletion request without consulting an inherited value or
 * invoking an accessor. Only an own data property containing a boolean can
 * override the safe default of requesting deletion.
 */
function shouldDeleteSourceBranch(options: MergeOptions): boolean {
	if (typeof options !== "object" || options === null || Array.isArray(options)) return true;
	const descriptor = Object.getOwnPropertyDescriptor(options, "deleteBranch");
	if (descriptor === undefined || !("value" in descriptor)) return true;
	return typeof descriptor.value === "boolean" ? descriptor.value : true;
}

/**
 * The argv that merges `pr` and, by default, requests source-branch deletion.
 *
 * Building the command is all this does. The returned argv is a *request*: a
 * zero exit from it proves the merge, never that the branch is gone. Only
 * {@link remoteBranchAbsent} can answer that.
 *
 * An unsupported forge throws rather than returning a guess, because there is no
 * argv that is correct-but-unproven here: any fabricated CLI name would either
 * fail obscurely or, worse, hit an unrelated binary.
 */
export function mergeArgs(forge: Forge, pr: number | string, options: MergeOptions = {}): string[] {
	const supported = supportedForge(forge);
	if (supported === null) {
		throw new Error(`mergeArgs cannot choose a CLI: forge is ${JSON.stringify(forge)}, expected "github" or "gitlab"`);
	}
	const number = typeof pr === "number" ? String(pr) : pr.trim();
	if (!POSITIVE_INTEGER.test(number)) {
		throw new Error(`mergeArgs refuses pr ${JSON.stringify(pr)}, expected a positive integer`);
	}
	const deleteBranch = shouldDeleteSourceBranch(options);
	if (supported === "github") {
		const argv = ["gh", "pr", "merge", number, "--squash"];
		if (deleteBranch) argv.push("--delete-branch");
		return argv;
	}
	const argv = ["glab", "mr", "merge", number, "--squash"];
	if (deleteBranch) argv.push("--remove-source-branch");
	return argv;
}

/**
 * Whether stdout is exactly one `<oid>\t<ref>` record for `expectedRef`.
 *
 * An exact-ref query should return at most one record. Extra, duplicate, blank,
 * unrelated, or non-canonical records are not partial proof; they make the
 * observation unknown. One final LF is accepted because it is Git's normal
 * record terminator. CRLF and embedded newlines are rejected rather than
 * normalised at this trust boundary.
 */
function stdoutProvesExactHead(stdout: string, expectedRef: string): boolean {
	if (stdout === "") return false;
	const record = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (record === "" || record.includes("\n") || record.includes("\r")) return false;
	const separator = record.indexOf("\t");
	if (separator <= 0 || record.indexOf("\t", separator + 1) !== -1) return false;
	return GIT_OID.test(record.slice(0, separator)) && record.slice(separator + 1) === expectedRef;
}

/**
 * Whether `branch` is gone from `remote`, observed against the exact ref.
 *
 * `git ls-remote --exit-code` reports exit 2 when no ref matched. That status
 * proves `"absent"` only with empty stdout and stderr. Exit 0 proves
 * `"present"` only when stdout is exactly one canonical object-id record for
 * the requested ref. Empty, malformed, unrelated, duplicate, or contradictory
 * output stays `"unknown"`, as does every other status, timeout, or spawn
 * failure.
 *
 * The ref is spelled in full as `refs/heads/<branch>`, not as a bare name or a
 * pattern, so `feature` cannot be answered by `feature-2`.
 *
 * This is the only function in the module that returns `"absent"`, and it only
 * ever does so from this observation. No merge result, deletion response, or
 * setting value reaches it.
 */
export function remoteBranchAbsent(remote: string, branch: string, run: CliRunner = runCli): "absent" | "present" | "unknown" {
	if (!isSafeArgument(remote) || !isValidBranchName(branch)) return "unknown";
	const ref = `refs/heads/${branch}`;
	const argv = [
		"git",
		...LS_REMOTE_PROTOCOL_POLICY,
		"ls-remote",
		"--exit-code",
		"--heads",
		"--upload-pack=git-upload-pack",
		remote,
		ref,
	];
	const result = run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env: gitObservationEnvironment() });
	if (!result.ok || result.error !== undefined) return "unknown";
	if (result.exitCode === 0) return stdoutProvesExactHead(result.stdout, ref) ? "present" : "unknown";
	if (result.exitCode === 2 && result.stdout === "" && result.stderr === "") return "absent";
	return "unknown";
}
