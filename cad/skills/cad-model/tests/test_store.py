#!/usr/bin/env python3
"""The part store and the build-cache keys of `cad_model.py run`, without a kernel.

Run: python3 -m unittest discover -s cad/skills/cad-model/tests -p test_store.py -v
Standard library only; the kernel builds that reuse parts are in test_cad_model.py.
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from cadmodel import build, provenance, store  # noqa: E402 - stdlib-only imports


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-store-test-")
        self.addCleanup(temporary.cleanup)
        self.hw = Path(temporary.name) / "hw"
        self.work = self.hw / "versions" / ".v1.partial-1" / "parts"
        self.work.mkdir(parents=True)
        self.store = store.Store(self.hw)

    def output(self, name: str, data: bytes) -> Path:
        path = self.work / name
        path.write_bytes(data)
        return path

    def test_an_interned_output_is_stored_once_and_linked(self) -> None:
        first = self.output("TST-0001.step", b"ISO-10303-21; one")
        digest = self.store.intern(first)
        obj = self.hw / ".cad" / "parts" / digest
        self.assertEqual((digest, obj.read_bytes()), (sha(b"ISO-10303-21; one"), b"ISO-10303-21; one"))
        self.assertTrue(os.path.samefile(first, obj))
        twin = self.output("TST-0002.step", b"ISO-10303-21; one")  # equal bytes from another build
        self.assertEqual(self.store.intern(twin), digest)
        self.assertTrue(os.path.samefile(twin, obj))
        self.assertEqual(sorted(p.name for p in obj.parent.iterdir()), sorted([".gitignore", digest]))
        self.assertEqual((obj.parent / ".gitignore").read_text(encoding="utf-8"), "*\n")

    def test_place_replaces_a_link_and_never_writes_through_it(self) -> None:
        old = self.store.intern(self.output("old.step", b"v1 bytes"))
        sealed = self.hw / "versions" / "v1" / "parts" / "TST-0001.step"
        staged = self.work / "TST-0001.step"
        for target in (sealed, staged):
            self.store.place(old, target)
        self.assertTrue(os.path.samefile(sealed, self.hw / ".cad" / "parts" / old))
        new = self.store.intern(self.output("new.step", b"v2 bytes"))
        self.store.place(new, staged)  # staged held a link to the v1 object
        self.assertEqual((staged.read_bytes(), sealed.read_bytes()), (b"v2 bytes", b"v1 bytes"))
        self.assertEqual((self.hw / ".cad" / "parts" / old).read_bytes(), b"v1 bytes")
        self.assertEqual(sorted(p.name for p in sealed.parent.iterdir()), ["TST-0001.step"])

    def test_without_hard_links_place_and_intern_copy_the_same_bytes(self) -> None:
        with mock.patch.object(store.os, "link", side_effect=OSError(18, "Invalid cross-device link")):
            first = self.output("TST-0001.step", b"copied")
            digest = self.store.intern(first)
            target = self.hw / "versions" / "v1" / "parts" / "TST-0001.step"
            self.store.place(digest, target)
        obj = self.hw / ".cad" / "parts" / digest
        self.assertEqual((obj.read_bytes(), target.read_bytes()), (b"copied", b"copied"))
        self.assertFalse(os.path.samefile(target, obj))
        self.assertEqual(target.stat().st_mode & 0o777, first.stat().st_mode & 0o777)

    def test_a_record_is_reused_only_while_its_objects_hash_to_their_names(self) -> None:
        digest = self.store.intern(self.output("TST-0001.step", b"geometry"))
        key = store.key({"kind": "part", "pn": "TST-0001"})
        self.store.save(key, {"kind": "part", "objects": {"step": digest}, "result": {"ok": True}})
        self.assertEqual(self.store.record(key)["objects"], {"step": digest})
        self.assertEqual(sorted(p.name for p in (self.hw / ".cad" / "builds").iterdir()), [".gitignore", f"{key}.json"])
        obj = self.hw / ".cad" / "parts" / digest
        obj.unlink()  # a damaged object: other bytes under its name
        obj.write_bytes(b"geometrX")
        self.assertIsNone(store.Store(self.hw).record(key))
        self.assertIsNone(self.store.record(store.key({"kind": "part", "pn": "TST-0002"})))

    def test_records_of_another_format_or_with_bad_names_are_never_reused(self) -> None:
        digest = self.store.intern(self.output("TST-0001.step", b"geometry"))
        key = store.key({"pn": "TST-0001"})
        path = self.hw / ".cad" / "builds" / f"{key}.json"
        for text in ('{"format": 0, "objects": {}}', '{"format": 1, "objects": {"step": "../../etc/passwd"}}',
                     f'{{"format": 1, "objects": {{"step": "{digest[:-1]}"}}}}', "not json"):
            with self.subTest(text=text):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
                self.assertIsNone(store.Store(self.hw).record(key))


class BuildKeyTests(unittest.TestCase):
    REQUEST = {"pn": "TST-0001", "name": "TST-0001 Base", "model_frame": "assembly_zero", "manufacture": "same",
               "model": "/a/hw/parts/TST-0001/model.py", "step": "/a/hw/versions/.v1.partial-1/parts/TST-0001.step",
               "manufacture_step": None}
    RUNTIME = {"tools": {"python": "3.12.13", "cadquery": "2.8.0"}, "distributions": ["cadquery==2.8.0"]}

    def test_the_key_changes_with_every_build_input_and_never_with_output_paths(self) -> None:
        inputs = {"model.py": "a" * 64}
        base = build.build_key(self.REQUEST, "cadquery", self.RUNTIME, inputs)
        self.assertEqual(base, build.build_key({**self.REQUEST, "step": "/b/hw/versions/.v9.partial-7/parts/x.step",
                                                "model": "/b/hw/parts/TST-0001/model.py"}, "cadquery", self.RUNTIME, inputs))
        changed = [build.build_key({**self.REQUEST, "name": "TST-0001 Renamed"}, "cadquery", self.RUNTIME, inputs),
                   build.build_key({**self.REQUEST, "model_frame": "part_local"}, "cadquery", self.RUNTIME, inputs),
                   build.build_key({**self.REQUEST, "manufacture": "different"}, "cadquery", self.RUNTIME, inputs),
                   build.build_key(self.REQUEST, "build123d", self.RUNTIME, inputs),
                   build.build_key(self.REQUEST, "cadquery", {**self.RUNTIME, "distributions": ["cadquery==2.8.1"]},
                                   inputs),
                   build.build_key(self.REQUEST, "cadquery", self.RUNTIME, {"model.py": "b" * 64}),
                   build.build_key(self.REQUEST, "cadquery", self.RUNTIME, {**inputs, "sources/vendor.step": "c" * 64})]
        self.assertEqual(len({base, *changed}), 1 + len(changed))

    def test_part_inputs_are_the_part_folder_files_but_part_yaml_and_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "hw" / "parts" / "TST-0001"
            for rel, data in (("model.py", b"PARAMS = {}"), ("part.yaml", b"PN: TST-0001"), ("sources/vendor.step", b"v"),
                              (".DS_Store", b"x"), ("__pycache__/model.cpython-312.pyc", b"x"), (".cad-work/a.py", b"x")):
                (folder / rel).parent.mkdir(parents=True, exist_ok=True)
                (folder / rel).write_bytes(data)
            source = build.PartSource("TST-0001", "Base", None, None, folder / "model.py", "cadquery", "assembly_zero")
            self.assertEqual(build.part_inputs(source), {"model.py": sha(b"PARAMS = {}"), "sources/vendor.step": sha(b"v")})

    def test_runner_sources_are_keyed_below_the_plugin_and_the_project_and_checked_again(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp).resolve() / "hw"
            helper = hw / "lib" / "helper.py"
            helper.parent.mkdir(parents=True)
            helper.write_text("X = 1\n", encoding="utf-8")
            occ = provenance.SKILLS / "cad-model" / "scripts" / "cadmodel" / "occ.py"
            found = {str(occ): sha(occ.read_bytes()), str(helper): sha(b"X = 1\n")}
            keyed = build.project_sources(found, hw)
            self.assertEqual(keyed, {"hw": {"lib/helper.py": sha(b"X = 1\n")},
                                     "skills": {"cad-model/scripts/cadmodel/occ.py": sha(occ.read_bytes())}})
            self.assertTrue(build.sources_hold(keyed, hw, {}))
            helper.write_text("X = 2\n", encoding="utf-8")
            self.assertFalse(build.sources_hold(keyed, hw, {}))
            self.assertFalse(build.sources_hold({"skills": {"cad-model/scripts/gone.py": "0" * 64}}, hw, {}))
            self.assertFalse(build.sources_hold(None, hw, {}))

    def test_a_record_stands_in_only_for_a_successful_build_with_the_files_it_needs(self) -> None:
        good = {"kernel": "cadquery", "objects": {"step": "a" * 64}, "result": {"ok": True},
                "sources": {"hw": {}, "skills": {}}}
        self.assertTrue(build.reusable(good, self.REQUEST, Path("/nowhere"), {}))
        different = {**self.REQUEST, "manufacture": "different", "manufacture_step": "/tmp/states/TST-0001.step"}
        self.assertFalse(build.reusable(good, different, Path("/nowhere"), {}))
        for broken in ({**good, "objects": {}}, {**good, "result": {"ok": False}}, {**good, "kernel": "fake"},
                       {**good, "sources": "x"}):
            with self.subTest(broken=broken):
                self.assertFalse(build.reusable(broken, self.REQUEST, Path("/nowhere"), {}))


class ProvenanceTests(unittest.TestCase):
    def test_sources_hash_loaded_plugin_files_and_skip_part_models(self) -> None:
        found = provenance.sources([provenance.SKILLS], "cadmodel.st")
        self.assertIn(str((SCRIPTS / "cadmodel" / "provenance.py").resolve()), found)
        self.assertNotIn(str((SCRIPTS / "cadmodel" / "store.py").resolve()), found)  # skipped by name prefix
        self.assertTrue(all(Path(path).is_relative_to(provenance.SKILLS) for path in found))

    def test_runtime_names_the_interpreter_and_every_distribution(self) -> None:
        runtime = provenance.runtime({"python": "x"})
        self.assertEqual((runtime["tools"], runtime["python"]), ({"python": "x"}, sys.version))
        self.assertEqual(runtime["distributions"], sorted(runtime["distributions"]))


if __name__ == "__main__":
    unittest.main()
