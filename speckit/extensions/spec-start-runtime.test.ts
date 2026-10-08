import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecStart } from "./spec-start-runtime.ts";

const spec = "001-example";
let dir: string;
let workspace: string;
let state: string;
let serialising: string;
let refusing: string;
const saved = { path: process.env.PATH, state: process.env.SPECKIT_FAKE_BD_STATE };

/** A Beads package whose store lock is an in-process queue, or one that refuses every hold. */
function fakeBeads(name: string, hold: string): string {
	const root = join(dir, name);
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@srobroek/beads", exports: { "./embedded-write": "./dist/bd-embedded-write-lock.js" } }));
	writeFileSync(join(root, "dist", "bd-embedded-write-lock.js"), `let tail = Promise.resolve();\nexport function embeddedStoreFor(cwd) { return cwd + "/.beads"; }\nexport async function withEmbeddedWriteLock(cwd, owner, write) {\n${hold}\n}\n`);
	return root;
}

/** A `bd` that keeps one JSON ledger, logs every call, and pours slowly enough to race. */
const FAKE_BD = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const path = process.env.SPECKIT_FAKE_BD_STATE;
const args = process.argv.slice(2).filter(arg => arg !== "--json");
appendFileSync(path + ".log", args.join(" ") + "\\n");
const ledger = JSON.parse(readFileSync(path, "utf8"));
const out = value => console.log(JSON.stringify(value));
if (args[0] === "query") out(ledger.filter(row => row.spec_id === "${spec}"));
else if (args[0] === "show") out(ledger.filter(row => row.id === args[1]));
else if (args[0] === "mol" && args[1] === "pour") {
	await Bun.sleep(300);
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
const start = (beadsPlugin: string) => runSpecStart({ spec, workspace, approvals: "yes", decision: "Keep routine approvals", beadsPlugin });

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
	process.env.PATH = `${bin}:${saved.path ?? ""}`;
	process.env.SPECKIT_FAKE_BD_STATE = state;
});

beforeEach(() => {
	writeFileSync(state, "[]");
	rmSync(`${state}.log`, { force: true });
});

afterAll(() => {
	process.env.PATH = saved.path;
	if (saved.state === undefined) delete process.env.SPECKIT_FAKE_BD_STATE;
	else process.env.SPECKIT_FAKE_BD_STATE = saved.state;
	rmSync(dir, { recursive: true, force: true });
});

test("concurrent starts for one spec hold the store lock end to end and pour one run", async () => {
	const [first, second] = await Promise.all([start(serialising), start(serialising)]);
	expect(first.status).toBe("READY");
	expect(second).toMatchObject({ status: "READY", root: first.root, humanApprovals: "yes" });
	expect(calls().filter(line => line.startsWith("mol pour"))).toHaveLength(1);
});

test("a refused store lock fails before any bd command runs", async () => {
	await expect(start(refusing)).rejects.toThrow("store busy. No workflow-start command ran.");
	expect(calls()).toEqual([]);
});
