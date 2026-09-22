import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as adapter from "./forge-adapter.ts";
import {
	autoDeleteSetting,
	type CliResult,
	type CliRunner,
	detectForge,
	enableAutoDelete,
	FORGE_TIMEOUT_MS,
	type Forge,
	forgeEnvironment,
	mergeArgs,
	remoteBranchAbsent,
	runCli,
} from "./forge-adapter.ts";

type Call = {
	argv: string[];
	cwd: string | undefined;
	timeoutMs: number;
	env: Readonly<Record<string, string>> | undefined;
};

type MergeOptionsForTest = NonNullable<Parameters<typeof mergeArgs>[2]>;

/** A runner that records every invocation and answers with one fixed result. */
const spy = (result: CliResult) => {
	const calls: Call[] = [];
	const run: CliRunner = (argv, options) => {
		calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
		return result;
	};
	return { run, calls };
};

const completed = (exitCode: number, stdout = "", stderr = ""): CliResult => ({
	ok: true,
	exitCode,
	stdout,
	stderr,
});

const SHA1_OID = "0123456789abcdef0123456789abcdef01234567";
const SHA256_OID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const headRecord = (branch: string, oid = SHA1_OID): string => `${oid}\trefs/heads/${branch}\n`;

/**
 * The working directory the absence probe is asked from.
 *
 * A remote name only resolves inside the repository that configures it, so the
 * probe takes the directory explicitly; the spy records what it was given.
 */
const REPO_CWD = "/repository/main";

const timedOut: CliResult = {
	ok: false,
	exitCode: null,
	stdout: "",
	stderr: "",
	error: "gh was terminated by SIGTERM (timeout 10000ms)",
};

const missingCli: CliResult = {
	ok: false,
	exitCode: null,
	stdout: "",
	stderr: "",
	error: "spawn gh ENOENT",
};

const forbidden: CliResult = {
	ok: true,
	exitCode: 1,
	stdout: "",
	stderr: "HTTP 403: Resource not accessible by integration",
};

/** The GitLab project field the adapter reads; also the prototype-pollution target. */
const GITLAB_FIELD = "remove_source_branch_after_merge";

/**
 * What `glab api projects/<encoded>` returns: the whole project object, because
 * `glab api` has no `--jq` to project the one field server-side.
 */
const gitlabProject = (removeSourceBranchAfterMerge: unknown): string =>
	JSON.stringify({
		id: 4711,
		path_with_namespace: "group/project",
		default_branch: "main",
		remove_source_branch_after_merge: removeSourceBranchAfterMerge,
	});

/**
 * Forge values a runtime caller can really hand over.
 *
 * `Forge` is a compile-time union, but these functions are trust boundaries: the
 * value arrives from a receipt, a JSON payload, or another package. The cast is
 * the point of these tests — it reproduces exactly what the type system cannot
 * prevent, including the defect review .16 caught, where anything that was not
 * `"github"` fell through to the GitLab branch and `"bitbucket"` would have been
 * merged with `glab`.
 */
const UNSUPPORTED_FORGES = [
	"unknown",
	"bitbucket",
	"gitea",
	"codeberg",
	"GitHub",
	"github ",
	" gitlab",
	"gitlab.com",
	"Gitlab",
	"",
	"constructor",
	"__proto__",
] as string[] as Forge[];

/**
 * Anything a shell would treat as syntax, plus whitespace. No argv this module
 * builds from valid input may contain one; nothing is ever handed to a shell, so
 * a hit means a hostile value slipped past validation into a command line.
 */
