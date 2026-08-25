import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import agenticLintTool, {
	detectKind,
	frontmatterDefects,
	hasRulesContract,
	hostSpecificPaths,
	lint,
	parseXlint,
	splitFrontmatter,
	type Triple,
} from "./agentic-lint-tool.ts";
import parity from "./fixtures/parity.json";

const temps: string[] = [];

afterAll(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "agentic-lint-"));
	temps.push(d);
	return d;
}

function write(dir: string, name: string, content: string): string {
	const p = join(dir, name);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content, "utf8");
	return p;
}

function fakeZod(): { zod: unknown } {
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	chain.string = self;
	chain.optional = self;
	chain.describe = self;
	chain.object = self;
	chain.enum = self;
	chain.array = self;
	chain.boolean = self;
	return { zod: chain };
}

type ExecuteResult = {
	content: Array<{ type: string; text: string }>;
	details: { ok?: boolean; exitCode?: number; findings?: Array<{ code?: string; severity: string }> };
};

type Registered = {
	name?: string;
	execute?: (id: string, params: { paths: string[] }) => Promise<ExecuteResult>;
};

function registerTool(): Registered {
	const tools: Registered = {};
	const fakePi = {
		...fakeZod(),
		registerTool: (d: Registered) => Object.assign(tools, d),
		on: () => {},
	};
	agenticLintTool(fakePi as never);
	return tools;
}

const SKILL_TEMPLATE_LONG = `---
name: test-skill
description: {desc}
x-lint:
  allow: [{codes}]
  reason: "{reason}"
---

# Test Skill

MUST do something.
`;

const SKILL_TEMPLATE_NO_OVERRIDE = `---
name: test-skill
description: {desc}
---

# Test Skill

MUST do something.
`;

const SKILL_BASE = `---
name: {name}
description: {desc}
---

# {name}

{body}
`;

describe("parseXlint", () => {
	test("no xlint", () => {
		const text = "---\nname: foo\ndescription: bar\n---\nbody";
		const [codes, reason] = parseXlint(text);
		expect([...codes]).toEqual([]);
		expect(reason).toBe("");
	});

	test("inline list", () => {
		const text = '---\nx-lint:\n  allow: [E1, E3]\n  reason: "test reason"\n---\nbody';
		const [codes, reason] = parseXlint(text);
		expect(codes).toEqual(new Set(["E1", "E3"]));
		expect(reason).toBe("test reason");
	});

	test("block list", () => {
		const text = "---\nx-lint:\n  allow:\n    - E1\n    - W9\n  reason: block reason\n---\nbody";
		const [codes, reason] = parseXlint(text);
		expect(codes).toEqual(new Set(["E1", "W9"]));
		expect(reason).toBe("block reason");
	});

	test("no frontmatter", () => {
		const [codes, reason] = parseXlint("no frontmatter here");
		expect([...codes]).toEqual([]);
		expect(reason).toBe("");
	});

	test("missing reason returns empty reason", () => {
		const text = "---\nx-lint:\n  allow: [E1]\n---\nbody";
		const [codes, reason] = parseXlint(text);
		expect(codes.has("E1")).toBe(true);
		expect(reason).toBe("");
	});

	test("w code allowed", () => {
		const text = '---\nx-lint:\n  allow: [W9]\n  reason: "acceptable duplication"\n---\nbody';
		const [codes, reason] = parseXlint(text);
		expect(codes.has("W9")).toBe(true);
		expect(reason).toBe("acceptable duplication");
	});
});

