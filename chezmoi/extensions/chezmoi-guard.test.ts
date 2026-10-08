import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import chezmoiGuard, {
	bashWriteTargets,
	considerPath,
	lexicalAbs,
	loadManaged,
	resetChezmoiGuardForTests,
	seedChezmoiCacheForTests,
	setChezmoiSpawnForTests,
	shouldInspect,
	under,
} from "./chezmoi-guard.ts";

afterEach(() => {
	resetChezmoiGuardForTests();
	setSystemTime();
});

type Handler = (event: Record<string, unknown>, ctx?: { cwd: string }) => unknown;

function fakePi(): { handlers: Record<string, Handler[]>; pi: { on: (ev: string, h: Handler) => void } } {
	const handlers: Record<string, Handler[]> = {};
	return {
		handlers,
		pi: {
			on: (ev, h) => {
				const registered = handlers[ev] ?? [];
				registered.push(h);
				handlers[ev] = registered;
			},
		},
	};
}

const HOME = homedir();
const OUTSIDE = join(HOME, ".config", "omp-plugins-chezmoi-guard-test");
const CWD = join(HOME, "projects", "app");
const SOURCE = join(HOME, ".local", "share", "chezmoi");
const ZSHRC = join(HOME, ".zshrc");
const ZSHRC_SOURCE = join(SOURCE, "dot_zshrc");

describe("shouldInspect / under / lexicalAbs", () => {
	test("inspects home paths outside cwd", () => {
		expect(shouldInspect(OUTSIDE, CWD)).toBe(true);
	});

	test("skips paths outside home", () => {
		expect(shouldInspect("/tmp/elsewhere", CWD)).toBe(false);
	});

	test("under treats identity and descendants", () => {
		expect(under(CWD, CWD)).toBe(true);
		expect(under(join(CWD, "x"), CWD)).toBe(true);
		expect(under("/tmp/x", CWD)).toBe(false);
	});

	test("lexicalAbs expands ~ and resolves relatives", () => {
		expect(lexicalAbs("~/.zshrc", CWD)).toBe(ZSHRC);
		expect(lexicalAbs("foo/../bar", "/abs/cwd")).toBe("/abs/cwd/bar");
	});
});

describe("bashWriteTargets", () => {
	test("an unquoted here-document body is data, not commands", () => {
		expect(bashWriteTargets("cat > /tmp/notes <<EOF\ncp a ~/.zshrc\nEOF", HOME)).toEqual(["/tmp/notes"]);
		expect(bashWriteTargets("gh pr create --body-file - <<EOF\nRun: echo x >> ~/.zshrc\nEOF", HOME)).toEqual([]);
	});

	test("a substitution in an unquoted here-document body still runs", () => {
		expect(bashWriteTargets("cat <<EOF\n$(cp a ~/.zshrc)\nEOF", HOME)).toEqual([ZSHRC]);
		expect(bashWriteTargets("cat <<EOF\nnote `printf x > ~/.zshrc`\nEOF", HOME)).toEqual([ZSHRC]);
		expect(bashWriteTargets("cat <<EOF\n\\$(cp a ~/.zshrc) and \\`cp a ~/.zshrc\\`\nEOF", HOME)).toEqual([]);
		expect(bashWriteTargets("cat <<EOF\n$(cd /tmp; printf x > .zshrc)\nEOF\nprintf x > .zshrc", HOME)).toEqual([
			"/tmp/.zshrc",
			ZSHRC,
		]);
	});

	test("a quoted target attached to a redirect operator is a redirect", () => {
		expect(bashWriteTargets('echo x >"$HOME/.zshrc"', "/tmp")).toEqual([ZSHRC]);
		expect(bashWriteTargets(`printf x >>"${ZSHRC}"`, "/tmp")).toEqual([ZSHRC]);
		expect(bashWriteTargets('echo ">" ~/.zshrc', "/tmp")).toEqual([]);
	});
});

describe("managed-set lookup", () => {
	test("blocks managed target and names source", () => {
		seedChezmoiCacheForTests(new Set([OUTSIDE]), SOURCE);
		setChezmoiSpawnForTests((args) => {
			if (args[0] === "source-path" && args[1] === OUTSIDE) return `${SOURCE}/dot_config/file\n`;
			return "";
		});
		const decision = considerPath(OUTSIDE, CWD);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain(OUTSIDE);
		expect(decision?.reason).toContain(`${SOURCE}/dot_config/file`);
	});

	test("allows unmanaged home path", () => {
		seedChezmoiCacheForTests(new Set([`${OUTSIDE}-other`]), SOURCE);
		expect(considerPath(OUTSIDE, CWD)).toBeUndefined();
	});

	test("allows when chezmoi spawn fails (binary missing)", () => {
		setChezmoiSpawnForTests(() => null);
		expect(loadManaged()).toBeNull();
		expect(considerPath(OUTSIDE, CWD)).toBeUndefined();
	});

	test("allows path inside source dir", () => {
		seedChezmoiCacheForTests(new Set([ZSHRC]), SOURCE);
		expect(considerPath(ZSHRC_SOURCE, CWD)).toBeUndefined();
	});
});