const SHELL_METACHARACTER = /[;&|<>$`(){}[\]!*?~#\\'"\s]/;

const MUTATING_HTTP_METHOD = /^(?:PATCH|PUT|POST|DELETE)$/;

describe("forgeEnvironment", () => {
	test("strips every forge repository and host redirector while preserving credentials", () => {
		const clean = forgeEnvironment({
			GH_REPO: "attacker/elsewhere",
			GH_HOST: "evil.example",
			GITLAB_HOST: "evil.example",
			GL_HOST: "evil.example",
			GITLAB_URI: "https://evil.example",
			GITLAB_API_HOST: "api.evil.example",
			GH_TOKEN: "keep-gh",
			GITLAB_TOKEN: "keep-gitlab",
			GL_TOKEN: "keep-gl",
			PATH: "/usr/bin",
		});

		for (const key of ["GH_REPO", "GH_HOST", "GITLAB_HOST", "GL_HOST", "GITLAB_URI", "GITLAB_API_HOST"]) {
			expect(clean[key]).toBeUndefined();
		}
		expect(clean.GH_TOKEN).toBe("keep-gh");
		expect(clean.GITLAB_TOKEN).toBe("keep-gitlab");
		expect(clean.GL_TOKEN).toBe("keep-gl");
		expect(clean.PATH).toBe("/usr/bin");
	});
});

describe("detectForge", () => {
	test("https remotes", () => {
		expect(detectForge("https://github.com/srobroek/omp-plugins.git")).toBe("github");
		expect(detectForge("https://gitlab.com/group/project.git")).toBe("gitlab");
	});

	test("scp-like ssh remotes", () => {
		expect(detectForge("git@github.com:srobroek/omp-plugins.git")).toBe("github");
		expect(detectForge("git@gitlab.com:group/project.git")).toBe("gitlab");
	});

	test("ssh:// remotes, including an explicit port", () => {
		expect(detectForge("ssh://git@github.com/srobroek/omp-plugins.git")).toBe("github");
		expect(detectForge("ssh://git@gitlab.com:2222/group/project.git")).toBe("gitlab");
	});

	test("embedded credentials do not hide the host", () => {
		expect(detectForge("https://someone:ghp_token@github.com/o/r")).toBe("github");
		expect(detectForge("https://oauth2:glpat-token@gitlab.com/g/p")).toBe("gitlab");
	});

	test("host comparison is case-insensitive", () => {
		expect(detectForge("https://GitHub.COM/o/r")).toBe("github");
	});

	test("documented alternate ssh endpoints are the same forge", () => {
		expect(detectForge("ssh://git@ssh.github.com:443/o/r.git")).toBe("github");
		expect(detectForge("ssh://git@altssh.gitlab.com:443/g/p.git")).toBe("gitlab");
	});

	test("a lookalike host is not the forge", () => {
		expect(detectForge("https://github.com.evil.example/o/r")).toBe("unknown");
		expect(detectForge("git@notgithub.com:o/r.git")).toBe("unknown");
		expect(detectForge("https://gitlab.company.example/g/p.git")).toBe("unknown");
	});

	test("a query or fragment containing @forge cannot become the authority", () => {
		// The defect this pins: a delimiter scan that stops at `/` and `:` but not at
		// `?` or `#` reads the `@` in a query as userinfo and hands back github.com.
		expect(detectForge("https://evil.example?@github.com/")).toBe("unknown");
		expect(detectForge("https://evil.example#@github.com/")).toBe("unknown");
		expect(detectForge("https://evil.example?x=@github.com")).toBe("unknown");
		expect(detectForge("https://evil.example#x@github.com")).toBe("unknown");
		expect(detectForge("ssh://evil.example?@github.com/")).toBe("unknown");
		expect(detectForge("ssh://evil.example#@gitlab.com/")).toBe("unknown");
		expect(detectForge("https://evil.example?@gitlab.com:443/g/p")).toBe("unknown");
	});

	test("a path, ref, or userinfo containing the forge host cannot spoof it", () => {
		expect(detectForge("https://evil.example/github.com/o/r")).toBe("unknown");
		expect(detectForge("https://evil.example/o/r@github.com")).toBe("unknown");
		// Here github.com:443 is userinfo, and evil.example is the real authority.
		expect(detectForge("https://github.com:443@evil.example/o/r")).toBe("unknown");
		expect(detectForge("https://github.com@evil.example/o/r")).toBe("unknown");
		expect(detectForge("ssh://gitlab.com@evil.example/g/p")).toBe("unknown");
	});

	test("a backslash is refused, because URL and RFC 3986 disagree about the host", () => {
		// WHATWG URL folds `\` to `/` and answers github.com; RFC 3986, which curl
		// and therefore Git follow, reads the authority as github.com\@evil.example.
		expect(detectForge("https://github.com\\@evil.example/o/r")).toBe("unknown");
		expect(detectForge("https://evil.example\\@github.com/o/r")).toBe("unknown");
		expect(detectForge("https://github.com\\.evil.example/o/r")).toBe("unknown");
		expect(detectForge("git@github.com:o\\r")).toBe("unknown");
	});

	test("a homoglyph host is punycoded and fails the allowlist", () => {
		// Cyrillic i in "github", Cyrillic a in "gitlab".
		expect(detectForge("https://gіthub.com/o/r")).toBe("unknown");
		expect(detectForge("https://gitlаb.com/g/p")).toBe("unknown");
	});

	test("an authority that is not a hostname is unknown", () => {
		expect(detectForge("https://[::1]/o/r")).toBe("unknown");
		expect(detectForge("https://127.0.0.1/o/r")).toBe("unknown");
		expect(detectForge("https://")).toBe("unknown");
		expect(detectForge("https:///o/r")).toBe("unknown");
		expect(detectForge("ssh://@github.com/o/r")).toBe("github");
	});

	test("a query or fragment on a real forge remote is still that forge", () => {
		expect(detectForge("https://github.com/o/r?x=1#y")).toBe("github");
		expect(detectForge("https://gitlab.com/g/p#frag")).toBe("gitlab");
		expect(detectForge("https://user:pass@github.com:443/o/r?x=1")).toBe("github");
	});

	test("null, empty, and local remotes are unknown", () => {
		expect(detectForge(null)).toBe("unknown");
		expect(detectForge("")).toBe("unknown");
		expect(detectForge("   ")).toBe("unknown");
		expect(detectForge("/Users/sjors/dev/omp-plugins")).toBe("unknown");
		expect(detectForge("./omp-plugins")).toBe("unknown");
		expect(detectForge("../omp-plugins")).toBe("unknown");
		expect(detectForge("~/dev/omp-plugins")).toBe("unknown");
		expect(detectForge("C:\\dev\\omp-plugins")).toBe("unknown");
	});

	test("only https, ssh, and scp-like spellings are trusted transports", () => {
		expect(detectForge("file:///Users/sjors/dev/omp-plugins")).toBe("unknown");
		expect(detectForge("git://github.com/o/r.git")).toBe("unknown");
		expect(detectForge("git+ssh://git@github.com/o/r.git")).toBe("unknown");
		expect(detectForge("ftp://github.com/o/r")).toBe("unknown");
		expect(detectForge("forge://github.com/o/r")).toBe("unknown");
		// Plain HTTP is not a transport either vendor serves; unknown is the safe answer.
		expect(detectForge("http://github.com/o/r")).toBe("unknown");
		expect(detectForge("http://gitlab.com/g/p")).toBe("unknown");
	});

	test("a bare host with no scheme names no verified transport", () => {
		expect(detectForge("github.com/srobroek/omp-plugins")).toBe("unknown");
		expect(detectForge("gitlab.com/group/project")).toBe("unknown");
		expect(detectForge("github.com")).toBe("unknown");
		expect(detectForge("git@github.com")).toBe("unknown");
	});

	test("an unverified scheme is refused, never re-read as scp-like", () => {
		// `git://github.com:9418/o/r` has a colon before a slash, so a parser that
		// fell back to the scp-like branch would happily call this GitHub.
		expect(detectForge("git://github.com:9418/o/r")).toBe("unknown");
		expect(detectForge("http://github.com:8080/o/r")).toBe("unknown");
	});

	test("a prototype key is not a forge", () => {
		expect(detectForge("https://constructor/o/r")).toBe("unknown");
		expect(detectForge("https://__proto__/o/r")).toBe("unknown");
		expect(detectForge("https://toString/o/r")).toBe("unknown");
	});

	test("a polluted prototype cannot add a forge host", () => {
		const pollutedHost = "polluted.example";
		Object.defineProperty(Object.prototype, pollutedHost, {
			value: "github",
			configurable: true,
			enumerable: false,
			writable: true,
		});
		try {
			expect(detectForge(`https://${pollutedHost}/o/r`)).toBe("unknown");
		} finally {
			Reflect.deleteProperty(Object.prototype, pollutedHost);
		}
	});
});

