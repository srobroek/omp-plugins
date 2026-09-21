import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import bdReconcileTool, {
	type BdSpawn,
	type BeadRecord,
	parseReceipt,
	type ReconcileDependencies,
	type ReconcileOperation,
	reconcileApproval,
	reconcileReceipts,
	resetReconcileArbiterForTests,
	type SpawnResult,
	type WriteLock,
} from "./bd-reconcile-tool.ts";

const REPO_KEY = "0123456789abcdef";
const HEAD = "1111111111111111111111111111111111111111";
const MERGE = "2222222222222222222222222222222222222222";
const NOW = "2026-09-21T12:00:00.000Z";
const roots: string[] = [];

function temporary(name: string): string {
	const path = mkdtempSync(join(tmpdir(), `bd-reconcile-${name}-`));
	roots.push(path);
	return path;
}

function envelope(data: unknown): string {
	return `bd human preamble\n${JSON.stringify({ data, schema_version: 1 })}`;
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const base = {
		schema: "omp.receipt.landing",
		version: 1,
		receiptId: "1000-222222222222",
		emittedAt: NOW,
		emitter: { plugin: "@srobroek/delivery", version: "1.0.0", tool: "delivery_cleanup" },
		repo: {
			key: REPO_KEY,
			canonicalRoot: "/repo",
			remote: "origin",
			forge: "github",
			nameWithOwner: "srobroek/omp-plugins",
		},
		pr: {
			number: 42,
			url: "https://github.com/srobroek/omp-plugins/pull/42",
			state: "MERGED",
			baseRefName: "main",
			headRefName: "feature/reconcile",
			headRefOid: HEAD,
			mergeCommitOid: MERGE,
			mergedAt: NOW,
		},
		branch: {
			name: "feature/reconcile",
			deletedRemote: true,
			remoteAbsenceVerifiedAt: NOW,
			autoDeleteSetting: "on",
		},
		worktree: {
			path: null,
			removed: true,
			localRefDeleted: true,
			absenceVerifiedAt: NOW,
		},
		beads: { ids: ["repo-task"], ledgerActive: true },
		proof: { method: "forge query", observedAt: NOW, evidence: {} },
		outcome: "cleaned",
		supersedes: null,
	};
	return { ...base, ...overrides };
}

function exactBead(id = "repo-task", overrides: Partial<BeadRecord> = {}): BeadRecord {
	return {
		id,
		status: "open",
		metadata: {
			pr: 42,
			base: "main",
			branch: "feature/reconcile",
			head_sha: HEAD,
			merge_sha: MERGE,
		},
		dependencies: [],
		comments: [],
		...overrides,
	};
}

function row(bead: BeadRecord): Record<string, unknown> {
	return {
		id: bead.id,
		status: bead.status,
		assignee: bead.assignee,
		metadata: bead.metadata,
		dependencies: bead.dependencies.map((edge) => ({
			id: edge.id,
			issue_id: edge.issueId,
			depends_on_id: edge.dependsOnId,
			dependency_type: edge.type,
			status: edge.status,
		})),
		comments: bead.comments.map((text) => ({ text })),
		parent: bead.parent,
	};
}

const passLock = (async <T>(
	_cwd: string,
	_holder: string,
	write: () => T | PromiseLike<T>,
) => ({ kind: "done" as const, value: await write() })) as WriteLock;

class Harness {
	readonly calls: string[][] = [];
	readonly beads = new Map<string, BeadRecord>();
	readonly gates: Array<{ id: string; blocks: string; reason: string }> = [];
	failOnce?: string;
	private gateNumber = 0;

	constructor(readonly cwd: string, ...beads: BeadRecord[]) {
		mkdirSync(join(cwd, ".beads"), { recursive: true });
		writeFileSync(join(cwd, ".beads", "metadata.json"), "{}");
		for (const bead of beads) this.beads.set(bead.id, structuredClone(bead));
	}

