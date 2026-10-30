#!/usr/bin/env python3
"""The part store and the build-cache keys of `cad_model.py run`, without a kernel.

Run: python3 -m unittest discover -s cad/skills/cad-model/tests -p test_store.py -v
Standard library only; the kernel builds that reuse parts are in test_cad_model.py.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
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
        self.assertEqual((target.stat().st_mode & 0o777, obj.stat().st_mode & 0o777), (0o444, 0o444))

    def test_a_missing_object_is_a_miss_for_place_and_is_stored_again_by_intern(self) -> None:
        """store gc removed an object after a run read its record: place reports the miss and leaves the
        target alone, so the part is built; interning the rebuilt bytes stores them again."""
        digest = self.store.intern(self.output("TST-0001.step", b"geometry"))
        (self.hw / ".cad" / "parts" / digest).unlink()
        target = self.hw / "versions" / ".v2.partial-2" / "parts" / "TST-0001.step"
        self.assertFalse(self.store.place(digest, target))
        self.assertEqual(list(target.parent.iterdir()), [])
        rebuilt = self.output("rebuilt.step", b"geometry")
        self.assertEqual(self.store.intern(rebuilt), digest)
        self.assertTrue(os.path.samefile(rebuilt, self.hw / ".cad" / "parts" / digest))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root writes through read-only modes")
    def test_a_later_rebuild_cannot_change_an_earlier_versions_bytes(self) -> None:
        """v1's part is a read-only link to its object. A rebuild that wrote through the old path fails
        instead of changing v1; the runner writes a new file, and storing it never touches v1."""
        digest = self.store.intern(self.output("TST-0001.step", b"v1 geometry"))
        sealed = self.hw / "versions" / "v1" / "parts" / "TST-0001.step"
        self.store.place(digest, sealed)
        self.assertEqual(sealed.stat().st_mode & 0o777, 0o444)
        for target in (sealed, self.work / "TST-0001.step"):  # the sealed copy and the linked staging path
            with self.subTest(target=target.name), self.assertRaises(PermissionError):
                target.write_bytes(b"v2 geometry")
        rebuilt = self.hw / "versions" / ".v2.partial-2" / "parts" / "TST-0001.step"
        rebuilt.parent.mkdir(parents=True)
        rebuilt.write_bytes(b"v2 geometry")
        self.store.intern(rebuilt)
        self.assertEqual(sealed.read_bytes(), b"v1 geometry")
        self.assertEqual(store.file_sha(self.hw / ".cad" / "parts" / digest), digest)

    def version(self, label: str, files: dict[str, bytes], keep: dict[str, str] | None = None) -> dict[str, str]:
        """A sealed version whose files are store objects, as `run` leaves it; returns path -> sha256."""
        folder = self.hw / "versions" / label
        shas = {}
        for rel, data in files.items():
            staged = self.output(f"{label}-{rel.replace('/', '-')}", data)
            shas[rel] = self.store.intern(staged)
            self.store.place(shas[rel], folder / rel)
        (folder / "manifest.json").write_text(json.dumps({"label": label, "files": shas}), encoding="utf-8")
        return shas

    def test_gc_frees_a_deleted_versions_own_outputs_and_keeps_shared_ones(self) -> None:
        v1 = self.version("v1", {"parts/A.step": b"shared base", "parts/B.step": b"arm v1, long" * 50})
        v2 = self.version("v2", {"parts/A.step": b"shared base", "parts/B.step": b"arm v2"})
        state = self.store.intern(self.output("state.step", b"flat blank"))  # in no manifest, needed by a record
        for name, objects in (("base", {"step": v1["parts/A.step"], "manufacture_step": state}),
                              ("arm1", {"step": v1["parts/B.step"]}), ("arm2", {"step": v2["parts/B.step"]})):
            self.store.save(store.key({"pn": name}), {"objects": objects})
        shutil.rmtree(self.work.parent)  # the run's staging folder is gone once a version is sealed
        shutil.rmtree(self.hw / "versions" / "v1")
        objects = self.hw / ".cad" / "parts"
        before = sorted(p.name for p in objects.iterdir())
        code, dry = build.store_gc(self.hw, dry_run=True)
        self.assertEqual((code, dry["removed_objects"]), (0, [v1["parts/B.step"]]))
        self.assertEqual(sorted(p.name for p in objects.iterdir()), before, "a dry run removes nothing")
        code, result = build.store_gc(self.hw)
        self.assertEqual((result["removed_objects"], result["records"]), ([v1["parts/B.step"]], {"kept": 2, "removed": 1}))
        self.assertEqual(result["removed_bytes"], len(b"arm v1, long" * 50))
        self.assertGreaterEqual(result["freed_bytes"], result["removed_bytes"])
        self.assertEqual(sorted(p.name for p in objects.iterdir() if p.name != ".gitignore"),
                         sorted({v2["parts/A.step"], v2["parts/B.step"], state}))
        self.assertIsNotNone(self.store.record(store.key({"pn": "base"})))
        self.assertIsNone(store.Store(self.hw).record(store.key({"pn": "arm1"})))
        self.assertEqual(build.record.load_layout().verify(self.hw / "versions" / "v2"), [])
        self.assertEqual(build.store_gc(self.hw)[1]["objects"]["removed"], 0)

    def test_gc_keeps_what_a_release_names_and_refuses_while_unsure(self) -> None:
        shas = self.version("v1", {"parts/A.step": b"released"})
        release = self.hw / "releases" / "A"
        release.mkdir(parents=True)
        (release / "manifest.json").write_text(json.dumps({"schema_version": 2, "files": {
            "definition/parts/A.step": {"sha256": shas["parts/A.step"], "original": "hw/versions/v1/parts/A.step"}}}),
            encoding="utf-8")
        shutil.rmtree(self.work.parent)
        shutil.rmtree(self.hw / "versions" / "v1")
        self.assertEqual(build.store_gc(self.hw)[1]["objects"], {"kept": 1, "removed": 0})
        (self.hw / "versions" / ".v2.partial-7").mkdir(parents=True)
        with self.assertRaisesRegex(build.UsageError, "in progress or was interrupted"):
            build.store_gc(self.hw)
        (self.hw / "versions" / ".v2.partial-7").rmdir()
        (release / "manifest.json").write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(build.UsageError, "cannot read"):
            build.store_gc(self.hw)
        self.assertTrue((self.hw / ".cad" / "parts" / shas["parts/A.step"]).is_file())

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