describe("autoDeleteSetting", () => {
	test("github reads delete_branch_on_merge with the documented argv", () => {
		const { run, calls } = spy(completed(0, "true\n"));
		expect(autoDeleteSetting("github", "srobroek/omp-plugins", run)).toBe("on");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.argv).toEqual([
			"gh",
			"api",
			"repos/srobroek/omp-plugins",
			"--jq",
			".delete_branch_on_merge",
		]);
		expect(calls[0]?.timeoutMs).toBe(FORGE_TIMEOUT_MS);
	});

	test("gitlab fetches the project object, with no --jq, and reads the field itself", () => {
		const { run, calls } = spy(completed(0, gitlabProject(true)));
		expect(autoDeleteSetting("gitlab", "group/sub/project", run)).toBe("on");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.argv).toEqual(["glab", "api", "projects/group%2Fsub%2Fproject"]);
		expect(calls[0]?.argv).not.toContain("--jq");
		expect(calls[0]?.argv).not.toContain("-q");
		expect(calls[0]?.timeoutMs).toBe(FORGE_TIMEOUT_MS);
	});

	test("false is off, for both forges", () => {
		expect(autoDeleteSetting("github", "o/r", spy(completed(0, "false\n")).run)).toBe("off");
		expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, gitlabProject(false))).run)).toBe("off");
	});

	test("github: a field the response omits reads as null, which is neither on nor off", () => {
		expect(autoDeleteSetting("github", "o/r", spy(completed(0, "null\n")).run)).toBe("unknown");
	});

	test("gitlab: a project object without the field is unknown, not off", () => {
		const withoutField = JSON.stringify({ id: 4711, path_with_namespace: "group/project" });
		expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, withoutField)).run)).toBe("unknown");
	});

	test("gitlab: a field present but not a boolean is unknown", () => {
		for (const value of ["true", "false", 1, 0, null, {}, [], "yes"]) {
			expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, gitlabProject(value))).run)).toBe("unknown");
		}
	});

	test("gitlab: a JSON key that only looks like a prototype write cannot answer", () => {
		// JSON.parse defines `__proto__` as an own property rather than mutating the
		// prototype, so neither of these puts the field where a read would find it.
		for (const stdout of ['{"constructor":true}', '{"__proto__":{"remove_source_branch_after_merge":true}}']) {
			expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, stdout)).run)).toBe("unknown");
		}
	});

	test("gitlab: a polluted Object.prototype cannot answer for the field", () => {
		// The defect this pins: `in` and a plain property read both consult the
		// prototype chain, so one polluting dependency anywhere in the session would
		// make every project report its deletion setting as configured.
		Object.defineProperty(Object.prototype, GITLAB_FIELD, {
			value: true,
			configurable: true,
			enumerable: false,
			writable: true,
		});
		try {
			expect(GITLAB_FIELD in {}).toBe(true);
			expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, '{"id":4711}')).run)).toBe("unknown");
		} finally {
			Reflect.deleteProperty(Object.prototype, GITLAB_FIELD);
		}
		expect(GITLAB_FIELD in {}).toBe(false);
	});

	test("gitlab: an inherited getter is refused rather than invoked", () => {
		let invoked = 0;
		Object.defineProperty(Object.prototype, GITLAB_FIELD, {
			get: () => {
				invoked += 1;
				return true;
			},
			configurable: true,
			enumerable: false,
		});
		try {
			expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, '{"id":4711}')).run)).toBe("unknown");
			expect(invoked).toBe(0);
		} finally {
			Reflect.deleteProperty(Object.prototype, GITLAB_FIELD);
		}
		expect(GITLAB_FIELD in {}).toBe(false);
	});

	test("gitlab: an array response is refused before any property is read", () => {
		for (const stdout of ["[]", '[{"remove_source_branch_after_merge":true}]', '["remove_source_branch_after_merge"]']) {
			expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, stdout)).run)).toBe("unknown");
		}
	});

	test("gitlab: a response that is not an object is unknown", () => {
		for (const stdout of ["", "   ", "true", "false", "null", "[]", '"project"', "42", "<html>", "{"]) {
			expect(autoDeleteSetting("gitlab", "g/p", spy(completed(0, stdout)).run)).toBe("unknown");
		}
	});

	test("github: output that is not a boolean is unknown", () => {
		for (const stdout of ["", "   ", "yes", "1", "True", "gh: command not found", "{", '{"a":1}', "[true]", '"true"']) {
			expect(autoDeleteSetting("github", "o/r", spy(completed(0, stdout)).run)).toBe("unknown");
		}
	});

	test("a non-zero exit is unknown even when stdout looks like an answer", () => {
		expect(autoDeleteSetting("github", "o/r", spy(completed(1, "true\n")).run)).toBe("unknown");
		expect(autoDeleteSetting("gitlab", "g/p", spy(completed(1, gitlabProject(true))).run)).toBe("unknown");
	});

	test("insufficient permissions is unknown, never off", () => {
		expect(autoDeleteSetting("github", "o/r", spy(forbidden).run)).toBe("unknown");
		expect(autoDeleteSetting("gitlab", "g/p", spy(forbidden).run)).toBe("unknown");
	});

	test("a timeout and a missing cli are unknown", () => {
		expect(autoDeleteSetting("github", "o/r", spy(timedOut).run)).toBe("unknown");
		expect(autoDeleteSetting("github", "o/r", spy(missingCli).run)).toBe("unknown");
		expect(autoDeleteSetting("gitlab", "g/p", spy(timedOut).run)).toBe("unknown");
		expect(autoDeleteSetting("gitlab", "g/p", spy(missingCli).run)).toBe("unknown");
	});

	test("a forge with no adapter never runs a cli and never falls through to one", () => {
		for (const forge of UNSUPPORTED_FORGES) {
			const { run, calls } = spy(completed(0, gitlabProject(true)));
			expect(autoDeleteSetting(forge, "group/project", run)).toBe("unknown");
			expect(calls).toHaveLength(0);
		}
	});

	test("an unusable repository path never runs a cli", () => {
		for (const repo of ["", "   ", "owner", "owner/", "/repo", "owner//repo", "owner/../other/repo", "owner/./repo", "-owner/repo", "owner/repo?x=1", "owner/re po", "owner/repo/extra"]) {
			const { run, calls } = spy(completed(0, "true\n"));
			expect(autoDeleteSetting("github", repo, run)).toBe("unknown");
			expect(calls).toHaveLength(0);
		}
	});

	test("the read path issues no mutating argv", () => {
		for (const forge of ["github", "gitlab"] as const) {
			const { run, calls } = spy(completed(0, "false\n"));
			autoDeleteSetting(forge, "group/project", run);
			expect(calls).toHaveLength(1);
			for (const call of calls) {
				expect(call.argv).not.toContain("-X");
				expect(call.argv).not.toContain("-f");
				expect(call.argv).not.toContain("-F");
				expect(call.argv.some(part => MUTATING_HTTP_METHOD.test(part))).toBe(false);
				expect(call.argv.some(part => part.endsWith("=true"))).toBe(false);
			}
		}
	});
});