describe("chezmoi-guard integration", () => {
	/** A fake `chezmoi` whose managed list the test can grow. */
	function guard(managed: string[] = [ZSHRC]) {
		const { handlers, pi } = fakePi();
		setChezmoiSpawnForTests((args) => {
			if (args[0] === "managed") return managed.join("\n");
			if (args[0] === "source-path" && args[1] === ZSHRC) return `${ZSHRC_SOURCE}\n`;
			if (args[0] === "source-path" && args.length === 1) return `${SOURCE}\n`;
			return null;
		});
		chezmoiGuard(pi as never);
		const call = (toolName: string, input: Record<string, unknown>, cwd = CWD) =>
			handlers.tool_call?.[0]?.({ toolName, toolCallId: "t", input }, { cwd });
		return { call, managed };
	}
	const refusal = expect.objectContaining({ block: true, reason: expect.stringContaining(ZSHRC_SOURCE) });

	test("refuses write to a managed target, naming the source path", () => {
		expect(guard().call("write", { path: ZSHRC })).toEqual(refusal);
	});

	test("allows unmanaged write", () => {
		expect(guard().call("edit", { path: OUTSIDE })).toBeUndefined();
	});

	test("allows when spawn reports missing binary", () => {
		const { handlers, pi } = fakePi();
		setChezmoiSpawnForTests(() => null);
		chezmoiGuard(pi as never);
		const out = handlers.tool_call?.[0]?.({ toolName: "write", toolCallId: "t", input: { path: ZSHRC } }, { cwd: CWD });
		expect(out).toBeUndefined();
	});

	test("refuses a hashline edit to a managed target", () => {
		expect(guard().call("edit", { input: "[~/.zshrc#AB12]\nPUT 1.=1:\n+export X=1" })).toEqual(refusal);
	});

	test("refuses a multi-file hashline edit when one section is a managed target", () => {
		const input = `[${OUTSIDE}#AB12]\nPUT 1.=1:\n+x\n[${ZSHRC}#CD34]\nPUT 2.=2:\n+y`;
		expect(guard().call("edit", { input })).toEqual(refusal);
	});

	test("refuses a hashline move onto a managed target", () => {
		expect(guard().call("edit", { input: `[${OUTSIDE}#AB12]\nMV ${ZSHRC}` })).toEqual(refusal);
	});

	test("allows a hashline edit to the chezmoi source path", () => {
		expect(guard().call("edit", { input: `[${ZSHRC_SOURCE}#AB12]\nPUT 1.=1:\n+export X=1` })).toBeUndefined();
	});

	test("a header quoted in a body row is not a target", () => {
		expect(guard().call("edit", { input: `[${OUTSIDE}#AB12]\nPUT 1.=1:\n+[${ZSHRC}#CD34]` })).toBeUndefined();
	});

	test("refuses an apply_patch edit to a managed target", () => {
		const input = "*** Begin Patch\n*** Update File: ~/.zshrc\n@@\n-a\n+b\n*** End Patch";
		expect(guard().call("edit", { input })).toEqual(refusal);
	});

	test("refuses an ast_edit whose paths name a managed target", () => {
		const ops = [{ pat: "export X=1", out: "export X=2" }];
		expect(guard().call("ast_edit", { ops, paths: [`${OUTSIDE}/`, "~/.zshrc"] })).toEqual(refusal);
		expect(guard().call("ast_edit", { ops, paths: [OUTSIDE] })).toBeUndefined();
	});

	test.each([
		"printf x > ~/.zshrc",
		"printf x >>~/.zshrc",
		"echo x 2>/dev/null >$HOME/.zshrc",
		"echo x | tee -a ~/.zshrc",
		"cp /tmp/x ~/.zshrc",
		"cp /tmp/.zshrc ~",
		"cp -t ~ /tmp/.zshrc",
		"mv /tmp/x ~/.zshrc",
		"perl -pi -e 's/a/b/' ~/.zshrc",
		"perl -i.bak -pe 's/a/b/' ~/.zshrc",
		"sudo sed -i s/a/b/ ~/.zshrc",
		"sudo -u root tee ~/.zshrc",
		"gsed -i s/a/b/ ~/.zshrc",
		"sed -i '' s/a/b/ ~/.zshrc",
		"cd ~ && sed -i s/a/b/ .zshrc",
		"cd /tmp; cd ~; printf x > .zshrc",
		'echo x >"$HOME/.zshrc"',
		`printf x >>"${ZSHRC}"`,
		"cat <<EOF\n$(cp a ~/.zshrc)\nEOF",
		"/usr/bin/sudo tee ~/.zshrc",
		"doas -u root tee ~/.zshrc",
		"nice -n 5 tee ~/.zshrc",
		"nice -5 cp /tmp/x ~/.zshrc",
		"timeout 5 tee ~/.zshrc",
		"timeout -s KILL 5 cp /tmp/x ~/.zshrc",
		"timeout --preserve-status 5s sed -i s/a/b/ ~/.zshrc",
		"stdbuf -oL tee ~/.zshrc",
		"stdbuf -o L tee ~/.zshrc",
		"exec -a name tee ~/.zshrc",
		"env -S 'tee -a ~/.zshrc'",
		"env -i -S'cp /tmp/x ~/.zshrc'",
		"sudo nice -n 5 timeout 5 tee ~/.zshrc",
	])("refuses bash write to a managed target: %s", (command) => {
		expect(guard().call("bash", { command })).toEqual(refusal);
	});

	test("resolves a relative target against cwd", () => {
		expect(guard().call("bash", { command: "sed -i s/a/b/ .zshrc", cwd: HOME })).toEqual(refusal);
	});

	test.each([
		"env -C ~ tee .zshrc",
		"env --chdir=$HOME cp x .zshrc",
		"sudo -D ~ sed -i s/a/b/ .zshrc",
		"sudo --chdir ~ perl -pi -e 's/a/b/' .zshrc",
		`env -C ${dirname(HOME)} env -C ${basename(HOME)} tee .zshrc`,
		"env -C /tmp printf x > .zshrc",
	])("resolves a wrapped command's paths in the wrapper's directory, redirects in the shell's: %s", (command) => {
		expect(guard().call("bash", { command, cwd: command.includes("> .zshrc") ? HOME : "/tmp" })).toEqual(refusal);
	});

	test.each([
		"env -C /tmp tee .zshrc",
		"env -C ~ printf x > .zshrc",
		'env -C "$DIR" tee .zshrc',
		"timeout 5 cat ~/.zshrc",
		"command -v tee",
		"stdbuf -oL grep x ~/.zshrc",
	])("allows a wrapped command that does not write a managed target: %s", (command) => {
		expect(guard().call("bash", { command, cwd: command.startsWith("env -C ~") ? "/tmp" : HOME })).toBeUndefined();
	});

	test.each([
		"cd /tmp; sed -i s/a/b/ .zshrc",
		"cd /tmp && printf x > .zshrc",
		"(cd /tmp; printf x > .zshrc)",
		"cd \"$DIR\"; printf x > .zshrc",
		"cat ~/.zshrc",
		"cp ~/.zshrc /tmp/backup",
		"echo '> ~/.zshrc'",
		"grep x ~/.zshrc 2>&1",
		"sed s/a/b/ ~/.zshrc",
		"cat <<'EOF' > /tmp/notes\ncp a ~/.zshrc\nEOF",
		"cat > /tmp/notes <<EOF\ncp a ~/.zshrc\nEOF",
		"gh pr create --body-file - <<EOF\nRun: echo x >> ~/.zshrc\nEOF",
		'echo ">" ~/.zshrc',
	])("allows bash command that does not write a managed target: %s", (command) => {
		expect(guard().call("bash", { command, cwd: HOME })).toBeUndefined();
	});

	test("re-reads the managed list after the TTL", () => {
		setSystemTime(new Date("2026-10-06T12:00:00Z"));
		const { call, managed } = guard([]);
		expect(call("write", { path: ZSHRC })).toBeUndefined();
		managed.push(ZSHRC);
		setSystemTime(new Date("2026-10-06T12:00:06Z"));
		expect(call("write", { path: ZSHRC })).toEqual(refusal);
	});

	test("a chezmoi command invalidates the managed list at once", () => {
		setSystemTime(new Date("2026-10-06T12:00:00Z"));
		const { call, managed } = guard([]);
		expect(call("write", { path: ZSHRC })).toBeUndefined();
		managed.push(ZSHRC);
		expect(call("bash", { command: "chezmoi add ~/.zshrc" })).toBeUndefined();
		expect(call("write", { path: ZSHRC })).toEqual(refusal);
	});
});