describe("detectKind / splitFrontmatter / hasRulesContract", () => {
	test("detectKind by filename and parent", () => {
		expect(detectKind("/x/SKILL.md")).toBe("skill");
		expect(detectKind("/x/template-skill.md")).toBe("template");
		expect(detectKind("/x/foo.agent.md")).toBe("agent");
		expect(detectKind("/x/agents/reviewer.md")).toBe("agent");
		expect(detectKind("/x/rules.instructions.md")).toBe("pointer");
		expect(detectKind("/x/rules.context.md")).toBe("context");
		expect(detectKind("/x/readme.md")).toBe("unknown");
	});

	test("splitFrontmatter parses keys and folded continuation", () => {
		const [fm, body] = splitFrontmatter("---\nname: foo\ndescription: bar\n  more\n---\nhello");
		expect(fm.name).toBe("foo");
		expect(fm.description).toBe("bar more");
		expect(body).toBe("\nhello");
		expect(splitFrontmatter("nope")[0]).toEqual({});
	});

	test("hasRulesContract reads sibling rules json", () => {
		const dir = tmpDir();
		const agents = join(dir, "agents");
		const rules = join(dir, "rules");
		mkdirSync(agents, { recursive: true });
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "reviewer.rules.json"), JSON.stringify({ completion: true }));
		const path = write(agents, "reviewer.md", "---\nname: reviewer\n---\n");
		expect(hasRulesContract(path, { name: "reviewer" })).toBe(true);
		expect(hasRulesContract(path, { name: "missing" })).toBe(false);
	});
});

describe("override mechanism", () => {
	test("suppressed e1 prints overridden", () => {
		const desc = "word ".repeat(30).trim();
		const content = SKILL_TEMPLATE_LONG.replace("{desc}", desc)
			.replace("{codes}", "E1")
			.replace("{reason}", "routing depends on full description");
		const p = write(tmpDir(), "SKILL.md", content);
		const findings = lint(p);
		const sevs = new Set(findings.map((f) => f[0]));
		expect(findings.filter((f) => f[1] === "E1").every((f) => f[0] === "OVERRIDDEN")).toBe(true);
		expect(sevs.has("OVERRIDDEN")).toBe(true);
		expect(sevs.has("ERROR")).toBe(false);
	});

	test("overridden message contains reason", () => {
		const desc = "word ".repeat(30).trim();
		const content = SKILL_TEMPLATE_LONG.replace("{desc}", desc)
			.replace("{codes}", "E1")
			.replace("{reason}", "routing depends on full description");
		const p = write(tmpDir(), "SKILL.md", content);
		const overridden = lint(p).filter((f) => f[0] === "OVERRIDDEN");
		expect(overridden.length).toBeGreaterThan(0);
		expect(overridden[0]?.[2]).toContain("routing depends on full description");
	});

	test("missing reason is e9", () => {
		const desc = "word ".repeat(30).trim();
		const content = `---
name: test-skill
description: ${desc}
x-lint:
  allow: [E1]
---

# Test Skill

MUST do something.
`;
		const p = write(tmpDir(), "SKILL.md", content);
		const errorCodes = lint(p)
			.filter((f) => f[0] === "ERROR")
			.map((f) => f[1]);
		expect(errorCodes).toContain("E9");
	});

	test("non overridden error still errors", () => {
		const desc = "word ".repeat(30).trim();
		const content = `---
name: test-skill
description: ${desc}
x-lint:
  allow: [E1]
  reason: "routing needs it"
---

# Test Skill

MUST do something.
MUST prefer haiku for cheap tasks.
`;
		const p = write(tmpDir(), "SKILL.md", content);
		const errorCodes = lint(p)
			.filter((f) => f[0] === "ERROR")
			.map((f) => f[1]);
		expect(errorCodes).toContain("E3");
	});

	test("no override e1 is error", () => {
		const desc = "word ".repeat(30).trim();
		const content = SKILL_TEMPLATE_NO_OVERRIDE.replace("{desc}", desc);
		const p = write(tmpDir(), "SKILL.md", content);
		const errorCodes = lint(p)
			.filter((f) => f[0] === "ERROR")
			.map((f) => f[1]);
		expect(errorCodes).toContain("E1");
	});

	test("allow w code", () => {
		const content = `---
name: test-skill
description: short skill description here nice
x-lint:
  allow: [W9]
  reason: "duplicate rules needed for emphasis in this reference doc"
---

# Test

- MUST always check the file path before editing any document in scope
- MUST always check the file path before editing any document in scope
`;
		const p = write(tmpDir(), "SKILL.md", content);
		for (const [sev, code] of lint(p)) {
			if (code === "W9") expect(sev).toBe("OVERRIDDEN");
		}
	});

	test("clean file returns empty errors", () => {
		const content = `---
name: test-skill
description: Short clean skill description here.
---

# Test Skill

MUST do something specific and verifiable.
`;
		const p = write(tmpDir(), "SKILL.md", content);
		const errors = lint(p).filter((f) => f[0] === "ERROR");
		expect(errors).toEqual([] as Triple[]);
	});
});