describe("enableAutoDelete", () => {
	test("github issues the documented PATCH argv with a typed field", () => {
		const { run, calls } = spy(completed(0, "{}"));
		expect(enableAutoDelete("github", "srobroek/omp-plugins", run)).toEqual({ ok: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.argv).toEqual([
			"gh",
			"api",
			"-X",
			"PATCH",
			"repos/srobroek/omp-plugins",
			"-F",
			"delete_branch_on_merge=true",
		]);
		expect(calls[0]?.timeoutMs).toBe(FORGE_TIMEOUT_MS);
	});

	test("gitlab issues the documented PUT argv with a typed field", () => {
		const { run, calls } = spy(completed(0, "{}"));
		expect(enableAutoDelete("gitlab", "group/sub/project", run)).toEqual({ ok: true });
		expect(calls[0]?.argv).toEqual([
			"glab",
			"api",
			"-X",
			"PUT",
			"projects/group%2Fsub%2Fproject",
			"-F",
			"remove_source_branch_after_merge=true",
		]);
		expect(calls[0]?.timeoutMs).toBe(FORGE_TIMEOUT_MS);
	});

	test("the endpoints take booleans, so neither write uses a raw string field", () => {
		for (const forge of ["github", "gitlab"] as const) {
			const { run, calls } = spy(completed(0, "{}"));
			enableAutoDelete(forge, "group/project", run);
			// `-f`/`--raw-field` would send the string "true" to a boolean field.
			expect(calls[0]?.argv).not.toContain("-f");
			expect(calls[0]?.argv).not.toContain("--raw-field");
			expect(calls[0]?.argv).toContain("-F");
			// glab's -F defaults the method to POST, so the method is always explicit.
			expect(calls[0]?.argv).toContain("-X");
			expect(calls[0]?.argv.indexOf("-X")).toBeLessThan(calls[0]?.argv.indexOf("-F") ?? -1);
		}
	});

	test("a rejected request names the observed and expected exit status", () => {
		const result = enableAutoDelete("github", "o/r", spy(forbidden).run);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("observed exit 1");
		expect(result.reason).toContain("expected exit 0");
		expect(result.reason).toContain("Resource not accessible by integration");
	});

	test("a timeout and a missing cli refuse with the cause", () => {
		expect(enableAutoDelete("github", "o/r", spy(timedOut).run).reason).toContain("terminated by SIGTERM");
		expect(enableAutoDelete("github", "o/r", spy(missingCli).run).reason).toContain("ENOENT");
	});

	test("a forge with no adapter refuses by name and never runs a cli", () => {
		for (const forge of UNSUPPORTED_FORGES) {
			const { run, calls } = spy(completed(0, "{}"));
			const result = enableAutoDelete(forge, "group/project", run);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain(`forge is ${JSON.stringify(forge)}`);
			expect(result.reason).toContain('expected "github" or "gitlab"');
			expect(calls).toHaveLength(0);
		}
	});

	test("an unusable repository path refuses without running a cli", () => {
		const { run, calls } = spy(completed(0, "{}"));
		const result = enableAutoDelete("github", "owner/../other/repo", run);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("owner/../other/repo");
		expect(result.reason).toContain("<owner>/<name>");
		expect(calls).toHaveLength(0);
	});

	test("an accepted request is not proof that the setting is on", () => {
		expect(enableAutoDelete("github", "o/r", spy(completed(0, "{}")).run)).toEqual({ ok: true });
		expect(autoDeleteSetting("github", "o/r", spy(completed(0, "false\n")).run)).toBe("off");
		expect(autoDeleteSetting("github", "o/r", spy(timedOut).run)).toBe("unknown");
	});

	test("no other exported function issues a mutating argv", () => {
		const calls: Call[] = [];
		const run: CliRunner = (argv, options) => {
			calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
			return completed(0, "true\n");
		};
		const forges: Forge[] = ["github", "gitlab", ...UNSUPPORTED_FORGES];
		for (const forge of forges) {
			autoDeleteSetting(forge, "group/project", run);
			remoteBranchAbsent("origin", "omp/agent/omp-plugins-9ej3.4", REPO_CWD, run);
			detectForge("https://github.com/group/project.git");
			try {
				mergeArgs(forge, 42);
			} catch {
				// A forge with no adapter refuses; that refusal issues no argv either.
			}
		}
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.argv).not.toContain("-X");
			expect(call.argv).not.toContain("-F");
			expect(call.argv).not.toContain("-f");
			expect(call.argv.some(part => MUTATING_HTTP_METHOD.test(part))).toBe(false);
		}
	});
});

