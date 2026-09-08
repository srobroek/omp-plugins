import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/context.py"
SPEC = importlib.util.spec_from_file_location("project_context", SCRIPT)
context = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(context)


class ContextBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "repo"
        self.root.mkdir()
        (self.root / ".omp").mkdir()
        self.output = self.root / "graphify-out"
        self.output.mkdir()
        self.status = self.output / "context-status.json"
        self.xml = self.root / "repomix.xml"
        self.xml.write_text("previous usable snapshot")
        (self.root / "source.py").write_text("print('safe')\n")
        self.graph_tool = Path(self.directory.name) / "graph.py"
        self.graph_tool.write_text(
            "import os\nfrom pathlib import Path\n"
            "out = Path(os.environ.get('GRAPHIFY_OUT', 'graphify-out'))\n"
            "out.mkdir(exist_ok=True)\n(out / 'graph.json').write_text('{}')\n"
        )
        self.pack_tool = Path(self.directory.name) / "pack.py"
        self.pack_tool.write_text(
            "import sys\nfrom pathlib import Path\n"
            "Path(sys.argv[sys.argv.index('--output') + 1]).write_text("
            "Path('.omp/fixture.xml').read_text())\n"
        )
        self.config = {
            "graphify": [sys.executable, str(self.graph_tool)],
            "repomix": [sys.executable, str(self.pack_tool)],
            "repomix_include": ["source.py"],
            "timeout": 10,
        }
        self.pack = self.root / ".omp/fixture.xml"
        self.pack.write_text(
            '<repomix><files><file path="source.py">safe</file></files></repomix>'
        )

    def refresh(self):
        (self.root / ".omp/project-context.json").write_text(json.dumps(self.config))
        with (
            patch.object(context, "__file__", str(self.root / ".omp/context.py")),
            patch.object(sys, "argv", ["context.py", "refresh"]),
        ):
            return context.main()

    def test_unsafe_includes_rejected_before_tools_and_leave_stale(self):
        for pattern in (
            "../outside.py",
            "/tmp/outside.py",
            "source.py,../outside.py",
            "source.py,!/tmp/outside.py",
            "src/../../outside.py",
            "{..}/outside.py",
            "C:/outside.py",
            "..\\outside.py",
            "!**/*.py",
        ):
            with self.subTest(pattern=pattern):
                self.config["repomix_include"] = [pattern]
                with self.assertRaises(ValueError):
                    self.refresh()
                self.assertFalse((self.output / "graph.json").exists())
                self.assertEqual(self.xml.read_text(), "previous usable snapshot")
                self.assertEqual(json.loads(self.status.read_text())["state"], "STALE")
                self.assertFalse((self.output / ".refresh.lock").exists())

    def test_status_transitions_replace_symlink_without_touching_victim(self):
        victim = Path(self.directory.name) / "victim"
        victim.write_text("untouched")
        for state in ("STALE", "CURRENT"):
            with self.subTest(state=state):
                self.status.unlink(missing_ok=True)
                self.status.symlink_to(victim)
                context.write_status(self.status, {"state": state})
                self.assertEqual(victim.read_text(), "untouched")
                self.assertFalse(self.status.is_symlink())
                self.assertEqual(json.loads(self.status.read_text())["state"], state)

    def test_empty_pack_preserves_previous_snapshot_and_stale_status(self):
        self.pack.write_text(
            "<repomix><files>Summary with no sources</files></repomix>"
        )
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertEqual(self.xml.read_text(), "previous usable snapshot")
        self.assertEqual(json.loads(self.status.read_text())["state"], "STALE")
        self.assertFalse(list(self.root.glob(".repomix-*.xml")))

    def test_graph_output_is_project_bound_despite_inherited_override(self):
        other = Path(self.directory.name) / "other-graph"
        with patch.dict(os.environ, {"GRAPHIFY_OUT": str(other)}):
            self.assertEqual(self.refresh(), 0)
        self.assertTrue((self.output / "graph.json").is_file())
        self.assertFalse(other.exists())
        self.assertEqual(json.loads(self.status.read_text())["state"], "CURRENT")

    def test_missing_project_graph_cannot_be_current(self):
        self.graph_tool.write_text("pass\n")
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertEqual(self.xml.read_text(), "previous usable snapshot")
        self.assertEqual(json.loads(self.status.read_text())["state"], "STALE")

    def test_symlinked_graph_child_is_refused_before_writer(self):
        victim = Path(self.directory.name) / "victim"
        victim.write_text("untouched")
        (self.output / "GRAPH_REPORT.md").symlink_to(victim)
        with self.assertRaises(ValueError):
            self.refresh()
        self.assertEqual(victim.read_text(), "untouched")
        self.assertFalse((self.output / "graph.json").exists())

    def test_unsafe_packed_sources_cannot_replace_snapshot(self):
        (self.root / ".omp/mcp.json").write_text('{"token":"private"}')
        (Path(self.directory.name) / "outside.py").write_text("private")
        for name in (".omp/mcp.json", "../outside.py"):
            with self.subTest(name=name):
                self.pack.write_text(
                    f'<repomix><files><file path="{name}">private</file></files></repomix>'
                )
                with self.assertRaises(ValueError):
                    self.refresh()
                self.assertEqual(self.xml.read_text(), "previous usable snapshot")
                self.assertEqual(json.loads(self.status.read_text())["state"], "STALE")


if __name__ == "__main__":
    unittest.main()
