import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCleanup, decideFlagCleanup, decideMissingStaleJob, decideStaleReminder, deliveryLandMerge, forgeFromRemote, mergedForgeData, staleThresholdHours } from "./trunk-dev-beads.ts";

const now = Date.parse("2026-10-20T12:00:00.000Z");
const bead = (id: string, started: string, branch = "feat/example", assignee = "agent") => ({
	id,
	status: "in_progress",
	started_at: started,
	assignee,
	metadata: { branch },
});
const flagTitle = "feat(api)!: add staged API";
const flagBody = "Flag: staged_api (default off; owner alice; remove by 2026-11-30)";
const links = { branch: "omp/agent/omp-1234", url: "https://github.com/acme/repo/pull/7" };

describe("decideStaleReminder", () => {
	test("does not select a claim exactly at the threshold but does select an older claim", () => {
		const result = decideStaleReminder([
			bead("exact", new Date(now - 48 * 60 * 60 * 1000).toISOString()),
			bead("old", new Date(now - 49 * 60 * 60 * 1000).toISOString()),
		], now, 48);
		expect(result).toContain("old");
		expect(result).not.toContain("exact");
	});

	test("ignores missing branches and malformed dates", () => {
		expect(decideStaleReminder([
			bead("no-branch", "2026-10-16T12:00:00.000Z", ""),
			bead("bad-date", "not a date"),
		], now, 48)).toBeUndefined();
	});

	test("lists only five oldest stale claims", () => {
		const rows = Array.from({ length: 7 }, (_, index) => bead(`bead-${index}`, new Date(now - (72 - index) * 60 * 60 * 1000).toISOString()));
		const result = decideStaleReminder(rows, now, 48) ?? "";
		expect(result).toContain("bead-0");
		expect(result).toContain("bead-4");
		expect(result).not.toContain("bead-5");
		expect(result).toContain("Land or split");
	});

	test("uses positive integer hour overrides and defaults invalid values", () => {
		expect(staleThresholdHours("24")).toBe(24);
		for (const invalid of [undefined, "", "0", "-1", "2.5", "abc", "9007199254740992"]) expect(staleThresholdHours(invalid)).toBe(48);
		const recent = [bead("recent", new Date(now - 30 * 60 * 60 * 1000).toISOString())];
		expect(decideStaleReminder(recent, now, staleThresholdHours("24"))).toContain("recent");
		expect(decideStaleReminder(recent, now, staleThresholdHours("bad"))).toBeUndefined();
	});
});

