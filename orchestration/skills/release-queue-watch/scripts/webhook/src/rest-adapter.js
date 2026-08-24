import { createHash } from "node:crypto";
import { Octokit } from "octokit";

const FAILED_CHECK_CONCLUSIONS = new Set([
	"action_required",
	"cancelled",
	"failure",
	"stale",
	"startup_failure",
	"timed_out",
]);
const PASSING_CHECK_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

function splitRepository(repository) {
	const [owner, repo, extra] = repository.split("/");
	if (!owner || !repo || extra)
		throw new Error(`invalid repository: ${repository}`);
	return { owner, repo };
}

function sortedSignals(values) {
	return values.map((value) => JSON.stringify(value)).sort();
}

export function checksFingerprint(checkRuns, combinedStatus) {
	const checkSignals = sortedSignals(
		checkRuns.map((run) => [
			run.id ?? null,
			run.name ?? null,
			run.check_suite?.id ?? null,
			run.status ?? null,
			run.conclusion ?? null,
			run.started_at ?? null,
			run.completed_at ?? null,
		]),
	);
	const statusSignals = sortedSignals(
		(combinedStatus.statuses ?? []).map((status) => [
			status.id ?? null,
			status.context ?? null,
			status.state ?? null,
			status.updated_at ?? null,
		]),
	);
	return createHash("sha256")
		.update(
			JSON.stringify([
				checkSignals,
				statusSignals,
				combinedStatus.state ?? null,
				combinedStatus.total_count ?? 0,
			]),
		)
		.digest("hex")
		.slice(0, 16);
}

export function combinedChecksState(checkRuns, combinedStatus) {
	const hasCommitStatuses = (combinedStatus.total_count ?? 0) > 0;
	if (
		checkRuns.some((run) => FAILED_CHECK_CONCLUSIONS.has(run.conclusion)) ||
		(hasCommitStatuses && ["error", "failure"].includes(combinedStatus.state))
	) {
		return "fail";
	}
	if (
		checkRuns.some((run) => run.status !== "completed" || !run.conclusion) ||
		(hasCommitStatuses && combinedStatus.state === "pending")
	) {
		return "pending";
	}
	const hasCheckSignal = checkRuns.length > 0 || hasCommitStatuses;
	const checksPass = checkRuns.every((run) =>
		PASSING_CHECK_CONCLUSIONS.has(run.conclusion),
	);
	const statusPasses = !hasCommitStatuses || combinedStatus.state === "success";
	return hasCheckSignal && checksPass && statusPasses ? "pass" : "pending";
}

export class OctokitRestAdapter {
	constructor({ token, octokit } = {}) {
		this.octokit = octokit ?? new Octokit({ auth: token });
	}

	async listOpenPullRequests(repository) {
		const { owner, repo } = splitRepository(repository);
		const pulls = await this.octokit.paginate(this.octokit.rest.pulls.list, {
			owner,
			repo,
			state: "open",
			per_page: 100,
		});
		return Promise.all(
			pulls.map(async (pull) => {
				const [{ data: detail }, checkRuns, { data: combinedStatus }] =
					await Promise.all([
						this.octokit.rest.pulls.get({
							owner,
							repo,
							pull_number: pull.number,
						}),
						this.octokit.paginate(this.octokit.rest.checks.listForRef, {
							owner,
							repo,
							ref: pull.head.sha,
							per_page: 100,
						}),
						this.octokit.rest.repos.getCombinedStatusForRef({
							owner,
							repo,
							ref: pull.head.sha,
						}),
					]);
				return {
					number: pull.number,
					title: pull.title,
					headSha: pull.head.sha,
					baseRef: pull.base.ref,
					labels: pull.labels.map((label) => label.name).filter(Boolean),
					draft: pull.draft ?? false,
					mergeable:
						detail.mergeable === true && detail.mergeable_state === "clean",
					checks: combinedChecksState(checkRuns, combinedStatus),
					checksFingerprint: checksFingerprint(checkRuns, combinedStatus),
					createdAt: pull.created_at,
					updatedAt: pull.updated_at,
				};
			}),
		);
	}
}