	spawn: BdSpawn = async (argv): Promise<SpawnResult> => {
		this.calls.push([...argv]);
		const command = argv.slice(0, 2).join(" ");
		if (this.failOnce !== undefined && (argv[0] === this.failOnce || command === this.failOnce)) {
			this.failOnce = undefined;
			return { ok: false, exitCode: 1, stdout: "", stderr: "injected interruption" };
		}
		if (argv[0] === "show") {
			const ids = argv.slice(1, argv.findIndex((part) => part.startsWith("--")));
			return this.ok(envelope(ids.map((id) => this.beads.get(id)).filter(Boolean).map((bead) => row(bead as BeadRecord))));
		}
		if (argv[0] === "list") return this.ok(envelope([...this.beads.values()].map(row)));
		if (command === "gate list") {
			const gates = this.gates.length === 0 ? null : this.gates.map((gate) => ({
				id: gate.id,
				status: "open",
				await_type: "human",
				description: `Ad-hoc gate blocking ${gate.blocks}\n\nReason: ${gate.reason}`,
			}));
			return this.ok(envelope(gates));
		}
		if (argv[0] === "update") {
			const bead = this.required(this.argument(argv, 1));
			for (let index = 2; index < argv.length; index++) {
				if (argv[index] === "--set-metadata") {
					const assignment = this.argument(argv, ++index);
					const separator = assignment.indexOf("=");
					if (separator < 1) throw new Error(`malformed metadata fixture argv: ${assignment}`);
					bead.metadata[assignment.slice(0, separator)] = assignment.slice(separator + 1);
				}
				if (argv[index] === "--assignee" && argv[index + 1] === "") {
					bead.assignee = undefined;
					index++;
				}
				if (argv[index] === "--status") bead.status = this.argument(argv, ++index);
			}
			return this.ok(envelope([row(bead)]));
		}
		if (command === "comments add") {
			this.required(this.argument(argv, 2)).comments.push(this.argument(argv, 3));
			return this.ok(envelope({ ok: true }));
		}
		if (command === "gate create") {
			const blocks = this.argument(argv, argv.indexOf("--blocks") + 1);
			const reason = this.argument(argv, argv.indexOf("--reason") + 1);
			this.gates.push({ id: `repo-gate-${++this.gateNumber}`, blocks, reason });
			return this.ok(envelope({ id: `repo-gate-${this.gateNumber}` }));
		}
		if (command === "dep add") {
			const target = this.required(this.argument(argv, 2));
			const source = this.argument(argv, 3);
			target.dependencies.push({ id: source, dependsOnId: source, type: "discovered-from", status: this.required(source).status });
			return this.ok(envelope({ ok: true }));
		}
		if (command === "audit record") {
			const issueId = this.argument(argv, argv.indexOf("--issue-id") + 1);
			const response = this.argument(argv, argv.indexOf("--response") + 1);
			const sidecar = join(this.cwd, ".beads", "interactions.jsonl");
			const previous = (() => {
				try { return readFileSync(sidecar, "utf8"); } catch { return ""; }
			})();
			writeFileSync(sidecar, `${previous}${JSON.stringify({ kind: "semantic_event", issue_id: issueId, response })}\n`);
			return this.ok(envelope({ ok: true }));
		}
		if (argv[0] === "close") {
			this.required(this.argument(argv, 1)).status = "closed";
			return this.ok(envelope({ ok: true }));
		}
		return { ok: false, exitCode: 2, stdout: "", stderr: `unexpected argv: ${argv.join(" ")}` };
	};

	private argument(argv: string[], index: number): string {
		const value = argv[index];
		if (value === undefined) throw new Error(`missing fixture argv at index ${index}: ${argv.join(" ")}`);
		return value;
	}

	private required(id: string): BeadRecord {
		const bead = this.beads.get(id);
		if (bead === undefined) throw new Error(`missing fixture bead ${id}`);
		return bead;
	}

	private ok(stdout: string): SpawnResult {
		return { ok: true, exitCode: 0, stdout, stderr: "" };
	}
}

