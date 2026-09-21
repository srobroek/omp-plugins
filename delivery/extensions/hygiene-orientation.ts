import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type RunResult = { exitCode: number; signalCode?: number | null; stdout: string; stderr: string };
export type HygieneStatus = "actionable" | "ambiguous" | "clean";
export type HygieneFinding = { kind: string; status: HygieneStatus; description: string; paths?: string[] };
export type HygieneReport = { scope: { cwd: string; commonGitDir: string | null; currentWorktree: string | null }; status: HygieneStatus; findings: HygieneFinding[]; limitations: string[]; mutation: "none" };
const TIMEOUT_MS = 2000;

function run(argv: string[], cwd: string): RunResult {
  try {
    const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
    return { exitCode: p.exitCode, signalCode: p.signalCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (error) { return { exitCode: 127, signalCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
}
function git(cwd: string, args: string[]): RunResult { return run(["git", "--no-optional-locks", ...args], cwd); }
function available(result: RunResult): boolean { return result.exitCode === 0 && (result.signalCode === undefined || result.signalCode === 0 || result.signalCode === null); }
function parseWorktrees(text: string): Array<{ path: string; branch?: string }> {
  const rows: Array<{ path: string; branch?: string }> = []; let row: { path: string; branch?: string } | undefined;
  for (const line of text.split("\n")) {
    if (!line) { if (row) rows.push(row); row = undefined; continue; }
    if (line.startsWith("worktree ")) { if (row) rows.push(row); row = { path: line.slice(9) }; }
    else if (line.startsWith("branch ") && row) row.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  if (row) rows.push(row);
  return rows;
}
export function parsePorcelainPaths(text: string): string[] {
  const fields = text.split("\0"); const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]; if (!field || field.startsWith("## ")) continue;
    const code = field.slice(0, 2); const path = field.slice(3);
    if (path) paths.push(path);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      const original = fields[i + 1]; if (original) { paths.push(original); i += 1; }
    }
  }
  return paths;
}
function repoKey(commonGitDir: string): string { return createHash("sha256").update(resolve(commonGitDir)).digest("hex").slice(0, 16); }
function validReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>; const repo = r.repo as Record<string, unknown> | undefined; const pr = r.pr as Record<string, unknown> | undefined;
  const branch = r.branch as Record<string, unknown> | undefined; const worktree = r.worktree as Record<string, unknown> | undefined; const beads = r.beads as Record<string, unknown> | undefined; const proof = r.proof as Record<string, unknown> | undefined;
  return r.schema === "omp.receipt.landing" && r.version === 1 && typeof r.receiptId === "string" && typeof r.emittedAt === "string" && !!r.emitter && !!repo && typeof repo.key === "string" && typeof repo.canonicalRoot === "string" && typeof repo.remote === "string" && ["github", "gitlab", "unknown"].includes(String(repo.forge)) && typeof repo.nameWithOwner === "string" && !!pr && typeof pr.number === "number" && typeof pr.url === "string" && typeof pr.state === "string" && typeof pr.baseRefName === "string" && typeof pr.headRefName === "string" && typeof pr.headRefOid === "string" && !!branch && typeof branch.name === "string" && typeof branch.deletedRemote === "boolean" && ["on", "off", "unknown"].includes(String(branch.autoDeleteSetting)) && !!worktree && (typeof worktree.path === "string" || worktree.path === null) && typeof worktree.removed === "boolean" && typeof worktree.localRefDeleted === "boolean" && !!beads && Array.isArray(beads.ids) && typeof beads.ledgerActive === "boolean" && !!proof && typeof proof.method === "string" && typeof proof.observedAt === "string" && !!r.outcome && ["landed", "cleaned", "partial"].includes(String(r.outcome));
}
function receiptResidue(common: string | null): HygieneFinding | null {
  const root = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".omp");
  if (!common || !root) return { kind: "receipts", status: "ambiguous", description: "Receipt state is unavailable because Git common-dir could not be proved." };
  const dir = join(root, "receipts", repoKey(common));
  try {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter(file => file.endsWith(".json")); const invalid: string[] = [];
    for (const file of files) { try { if (!validReceipt(JSON.parse(readFileSync(join(dir, file), "utf8")))) invalid.push(file); } catch { invalid.push(file); } }
    if (!files.length) return null;
    const paths = files.map(file => join(dir, file));
    return { kind: "receipts", status: invalid.length ? "ambiguous" : "actionable", description: invalid.length ? `Receipt residue includes ${invalid.length} malformed or unsupported object(s); reconciliation proof is ambiguous.` : `${files.length} valid landing receipt(s) remain for reconciliation review.`, paths };
  } catch { return { kind: "receipts", status: "ambiguous", description: "Receipt directory could not be read; do not infer cleanup eligibility." }; }
}
function externalState(cwd: string, findings: HygieneFinding[], limitations: string[]): void {
  const remote = git(cwd, ["remote", "get-url", "origin"]); const branch = git(cwd, ["branch", "-vv"]);
  if (!available(remote)) { findings.push({ kind: "forge", status: "ambiguous", description: "Forge publication evidence is unavailable; landed cleanup cannot be inferred." }); limitations.push("Forge state was unavailable."); }
  if (!available(branch)) { findings.push({ kind: "publication", status: "ambiguous", description: "Publication/upstream evidence is unavailable; branch landing cannot be inferred." }); limitations.push("Publication state was unavailable."); }
  const bd = run(["bd", "list", "--limit", "1", "--json"], cwd);
  if (!available(bd)) { findings.push({ kind: "beads", status: "ambiguous", description: "Beads state is unavailable; reconciliation and cleanup eligibility cannot be inferred." }); limitations.push("Beads state was unavailable."); }
}
export function scanHygiene(cwd: string): HygieneReport {
  const root = resolve(cwd); const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })(); const findings: HygieneFinding[] = []; const limitations: string[] = [];
  const commonResult = git(root, ["rev-parse", "--git-common-dir"]); const common = available(commonResult) ? resolve(root, commonResult.stdout.trim()) : null;
  if (!common) findings.push({ kind: "git", status: "ambiguous", description: "Git common-dir is unavailable; owned repository scope cannot be established." });
  const wtResult = common ? git(root, ["worktree", "list", "--porcelain"]) : { exitCode: 1, stdout: "", stderr: "" };
  const worktrees = available(wtResult) ? parseWorktrees(wtResult.stdout) : []; const current = worktrees.find(w => { try { return realpathSync(w.path) === realRoot; } catch { return resolve(w.path) === realRoot; } });
  if (!current) findings.push({ kind: "scope", status: "ambiguous", description: "Current path is not present in Git's owned worktree list; no sibling or foreign state was scanned." });
  const status = common ? git(root, ["status", "--porcelain=v1", "-z", "-b"]) : { exitCode: 1, stdout: "", stderr: "" };
  if (!available(status)) findings.push({ kind: "git", status: "ambiguous", description: "Git status is unavailable or timed out; dirty or unpushed state is unknown." });
  else { const dirty = parsePorcelainPaths(status.stdout); if (dirty.length) findings.push({ kind: "dirty", status: "actionable", description: `${dirty.length} current-worktree path(s) are dirty; review before cleanup.`, paths: dirty }); }
  if (worktrees.length > 1 && current) { const duplicates = worktrees.filter(w => w.path !== current?.path && w.branch && w.branch === current.branch).map(w => resolve(w.path)); if (duplicates.length) findings.push({ kind: "duplicate-work", status: "ambiguous", description: `Another owned worktree uses branch ${current.branch}; cleanup requires explicit ownership proof.`, paths: duplicates }); }
  const receipt = receiptResidue(common); if (receipt) findings.push(receipt); externalState(root, findings, limitations);
  const statusValue: HygieneStatus = findings.some(f => f.status === "ambiguous") ? "ambiguous" : findings.some(f => f.status === "actionable") ? "actionable" : "clean";
  return { scope: { cwd: root, commonGitDir: common, currentWorktree: current?.path ?? null }, status: statusValue, findings, limitations, mutation: "none" };
}
function render(report: HygieneReport, name: string): string { return `${name}: ${report.status}\n${JSON.stringify(report, null, 2)}`; }
export default function hygieneOrientation(pi: ExtensionAPI): void {
  const z = pi.zod; const parameters = z.object({}) as unknown as TSchema;
  const execute = async (_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) => { const report = scanHygiene(ctx.cwd); return { content: [{ type: "text" as const, text: render(report, "delivery_hygiene_report") }], details: report }; };
  pi.registerTool({ name: "delivery_orient", label: "Delivery Orientation", description: "Read-only orientation for the main agent or run lead. Inspect only the current owned repository; invocation guidance is explicit and does not enforce runtime role identity.", parameters, approval: "read", execute });
  pi.registerTool({ name: "delivery_hygiene_report", label: "Delivery Hygiene Report", description: "Read-only report of current owned repository hygiene. It never mutates state and recommends the report-only reaper only for ambiguity.", parameters, approval: "read", execute });
}