describe("mergeArgs", () => {
	test("github merges and requests deletion", () => {
		expect(mergeArgs("github", 123)).toEqual(["gh", "pr", "merge", "123", "--squash", "--delete-branch"]);
		expect(mergeArgs("github", "123")).toEqual(["gh", "pr", "merge", "123", "--squash", "--delete-branch"]);
	});

	test("gitlab merges and requests deletion", () => {
		expect(mergeArgs("gitlab", 7)).toEqual(["glab", "mr", "merge", "7", "--squash", "--remove-source-branch"]);
	});

	test("deleteBranch false drops only the deletion request", () => {
		expect(mergeArgs("github", 123, { deleteBranch: false })).toEqual(["gh", "pr", "merge", "123", "--squash"]);
		expect(mergeArgs("gitlab", 7, { deleteBranch: false })).toEqual(["glab", "mr", "merge", "7", "--squash"]);
	});

	test("deleteBranch ignores inherited, accessor, and non-boolean values", () => {
		const inherited = Object.create({ deleteBranch: false }) as MergeOptionsForTest;
		expect(mergeArgs("github", 1, inherited)).toContain("--delete-branch");

		let getterCalls = 0;
		const accessor = {} as MergeOptionsForTest;
		Object.defineProperty(accessor, "deleteBranch", {
			get: () => {
				getterCalls += 1;
				return false;
			},
			configurable: true,
		});
		expect(mergeArgs("gitlab", 1, accessor)).toContain("--remove-source-branch");
		expect(getterCalls).toBe(0);

		for (const value of [undefined, null, 0, "false", {}, []]) {
			expect(mergeArgs("github", 1, { deleteBranch: value } as MergeOptionsForTest)).toContain("--delete-branch");
		}
	});

	test("a polluted Object.prototype cannot disable deletion", () => {
		Object.defineProperty(Object.prototype, "deleteBranch", {
			value: false,
			configurable: true,
			enumerable: false,
			writable: true,
		});
		try {
			expect(mergeArgs("github", 1)).toContain("--delete-branch");
			expect(mergeArgs("gitlab", 1)).toContain("--remove-source-branch");
		} finally {
			Reflect.deleteProperty(Object.prototype, "deleteBranch");
		}
	});

	test("a forge with no adapter refuses by name, never falling through to a cli", () => {
		for (const forge of UNSUPPORTED_FORGES) {
			// The defect this pins: `forge !== "unknown"` let everything else reach
			// the GitLab branch, so a receipt saying "bitbucket" merged with glab.
			expect(() => mergeArgs(forge, 1)).toThrow(`forge is ${JSON.stringify(forge)}, expected "github" or "gitlab"`);
		}
	});

	test("a pull-request reference that is not a positive integer is refused", () => {
		for (const pr of ["", "  ", "0", "-1", "--squash", "12a", "1 2", "abc", "1;rm -rf .", "https://github.com/o/r/pull/1"]) {
			expect(() => mergeArgs("github", pr)).toThrow(/expected a positive integer/);
			expect(() => mergeArgs("gitlab", pr)).toThrow(/expected a positive integer/);
		}
		expect(() => mergeArgs("github", 0)).toThrow(/expected a positive integer/);
		expect(() => mergeArgs("github", -3)).toThrow(/expected a positive integer/);
		expect(() => mergeArgs("github", 1.5)).toThrow(/expected a positive integer/);
	});
});

