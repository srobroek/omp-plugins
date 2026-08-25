import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import migrationEditGate, {
	decidePath,
	decideToolCall,
	editedPaths,
	hashlinePaths,
	latestMigration,
	migrationTarget,
} from "./migration-edit-gate.ts";

/** A repo with `migrations/<name>` for each entry; directory entries end in `/`. */
function repo(entries: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "migration-gate-"));
	const dir = join(root, "migrations");
	mkdirSync(dir, { recursive: true });
	for (const entry of entries) {
		if (entry.endsWith("/")) {
			mkdirSync(join(dir, entry.slice(0, -1)), { recursive: true });
			writeFileSync(join(dir, entry.slice(0, -1), "up.sql"), "SELECT 1;\n");
		} else {
			writeFileSync(join(dir, entry), "SELECT 1;\n");
		}
	}
	return root;
}

describe("migrationTarget", () => {
	test("finds the numbered entry under migrations/", () => {
		expect(migrationTarget("migrations/0001_init.sql")).toEqual({
			dir: "migrations",
			entry: "0001_init.sql",
		});
		expect(migrationTarget("crates/db/migrations/20240115120000_add.sql")).toEqual({
			dir: "crates/db/migrations",
			entry: "20240115120000_add.sql",
		});
		expect(migrationTarget("migrations/0003_name/up.sql")).toEqual({
			dir: "migrations",
			entry: "0003_name",
		});
		expect(migrationTarget("/abs/migrations/0001_init.sql")?.dir).toBe("/abs/migrations");
	});

	test("ignores unnumbered entries and non-migration paths", () => {
		expect(migrationTarget("migrations/README.md")).toBeNull();
		expect(migrationTarget("migrations/.gitkeep")).toBeNull();
		expect(migrationTarget("src/lib.rs")).toBeNull();
		expect(migrationTarget("migrations")).toBeNull();
		expect(migrationTarget("docs/migrations-guide.md")).toBeNull();
	});
});

describe("latestMigration", () => {
	test("orders by numeric prefix, not lexically", () => {
		const root = repo(["1_a.sql", "2_b.sql", "10_c.sql", "README.md"]);
		expect(latestMigration(join(root, "migrations"))).toBe("10_c.sql");
	});

	test("handles timestamp prefixes and per-migration directories", () => {
		const root = repo(["20240101090000_a.sql", "20240115120000_b/"]);
		expect(latestMigration(join(root, "migrations"))).toBe("20240115120000_b");
	});

	test("missing directory yields nothing", () => {
		expect(latestMigration(join(tmpdir(), "no-such-migrations-dir"))).toBeUndefined();
	});
});

describe("decidePath", () => {
	test("blocks a committed migration that is not the latest", () => {
		const root = repo(["0001_init.sql", "0002_add.sql"]);
		const decision = decidePath("migrations/0001_init.sql", root);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("append-only");
		expect(decision?.reason).toContain("0002_add.sql");
	});

	test("leaves the latest migration editable", () => {
		const root = repo(["0001_init.sql", "0002_add.sql"]);
		expect(decidePath("migrations/0002_add.sql", root)).toBeUndefined();
	});

	test("numeric ordering decides which one is latest", () => {
		const root = repo(["1_a.sql", "2_b.sql", "10_c.sql"]);
		expect(decidePath("migrations/10_c.sql", root)).toBeUndefined();
		expect(decidePath("migrations/2_b.sql", root)?.block).toBe(true);
	});

	test("a new migration file is always allowed", () => {
		const root = repo(["0001_init.sql"]);
		expect(decidePath("migrations/0002_add.sql", root)).toBeUndefined();
	});

	test("blocks a file inside an older per-migration directory", () => {
		const root = repo(["0001_init/", "0002_add/"]);
		expect(decidePath("migrations/0001_init/up.sql", root)?.block).toBe(true);
		expect(decidePath("migrations/0002_add/up.sql", root)).toBeUndefined();
	});

	test("ignores unnumbered files, other trees, and internal URIs", () => {
		const root = repo(["0001_init.sql", "0002_add.sql"]);
		writeFileSync(join(root, "migrations", "README.md"), "docs\n");
		expect(decidePath("migrations/README.md", root)).toBeUndefined();
		expect(decidePath("src/lib.rs", root)).toBeUndefined();
		expect(decidePath("xd://ast_edit", root)).toBeUndefined();
		expect(decidePath("", root)).toBeUndefined();
	});

	test("absolute paths resolve to the same decision", () => {
		const root = repo(["0001_init.sql", "0002_add.sql"]);
		expect(decidePath(join(root, "migrations", "0001_init.sql"), "/nowhere")?.block).toBe(true);
	});
});

