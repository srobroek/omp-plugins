#!/usr/bin/env python3
"""Focused tests for clean_envs.py: which per-path environments it lists, their sizes, and deletion only on request."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "clean_envs.py"
spec = importlib.util.spec_from_file_location("cad_clean_envs", SCRIPT)
assert spec is not None and spec.loader is not None
clean_envs = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = clean_envs
spec.loader.exec_module(clean_envs)

DAY = 86400.0


def environment(root: Path, name: str, prompt: str, distributions: tuple[str, ...], age_s: float = 3 * DAY) -> Path:
    path = root / name
    site = path / "lib" / "python3.12" / "site-packages"
    site.mkdir(parents=True)
    (path / "pyvenv.cfg").write_text(f"home = /python\nversion_info = 3.12\nprompt = {prompt}\n", encoding="utf-8")
    for distribution in distributions:
        (site / f"{distribution}.dist-info").mkdir()
    (site / "module.py").write_text("x = 1\n" * 100, encoding="utf-8")
    stamp = time.time() - age_s
    for folder in (site, path):
        os.utime(folder, (stamp, stamp))
    return path


class PlanTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name) / "environments-v2"
        self.root.mkdir()
        cadquery = ("cadquery-2.8.0", "cadquery_ocp-7.9.3.1.1", "vtk-9.6.2")
        self.stale = environment(self.root, "run-cadquery-0123456789abcdef", "run_cadquery.py", cadquery)
        self.recent = environment(self.root, "run-cadquery-1111111111111111", "run_cadquery.py", cadquery, age_s=60)
        self.current = environment(self.root, "cad-model-2222222222222222", "cad_model.py",
                                   ("cadquery_ocp_novtk-8.0.1.1.0", "PyYAML-6.0.3", "trimesh-4.9.0", "numpy-2.3.0",
                                    "python_fcl-0.7.0.11"))  # every distribution cad_model.py's header names
        self.hook = environment(self.root, "cad-recheck-stamp-3333333333333333", "cad-recheck-stamp.py",
                                ("PyYAML-6.0.3", "jsonschema-4.26.0"))  # stamp.py runs validate.py's layout check
        # Not the plugin's: another tool's validate.py, an unshipped name, and a shared environment.
        environment(self.root, "validate-4444444444444444", "validate.py", ("requests-2.32.0",))
        environment(self.root, "unshipped-5555555555555555", "unshipped.py", ())
        (self.root / "a61125e538556c9c").mkdir()
        (self.root / "a61125e538556c9c" / "bd2d60a269142b67").symlink_to("../../archive-v0/XYZ")
        self.scripts = clean_envs.shipped_scripts()

    def plan(self):
        return clean_envs.plan(self.root, self.scripts, {self.current}, DAY, sizes=lambda path: (1000, 10))

    def test_lists_only_cad_script_environments_with_their_status(self) -> None:
        listed = {Path(env.path).name: (env.script, env.status) for env in self.plan()}
        self.assertEqual(listed, {
            "run-cadquery-0123456789abcdef": ("run_cadquery.py", "stale"),
            "run-cadquery-1111111111111111": ("run_cadquery.py", "recent"),
            "cad-model-2222222222222222": ("cad_model.py", "current"),
            "cad-recheck-stamp-3333333333333333": ("cad-recheck-stamp.py", "stale"),
        })

    def test_the_shipped_names_include_the_kernel_runners_and_the_installed_hook(self) -> None:
        for name in ("run_cadquery.py", "run_build123d.py", "cad_model.py", "render.py", "cad-recheck-stamp.py"):
            with self.subTest(name=name):
                self.assertIn(name, self.scripts)

    def test_listing_deletes_nothing_and_delete_removes_only_stale_environments(self) -> None:
        before = sorted(path.name for path in self.root.iterdir())
        environments = self.plan()
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), before)
        deleted, errors = clean_envs.delete(environments)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(Path(path).name for path in deleted),
                         ["cad-recheck-stamp-3333333333333333", "run-cadquery-0123456789abcdef"])
        self.assertTrue(self.recent.is_dir() and self.current.is_dir())
        self.assertFalse(self.stale.exists() or self.hook.exists())

    def test_main_is_a_dry_run_unless_delete_is_given(self) -> None:
        cache = subprocess.CompletedProcess(["uv"], 0, f"{self.root.parent}\n", "")
        with patch.object(clean_envs.shutil, "which", return_value="uv"), \
                patch.object(clean_envs.subprocess, "run", return_value=cache), \
                patch.object(clean_envs, "current_environments", return_value={self.current}), \
                patch("sys.stdout") as stdout:
            self.assertEqual(clean_envs.main([]), 0)
        text = "".join(call.args[0] for call in stdout.write.call_args_list)
        self.assertIn("Dry run: nothing was deleted. Rerun with --delete to remove the 2 stale environments.", text)
        self.assertTrue(self.stale.is_dir() and self.hook.is_dir())


class MeasureTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.base = Path(folder.name)
        self.env = self.base / "env"
        self.env.mkdir()
        (self.base / "cache.bin").write_bytes(os.urandom(1 << 20))

    def test_a_file_hard_linked_from_the_cache_frees_nothing(self) -> None:
        os.link(self.base / "cache.bin", self.env / "linked.bin")
        self.assertEqual(clean_envs.measure(self.env), (1 << 20, 0))

    def test_a_private_file_frees_its_allocation(self) -> None:
        (self.env / "own.bin").write_bytes(os.urandom(1 << 20))
        apparent, freed = clean_envs.measure(self.env)
        self.assertEqual(apparent, 1 << 20)
        self.assertGreaterEqual(freed, 1 << 20)

    def test_a_clone_of_the_cache_frees_nothing(self) -> None:
        flag = "-c" if sys.platform == "darwin" else "--reflink=always"  # APFS clone; XFS or Btrfs reflink
        cloned = subprocess.run(["cp", flag, str(self.base / "cache.bin"), str(self.env / "clone.bin")],
                                capture_output=True, check=False)
        if cloned.returncode != 0:
            self.skipTest(f"{self.base} cannot hold a copy-on-write clone")
        apparent, freed = clean_envs.measure(self.env)
        self.assertEqual(apparent, 1 << 20)
        self.assertLess(freed, 1 << 16)


if __name__ == "__main__":
    unittest.main()
