#!/usr/bin/env python3
"""Install-path checks for the generated CAD agents and the Beads formulas.

Each harness test stages the install that cad/README.md documents in a temporary
project, then asks the harness itself, without a model call, whether it found the
agents. The formula test asks `bd` whether it found the copied formulas. A test skips when its harness CLI is not installed. The isolation and
login helpers come from the eval adapters, which drive the same CLIs.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

CAD = Path(__file__).resolve().parents[1]
AGENTS = sorted(path.stem for path in (CAD / "agents").glob("*.md"))
FORMULAS = sorted(path.name.removesuffix(".formula.toml") for path in (CAD / "formulas").glob("*.formula.toml"))

sys.path.insert(0, str(CAD / "evals"))
from adapters.claude import resolve_launcher  # noqa: E402
from adapters.kiro import _APP_SUPPORT, _token, copy_login  # noqa: E402
from adapters.opencode import resolve_bin  # noqa: E402


def isolated_env(root: Path, path: str = "") -> dict[str, str]:
    """HOME, the XDG roots and TMPDIR inside `root`, so no user configuration loads."""
    home = root / "home"
    (root / "tmp").mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    return {
        "PATH": os.pathsep.join(p for p in (path, os.environ.get("PATH", "")) if p),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "TMPDIR": str(root / "tmp"),
        "NO_COLOR": "1",
    }


def closed_port() -> int:
    """A local port with no listener, so a request to it is refused at once."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class InstallTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-install-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "project"
        self.project.mkdir()