describe("pointer shape", () => {
	function pointer(dir: string, frontmatter: string): string {
		mkdirSync(join(dir, "context"), { recursive: true });
		writeFileSync(join(dir, "context", "rules.context.md"), "# Rules\n");
		return write(
			join(dir, "instructions"),
			"rules.instructions.md",
			`---
description: Route to the detailed rules.
${frontmatter}---

Read [rules](../context/rules.context.md).
`,
		);
	}

	test("unconditional pointer may omit apply to", () => {
		const findings = lint(pointer(tmpDir(), ""));
		expect(findings.filter((f) => f[0] === "ERROR")).toEqual([]);
	});

	test("scoped pointer may include apply to", () => {
		const findings = lint(pointer(tmpDir(), 'applyTo: "**/*.py"\n'));
		expect(findings.filter((f) => f[0] === "ERROR")).toEqual([]);
	});

	test("pointer still requires context link", () => {
		const path = write(
			tmpDir(),
			"rules.instructions.md",
			`---
description: Route to the detailed rules.
---

Rules are documented elsewhere.
`,
		);
		expect(lint(path).some(([sev, code]) => sev === "ERROR" && code === "E7")).toBe(true);
	});
});

describe("main exit code via execute", () => {
	test("overridden only exits 0", async () => {
		const desc = "word ".repeat(30).trim();
		const content = SKILL_TEMPLATE_LONG.replace("{desc}", desc)
			.replace("{codes}", "E1")
			.replace("{reason}", "routing depends on full description");
		const p = write(tmpDir(), "SKILL.md", content);
		const tools = registerTool();
		const out = await tools.execute!("id", { paths: [p] });
		expect(out.details.exitCode).toBe(0);
		expect(out.details.ok).toBe(true);
	});

	test("real error exits 1", async () => {
		const desc = "word ".repeat(30).trim();
		const content = SKILL_TEMPLATE_NO_OVERRIDE.replace("{desc}", desc);
		const p = write(tmpDir(), "SKILL.md", content);
		const tools = registerTool();
		const out = await tools.execute!("id", { paths: [p] });
		expect(out.details.exitCode).toBe(1);
	});

	test("e9 exits 1", async () => {
		const desc = "word ".repeat(30).trim();
		const content = `---
name: test-skill
description: ${desc}
x-lint:
  allow: [E1]
---

# Test Skill

MUST do something.
`;
		const p = write(tmpDir(), "SKILL.md", content);
		const tools = registerTool();
		const out = await tools.execute!("id", { paths: [p] });
		expect(out.details.exitCode).toBe(1);
	});
});

