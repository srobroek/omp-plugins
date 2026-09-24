import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { candidates, listWorktrees, repoRoot, scanTranscriptMeta, sessionsRoot, type Candidate } from "./store";

type Params = { path?: string; scope?: "current" | "global"; limit?: number };

export default function sessionStatusTool(pi: ExtensionAPI): void {
 const z = pi.zod;
 pi.registerTool({
  name: "session_status",
  label: "Session status",
  description: "Read-only summary of persisted OMP sessions, scoped to the current repository by default.",
  parameters: z.object({ path: z.string().optional(), scope: z.enum(["current", "global"]).optional(), limit: z.number().int().positive().optional() }),
  approval: "read",
  async execute(_id, input, _signal, _onUpdate, ctx) {
   const params = input as Params;
   const project = repoRoot(params.path ?? ctx.cwd);
   const root = sessionsRoot();
   const family = params.scope === "global" ? undefined : listWorktrees(project);
   const accepted = family === undefined ? undefined : new Set(family.flatMap((w) => [w.path]));
   const found: Candidate[] = await candidates(root, accepted);
   const rows = [];
   for (const candidate of found.slice(0, params.limit ?? 20)) {
    try { const meta = await scanTranscriptMeta(candidate.file); rows.push({ id: meta.id, cwd: meta.cwd, branch: meta.branch, lastActiveMs: meta.lastActiveMs, turns: meta.turnCount }); }
    catch { /* unreadable sessions remain absent from a read-only summary */ }
   }
   const text = JSON.stringify({ project, scope: params.scope ?? "current", sessions: rows }, null, 2);
   return { content: [{ type: "text", text }], details: { project, scope: params.scope ?? "current", count: rows.length } };
  },
 });
}