describe("decideFlagCleanup", () => {
	test("creates a safe due-dated cleanup command for a valid flagged feature", () => {
		const decision = decideFlagCleanup(flagTitle, flagBody, [], links);
		expect(decision?.command).toContain("bd create 'chore: remove feature flag staged_api'");
		expect(decision?.command).toContain("--type chore --due 2026-11-30");
		expect(decision?.command).toContain("--deps discovered-from:omp-1234");
		expect(decision?.command).toContain("--silent");
	});

	test("does not make cleanup work for Flag none or non-features", () => {
		expect(decideFlagCleanup("feat: no flag", "Flag: none — no temporary flag", [], links)).toBeUndefined();
		expect(decideFlagCleanup("fix: repair", flagBody, [], links)).toBeUndefined();
	});

	test("rejects unsafe names and impossible dates", () => {
		expect(decideFlagCleanup(flagTitle, flagBody.replace("staged_api", "bad name"), [], links)).toBeUndefined();
		expect(decideFlagCleanup(flagTitle, flagBody.replace("2026-11-30", "2026-02-30"), [], links)).toBeUndefined();
		expect(decideFlagCleanup(flagTitle, flagBody.replace("2026-11-30", "2026-1-30"), [], links)).toBeUndefined();
	});

	test("skips when a non-closed cleanup bead already exists", () => {
		const existing = [{ id: "cleanup", status: "in_progress", metadata: { trunk_dev_flag: "staged_api" } }];
		expect(decideFlagCleanup(flagTitle, flagBody, existing, links)).toBeUndefined();
		expect(decideFlagCleanup(flagTitle, flagBody, [{ ...existing[0], status: "closed" }], links)).toBeDefined();
	});

	test("shell-quotes PR metadata and generated descriptions containing quotes", () => {
		const quoteLinks = { url: "https://github.com/acme/repo/pull/7?note=o'connor" };
		const quoted = decideFlagCleanup(flagTitle, flagBody, [], quoteLinks);
		expect(quoted?.command).toContain("o'\\''connor");
		expect(quoted?.command).toContain("--metadata '");
	});

	test("uses a Bead trailer when the branch has no bead id", () => {
		const decision = decideFlagCleanup(flagTitle, `${flagBody}\n\nBead: bd-4321`, [], { url: links.url });
		expect(decision?.command).toContain("discovered-from:bd-4321");
	});

	test("an open hand-made cleanup bead for the same flag suppresses a duplicate", () => {
		const handMade = (title: string, status = "open") => [{ id: "sbx-ugk", status, title, metadata: { due: "2026-11-30" } }];
		expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove staged_api feature flag by 2026-11-30"), links)).toBeUndefined();
		expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove `staged_api` flag"), links)).toBeUndefined();
		expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove feature flag staged_api"), links)).toBeUndefined();
		expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove staged_api feature flag", "closed"), links)).toBeDefined();
		expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove staged_api_v2 feature flag"), links)).toBeDefined();
		expect(decideFlagCleanup(flagTitle, flagBody, handMade("feat: rename staged_api flag docs"), links)).toBeDefined();
	});
});
describe("createCleanup runner fallback", () => {
	const decision = decideFlagCleanup(flagTitle, flagBody, [], links);
	if (decision === undefined) throw new Error("expected a cleanup decision");
	test("runs through a resolved writer with an explicit actor and reports the created bead", async () => {
		let argv: string[] = [];
		let actorEnv: string | undefined;
		let killOnTimeout: boolean | undefined;
		const result = await createCleanup(decision, "/repo/.beads", "/repo", { BEADS_ACTOR: "omp/agent-1" }, {
			findRunner: () => ({ interpreter: "/usr/bin/bun", script: "/beads/runner.js" }),
			run: async (cmd, _cwd, env, _timeout, kill) => { argv = cmd; actorEnv = env.BEADS_ACTOR; killOnTimeout = kill; return { exitCode: 0, stdout: '{"id":"cleanup-1"}' }; },
		});
		expect(argv.slice(0, 12)).toEqual(["/usr/bin/bun", "/beads/runner.js", "--beads-store", "/repo/.beads", "--beads-wait-ms", "5000", "--", "bd", "--json", "--actor", "omp/agent-1", "create"]);
		expect(actorEnv).toBe("omp/agent-1");
		expect(killOnTimeout).toBe(false);
		expect(result).toContain("created cleanup bead cleanup-1");
	});

	test("a write that outlives the wait reports pending instead of a retry command", async () => {
		const result = await createCleanup(decision, "/repo/.beads", "/repo", {}, {
			findRunner: () => ({ interpreter: "/usr/bin/bun", script: "/beads/runner.js" }),
			run: async () => ({ exitCode: -1, stdout: "", timedOut: true }),
		});
		expect(result).toContain("still being written");
		expect(result).not.toContain("bd create");
	});

	test("falls back when no runner exists or the writer lock refuses", async () => {
		const missing = await createCleanup(decision, "/repo/.beads", "/repo", {}, { findRunner: () => undefined, run: async () => undefined });
		expect(missing).toContain("bd create 'chore: remove feature flag staged_api'");
		const locked = await createCleanup(decision, "/repo/.beads", "/repo", {}, {
			findRunner: () => ({ interpreter: "bun", script: "runner.js" }),
			run: async () => ({ exitCode: 120, stdout: "" }),
		});
		expect(locked).toContain("bd create 'chore: remove feature flag staged_api'");
	});
});

