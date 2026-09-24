import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolationDecision } from "./external-repo-isolation.ts";

const input = (toolName: string, input: Record<string, unknown>) => ({ toolName, input }) as never;

describe("external repository isolation", () => {
 test("refuses edits in caller checkout", () => {
  const caller = mkdtempSync(join(tmpdir(), "build-gate-caller-"));
  mkdirSync(join(caller, ".git"));
  const file = join(caller, "file.txt"); writeFileSync(file, "x");
  expect(isolationDecision(input("edit", { path: file }), caller)).toContain("caller checkout");
 });
 test("allows an existing external checkout", () => {
  const caller = mkdtempSync(join(tmpdir(), "build-gate-caller-"));
  const external = mkdtempSync(join(tmpdir(), "build-gate-external-"));
  mkdirSync(join(caller, ".git")); mkdirSync(join(external, ".git"));
  const file = join(external, "file.txt"); writeFileSync(file, "x");
  expect(isolationDecision(input("write", { path: file }), caller)).toBeNull();
 });
 test("refuses caller bash without a proven external target", () => {
  const caller = mkdtempSync(join(tmpdir(), "build-gate-caller-")); mkdirSync(join(caller, ".git"));
  expect(isolationDecision(input("bash", { cwd: caller, command: "touch file.txt" }), caller)).toContain("caller checkout");
 });
});