describe("remoteBranchAbsent", () => {
	test("a clean exit 2 is absent and pins the safe protocol policy", () => {
		const { run, calls } = spy(completed(2));
		expect(remoteBranchAbsent("origin", "omp/agent/omp-plugins-9ej3.4", REPO_CWD, run)).toBe("absent");
		expect(calls[0]?.argv).toEqual([
			"git",
			"-c",
			"protocol.allow=never",
			"-c",
			"protocol.file.allow=always",
			"-c",
			"protocol.https.allow=always",
			"-c",
			"protocol.ssh.allow=always",
			"-c",
			"protocol.ext.allow=never",
			"-c",
			"core.sshCommand=ssh",
			"-c",
			"core.askPass=",
			"-c",
			"credential.helper=",
			"-c",
			"credential.interactive=never",
			"ls-remote",
			"--exit-code",
			"--heads",
			"--upload-pack=git-upload-pack",
			"origin",
			"refs/heads/omp/agent/omp-plugins-9ej3.4",
		]);
		expect(calls[0]?.timeoutMs).toBe(FORGE_TIMEOUT_MS);
		expect(calls[0]?.cwd).toBe(REPO_CWD);
	});

	/**
	 * A remote name resolves per repository, so the directory the question is asked in
	 * is part of the question. Answering it somewhere else can only produce a false
	 * verdict, and a false absence is what marks a live branch deleted.
	 */
	test("the probe is asked in the directory it was given, never an ambient one", () => {
		const { run, calls } = spy(completed(2));
		expect(remoteBranchAbsent("origin", "feature", "/repository/linked worktree", run)).toBe("absent");
		expect(calls.map(call => call.cwd)).toEqual(["/repository/linked worktree"]);
	});

	test("no directory is no observation: an empty cwd is unknown and issues nothing", () => {
		for (const cwd of ["", "   "]) {
			const { run, calls } = spy(completed(2));
			expect(remoteBranchAbsent("origin", "feature", cwd, run)).toBe("unknown");
			expect(calls).toHaveLength(0);
		}
	});

	test("the observation environment removes executable Git overrides", () => {
		const previous = process.env.GIT_SSH_COMMAND;
		process.env.GIT_SSH_COMMAND = "/tmp/checkout-controlled-ssh";
		try {
			const { run, calls } = spy(completed(2));
			expect(remoteBranchAbsent("origin", "feature", REPO_CWD, run)).toBe("absent");
			const env = calls[0]?.env;
			expect(env?.GIT_ALLOW_PROTOCOL).toBe("file:https:ssh");
			expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
			for (const key of ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_EXEC_PATH", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "SSH_ASKPASS"]) {
				expect(Object.hasOwn(env ?? {}, key)).toBe(false);
			}
		} finally {
			if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
			else process.env.GIT_SSH_COMMAND = previous;
		}
	});

	test("exit 0 is present only for one exact canonical head record", () => {
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(0, headRecord("feature"))).run)).toBe("present");
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(0, headRecord("feature", SHA256_OID))).run)).toBe("present");
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(0, headRecord("feature").slice(0, -1))).run)).toBe("present");
	});

	test("empty, malformed, unrelated, or multiple stdout records are unknown", () => {
		for (const stdout of [
			"",
			"\n",
			"abc123\trefs/heads/feature\n",
			`${SHA1_OID} refs/heads/feature\n`,
			headRecord("other"),
			`${headRecord("feature")}${headRecord("other")}`,
			`${headRecord("feature")}\n`,
			`${SHA1_OID.toUpperCase()}\trefs/heads/feature\n`,
			`${SHA1_OID}\trefs/heads/feature\r\n`,
			`${SHA1_OID}\trefs/heads/feature\textra\n`,
		]) {
			expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(0, stdout)).run)).toBe("unknown");
		}
	});

	test("stdout and exit status must agree", () => {
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(2, headRecord("feature"))).run)).toBe("unknown");
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(2, "", "warning")).run)).toBe("unknown");
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(1, headRecord("feature"))).run)).toBe("unknown");
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(128, headRecord("feature"))).run)).toBe("unknown");
	});

	test("an unreachable remote or refused credentials is unknown", () => {
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(128, "", "fatal: could not read Username")).run)).toBe("unknown");
	});

	test("every other exit is unknown", () => {
		for (const exitCode of [1, 3, 127, 129, 141, 255]) {
			expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(completed(exitCode)).run)).toBe("unknown");
		}
	});

	test("a timeout and a missing git are unknown", () => {
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(timedOut).run)).toBe("unknown");
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(missingCli).run)).toBe("unknown");
	});

	test("a result carrying no exit status is unknown even when it claims success", () => {
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy({ ok: true, exitCode: null, stdout: "", stderr: "" }).run)).toBe("unknown");
		expect(
			remoteBranchAbsent("origin", "feature", REPO_CWD, spy({ ok: true, exitCode: 2, stdout: "", stderr: "", error: "killed" }).run),
		).toBe("unknown");
	});

	test("absence never comes from a merge result, only from the ls-remote observation", () => {
		const mergeSucceeded: CliResult = completed(0, "! Merged pull request #123\n✓ Deleted remote branch feature\n");
		expect(remoteBranchAbsent("origin", "feature", REPO_CWD, spy(mergeSucceeded).run)).toBe("unknown");
		expect(mergeArgs("github", 123)).toContain("--delete-branch");
	});

	test("the ref is spelled in full, so it can only be answered by itself", () => {
		const { run, calls } = spy(completed(2));
		remoteBranchAbsent("origin", "feature", REPO_CWD, run);
		expect(calls[0]?.argv.at(-1)).toBe("refs/heads/feature");
		expect(calls[0]?.argv).toContain("--heads");
		expect(calls[0]?.argv.some(part => part.includes("*"))).toBe(false);
	});

	test("a branch name carrying shell syntax is refused before any command exists", () => {
		for (const branch of ["x; rm -rf .", "x && rm -rf .", "x | tee /tmp/x", "$(id)", "`id`", "x\nrm -rf .", "x y"]) {
			const { run, calls } = spy(completed(2));
			expect(remoteBranchAbsent("origin", branch, REPO_CWD, run)).toBe("unknown");
			expect(calls).toHaveLength(0);
		}
	});

	test("a branch name git itself forbids is refused", () => {
		for (const branch of ["", "@", "-feature", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "feature/", "/feature", ".hidden", "a/.b", "a.", "a.lock", "a/b.lock", "a@{0}"]) {
			const { run, calls } = spy(completed(2));
			expect(remoteBranchAbsent("origin", branch, REPO_CWD, run)).toBe("unknown");
			expect(calls).toHaveLength(0);
		}
	});

	test("a remote that would be read as an option is refused", () => {
		for (const remote of ["", "--upload-pack=/tmp/evil", "-o"]) {
			const { run, calls } = spy(completed(2));
			expect(remoteBranchAbsent(remote, "feature", REPO_CWD, run)).toBe("unknown");
			expect(calls).toHaveLength(0);
		}
	});

	test("ordinary branch names are accepted", () => {
		for (const branch of ["main", "feature", "omp/agent/omp-plugins-9ej3.4", "release-1.2.3", "user.name/fix_it"]) {
			expect(remoteBranchAbsent("origin", branch, REPO_CWD, spy(completed(2)).run)).toBe("absent");
		}
	});
});

