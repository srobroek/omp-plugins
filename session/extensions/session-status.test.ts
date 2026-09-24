import { describe, expect, test } from "bun:test";
import { dirtyFromStatus, reconcileStatus, renderStatus, type StatusSources } from "./session-status-tool";

const fixtureSources: StatusSources = {
	live: [
		{
			id: "session-live",
			cwd: "/repo/worktrees/feature",
			status: "running",
			kind: "main",
			branch: "feature",
			lastActivityMs: 2_000,
		},
	],
	transcripts: [
		{
			id: "session-live",
			cwd: "/repo/worktrees/feature",
			branch: "feature",
			outcome: "live",
			lastActiveMs: 2_000,
			title: "Feature work",
			file: "/sessions/session-live.jsonl",
		},
		{
			id: "session-done",
			cwd: "/repo",
			branch: "main",
			outcome: "complete",
			lastActiveMs: 1_000,
			title: "Finished work",
			file: "/sessions/session-done.jsonl",
		},
	],
	beads: [{ id: "b-feature", title: "Feature bead", status: "in_progress", assignee: "alice", branch: "feature" }],
	worktrees: [{ path: "/repo/worktrees/feature", branch: "feature", head: "abc123", dirty: "dirty" }],
	changes: [{ kind: "PR", id: "42", branch: "feature", state: "OPEN", url: "https://github.test/pr/42", base: "main" }],
	releases: [{ name: "session", version: "1.2.2", source: "package.json" }],
	warnings: [],
};

describe("worktree dirty probe", () => {
	test("reports clean and modified worktrees from porcelain output", () => {
		expect(dirtyFromStatus({ stdout: "", stderr: "", exitCode: 0 })).toBe("no");
		expect(dirtyFromStatus({ stdout: " M session-status-tool.ts\n", stderr: "", exitCode: 0 })).toBe("yes");
		expect(dirtyFromStatus({ stdout: "", stderr: "fatal: not a repository", exitCode: 128 })).toBe("unknown");
	});
});

describe("session status reconciliation", () => {
	test("joins live, transcript, bead, change, and worktree rows by stable identity", () => {
		const report = reconcileStatus("project", "/repo", fixtureSources);

		expect(report.sessions).toHaveLength(2);
		expect(report.sessions[0]).toMatchObject({
			transcript: { id: "session-live", branch: "feature" },
			live: { id: "session-live", status: "running" },
			bead: { id: "b-feature", assignee: "alice" },
			change: { kind: "PR", id: "42", state: "OPEN" },
			worktree: { path: "/repo/worktrees/feature" },
		});
		expect(report.sessions[1]).toMatchObject({ transcript: { id: "session-done" }, live: null, bead: null, change: null, worktree: null });
		expect(fixtureSources.transcripts).toHaveLength(2);
	});

	test("renders compact bounded tables without changing the reconciled sources", () => {
		const report = { ...reconcileStatus("global", "/repo", fixtureSources), maxRows: 1 };
		const rendered = renderStatus(report);

		expect(rendered).toContain("scope: global");
		expect(rendered).toContain("session-live");
		expect(rendered).not.toContain("session-done");
		expect(rendered).toContain("https://github.test/pr/42");
		expect(rendered).toContain("1.2.2");
	});

	test("retains a live session when its transcript is not persisted yet", () => {
		const report = reconcileStatus("global", "/repo", {
			...fixtureSources,
			transcripts: [],
			live: [{ id: "session-new", cwd: "/repo/worktrees/feature", status: "running", kind: "main", branch: "feature", lastActivityMs: 2_000 }],
		});

		expect(report.sessions).toHaveLength(1);
		expect(report.sessions[0]).toMatchObject({ transcript: { id: "session-new", outcome: "live" }, live: { id: "session-new" } });
	});
});
