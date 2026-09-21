import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import hygieneOrientation, { parsePorcelainPaths, scanHygiene } from "./hygiene-orientation";
import { receiptDirectory, repoKey } from "./landing-receipt";

const temp = () => mkdtempSync(join(tmpdir(), "delivery-hygiene-"));
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 2000 });
function repo(): string { const cwd = temp(); git(cwd, "init", "-q"); writeFileSync(join(cwd, "tracked.txt"), "base\n"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "base"); return cwd; }
process.env.PI_CODING_AGENT_DIR = temp();

describe("delivery hygiene orientation", () => {
  test("dirty state is actionable but missing publication evidence is ambiguous", () => {
    const cwd = repo(); writeFileSync(join(cwd, "tracked.txt"), "changed\n");
    const result = scanHygiene(cwd);
    expect(result.status).toBe("ambiguous");
    expect(result.findings.some(f => f.kind === "dirty" && f.status === "actionable")).toBe(true);
    expect(result.findings.some(f => f.kind === "beads" || f.kind === "forge" || f.kind === "publication")).toBe(true);
  });
  test("missing git is conservatively ambiguous", () => {
    const result = scanHygiene(temp());
    expect(result.status).toBe("ambiguous");
    expect(result.findings.some(f => f.kind === "git" || f.kind === "scope")).toBe(true);
  });
  test("porcelain rename and copy records consume both paths", () => {
    expect(parsePorcelainPaths("R  new.txt\0old.txt\0C  copy.txt\0source.txt\0")).toEqual(["new.txt", "old.txt", "copy.txt", "source.txt"]);
  });
  test("read-only scan does not change the git index", () => {
    const cwd = repo(); const index = join(cwd, ".git", "index"); const before = statSync(index).mtimeMs;
    scanHygiene(cwd);
    expect(statSync(index).mtimeMs).toBe(before);
  });
  test("both tools are read-approved and use the context cwd only", () => {
    const registered: Record<string, { approval?: string; description?: string; execute?: (...args: unknown[]) => unknown }> = {};
    const pi = { zod: { object: (v: unknown) => v }, registerTool(def: { name: string; approval?: string; description?: string; execute?: (...args: unknown[]) => unknown }) { registered[def.name] = def; } };
    hygieneOrientation(pi as never);
    expect(Object.keys(registered)).toEqual(["delivery_orient", "delivery_hygiene_report"]);
    expect(registered.delivery_orient?.approval).toBe("read");
    expect(registered.delivery_hygiene_report?.approval).toBe("read");
    expect(registered.delivery_orient?.description).toContain("does not enforce runtime role");
  });
  test("scan leaves inspected files unchanged", () => {
    const cwd = repo(); const before = readFileSync(join(cwd, "tracked.txt"), "utf8");
    scanHygiene(cwd);
    expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe(before);
  });
  test("hostile receipt entries are ambiguous", () => {
    const cwd = repo(); const agent = process.env.PI_CODING_AGENT_DIR as string; const key = repoKey(cwd); if (!key) throw new Error("missing repo key");
    const dir = join(agent, "receipts", key); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "oversize.json"), "x".repeat(1024 * 1024 + 1));
    symlinkSync(join(cwd, "tracked.txt"), join(dir, "linked.json"));
    const fifo = join(dir, "pipe.json"); Bun.spawnSync(["mkfifo", fifo]);
    const result = scanHygiene(cwd);
    expect(result.status).toBe("ambiguous");
    const receipt = result.findings.find(f => f.kind === "receipts");
    expect(receipt?.paths).toEqual(expect.arrayContaining([join(dir, "oversize.json"), join(dir, "linked.json"), fifo]));
  });
  test("receipt directory falls back to platform home when HOME is unset", () => {
    expect(receiptDirectory({ HOME: "", PI_CODING_AGENT_DIR: "" })).toContain(".omp/receipts");
  });
});