describe("every issued command", () => {
	test("is an argv array of strings with a bounded timeout and no shell syntax", () => {
		const calls: Call[] = [];
		const run: CliRunner = (argv, options) => {
			calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env });
			return completed(0, "true\n");
		};
		for (const forge of ["github", "gitlab"] as const) {
			autoDeleteSetting(forge, "group/project", run);
			enableAutoDelete(forge, "group/project", run);
		}
		remoteBranchAbsent("origin", "omp/agent/omp-plugins-9ej3.4", REPO_CWD, run);
		const built = [...calls.map(call => call.argv), mergeArgs("github", 123), mergeArgs("gitlab", 7)];

		expect(calls).toHaveLength(5);
		for (const call of calls) {
			expect(Array.isArray(call.argv)).toBe(true);
			expect(call.timeoutMs).toBe(FORGE_TIMEOUT_MS);
			expect(call.timeoutMs).toBeGreaterThan(0);
			expect(Number.isFinite(call.timeoutMs)).toBe(true);
		}
		for (const argv of built) {
			expect(argv.length).toBeGreaterThan(0);
			for (const part of argv) {
				expect(typeof part).toBe("string");
				expect(part).not.toMatch(SHELL_METACHARACTER);
			}
		}
	});

	test("the runtime surface is exactly the contract the delivery tools import", () => {
		expect(Object.keys(adapter).sort()).toEqual([
			"FORGE_TIMEOUT_MS",
			"autoDeleteSetting",
			"detectForge",
			"enableAutoDelete",
			"forgeEnvironment",
			"mergeArgs",
			"remoteBranchAbsent",
			"runCli",
		]);
	});
});

/**
 * Everything above stubs the runner, which proves the mapping but not the
 * premise: that `git ls-remote --exit-code` really answers 0, 2, and 128 the way
 * this module reads them. These tests spawn the real processes.
 *
 * Each carries an explicit timeout. Bun's 5s default is not enough here — a
 * single `git` spawn measured 0.2s idle and over 2s while the machine was busy —
 * and a deadline that fires mid-spawn reports a killed child as `unknown`, which
 * looks exactly like the defect these tests exist to rule out.
 */
