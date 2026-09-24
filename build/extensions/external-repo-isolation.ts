import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const MUTATING = new Set(["edit", "write", "bash"]);

function resolvedExisting(path: string): string | null {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  try { return realpathSync(candidate); } catch { return null; }
}

export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function isolationDecision(event: Pick<ToolCallEvent, "toolName" | "input">, callerCwd: string): string | null {
  if (!MUTATING.has(event.toolName)) return null;
  const callerRoot = resolvedExisting(callerCwd);
  if (!callerRoot) return "refusing mutation: caller checkout root cannot be resolved";
  const input = (event.input ?? {}) as Record<string, unknown>;
  if (event.toolName === "bash") {
    const cwd = typeof input.cwd === "string" ? input.cwd : callerCwd;
    const target = resolvedExisting(cwd);
    if (!target) return "refusing mutation: bash cwd cannot be resolved";
    if (isInside(target, callerRoot)) {
      const command = typeof input.command === "string" ? input.command : "";
      const outside = [...command.matchAll(/(?:^|\s)(\/[^\s;&|]+)/g)].map((m) => resolvedExisting(m[1] as string)).filter(Boolean) as string[];
      if (!outside.some((path) => !isInside(path, callerRoot))) return "refusing bash mutation in caller checkout; use a verified external checkout cwd or absolute external target";
    }
    return null;
  }
  const raw = typeof input.path === "string" ? input.path : "";
  const target = resolvedExisting(isAbsolute(raw) ? raw : resolve(callerCwd, raw));
  if (!target) return "refusing mutation: target path cannot be resolved";
  if (isInside(target, callerRoot)) return "refusing mutation inside caller checkout; target an external checkout";
  return null;
}

export default function externalRepoIsolation(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    const reason = isolationDecision(event, ctx.cwd);
    if (reason) throw new Error(reason);
  });
}