function writeReceipt(root: string, value: Record<string, unknown>, name = "1000-222222222222.json"): string {
	const path = join(root, "receipts", REPO_KEY, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
	return path;
}

function dependencies(root: string, harness: Harness, additions: Partial<ReconcileDependencies> = {}): ReconcileDependencies {
	return {
		spawn: harness.spawn,
		lock: passLock,
		receiptRoot: join(root, "receipts"),
		repoKey: async () => REPO_KEY,
		host: "test-host",
		pidAlive: () => true,
		...additions,
	};
}

async function reconcile(
	root: string,
	harness: Harness,
	params: Record<string, unknown> = {},
	additions: Partial<ReconcileDependencies> = {},
) {
	return reconcileReceipts(
		{ repoKey: REPO_KEY, ...params },
		"call-1",
		harness.cwd,
		{ BD_ACTOR: "omp/Test/session" },
		dependencies(root, harness, additions),
	);
}

function mutationCalls(harness: Harness): string[][] {
	return harness.calls.filter((argv) => !["show", "list", "gate"].includes(argv[0] ?? ""));
}

function closeOperations(operations: ReconcileOperation[]): ReconcileOperation[] {
	return operations.filter((item) => item.kind === "close");
}

afterEach(() => {
	resetReconcileArbiterForTests();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("receipt v1 intake", () => {
	test("refuses a forward receipt version without reading or writing Beads", async () => {
		const root = temporary("forward");
		writeReceipt(root, receipt({ version: 2 }));
		const harness = new Harness(join(root, "repo"), exactBead());
		const report = await reconcile(root, harness);
		expect(report.refusals[0]?.reason).toContain("observed 2");
		expect(report.operations).toEqual([]);
		expect(harness.calls).toEqual([]);
	});

	test("reports missing, unreadable, and foreign-schema receipts without throwing", async () => {
		const root = temporary("invalid");
		const harness = new Harness(join(root, "repo"), exactBead());
		const missing = await reconcile(root, harness, { receipt: "missing" });
		expect(missing.refusals[0]?.reason).toContain("unreadable");
		writeReceipt(root, { schema: "foreign", version: 1 }, "foreign.json");
		const foreign = await reconcile(root, harness, { receipt: "foreign" });
		expect(foreign.refusals[0]?.reason).toContain("omp.receipt.landing");
		writeFileSync(join(root, "receipts", REPO_KEY, "bad.json"), "{");
		const unreadable = await reconcile(root, harness, { receipt: "bad" });
		expect(unreadable.refusals[0]?.reason).toContain("unreadable JSON");
	});

	test("consumes a receipt object returned by a delivery tool", async () => {
		const root = temporary("inline");
		const harness = new Harness(join(root, "repo"), exactBead());
		const report = await reconcileReceipts(
			{ receipt: JSON.stringify(receipt()), apply: false },
			"inline",
			harness.cwd,
			{ BD_ACTOR: "omp/Test/session" },
			dependencies(root, harness),
		);
		expect(report.receipts).toEqual(["<tool-result:1000-222222222222>"]);
		expect(closeOperations(report.operations)).toHaveLength(1);
	});

	test("parses a valid receipt while preserving unconstrained proof evidence", () => {
		const value = receipt({ proof: { method: "forge query", observedAt: NOW, evidence: { future: true } } });
		expect(parseReceipt(value).receipt?.proof.evidence).toEqual({ future: true });
	});
});

describe("scan and apply", () => {
	test("scan mode produces the complete plan and never sends mutating argv", async () => {
		const root = temporary("scan");
		writeReceipt(root, receipt());
		const harness = new Harness(join(root, "repo"), exactBead());
		const report = await reconcile(root, harness);
		expect(report.operations.map((item) => item.kind)).toEqual(["record-merge-audit", "close"]);
		expect(report.text).toContain("Scan mode wrote nothing");
		expect(mutationCalls(harness)).toEqual([]);
	});

	test("apply closes only exact proof and a second run is converged", async () => {
		const root = temporary("apply");
		writeReceipt(root, receipt());
		const harness = new Harness(join(root, "repo"), exactBead());
		const first = await reconcile(root, harness, { apply: true });
		expect(first.failures).toEqual([]);
		expect(first.applied.map((item) => item.kind)).toEqual(["record-merge-audit", "close"]);
		const close = harness.calls.find((argv) => argv[0] === "close");
		expect(close).toContain("PR #42 merged as 2222222222222222222222222222222222222222; exact receipt 1000-222222222222 reconciled.");
		const second = await reconcile(root, harness, { apply: true });
		expect(second.operations).toEqual([]);
		expect(second.text).toContain("state is converged");
	});

	test("apply stops at a partial failure and a retry resumes from the durable audit", async () => {
		const root = temporary("restart");
		writeReceipt(root, receipt());
		const harness = new Harness(join(root, "repo"), exactBead());
		harness.failOnce = "close";
		const first = await reconcile(root, harness, { apply: true });
		expect(first.applied.map((item) => item.kind)).toEqual(["record-merge-audit"]);
		expect(first.failures[0]).toContain("retry will resume");
		const second = await reconcile(root, harness, { apply: true });
		expect(second.operations.map((item) => item.kind)).toEqual(["close"]);
		expect(second.applied.map((item) => item.kind)).toEqual(["close"]);
	});

	test("an unavailable embedded write lock refuses the first mutation and writes nothing", async () => {
		const root = temporary("lock");
		writeReceipt(root, receipt());
		const harness = new Harness(join(root, "repo"), exactBead());
		const denied = (async () => ({ kind: "failed" as const, reason: "lock unavailable" })) as WriteLock;
		const report = await reconcile(root, harness, { apply: true }, { lock: denied });
		expect(report.applied).toEqual([]);
		expect(report.failures[0]).toContain("lock unavailable");
		expect(mutationCalls(harness)).toEqual([]);
	});
});

describe("close-out proof", () => {
	test.each([
		["T3 asserted summary", { emitter: { plugin: "@srobroek/delivery", version: "1", tool: "session_summary" } }, "emitter.tool", false],
		["unknown forge", { repo: { key: REPO_KEY, canonicalRoot: "/repo", remote: "origin", forge: "unknown", nameWithOwner: "srobroek/omp-plugins" } }, "repo.forge", false],
		["unknown auto-delete", { branch: { name: "feature/reconcile", deletedRemote: true, remoteAbsenceVerifiedAt: NOW, autoDeleteSetting: "unknown" } }, "autoDeleteSetting", true],
	])("refuses %s evidence", async (_label, override, expected, mergeAudit) => {
		const root = temporary("unknown");
		writeReceipt(root, receipt(override));
		const harness = new Harness(join(root, "repo"), exactBead());
		const report = await reconcile(root, harness);
		expect(closeOperations(report.operations)).toEqual([]);
		expect(report.operations.some((item) => item.kind === "record-merge-audit")).toBe(mergeAudit);
		expect(report.refusals.some((item) => item.reason.includes(expected))).toBe(true);
	});

	test("refuses an open gate", async () => {
		const root = temporary("gate");
		writeReceipt(root, receipt());
		const harness = new Harness(join(root, "repo"), exactBead());
		harness.gates.push({ id: "repo-gate", blocks: "repo-task", reason: "human answer required" });
		const report = await reconcile(root, harness);
		expect(closeOperations(report.operations)).toEqual([]);
		expect(report.refusals.some((item) => item.reason.includes("open gates"))).toBe(true);
	});

	test("refuses an open child", async () => {
		const root = temporary("child");
		writeReceipt(root, receipt());
		const harness = new Harness(
			join(root, "repo"),
			exactBead(),
			exactBead("repo-child", { parent: "repo-task", metadata: {} }),
		);
		const report = await reconcile(root, harness);
		expect(closeOperations(report.operations)).toEqual([]);
		expect(report.refusals.some((item) => item.reason.includes("open children"))).toBe(true);
	});

	test("refuses a live assignment instead of closing work another holder owns", async () => {
		const root = temporary("live-lease");
		writeReceipt(root, receipt());
		const bead = exactBead("repo-task", {
			status: "in_progress",
			assignee: "omp/Live/session",
			metadata: { ...exactBead().metadata, lease_host: "test-host", lease_pid: "1234" },
		});
		const harness = new Harness(join(root, "repo"), bead);
		const report = await reconcile(root, harness, {}, { pidAlive: () => true });
		expect(closeOperations(report.operations)).toEqual([]);
		expect(report.refusals.some((item) => item.reason.includes("live assignment/lease"))).toBe(true);
	});

	test("orders receipt-named leaves before their parents", async () => {
		const root = temporary("leaf-first");
		writeReceipt(root, receipt({ beads: { ids: ["repo-parent", "repo-child"], ledgerActive: true } }));
		const harness = new Harness(
			join(root, "repo"),
			exactBead("repo-parent"),
			exactBead("repo-child", { parent: "repo-parent" }),
		);
		const report = await reconcile(root, harness);
		expect(closeOperations(report.operations).map((item) => item.bead)).toEqual(["repo-child", "repo-parent"]);
	});
});

describe("convergent repairs", () => {
	test("plans CAS dead-claim release and exact missing anchors without overwriting", async () => {
		const root = temporary("repairs");
		writeReceipt(root, receipt());
		const bead = exactBead("repo-task", {
			status: "in_progress",
			assignee: "omp/Dead/session",
			metadata: {
				base: "main",
				branch: "feature/reconcile",
				head_sha: HEAD,
				lease_host: "test-host",
				lease_pid: "999999",
			},
		});
		const harness = new Harness(join(root, "repo"), bead);
		const report = await reconcile(root, harness, {}, { pidAlive: () => false });
		expect(report.operations.map((item) => item.kind)).toContain("release-dead-claim");
		const release = report.operations.find((item) => item.kind === "release-dead-claim")?.argv ?? [];
		expect(release).toContain("--if-assignee");
		expect(release).not.toContain("--force");
		const anchors = report.operations.find((item) => item.kind === "set-merge-anchors")?.argv ?? [];
		expect(anchors).toContain("pr=42");
		expect(anchors).toContain(`merge_sha=${MERGE}`);
	});

	test("conflicting anchors are never overwritten and persist one ambiguity comment/gate", async () => {
		const root = temporary("conflict");
		writeReceipt(root, receipt());
		const bead = exactBead();
		bead.metadata.merge_sha = "different";
		const harness = new Harness(join(root, "repo"), bead);
		const first = await reconcile(root, harness, { apply: true });
		expect(first.operations.map((item) => item.kind)).toContain("comment-ambiguity");
		expect(first.operations.map((item) => item.kind)).toContain("gate-ambiguity");
		expect(first.operations.some((item) => item.kind === "set-merge-anchors" || item.kind === "close")).toBe(false);
		const second = await reconcile(root, harness);
		expect(second.operations.filter((item) => item.kind === "comment-ambiguity" || item.kind === "gate-ambiguity")).toEqual([]);
	});

	test("conflicting receipt identities block every derived merge write", async () => {
		const root = temporary("receipt-conflict");
		writeReceipt(root, receipt(), "1000-222222222222.json");
		const other = receipt({
			receiptId: "2000-333333333333",
			emittedAt: "2026-09-21T13:00:00.000Z",
		});
		const otherPr = other.pr as Record<string, unknown>;
		otherPr.number = 43;
		otherPr.url = "https://github.com/srobroek/omp-plugins/pull/43";
		otherPr.mergeCommitOid = "3333333333333333333333333333333333333333";
		writeReceipt(root, other, "2000-333333333333.json");
		const harness = new Harness(join(root, "repo"), exactBead());
		const report = await reconcile(root, harness);
		expect(report.refusals.some((item) => item.reason.includes("ambiguous receipts"))).toBe(true);
		expect(report.operations.some((item) => ["set-merge-anchors", "record-merge-audit", "close"].includes(item.kind))).toBe(false);
		expect(report.operations.map((item) => item.kind)).toEqual(["comment-ambiguity", "gate-ambiguity"]);
	});

	test("adds discovered-from only from an injected recognized ledger carrier", async () => {
		const root = temporary("source");
		writeReceipt(root, receipt());
		const harness = new Harness(join(root, "repo"), exactBead(), exactBead("repo-source", { status: "closed" }));
		const resolver = () => "repo-source";
		const first = await reconcile(root, harness, {}, { authoritativeSource: resolver });
		expect(first.operations.find((item) => item.kind === "add-discovered-from")?.argv).toEqual([
			"dep", "add", "repo-task", "repo-source", "--type", "discovered-from", "--json",
		]);
		await reconcile(root, harness, { apply: true }, { authoritativeSource: resolver });
		const converged = await reconcile(root, harness, {}, { authoritativeSource: resolver });
		expect(converged.operations.some((item) => item.kind === "add-discovered-from")).toBe(false);
	});

	test("emitted argv never contains a forbidden destructive verb", async () => {
		const root = temporary("forbidden");
		writeReceipt(root, receipt());
		const bead = exactBead();
		bead.metadata.merge_sha = "different";
		const harness = new Harness(join(root, "repo"), bead, exactBead("repo-source", { status: "closed" }));
		const report = await reconcile(root, harness, {}, { authoritativeSource: () => "repo-source" });
		const forbidden = new Set(["reopen", "supersede", "--force", "prune", "purge", "flatten", "gc", "compact", "delete"]);
		for (const item of report.operations) {
			expect(item.argv.some((argument) => forbidden.has(argument))).toBe(false);
		}
	});
});

describe("tool registration and committed bundle", () => {
	test("approval is read by default and exec only for apply=true", () => {
		expect(reconcileApproval({ input: {} })).toBe("read");
		expect(reconcileApproval({ input: { apply: false } })).toBe("read");
		expect(reconcileApproval({ input: { apply: true } })).toBe("exec");
	});

	test("schema rejection releases the process-global registration arbiter for one retry", () => {
		const registered: Array<Record<string, unknown>> = [];
		const chain: Record<string, unknown> = {};
		chain.optional = () => chain;
		chain.describe = () => chain;
		let attempts = 0;
		const pi = {
			zod: {
				string: () => chain,
				boolean: () => chain,
				object: () => chain,
			},
			registerTool: (tool: Record<string, unknown>) => {
				attempts++;
				if (attempts === 1) throw new Error("schema rejection");
				registered.push(tool);
			},
		};
		expect(() => bdReconcileTool(pi as never)).toThrow("schema rejection");
		bdReconcileTool(pi as never);
		bdReconcileTool(pi as never);
		expect(attempts).toBe(2);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.name).toBe("bd_reconcile");
		expect(registered[0]?.approval).toBe(reconcileApproval);
	});

	test("independent extension API instances each register once", () => {
		const registered: Array<Record<string, unknown>> = [];
		const chain: Record<string, unknown> = {};
		chain.optional = () => chain;
		chain.describe = () => chain;
		const api = () => ({
			zod: {
				string: () => chain,
				boolean: () => chain,
				object: () => chain,
			},
			registerTool: (tool: Record<string, unknown>) => registered.push(tool),
		});
		const first = api();
		const second = api();
		bdReconcileTool(first as never);
		bdReconcileTool(first as never);
		bdReconcileTool(second as never);
		bdReconcileTool(second as never);
		expect(registered).toHaveLength(2);
	});

	test("manifest keeps the reconcile bundle last and the committed bundle matches a focused rebuild", () => {
		const packageRoot = resolve(import.meta.dir, "..");
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		expect(manifest.omp.extensions).toEqual([
			"./dist/bash-gates.js",
			"./dist/formula-check-tool.js",
			"./dist/bd-pool-discipline.js",
			"./dist/session-beads-lifecycle.js",
			"./dist/unreported-failure-advisory.js",
			"./dist/claim-before-branch.js",
			"./dist/bd-reconcile-tool.js",
		]);
		const out = temporary("bundle");
		const built = Bun.spawnSync([
			"bun", "build", "--target=bun",
			join(packageRoot, "extensions", "bd-reconcile-tool.ts"),
			"--outdir", out,
			"--external", "@oh-my-pi/*",
		], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
		expect(built.exitCode, built.stderr.toString()).toBe(0);
		expect(readFileSync(join(out, "bd-reconcile-tool.js"))).toEqual(
			readFileSync(join(packageRoot, "dist", "bd-reconcile-tool.js")),
		);
	}, 20_000);
});