describe("anti-pattern rules", () => {
	test("e1 short description under 20 chars", () => {
		const content = SKILL_BASE.replaceAll("{name}", "short-desc-skill")
			.replace("{desc}", "Too brief.")
			.replace("{body}", "MUST do something.");
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "ERROR")
				.map((f) => f[1]),
		).toContain("E1");
	});

	test("e1 yaml folded description not flagged as short", () => {
		const content = `---
name: folded-desc-skill
description: >-
  This is a long enough description to not trigger the short-desc check.
---

# folded-desc-skill

MUST do something.
`;
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "ERROR")
				.map((f) => f[1]),
		).not.toContain("E1");
	});

	test("e1 description exactly 20 chars is clean", () => {
		const content = SKILL_BASE.replaceAll("{name}", "exact-skill")
			.replace("{desc}", "Use when you need it.")
			.replace("{body}", "MUST do something.");
		const p = write(tmpDir(), "SKILL.md", content);
		const short = lint(p)
			.filter((f) => f[0] === "ERROR" && f[1] === "E1")
			.map((f) => f[2])
			.filter((m) => m.includes("too short"));
		expect(short).toEqual([]);
	});

	test("w10 over constrained skill", () => {
		const musts = Array.from({ length: 16 }, (_, i) => `MUST do step ${i}.`).join("\n");
		const content = SKILL_BASE.replaceAll("{name}", "over-constrained")
			.replace("{desc}", "Use when you need to do many constrained things.")
			.replace("{body}", musts);
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).toContain("W10");
	});

	test("w10 at threshold not triggered", () => {
		const musts = Array.from({ length: 15 }, (_, i) => `MUST do step ${i}.`).join("\n");
		const content = SKILL_BASE.replaceAll("{name}", "at-threshold")
			.replace("{desc}", "Use when you need exactly fifteen constraints.")
			.replace("{body}", musts);
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).not.toContain("W10");
	});

	test("w10 not applied to context", () => {
		const musts = Array.from({ length: 20 }, (_, i) => `MUST do step ${i}.`).join("\n");
		const p = write(tmpDir(), "rules.context.md", `# dense context\n\n${musts}\n`);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).not.toContain("W10");
	});

	test("w11 description with use when", () => {
		const content = SKILL_BASE.replaceAll("{name}", "triggered-skill")
			.replace("{desc}", "Use when you need to audit code for smells.")
			.replace("{body}", "MUST check everything.");
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).not.toContain("W11");
	});

	test("w11 description with use for", () => {
		const content = SKILL_BASE.replaceAll("{name}", "for-triggered-skill")
			.replace("{desc}", "Use for running lint checks on the project.")
			.replace("{body}", "MUST check everything.");
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).not.toContain("W11");
	});

	test("w11 missing trigger warns", () => {
		const content = SKILL_BASE.replaceAll("{name}", "no-trigger-skill")
			.replace("{desc}", "Manages isolated worktrees for delegated repository agents.")
			.replace("{body}", "MUST check everything.");
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).toContain("W11");
	});

	test("w11 not applied to agent", () => {
		const content = `---
name: my-agent
description: Manages isolated operations without any trigger phrase.
---

# My Agent

## Output

PASS|FAIL verdict. CAP 100 words. Never reprint paths only.
`;
		const p = write(tmpDir(), "my-agent.agent.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).not.toContain("W11");
	});

	test("w12 bloated skill without references", () => {
		const body = Array.from({ length: 850 }, (_, i) => `Line of content number ${i}.`).join("\n");
		const content = SKILL_BASE.replaceAll("{name}", "bloated-skill")
			.replace("{desc}", "Use when you need this very large skill.")
			.replace("{body}", body);
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).toContain("W12");
	});

	test("w12 bloated skill with references no warn", () => {
		const dir = tmpDir();
		mkdirSync(join(dir, "references"));
		writeFileSync(join(dir, "references", "extra.md"), "# Extra reference content\n");
		const body = Array.from({ length: 850 }, (_, i) => `Line of content number ${i}.`).join("\n");
		const content = SKILL_BASE.replaceAll("{name}", "big-but-structured-skill")
			.replace("{desc}", "Use when you need this large but well-structured skill.")
			.replace("{body}", body);
		const p = write(dir, "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).not.toContain("W12");
	});

	test("w12 under threshold no warn", () => {
		const content = SKILL_BASE.replaceAll("{name}", "normal-skill")
			.replace("{desc}", "Use when you need this normal-sized skill.")
			.replace("{body}", "MUST do something reasonable.");
		const p = write(tmpDir(), "SKILL.md", content);
		expect(
			lint(p)
				.filter((f) => f[0] === "WARN")
				.map((f) => f[1]),
		).not.toContain("W12");
	});
});