describe("runCli against real processes", () => {
	const dir = mkdtempSync(join(tmpdir(), "forge-adapter-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	/** A global `commit.gpgsign` costs seconds per commit; a hook can block one outright. */
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});

	const executableMarker = (name: string) => {
		const script = join(dir, name);
		const marker = join(dir, `${name}-ran`);
		writeFileSync(script, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
		chmodSync(script, 0o700);
		return { script, marker };
	};

	test("a completed command reports ok with its real exit status", () => {
		const zero = runCli(["git", "--version"], { timeoutMs: FORGE_TIMEOUT_MS });
		expect(zero.ok).toBe(true);
		expect(zero.exitCode).toBe(0);
		expect(zero.stdout).toContain("git version");
		expect(zero.error).toBeUndefined();
	}, 60_000);

	test("a missing binary is not an observation", () => {
		const gone = runCli(["omp-forge-adapter-no-such-binary"], { timeoutMs: FORGE_TIMEOUT_MS });
		expect(gone.ok).toBe(false);
		expect(gone.exitCode).toBeNull();
		expect(gone.error ?? "").not.toBe("");
	}, 60_000);

	test("an empty argv is refused rather than spawned", () => {
		const nothing = runCli([], { timeoutMs: FORGE_TIMEOUT_MS });
		expect(nothing.ok).toBe(false);
		expect(nothing.exitCode).toBeNull();
		expect(nothing.error).toBe("no command to run");
	});

	test("the timeout is real: a sleeping command is killed and reports no status", () => {
		const slept = runCli(["sleep", "30"], { timeoutMs: 250 });
		expect(slept.ok).toBe(false);
		expect(slept.exitCode).toBeNull();
		expect(slept.error ?? "").not.toBe("");
	}, 60_000);

	test("git answers exit 0 for the exact ref and exit 2 for anything else", () => {
		expect(git("init", "-b", "main", ".").exitCode).toBe(0);
		expect(git("commit", "--allow-empty", "-m", "seed").exitCode).toBe(0);
		expect(remoteBranchAbsent(dir, "main", dir, runCli)).toBe("present");
		expect(remoteBranchAbsent(dir, "gone", dir, runCli)).toBe("absent");
		// A prefix of a real branch is absent: the ref is matched, not searched for.
		expect(remoteBranchAbsent(dir, "mai", dir, runCli)).toBe("absent");
	}, 120_000);

	test("an unreachable remote is exit 128, an observation that still means unknown", () => {
		const missing = join(dir, "not-a-repo");
		const raw = runCli(["git", "ls-remote", "--exit-code", "--heads", missing, "refs/heads/main"], {
			timeoutMs: FORGE_TIMEOUT_MS,
		});
		expect(raw.ok).toBe(true);
		expect(raw.exitCode).toBe(128);
		expect(remoteBranchAbsent(missing, "main", dir, runCli)).toBe("unknown");
	}, 60_000);

	test("repo config cannot re-enable the executable ext transport", () => {
		const script = join(dir, "remote-helper");
		const marker = join(dir, "remote-helper-ran");
		writeFileSync(script, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 0\n`);
		chmodSync(script, 0o700);
		expect(git("config", "remote.executable.url", `ext::${script}`).exitCode).toBe(0);
		expect(git("config", "protocol.ext.allow", "always").exitCode).toBe(0);
		expect(remoteBranchAbsent("executable", "main", dir, runCli)).toBe("unknown");
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("repo uploadpack and SSH command overrides cannot execute", () => {
		const uploadPack = executableMarker("upload-pack-override");
		expect(git("config", "remote.uploadpack.url", dir).exitCode).toBe(0);
		expect(git("config", "remote.uploadpack.uploadpack", uploadPack.script).exitCode).toBe(0);
		expect(remoteBranchAbsent("uploadpack", "main", dir, runCli)).toBe("present");
		expect(existsSync(uploadPack.marker)).toBe(false);

		const sshCommand = executableMarker("ssh-command-override");
		expect(git("config", "remote.sshconfig.url", "ssh://127.0.0.1:1/repo").exitCode).toBe(0);
		expect(git("config", "core.sshCommand", sshCommand.script).exitCode).toBe(0);
		expect(remoteBranchAbsent("sshconfig", "main", dir, runCli)).toBe("unknown");
		expect(existsSync(sshCommand.marker)).toBe(false);
		expect(git("config", "--unset", "core.sshCommand").exitCode).toBe(0);
	}, 60_000);

	test("environment SSH and proxy command overrides cannot execute", () => {
		expect(git("config", "remote.sshenv.url", "ssh://127.0.0.1:1/repo").exitCode).toBe(0);
		for (const key of ["GIT_SSH_COMMAND", "GIT_SSH"] as const) {
			const override = executableMarker(key.toLowerCase());
			const previous = process.env[key];
			process.env[key] = override.script;
			try {
				expect(remoteBranchAbsent("sshenv", "main", dir, runCli)).toBe("unknown");
				expect(existsSync(override.marker)).toBe(false);
			} finally {
				if (previous === undefined) delete process.env[key];
				else process.env[key] = previous;
			}
		}

		const proxy = executableMarker("git-proxy-command");
		expect(git("config", "remote.proxyenv.url", "git://127.0.0.1:1/repo").exitCode).toBe(0);
		expect(git("config", "protocol.git.allow", "always").exitCode).toBe(0);
		const previousProxy = process.env.GIT_PROXY_COMMAND;
		process.env.GIT_PROXY_COMMAND = proxy.script;
		try {
			expect(remoteBranchAbsent("proxyenv", "main", dir, runCli)).toBe("unknown");
			expect(existsSync(proxy.marker)).toBe(false);
		} finally {
			if (previousProxy === undefined) delete process.env.GIT_PROXY_COMMAND;
			else process.env.GIT_PROXY_COMMAND = previousProxy;
		}
	}, 60_000);

	test("a configured custom remote helper cannot execute through GIT_EXEC_PATH", () => {
		const helper = executableMarker("git-remote-evil");
		expect(git("config", "remote.custom.url", "evil::payload").exitCode).toBe(0);
		expect(git("config", "protocol.evil.allow", "always").exitCode).toBe(0);
		const previous = process.env.GIT_EXEC_PATH;
		process.env.GIT_EXEC_PATH = dir;
		try {
			expect(remoteBranchAbsent("custom", "main", dir, runCli)).toBe("unknown");
			expect(existsSync(helper.marker)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.GIT_EXEC_PATH;
			else process.env.GIT_EXEC_PATH = previous;
		}
	}, 60_000);
});
