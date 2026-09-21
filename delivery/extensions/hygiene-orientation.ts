import { lstatSync, readdirSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readReceipt, receiptDirectory, repoKey } from "./landing-receipt";

type RunResult = { exitCode: number; signalCode?: string | number | null; stdout: string; stderr: string; timedOut: boolean };
export type HygieneStatus = "actionable" | "ambiguous" | "clean";
export type HygieneFinding = { kind: string; status: HygieneStatus; description: string; paths?: string[] };
export type HygieneReport = { scope: { cwd: string; commonGitDir: string | null; currentWorktree: string | null }; status: HygieneStatus; findings: HygieneFinding[]; limitations: string[]; mutation: "none" };
const TIMEOUT_MS = 2000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_RECEIPTS = 256;
const MAX_RECEIPT_BYTES = 1024 * 1024;

function run(argv: string[], cwd: string): RunResult {
  try {
    const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS, killSignal: 9, maxBuffer: MAX_OUTPUT_BYTES });
    const result = p as typeof p & { exitedDueToTimeout?: boolean };
    return { exitCode: p.exitCode, signalCode: p.signalCode, stdout: p.stdout.toString(), stderr: p.stderr.toString(), timedOut: result.exitedDueToTimeout === true };
  } catch (error) { return { exitCode: 127, signalCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false }; }
}
function git(cwd: string, args: string[]): RunResult { return run(["git", "--no-optional-locks", ...args], cwd); }
function available(result: RunResult): boolean { return result.exitCode === 0 && !result.timedOut && (result.signalCode === undefined || result.signalCode === 0 || result.signalCode === null); }
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
    const code = field.slice(0, 2); const path = field.slice(3); if (path) paths.push(path);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") { const original = fields[i + 1]; if (original) { paths.push(original); i += 1; } }
  }
  return paths;
}
function receiptResidue(cwd: string): HygieneFinding | null {
  const key = repoKey(cwd); if (!key) return { kind: "receipts", status: "ambiguous", description: "Receipt state is unavailable because the canonical Git repository key could not be proved." };
  let dir: string;
  try { dir = receiptDirectory(process.env, key); } catch { return { kind: "receipts", status: "ambiguous", description: "Receipt directory could not be resolved from a validated agent root." }; }
  if (!isAbsolute(dir)) return { kind: "receipts", status: "ambiguous", description: "Receipt directory is not absolute; receipt state is untrusted." };
  try {
    const rootStat = lstatSync(resolve(dir, "..", "..")); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { kind: "receipts", status: "ambiguous", description: "Agent receipt root is not a regular directory; receipt state is untrusted." };
    const dirStat = lstatSync(dir); if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { kind: "receipts", status: "ambiguous", description: "Receipt directory is not a regular directory; receipt state is untrusted." };
    const entries = readdirSync(dir, { withFileTypes: true }); if (entries.length > MAX_RECEIPTS) return { kind: "receipts", status: "ambiguous", description: "Receipt directory exceeds the bounded scan limit; receipt state is incomplete." };
    const paths: string[] = []; const invalid: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name); let stat: Stats;
      try { stat = lstatSync(path); } catch { invalid.push(path); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) { invalid.push(path); continue; }
      paths.push(path); const validation = readReceipt(path); if (!validation.ok) invalid.push(path);
    }
    if (!paths.length && !invalid.length) return null;
    return { kind: "receipts", status: invalid.length ? "ambiguous" : "actionable", description: invalid.length ? "Receipt residue includes malformed, hostile, or unsupported object(s); reconciliation proof is ambiguous." : `${paths.length} valid landing receipt(s) remain for reconciliation review.`, paths: [...new Set([...paths, ...invalid])] };
  } catch { return { kind: "receipts", status: "ambiguous", description: "Receipt directory could not be safely read; do not infer cleanup eligibility." }; }
}
function externalState(cwd: string, findings: HygieneFinding[], limitations: string[]): void {
  const remote = git(cwd, ["remote", "get-url", "origin"]); const branch = git(cwd, ["branch", "-vv"]);
  if (!available(remote)) { findings.push({ kind: "forge", status: "ambiguous", description: "Forge publication evidence is unavailable; landed cleanup cannot be inferred." }); limitations.push("Forge state was unavailable."); }
  if (!available(branch)) { findings.push({ kind: "publication", status: "ambiguous", description: "Publication/upstream evidence is unavailable; branch landing cannot be inferred." }); limitations.push("Publication state was unavailable."); }
  const bd = run(["bd", "list", "--limit", "1", "--json"], cwd); if (!available(bd)) { findings.push({ kind: "beads", status: "ambiguous", description: "Beads state is unavailable; reconciliation and cleanup eligibility cannot be inferred." }); limitations.push("Beads state was unavailable."); }
}
export function scanHygiene(cwd: string): HygieneReport {
  const root = resolve(cwd); const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })(); const findings: HygieneFinding[] = []; const limitations: string[] = [];
  const commonResult = git(root, ["rev-parse", "--git-common-dir"]); let common: string | null = null;
  if (available(commonResult)) { const candidate = resolve(root, commonResult.stdout.trim()); try { common = realpathSync(candidate); } catch { common = null; } }
  if (!common) findings.push({ kind: "git", status: "ambiguous", description: "Git common-dir is unavailable or cannot be realpathed; owned repository scope cannot be established." });
  const wtResult = common ? git(root, ["worktree", "list", "--porcelain"]) : { exitCode: 1, stdout: "", stderr: "", timedOut: false }; const worktrees = available(wtResult) ? parseWorktrees(wtResult.stdout) : []; const current = worktrees.find(w => { try { return realpathSync(w.path) === realRoot; } catch { return resolve(w.path) === realRoot; } });
  if (!current) findings.push({ kind: "scope", status: "ambiguous", description: "Current path is not present in Git's owned worktree list; no sibling or foreign state was scanned." });
  const status = common ? git(root, ["status", "--porcelain=v1", "-z", "-b"]) : { exitCode: 1, stdout: "", stderr: "", timedOut: false }; if (!available(status)) findings.push({ kind: "git", status: "ambiguous", description: "Git status is unavailable, timed out, or was killed; dirty or upstream state is unknown." });
  else { const dirty = parsePorcelainPaths(status.stdout); if (dirty.length) findings.push({ kind: "dirty", status: "actionable", description: `${dirty.length} current-worktree path(s) are dirty; review before cleanup.`, paths: dirty }); const header = status.stdout.split("\0")[0] || ""; if (/\[ahead(?: \d+)?(?:,|\])/.test(header)) findings.push({ kind: "unpushed", status: "actionable", description: "Current branch has unpushed commits; do not classify it as landed." }); if (/\[behind(?: \d+)?(?:,|\])/.test(header)) findings.push({ kind: "upstream", status: "actionable", description: "Current branch is behind its upstream; publication state requires review." }); }
  if (worktrees.length > 1 && current) { const duplicates = worktrees.filter(w => w.path !== current?.path && w.branch && w.branch === current.branch).map(w => resolve(w.path)); if (duplicates.length) findings.push({ kind: "duplicate-work", status: "ambiguous", description: `Another owned worktree uses branch ${current.branch}; cleanup requires explicit ownership proof.`, paths: duplicates }); }
  const receipt = receiptResidue(root); if (receipt) findings.push(receipt); externalState(root, findings, limitations);
  const statusValue: HygieneStatus = findings.some(f => f.status === "ambiguous") ? "ambiguous" : findings.some(f => f.status === "actionable") ? "actionable" : "clean"; return { scope: { cwd: root, commonGitDir: common, currentWorktree: current?.path ?? null }, status: statusValue, findings, limitations, mutation: "none" };
}
function render(report: HygieneReport, name: string): string { return `${name}: ${report.status}\n${JSON.stringify(report, null, 2)}`; }
export default function hygieneOrientation(pi: ExtensionAPI): void {
  const z = pi.zod; const parameters = z.object({}) as unknown as TSchema; const execute = async (_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) => { const report = scanHygiene(ctx.cwd); return { content: [{ type: "text" as const, text: render(report, "delivery_hygiene_report") }], details: report }; };
  pi.registerTool({ name: "delivery_orient", label: "Delivery Orientation", description: "Read-only orientation for the main agent or run lead. Inspect only the current owned repository; invocation guidance is explicit and does not enforce runtime role identity.", parameters, approval: "read", execute });
  pi.registerTool({ name: "delivery_hygiene_report", label: "Delivery Hygiene Report", description: "Read-only report of current owned repository hygiene. It never mutates state and recommends the report-only reaper only for ambiguity.", parameters, approval: "read", execute });
}