describe("python/ts finding-code parity", () => {
	test("codes match baked python fixture", () => {
		const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
		const expected = parity as Record<string, string[]>;
		const mismatches: string[] = [];
		for (const [rel, pyCodes] of Object.entries(expected)) {
			const tsCodes = lint(join(repoRoot, rel))
				.map((f) => f[1])
				.sort();
			const a = [...pyCodes].sort();
			if (JSON.stringify(tsCodes) !== JSON.stringify(a)) {
				mismatches.push(`${rel}: py=${JSON.stringify(a)} ts=${JSON.stringify(tsCodes)}`);
			}
		}
		expect(mismatches).toEqual([]);
	});
});

describe("frontmatterDefects", () => {
	const codes = (text: string): string[] => frontmatterDefects(text).map((t) => t[1]);
	const sev = (text: string): string[] => frontmatterDefects(text).map((t) => t[0]);

	test("valid yaml with a flow array is clean", () => {
		expect(codes('---\nname: x\ncondition: ["\\\\bfoo\\\\b"]\n---\nbody')).toEqual([]);
	});

	test("an unquoted colon needs repair, so it warns rather than errors", () => {
		// Found in seven shipped rules. omp recovers it via quoteAmbiguousPlainScalars,
		// so the rule still fires -- proven with a live three-rule probe. The casualty
		// is vale, which lints nothing and lets prose gates pass unchecked.
		const text = "---\nname: x\ndescription: Core contract: claiming and routing.\n---\nbody";
		expect(codes(text)).toEqual(["W13"]);
		expect(sev(text)).toEqual(["WARN"]);
	});

	test("quoting that same value fixes it", () => {
		expect(codes('---\nname: x\ndescription: "Core contract: claiming and routing."\n---\nbody')).toEqual([]);
	});

	test("a block sequence is not a defect on its own", () => {
		// Measured: a rule whose condition is a block sequence fires normally, and it
		// still fires when the frontmatter also needs repair. Flagging it would be
		// inventing a problem.
		expect(codes("---\nname: x\nglobs:\n  - '**/*.ts'\n---\nbody")).toEqual([]);
	});

	test("a block sequence beside a repaired scalar reports only the repair", () => {
		const text = "---\ndescription: bad: colon\ncondition:\n  - '\\bfoo\\b'\n---\nbody";
		expect(codes(text)).toEqual(["W13"]);
	});

	test("only array-valued keys are checked", () => {
		expect(codes("---\nname: x\nsomelist:\n  - a\n---\nbody")).toEqual([]);
	});

	test("a file with no frontmatter is clean", () => {
		expect(codes("# just a heading\n")).toEqual([]);
	});
});

describe("hostSpecificPaths", () => {
	test("home directories on any OS are flagged", () => {
		expect(hostSpecificPaths("see /Users/sjors/dev/repo/file.md")).toEqual(["/Users/sjors/dev/repo/file.md"]);
		expect(hostSpecificPaths("see /home/runner/work/x")).toEqual(["/home/runner/work/x"]);
		expect(hostSpecificPaths("see C:\\Users\\sjors\\dev")).toEqual(["C:\\Users\\sjors\\dev"]);
	});

	test("portable absolute paths are not defects", () => {
		// The false positive that killed the first version of this check: a scratch
		// dir in a shell snippet is absolute by necessity and correct anywhere.
		expect(hostSpecificPaths("mkdir -p /tmp/agentic/external-repos && cd /tmp/agentic")).toEqual([]);
		expect(hostSpecificPaths("2>/dev/null and /usr/bin/env bash and /etc/hosts")).toEqual([]);
		expect(hostSpecificPaths("under /var/folders/ab/cd")).toEqual([]);
	});

	test("tilde and scheme URLs stay allowed", () => {
		expect(hostSpecificPaths("~/personal/dev/repo and ~/.omp/agent")).toEqual([]);
		expect(hostSpecificPaths("https://example.com/a/b/c and skill://write-docs/x.md")).toEqual([]);
	});

	test("duplicates collapse", () => {
		expect(hostSpecificPaths("/home/a/b then /home/a/b again")).toEqual(["/home/a/b"]);
	});
});
