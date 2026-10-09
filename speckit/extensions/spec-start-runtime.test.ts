import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecStart } from "./spec-start-runtime.ts";
import speckitStartTool from "./speckit-start-tool.ts";

const spec = "001-example";
let dir: string;
let workspace: string;
let state: string;
let serialising: string;
let refusing: string;
let recording: string;
const saved = { path: process.env.PATH, state: process.env.SPECKIT_FAKE_BD_STATE, delay: process.env.SPECKIT_FAKE_BD_DELAY };

/** A Beads package whose store lock is an in-process queue, one that refuses every hold, or one that records its wait arguments. */
function fakeBeads(name: string, hold: string): string {
	const root = join(dir, name);
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@srobroek/beads", exports: { "./embedded-write": "./dist/bd-embedded-write-lock.js" } }));
	writeFileSync(join(root, "dist", "bd-embedded-write-lock.js"), `let tail = Promise.resolve();\nexport function embeddedStoreFor(cwd) { return cwd + "/.beads"; }\nexport async function withEmbeddedWriteLock(cwd, owner, write, env, deadline, signal) {\n${hold}\n}\n`);
	return root;
}

/** A `bd` that keeps one JSON ledger, logs every call, and pours slowly enough to race; SPECKIT_FAKE_BD_DELAY slows named steps further. */
const FAKE_BD = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const path = process.env.SPECKIT_FAKE_BD_STATE;
const args = process.argv.slice(2).filter(arg => arg !== "--json");
appendFileSync(path + ".log", args.join(" ") + "\\n");
const step = args[0] === "mol" ? args[0] + " " + args[1] : args[0];
await Bun.sleep(JSON.parse(process.env.SPECKIT_FAKE_BD_DELAY ?? "{}")[step] ?? (step === "mol pour" ? 300 : 0));
const ledger = JSON.parse(readFileSync(path, "utf8"));
const out = value => console.log(JSON.stringify(value));
if (args[0] === "query") out(ledger.filter(row => row.spec_id === "${spec}"));
else if (args[0] === "show") out(ledger.filter(row => row.id === args[1]));
else if (args[0] === "mol" && args[1] === "pour") {
	const id = "run-" + (ledger.length + 1);
	ledger.push({ id, title: args[2], issue_type: "molecule", status: "open", metadata: {} });
	writeFileSync(path, JSON.stringify(ledger));
	out({ new_epic_id: id });
} else if (args[0] === "update") {
	const row = ledger.find(issue => issue.id === args[1]);
	for (let i = 2; i < args.length; i++) {
		if (args[i] === "--spec-id") row.spec_id = args[++i];
		else if (args[i] === "--set-metadata") { const [key, value] = args[++i].split("="); row.metadata[key] = value; }
		else if (args[i] === "--append-notes") i++;
	}
	writeFileSync(path, JSON.stringify(ledger));
} else { console.error("unexpected " + args.join(" ")); process.exit(2); }
`;

const calls = (): string[] => (existsSync(`${state}.log`) ? readFileSync(`${state}.log`, "utf8").trim().split("\n").filter(Boolean) : []);
const options = (beadsPlugin: string) => ({ spec, workspace, approvals: "yes" as const, decision: "Keep routine approvals", beadsPlugin });
const start = (beadsPlugin: string, signal?: AbortSignal, commandMs?: number) => runSpecStart(options(beadsPlugin), signal, commandMs);
const delay = (steps: Record<string, number>) => { process.env.SPECKIT_FAKE_BD_DELAY = JSON.stringify(steps); };

type ToolResult = { content: { text: string }[]; details: Record<string, unknown>; isError?: boolean };
/** The registered `speckit_start` execute, called the way OMP calls it. */
function tool(): (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult> {
	let execute!: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
	const schema = () => { const node = { optional: () => node, describe: () => node }; return node; };
	speckitStartTool({ zod: { object: (shape: unknown) => shape, string: schema, enum: schema, boolean: schema }, registerTool: (definition: { execute: typeof execute }) => { execute = definition.execute; } } as never);
	return execute;
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "spec-start-runtime-")));
	workspace = join(dir, "repo");
	mkdirSync(join(workspace, ".beads"), { recursive: true });
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "bd"), FAKE_BD);
	chmodSync(join(bin, "bd"), 0o755);
	state = join(dir, "ledger.json");
	serialising = fakeBeads("beads-queue", `const turn = tail.then(() => write());\ntail = turn.catch(() => {});\nreturn { kind: "done", value: await turn };`);
	refusing = fakeBeads("beads-busy", `return { kind: "failed", reason: "store busy." };`);
	recording = fakeBeads("beads-recording", `globalThis.speckitLockWait = { deadline, signal };\nreturn { kind: "done", value: await write() };`);
	process.env.PATH = `${bin}:${saved.path ?? ""}`;
	process.env.SPECKIT_FAKE_BD_STATE = state;
});

beforeEach(() => {
	writeFileSync(state, "[]");
	rmSync(`${state}.log`, { force: true });
	delete process.env.SPECKIT_FAKE_BD_DELAY;
});

afterAll(() => {
	process.env.PATH = saved.path;
	if (saved.state === undefined) delete process.env.SPECKIT_FAKE_BD_STATE;
	else process.env.SPECKIT_FAKE_BD_STATE = saved.state;
	if (saved.delay === undefined) delete process.env.SPECKIT_FAKE_BD_DELAY;
	else process.env.SPECKIT_FAKE_BD_DELAY = saved.delay;
	rmSync(dir, { recursive: true, force: true });
});

test("concurrent starts for one spec hold the store lock end to end and pour one run", async () => {
	const [first, second] = await Promise.all([start(serialising), start(serialising)]);
	expect(first.status).toBe("READY");
	expect(second).toMatchObject({ status: "READY", root: first.root, humanApprovals: "yes" });
	expect(calls().filter(line => line.startsWith("mol pour"))).toHaveLength(1);
});

test("a refused store lock is an incomplete start before any bd command runs", async () => {
	const result = await tool()("id", options(refusing), new AbortController().signal);
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("store busy. No workflow-start command ran.");
	expect(result.details).toMatchObject({ status: "INCOMPLETE", step: "store lock", completedSteps: [] });
	expect(calls()).toEqual([]);
});

test("the store-lock wait uses the Beads default bound and the tool's abort signal", async () => {
	const controller = new AbortController();
	const result = await tool()("id", options(recording), controller.signal);
	expect(result.details).toMatchObject({ status: "READY" });
	const wait = Reflect.get(globalThis, "speckitLockWait") as { deadline?: number; signal?: AbortSignal };
	expect(wait.deadline).toBeUndefined();
	expect(wait.signal).toBe(controller.signal);
});

test("a cancelled call runs no bd command and reports an incomplete start", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await tool()("id", options(serialising), controller.signal);
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("No workflow-start command ran.");
	expect(result.details).toMatchObject({ status: "INCOMPLETE", step: "query", completedSteps: [] });
	expect(calls()).toEqual([]);
});

test("cancelling during the pour stops bd and reports that a pour was issued", async () => {
	delay({ "mol pour": 60_000 });
	const controller = new AbortController();
	const pending = tool()("id", options(serialising), controller.signal);
	while (!calls().some(line => line.startsWith("mol pour"))) await Bun.sleep(50);
	controller.abort();
	const result = await pending;
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("a pour was issued and may be partial");
	expect(result.details).toMatchObject({ status: "INCOMPLETE", step: "mol pour", completedSteps: ["query"] });
	expect(calls()).toHaveLength(2);
	expect(readFileSync(state, "utf8")).toBe("[]");
}, 20_000);

test("a bounded read that outlasts its own bound is an incomplete start, not a failure", async () => {
	delay({ query: 60_000 });
	const error = await start(serialising, undefined, 3_000).then(() => undefined, (caught: unknown) => caught);
	expect(error).toMatchObject({ details: { status: "INCOMPLETE", step: "query", completedSteps: [] } });
	expect((error as Error).message).toContain("no pour was issued");
	expect(calls()).toHaveLength(1);
}, 20_000);

test("a pour longer than the per-command bound is not cut off", async () => {
	delay({ "mol pour": 6_000 });
	expect(await start(serialising, undefined, 3_000)).toMatchObject({ status: "READY", root: "run-1" });
}, 20_000);