describe("mergedForgeData", () => {
	const pr = { title: flagTitle, body: flagBody, url: links.url, headRefName: "omp/agent/omp-1234" };
	test("only a completed merge yields data, so --auto merges that are still open create nothing", () => {
		expect(mergedForgeData(JSON.stringify({ ...pr, state: "OPEN" }), "gh")).toBeUndefined();
		expect(mergedForgeData(JSON.stringify(pr), "gh")).toBeUndefined();
		expect(mergedForgeData(JSON.stringify({ ...pr, state: "MERGED" }), "gh")).toEqual({ title: flagTitle, body: flagBody, url: links.url, branch: "omp/agent/omp-1234" });
	});

	test("reads GitLab description, web_url and source_branch", () => {
		const mr = { title: flagTitle, description: flagBody, web_url: "https://gitlab.example/acme/repo/-/merge_requests/7", source_branch: "feat/x", state: "merged" };
		expect(mergedForgeData(JSON.stringify(mr), "glab")).toMatchObject({ body: flagBody, branch: "feat/x" });
		expect(mergedForgeData(JSON.stringify({ ...mr, state: "opened" }), "glab")).toBeUndefined();
	});
});

describe("stale-branch CI job check", () => {
	test("detects GitHub and GitLab remotes, including self-hosted GitLab and scp-style URLs", () => {
		expect(forgeFromRemote("git@github.com:srobroek/omp-plugins.git")).toBe("github");
		expect(forgeFromRemote("https://github.com/acme/repo")).toBe("github");
		expect(forgeFromRemote("ssh://git@ssh.gitlab.aws.dev/sjors/repo.git")).toBe("gitlab");
		expect(forgeFromRemote("https://oauth2:token@gitlab.com/acme/repo.git")).toBe("gitlab");
		expect(forgeFromRemote("https://bitbucket.org/acme/repo.git")).toBeUndefined();
		expect(forgeFromRemote("/local/path")).toBeUndefined();
	});

	test("reports a missing job per forge and stays silent once the job is defined", () => {
		expect(decideMissingStaleJob("github", ["name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n"])).toContain("scheduled GitHub workflow");
		expect(decideMissingStaleJob("gitlab", [])).toContain("GitLab job plus pipeline schedule");
		expect(decideMissingStaleJob("github", ["jobs:\n  stale-bead-branches:\n    runs-on: ubuntu-latest\n"])).toBeUndefined();
		expect(decideMissingStaleJob("gitlab", ["stale-bead-branches:\n  image: debian\n"])).toBeUndefined();
		expect(decideMissingStaleJob("gitlab", ["# mentions stale-bead-branches: in a comment only\n"])).toContain("no daily");
		expect(decideMissingStaleJob(undefined, [])).toBeUndefined();
	});

	test("the shipped GitHub and GitLab templates satisfy the check", () => {
		const template = (name: string) => readFileSync(join(import.meta.dir, "..", "skills", "trunk-dev-release-setup", "templates", name), "utf8");
		expect(decideMissingStaleJob("github", [template("stale-branches.github.yml")])).toBeUndefined();
		expect(decideMissingStaleJob("gitlab", [template("stale-branches.gitlab-ci.yml")])).toBeUndefined();
	});
});

describe("delivery_land merges", () => {
	const input = { path: "xd://delivery_land", content: JSON.stringify({ pr: 6, merge_method: "squash", worktree: "/wt/feat" }) };
	const proved = "delivery_land proved srobroek/trunk-dev-sandbox#6 merged as 78897a74672e on github.";
	test("a proved landing yields the PR number and worktree", () => {
		expect(deliveryLandMerge("write", input, false, proved)).toEqual({ number: "6", worktree: "/wt/feat" });
		expect(deliveryLandMerge("write", { ...input, content: JSON.stringify({ pr: "12" }) }, false, proved)).toEqual({ number: "12", worktree: undefined });
	});

	test("refusals, errors, other devices, and bash calls yield nothing", () => {
		expect(deliveryLandMerge("write", input, false, "delivery_land refused: the re-read after gh pr merge 6 observed no completed merge")).toBeUndefined();
		expect(deliveryLandMerge("write", input, true, proved)).toBeUndefined();
		expect(deliveryLandMerge("write", { ...input, path: "xd://delivery_cleanup" }, false, proved)).toBeUndefined();
		expect(deliveryLandMerge("bash", { command: "gh pr merge 6" }, false, proved)).toBeUndefined();
		expect(deliveryLandMerge("write", { ...input, content: "{not json" }, false, proved)).toBeUndefined();
	});
});