class ClaudePluginInstall(InstallTest):
    """`claude --plugin-dir cad`: the manifest serves the generated subagents."""

    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("claude") is None:
            raise unittest.SkipTest("Claude Code is not installed")
        cls.bin = resolve_launcher("claude")

    def init_event(self, plugin: Path) -> dict:
        """Claude Code's system/init event, read before the first API request lands.

        The API base URL is a closed local port and the key is a placeholder, so no
        model is reached; the process is stopped as soon as init arrives."""
        env = {
            **isolated_env(self.root),
            "CLAUDE_CONFIG_DIR": str(self.root / "home" / ".claude"),
            "CLAUDE_CODE_TMPDIR": str(self.root / "tmp"),
            "ANTHROPIC_API_KEY": "cad-install-test-placeholder",
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{closed_port()}",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }
        (self.root / "home" / ".claude").mkdir(parents=True, exist_ok=True)
        argv = [
            self.bin, "-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers": {}}', "--plugin-dir", str(plugin), "inventory probe",
        ]
        process = subprocess.Popen(argv, cwd=self.project, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        deadline = threading.Timer(60, process.kill)
        deadline.start()
        try:
            for line in process.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") == "system" and event.get("subtype") == "init":
                    return event
        finally:
            deadline.cancel()
            process.kill()
            process.wait()
            process.stdout.close()
        self.fail("Claude Code exited without a system/init event")

    def test_plugin_dir_loads_generated_subagents_and_not_the_omp_sources(self) -> None:
        plugin = self.root / "cad"
        shutil.copytree(CAD, plugin, ignore=shutil.ignore_patterns("evals"))
        # An OMP-format agent that only the default agents/ scan would find.
        (plugin / "agents" / "omp-source-sentinel.md").write_text(
            "---\nname: omp-source-sentinel\ndescription: Present only in the OMP agents directory.\n---\n\nSentinel.\n",
            encoding="utf-8",
        )
        init = self.init_event(plugin)
        self.assertIn("cad", [entry.get("name") for entry in init.get("plugins", [])])
        agents = set(init.get("agents", []))
        for name in AGENTS:
            self.assertIn(f"cad:{name}", agents)
        self.assertNotIn("cad:omp-source-sentinel", agents)


class KiroWorkspaceInstall(InstallTest):
    """The plugin at `<workspace>/cad`, the generated agents in `<workspace>/.kiro/agents/`."""

    def stage_workspace(self) -> None:
        (self.project / "cad").symlink_to(CAD, target_is_directory=True)
        agents = self.project / ".kiro" / "agents"
        agents.mkdir(parents=True)
        for path in sorted((CAD / "harness" / "kiro" / "agents").glob("*.json")):
            shutil.copy2(path, agents / path.name)

    def test_skill_resources_resolve_from_the_workspace_root(self) -> None:
        # Kiro resolves a relative resource URI from the workspace root, like the
        # `skill://.kiro/skills/**/SKILL.md` examples in its configuration reference.
        self.stage_workspace()
        for name in AGENTS:
            agent = json.loads((self.project / ".kiro" / "agents" / f"{name}.json").read_text(encoding="utf-8"))
            skills = [uri.removeprefix("skill://") for uri in agent["resources"] if uri.startswith("skill://")]
            with self.subTest(agent=name):
                self.assertTrue(skills)
                for skill in skills:
                    self.assertTrue((self.project / skill).is_file(), f"{name} resource skill://{skill} does not resolve")

    def test_agent_list_reports_every_agent_as_a_workspace_agent(self) -> None:
        kiro = shutil.which("kiro-cli")
        if kiro is None:
            self.skipTest("kiro-cli is not installed")
        user_db = Path.home().joinpath(*_APP_SUPPORT, "data.sqlite3")
        if _token(user_db) is None:
            self.skipTest("no Kiro login to copy; `kiro-cli agent list` requires one")
        self.stage_workspace()
        env = isolated_env(self.root, str(self.root / "home" / ".local" / "bin"))
        store = self.root.joinpath("home", *_APP_SUPPORT)
        store.mkdir(parents=True)
        copy_login(user_db, store / "data.sqlite3")  # a copy of the login only; the user's store is opened read-only
        bin_dir = self.root / "home" / ".local" / "bin"
        bin_dir.mkdir(parents=True)
        for exe in Path(kiro).parent.glob("kiro-cli*"):  # kiro-cli launches its kiro-cli-* siblings from $HOME/.local/bin
            (bin_dir / exe.name).symlink_to(exe.resolve())
        listed = subprocess.run(["kiro-cli", "agent", "list"], cwd=self.project, env=env, capture_output=True, text=True, timeout=120)
        # kiro-cli 2.34 writes the listing to stderr, coloured even under NO_COLOR.
        report = re.sub(r"\x1b\[[0-9;]*m", "", listed.stdout + listed.stderr)
        self.assertEqual(listed.returncode, 0, report)
        for name in AGENTS:
            line = next((row for row in report.splitlines() if row.split()[:1] == [name]), "")
            self.assertIn("Workspace", line, report)
            self.assertIn("(v3 format)", line, report)


class OpencodeProjectInstall(InstallTest):
    """The generated agents and command in `.opencode/`, plus `.opencode/skills/`."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.bin = resolve_bin("opencode")
        if shutil.which(cls.bin) is None:
            raise unittest.SkipTest("OpenCode is not installed")

    def run_agent(self, agent: str) -> list[dict]:
        """One `opencode run` with `agent`, stopped at model routing: the model id is
        unknown and the isolated environment holds no provider credentials."""
        argv = [
            self.bin, "run", "--standalone", "--format", "json", "--agent", agent,
            "--model", "amazon-bedrock/cad-install-test-no-such-model", "inventory probe",
        ]
        done = subprocess.run(argv, cwd=self.project, env=isolated_env(self.root), capture_output=True, text=True, timeout=120)
        events = []
        for line in done.stdout.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
        return [event["error"] for event in events if event.get("type") == "error" and isinstance(event.get("error"), dict)]

    def test_run_resolves_every_agent_from_the_project_directory(self) -> None:
        agents = self.project / ".opencode" / "agents"
        agents.mkdir(parents=True)
        for path in sorted((CAD / "harness" / "opencode" / "agents").glob("*.md")):
            shutil.copy2(path, agents / path.name)
        shutil.copytree(CAD / "skills", self.project / ".opencode" / "skills")
        subprocess.run(["git", "init", "-q"], cwd=self.project, check=True)
        # Control: an agent OpenCode cannot find fails before model routing.
        absent = self.run_agent("cad-absent-reviewer")
        self.assertTrue(any("Agent not found" in error.get("message", "") for error in absent), absent)
        for name in AGENTS:
            with self.subTest(agent=name):
                errors = self.run_agent(name)
                self.assertEqual([error.get("type") for error in errors], ["provider.no-route"], errors)
    def test_copy_steps_include_command_template(self) -> None:
        commands = self.project / ".opencode" / "commands"
        commands.mkdir(parents=True)
        for path in sorted((CAD / "harness" / "opencode" / "commands").glob("*.md")):
            shutil.copy2(path, commands / path.name)
        command = (commands / "cad-flow.md").read_text(encoding="utf-8")
        self.assertIn("description: Prototype-to-CAD flow (cad plugin)", command)
        self.assertIn("Load the `cad-flow` skill and follow it", command)
        self.assertIn("$ARGUMENTS", command)


class BeadsFormulaInstall(InstallTest):
    """The formulas copied into `.beads/formulas/`, as every install path in cad/README.md does."""

    def test_bd_lists_every_copied_formula(self) -> None:
        if shutil.which("bd") is None:
            self.skipTest("bd is not installed")
        env = {**isolated_env(self.root), "BEADS_DIR": str(self.project / ".beads"),
               "BEADS_ACTOR": "cad-install-test", "BEADS_DOLT_SHARED_SERVER": ""}
        subprocess.run(["git", "init", "-q"], cwd=self.project, check=True)
        subprocess.run(["bd", "init", "--quiet"], cwd=self.project, env=env, check=True, capture_output=True, timeout=120)
        formulas = self.project / ".beads" / "formulas"
        formulas.mkdir(parents=True, exist_ok=True)
        for path in sorted((CAD / "formulas").glob("*.formula.toml")):
            shutil.copy2(path, formulas / path.name)
        listed = subprocess.run(["bd", "formula", "list", "--json"], cwd=self.project, env=env,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        found = {entry.get("name") for entry in json.loads(listed.stdout)}
        self.assertLessEqual(set(FORMULAS), found, listed.stdout)


if __name__ == "__main__":
    unittest.main()