describe("editedPaths", () => {
	test("reads direct paths and hashline section headers", () => {
		expect(editedPaths({ path: "migrations/0001_init.sql" })).toEqual(["migrations/0001_init.sql"]);
		expect(editedPaths({ paths: ["a.sql", "b.sql"] })).toEqual(["a.sql", "b.sql"]);
		expect(hashlinePaths('[migrations/0001_init.sql#A1B2]\nPUT 1.=1:\n+SELECT 2;')).toEqual([
			"migrations/0001_init.sql",
		]);
		expect(
			editedPaths({ input: '[src/lib.rs#A1B2]\nPUT 1.=1:\n+x\n[migrations/0001_init.sql#C3D4]\nREM' }),
		).toEqual(["src/lib.rs", "migrations/0001_init.sql"]);
	});

	test("body rows are not headers", () => {
		expect(hashlinePaths('[a.sql#A1B2]\nPUT 1.=1:\n+[migrations/0001_init.sql#C3D4]')).toEqual(["a.sql"]);
	});
});

describe("decideToolCall", () => {
	test("blocks write and edit, ignores other tools", () => {
		const root = repo(["0001_init.sql", "0002_add.sql"]);
		expect(decideToolCall("write", { path: "migrations/0001_init.sql" }, root)?.block).toBe(true);
		expect(
			decideToolCall("edit", { input: '[migrations/0001_init.sql#A1B2]\nPUT 1.=1:\n+SELECT 2;' }, root)
				?.block,
		).toBe(true);
		expect(decideToolCall("bash", { command: "sed -i s/a/b/ migrations/0001_init.sql" }, root)).toBeUndefined();
		expect(decideToolCall("read", { path: "migrations/0001_init.sql" }, root)).toBeUndefined();
	});

	test("one blocked section blocks the whole multi-file patch", () => {
		const root = repo(["0001_init.sql", "0002_add.sql"]);
		const payload = [
			"[src/db.rs#1111]",
			"PUT 1.=1:",
			"+// note",
			"[migrations/0001_init.sql#2222]",
			"PUT 1.=1:",
			"+SELECT 2;",
		].join("\n");
		expect(decideToolCall("edit", { input: payload }, root)?.block).toBe(true);
	});
});

describe("integration", () => {
	const wire = () => {
		const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
		migrationEditGate({
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: (e: Record<string, unknown>) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		} as never);
		return handlers;
	};

	test("registers a tool_call gate that blocks by absolute path", () => {
		const root = repo(["0001_init.sql", "0002_add.sql"]);
		const handlers = wire();
		const blocked = handlers.tool_call![0]!({
			toolName: "write",
			toolCallId: "m1",
			input: { path: join(root, "migrations", "0001_init.sql"), content: "SELECT 2;" },
		});
		expect(blocked).toEqual(
			expect.objectContaining({ block: true, reason: expect.stringContaining("append-only") }),
		);
		expect(
			handlers.tool_call![0]!({
				toolName: "write",
				toolCallId: "m2",
				input: { path: join(root, "migrations", "0002_add.sql"), content: "SELECT 2;" },
			}),
		).toBeUndefined();
	});

	test("handler swallows malformed events", () => {
		const handlers = wire();
		expect(handlers.tool_call![0]!({ toolName: "write", toolCallId: "x", input: null })).toBeUndefined();
	});
});
