import { describe, expect, test } from "bun:test";
import { decideMrAdvisory } from "./trunk-dev-mr-advisory.ts";

const cwd = "/repo";
const releaseGit = (args: readonly string[]) => {
	if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return cwd;
	if (args[0] === "symbolic-ref") return "origin/main";
	if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "headsha";
	if (args[0] === "rev-parse" && args[1] === "--verify") return "basesha";
	if (args[0] === "merge-base") return "basesha";
	if (args[0] === "show") return "1000";
	return null;
};

const options = { git: releaseGit, exists: (path: string) => path === `${cwd}/.releaserc`, now: 1000 * 1000 + 3 * 24 * 60 * 60 * 1000 };

function advise(command: string, opts: Parameters<typeof decideMrAdvisory>[2] = options) {
	return decideMrAdvisory(command, cwd, opts);
}

describe("decideMrAdvisory create and merge hints", () => {
	test("advises invalid Conventional Commit titles and feat/breaking descriptions without Flag", () => {
		expect(advise("gh pr create --title 'Add feature' --body 'body'").join(" ")).toContain("Conventional Commits");
		expect(advise("glab mr create -t 'feat(api): add API' -d 'Description'").join(" ")).toContain("Flag:");
		expect(advise("gh pr create -t 'fix!: break API' -b 'Flag: none — incompatible change'")).toEqual([]);
		expect(advise("gh pr create -t 'fix: bug' -b 'body'")).toEqual([]);
	});

	test("does not judge descriptions supplied from file or editor", () => {
		const fromFile = advise("gh pr create -t 'feat: new feature' --body @description.md");
		expect(fromFile.join(" ")).toContain("review file/editor-provided text manually");
		expect(advise("gh pr create -t 'feat: new feature'").join(" ")).toContain("Flag:");
		expect(advise("gh pr create -t 'feat: new feature' --body 'Flag: new_ui (default off; owner x; remove by 2026-12-31)'")).toEqual([]);
		expect(advise("gh pr create -t 'feat: new feature' --body 'Flag: none — tiny'").join(" ")).toContain("only for non-feature changes");
		expect(advise("gh pr create -t 'feat(api)!: replace API' --body 'Flag: none — x'").join(" ")).toContain("only for non-feature changes");
	});

	test("advises forge merges without squash only in release repos", () => {
		expect(advise("gh pr merge 12").join(" ")).toContain("squash-merge");
		expect(advise("glab mr merge 12 --squash")).toEqual([]);
		expect(advise("gh pr merge 12 -s")).toEqual([]);
		expect(advise("gh pr merge 12", { ...options, exists: () => false })).toEqual([]);
	});

	test("advises a long-lived branch push, but remains quiet for young, dry-run and tag pushes", () => {
		expect(advise("git push origin topic").join(" ")).toContain("3 days old");
		expect(advise("git push --dry-run origin topic")).toEqual([]);
		expect(advise("git push --tags origin")).toEqual([]);
		expect(advise("git push origin topic", { ...options, now: 1000 * 1000 + 1_000 })).toEqual([]);
	});

	test("handles quoting, chains, assignment prefixes, dgit and -C", () => {
		expect(advise("echo 'gh pr create --title bad' && gh pr create -t 'Bad title'; true").join(" ")).toContain("Conventional Commits");
		expect(advise("MODE=x gh pr merge 1").join(" ")).toContain("squash-merge");
		expect(advise("dgit push origin topic").join(" ")).toContain("short-lived");
		expect(advise("git -C /repo push origin topic").join(" ")).toContain("short-lived");
	});

	test("never throws when probes or inputs fail", () => {
		expect(() => decideMrAdvisory("gh pr merge 1; git push", cwd, { git: () => { throw new Error("unavailable"); } })).not.toThrow();
		expect(decideMrAdvisory("gh pr merge 1; git push", cwd, { git: () => { throw new Error("unavailable"); } })).toEqual([]);
		expect(() => decideMrAdvisory("glab mr create --title 'feat: test' --body 'Flag: none — x'", cwd)).not.toThrow();
	});
});
