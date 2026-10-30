#!/usr/bin/env python3
"""The hw/ layout contract: layout.json, the resolver, bundle publication, the tree audit and its
enforcement in validate.py."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"
VALIDATOR = SCRIPTS / "validate.py"
LAMP = SKILL.parent.parent / "examples" / "lamp-arm" / "hw"


def load(name: str, path: Path) -> Any:
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec and spec.loader
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


layout = load("cad_record_layout", SCRIPTS / "layout.py")
validate = load("cad_record_validate", VALIDATOR)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, text: str = "x\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def seal_version(hw: Path, label: str) -> Path:
    """A version folder whose manifest inventories every file below it, as cad-model run writes it.
    A version is sealed once; sealing it again keeps the first manifest."""
    folder = hw / "versions" / label
    folder.mkdir(parents=True, exist_ok=True)
    if not (folder / "manifest.json").exists():
        files = {p.relative_to(folder).as_posix(): sha(p) for p in sorted(folder.rglob("*")) if p.is_file()}
        (folder / "manifest.json").write_text(json.dumps({"label": label, "files": files}), encoding="utf-8")
    return folder


def publish(hw: Path, entry_id: str, params: dict[str, str], files: dict[str, str],
            recipe: dict[str, Any] | None = None, replace: bool = False) -> Any:
    staged = layout.staging(hw, entry_id)
    for name, text in files.items():
        write(staged / name, text)
    return layout.publish(hw, entry_id, params, staged, recipe=recipe or {"views": sorted(files)},
                          producer="test", status="pass", replace=replace)


def canonical_tree(hw: Path) -> None:
    """One example of every canonical layout row, sealed directories sealed, bundles published."""
    lay = layout.load()
    for entry in lay.entries:
        if entry.kind == "scratch" or entry.manifest == "bundle":
            continue
        for name in [spec.name for spec in entry.files if spec.name != "manifest.json"] or [None]:
            write(layout.locate(hw, lay.example(entry, name)))
    write(hw / "versions" / "latest.json", json.dumps({"label": "v3"}))
    seal_version(hw, "v3")
    release = hw / "releases" / "A"
    package = {p.relative_to(release).as_posix(): {"sha256": sha(p), "original": "hw/bom.csv"}
               for p in sorted(release.rglob("*")) if p.is_file()}
    write(release / "manifest.json", json.dumps({"schema_version": 2, "files": package}))
    for entry in lay.entries:
        if entry.manifest != "bundle":
            continue
        base = lay.example(entry)
        params = dict(lay.classify(lay.example(entry, "manifest.json")).params)
        files = {lay.example(entry, spec.name)[len(base) + 1:]: f"{spec.name}\n"
                 for spec in entry.files if spec.name != "manifest.json"}
        publish(hw, entry.id, params, files)


class TempProject(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-layout-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "project"
        self.hw = self.project / "hw"


class LayoutData(TempProject):
    def test_layout_json_matches_its_schema(self) -> None:
        schemas = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((SKILL / "schemas").glob("*.schema.json"))]
        registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas)
        schema = json.loads((SKILL / "schemas" / "layout.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        errors = list(Draft202012Validator(schema, registry=registry).iter_errors(layout.load().data))
        self.assertEqual([e.message for e in errors], [])

    def test_layout_md_is_generated_from_layout_json(self) -> None:
        self.assertEqual((SKILL / "references" / "layout.md").read_text(encoding="utf-8"), layout.markdown(),
                         "regenerate: python3 cad/skills/cad-record/scripts/layout.py --markdown "
                         "> cad/skills/cad-record/references/layout.md")

    def test_every_canonical_row_classifies_as_its_entry(self) -> None:
        lay = layout.load()
        for entry in lay.entries:
            for name in [spec.name for spec in entry.files] or [None]:
                example = lay.example(entry, name)
                with self.subTest(entry=entry.id, path=example):
                    match = layout.classify(example)
                    self.assertIsNotNone(match)
                    self.assertEqual((match.entry.id, match.name), (entry.id, name))

    def test_wrong_pn_version_or_nested_name_is_rejected(self) -> None:
        for path in ("hw/parts/LMP-001/part.yaml", "hw/parts/lmp-0001/part.yaml", "hw/parts/LMP-0001/print/flat.step",
                     "hw/versions/v0/assembly.step", "hw/versions/3/assembly.step", "hw/versions/v03/assembly.step",
                     "hw/versions/v3/parts/LMP-0001/part.step", "hw/versions/v3/parts/LMP-0001.stl",
                     "hw/versions/v3/manufacturing/LMP-0001/flat.step",
                     "hw/versions/v3/manufacturing/LMP-0001/stl/part.stl", "hw/versions/v3/manufacturing/lmp/part.step",
                     "hw/drawings/v3/LMP-0001/sheet-0.svg", "hw/drawings/v3/LMP-0001/old/sheet-1.svg",
                     "hw/drawings/LMP-0001/sheet-1.svg", "hw/print/LMP-0001_flat.step", "hw/docs/flat.step",
                     "hw/docs/notes/export.py", "hw/decisions/DR-01.md", "hw/releases/I/manifest.json",
                     "hw/renders/v3/iso.png", "hw/checks/v3/LMP-0001/result.json.bak"):
            with self.subTest(path=path):
                self.assertIsNone(layout.classify(path))

    def test_resolvers_build_paths_and_refuse_bad_tokens(self) -> None:
        self.assertEqual(layout.version_dir(self.hw, "v3"), self.hw / "versions" / "v3")
        self.assertEqual(layout.manufacturing_dir(self.hw, "v3", "LMP-0001"),
                         self.hw / "versions" / "v3" / "manufacturing" / "LMP-0001")
        self.assertEqual(layout.bundle_dir(self.hw, "drawings", "v3", "LMP-0001"), self.hw / "drawings" / "v3" / "LMP-0001")
        self.assertEqual(layout.resolve(self.hw, "record.part_sources", PN="LMP-0005"),
                         self.hw / "parts" / "LMP-0005" / "sources")
        self.assertEqual(layout.bundle_kinds(), ("checks", "drawings", "renders", "captures", "motion", "analysis"))
        self.assertEqual(layout.classify(self.hw / "versions" / "v3" / "parts" / "LMP-0001.step", self.hw).entry.id,
                         "version.core")
        for call in (lambda: layout.version_dir(self.hw, "v0"), lambda: layout.version_dir(self.hw, "latest"),
                     lambda: layout.manufacturing_dir(self.hw, "v3", "lmp-1"),
                     lambda: layout.bundle_dir(self.hw, "print", "v3", "LMP-0001"),
                     lambda: layout.bundle_dir(self.hw, "drawings", "v3", "../x"),
                     lambda: layout.resolve(self.hw, "bundle.renders", V="v3"),
                     lambda: layout.relative(self.hw, self.root / "elsewhere")):
            with self.assertRaises(layout.LayoutError):
                call()

    def test_versions_latest_and_next_version(self) -> None:
        self.assertEqual((layout.versions(self.hw), layout.latest(self.hw), layout.next_version(self.hw)), ([], None, "v1"))
        seal_version(self.hw, "v2")
        seal_version(self.hw, "v10")
        (self.hw / "versions" / ".v11.partial-7").mkdir()
        (self.hw / "versions" / "v11").mkdir()  # an unsealed folder still takes its label
        write(self.hw / "versions" / "latest.json", json.dumps({"label": "v10"}))
        self.assertEqual((layout.versions(self.hw), layout.latest(self.hw), layout.next_version(self.hw)),
                         (["v2", "v10"], "v10", "v12"))
        write(self.hw / "versions" / "latest.json", json.dumps({"label": "v11"}))
        with self.assertRaisesRegex(layout.LayoutError, "not a built version"):
            layout.latest(self.hw)

    def test_custom_made_predicate_and_manufacture_policy(self) -> None:
        printed = {"PN": "LMP-0001", "process": "fdm", "make_buy": "make"}
        pin = {"PN": "LMP-0005", "process": "purchased", "make_buy": "buy", "procurement": {"mode": "made_to_drawing"}}
        catalogue = {"PN": "LMP-0008", "process": "purchased", "make_buy": "buy", "procurement": {"mode": "catalog"}}
        self.assertEqual([layout.custom_made(p) for p in (printed, pin, catalogue)], [True, True, False])
        same = layout.manufacture_policy(printed)
        self.assertEqual((same.relationship, same.outputs, same.linear_deflection_mm, same.angular_deflection_rad),
                         ("same", ("part.step", "part.stl", "manufacturing.json"), 0.05, 0.1))
        self.assertAlmostEqual(same.volume_tolerance_mm3(1000.0), 1e-6)
        self.assertEqual(layout.manufacture_policy(pin).outputs, ("part.step", "manufacturing.json"))
        flat = layout.manufacture_policy({**printed, "manufacture": {
            "relationship": "different", "state": "flat", "reason": "elastic_bending", "decision": "DR-002",
            "volume_rel_tolerance": 0.002, "volume_abs_tolerance_mm3": 0.5, "mesh": {"linear_deflection_mm": 0.02}}})
        self.assertEqual((flat.relationship, flat.state, flat.linear_deflection_mm, flat.angular_deflection_rad),
                         ("different", "flat", 0.02, 0.1))
        self.assertAlmostEqual(flat.volume_tolerance_mm3(1000.0), 2.0)
        self.assertAlmostEqual(flat.volume_tolerance_mm3(10.0), 0.5)
        with self.assertRaises(layout.LayoutError):
            layout.manufacture_policy(catalogue)
        with self.assertRaisesRegex(layout.LayoutError, "without a volume tolerance"):
            layout.manufacture_policy({**printed, "manufacture": {"relationship": "different"}})


class Publication(TempProject):
    def setUp(self) -> None:
        super().setUp()
        seal_version(self.hw, "v1")
        self.target = self.hw / "renders" / "v1" / "assembly"
        self.params = {"V": "v1", "S": "assembly"}

    def test_publish_seals_a_bundle_and_reuses_an_identical_one(self) -> None:
        first = publish(self.hw, "bundle.renders", self.params, {"iso.png": "png\n"})
        self.assertEqual((first.path, first.reused, first.replaced), (self.target, False, None))
        manifest = json.loads((self.target / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["layout"], manifest["path"], manifest["files"], manifest["replaces"]),
                         ("bundle.renders", "hw/renders/v1/assembly", {"iso.png": sha(self.target / "iso.png")}, None))
        self.assertEqual(manifest["version_manifest_sha256"], sha(self.hw / "versions" / "v1" / "manifest.json"))
        self.assertEqual(layout.verify(self.target), [])
        before = (self.target / "manifest.json").read_bytes()
        again = publish(self.hw, "bundle.renders", self.params, {"iso.png": "png\n"})
        self.assertTrue(again.reused)
        self.assertEqual((self.target / "manifest.json").read_bytes(), before)
        self.assertEqual(list((self.project / ".cad-work" / "publication").iterdir()), [])
        schema = json.loads((SKILL / "schemas" / "bundle-manifest.schema.json").read_text(encoding="utf-8"))
        self.assertEqual([e.message for e in Draft202012Validator(schema).iter_errors(manifest)], [])

    def test_a_different_recipe_needs_replace_and_the_manifest_records_what_it_replaced(self) -> None:
        old = publish(self.hw, "bundle.renders", self.params, {"iso.png": "old\n"}, recipe={"size": 800})
        old_manifest_sha = sha(self.target / "manifest.json")
        with self.assertRaisesRegex(layout.PublishConflict, "--replace"):
            publish(self.hw, "bundle.renders", self.params, {"iso.png": "new\n"}, recipe={"size": 1600})
        self.assertEqual((self.target / "iso.png").read_text(encoding="utf-8"), "old\n")
        new = publish(self.hw, "bundle.renders", self.params, {"iso.png": "new\n"}, recipe={"size": 1600}, replace=True)
        replaces = new.manifest["replaces"]
        self.assertEqual((replaces["manifest_sha256"], replaces["recipe_sha256"]),
                         (old_manifest_sha, old.manifest["recipe_sha256"]))
        self.assertEqual(self.project / replaces["moved_to"], new.replaced)
        self.assertEqual((new.replaced / "iso.png").read_text(encoding="utf-8"), "old\n")
        self.assertEqual((self.target / "iso.png").read_text(encoding="utf-8"), "new\n")
        self.assertEqual(layout.audit(self.hw).problems, ())

    def test_a_writer_that_lands_first_during_replace_keeps_the_replaced_bundle_named(self) -> None:
        publish(self.hw, "bundle.renders", self.params, {"iso.png": "old\n"}, recipe={"size": 800})
        claim = layout.claim

        def racing(staged: Path, target: Path, target_rel: str) -> None:
            target.mkdir()  # another writer claims the path after the old bundle moved away
            claim(staged, target, target_rel)

        layout.claim = racing
        self.addCleanup(setattr, layout, "claim", claim)
        with self.assertRaisesRegex(layout.PublishConflict, "another writer published hw/renders/v1/assembly first; "
                                                            "the bundle it replaced is kept at .cad-work/replaced/"):
            publish(self.hw, "bundle.renders", self.params, {"iso.png": "new\n"}, recipe={"size": 1600}, replace=True)
        staged = list((self.project / ".cad-work" / "publication").iterdir())
        self.assertEqual([sorted(p.name for p in s.iterdir()) for s in staged], [["iso.png"]])

    def test_a_tampered_bundle_is_not_reused(self) -> None:
        publish(self.hw, "bundle.renders", self.params, {"iso.png": "png\n"})
        write(self.target / "iso.png", "edited\n")
        self.assertEqual(layout.verify(self.target), ["iso.png changed after it was sealed"])
        with self.assertRaises(layout.PublishConflict):
            publish(self.hw, "bundle.renders", self.params, {"iso.png": "png\n"})

    def test_a_sealed_v2_release_verifies_and_a_tampered_copy_is_reported(self) -> None:
        release = self.hw / "releases" / "A"
        write(release / "bom.csv", "level,PN\n")
        write(release / "manufacturing" / "LMP-0001" / "part.step", "step\n")
        files = {p.relative_to(release).as_posix(): {"sha256": sha(p), "original": "hw/bom.csv"}
                 for p in sorted(release.rglob("*")) if p.is_file()}
        write(release / "manifest.json", json.dumps({"schema_version": 2, "files": files}))
        self.assertEqual(layout.verify(release), [])
        write(release / "manufacturing" / "LMP-0001" / "part.step", "edited\n")
        self.assertEqual(layout.verify(release), ["manufacturing/LMP-0001/part.step changed after it was sealed"])

    def test_claim_renames_onto_a_free_target_and_never_onto_a_taken_one(self) -> None:
        staged = write(self.project / ".cad-work" / "stage" / "bom.csv").parent
        target = self.hw / "releases" / "A"
        layout.claim(staged, target, "hw/releases/A")
        self.assertEqual((sorted(p.name for p in target.iterdir()), staged.exists()), (["bom.csv"], False))
        again = write(self.project / ".cad-work" / "again" / "bom.csv", "other\n").parent
        with self.assertRaisesRegex(layout.PublishConflict, "another writer published hw/releases/A first"):
            layout.claim(again, target, "hw/releases/A")
        self.assertEqual(((target / "bom.csv").read_text(encoding="utf-8"), again.is_dir()), ("x\n", True))

    def test_publish_refuses_foreign_names_missing_files_and_staging_outside_scratch(self) -> None:
        cases = {"foreign name": ("bundle.renders", {"iso.png": "x", "notes.txt": "x"}, "not a file a bundle.renders"),
                 "nested name": ("bundle.renders", {"old/iso.png": "x"}, "not a file a bundle.renders"),
                 "own manifest": ("bundle.renders", {"iso.png": "x", "manifest.json": "{}"}, "publish writes it"),
                 "required file": ("bundle.checks", {}, "is empty"),
                 "drawing without package": ("bundle.drawings", {"sheet-1.svg": "x", "sheet-1.pdf": "x",
                                                                 "sheet-1.png": "x", "coverage.json": "{}"}, "needs")}
        for label, (entry_id, files, message) in cases.items():
            with self.subTest(label):
                staged = layout.staging(self.hw, entry_id)
                for name, text in files.items():
                    write(staged / name, text)
                with self.assertRaisesRegex(layout.LayoutError, message):
                    layout.publish(self.hw, entry_id, {"V": "v1", "S": "LMP-0001"}, staged, recipe={}, producer="test")
                self.assertTrue(staged.is_dir(), "a failed publication keeps its staging as scratch")
        outside = self.root / "outside"
        write(outside / "iso.png")
        with self.assertRaisesRegex(layout.LayoutError, "under"):
            layout.publish(self.hw, "bundle.renders", self.params, outside, recipe={}, producer="test")
        with self.assertRaisesRegex(layout.LayoutError, "not a bundle"):
            layout.staging(self.hw, "version.core")

    def test_publish_never_clobbers_an_existing_directory(self) -> None:
        self.target.mkdir(parents=True)  # another writer's claim, not yet renamed onto
        staged = layout.staging(self.hw, "bundle.renders")
        write(staged / "iso.png")
        with self.assertRaises(layout.PublishConflict):
            layout.publish(self.hw, "bundle.renders", self.params, staged, recipe={}, producer="test")
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertEqual(sorted(p.name for p in staged.iterdir()), ["iso.png"])

    def test_publish_refuses_an_unbuilt_version(self) -> None:
        with self.assertRaisesRegex(layout.LayoutError, "v2 is not a built version"):
            publish(self.hw, "bundle.renders", {"V": "v2", "S": "assembly"}, {"iso.png": "x"})

    def test_reusable_answers_before_a_producer_runs(self) -> None:
        params = self.params
        self.assertIsNone(layout.reusable(self.hw, "bundle.renders", params, {"size": 800}))
        publish(self.hw, "bundle.renders", params, {"iso.png": "png\n"}, recipe={"size": 800})
        self.assertEqual(layout.reusable(self.hw, "bundle.renders", params, {"size": 800}), self.target)
        with self.assertRaisesRegex(layout.PublishConflict, "--replace"):
            layout.reusable(self.hw, "bundle.renders", params, {"size": 1600})
        self.assertIsNone(layout.reusable(self.hw, "bundle.renders", params, {"size": 1600}, replace=True))
        write(self.target / "iso.png", "edited\n")
        with self.assertRaises(layout.PublishConflict):
            layout.reusable(self.hw, "bundle.renders", params, {"size": 800})

    def test_built_version_needs_a_verified_manifest_and_a_record_snapshot(self) -> None:
        write(self.hw / "versions" / "v2" / "record" / "product.yaml")
        seal_version(self.hw, "v2")
        write(self.hw / "versions" / "latest.json", json.dumps({"label": "v2"}))
        self.assertEqual(layout.built_version(self.hw, "latest"),
                         ("v2", self.hw / "versions" / "v2", self.hw / "versions" / "v2" / "record"))
        with self.assertRaisesRegex(layout.LayoutError, "no record snapshot"):
            layout.built_version(self.hw, "v1")
        with self.assertRaisesRegex(layout.LayoutError, "v3 is not a built version"):
            layout.built_version(self.hw, "v3")
        write(self.hw / "versions" / "v2" / "record" / "product.yaml", "edited\n")
        with self.assertRaisesRegex(layout.LayoutError, "fails its manifest"):
            layout.built_version(self.hw, "v2")

    def test_scratch_path_accepts_only_cad_work(self) -> None:
        inside = self.project / ".cad-work" / "unit" / "out.json"
        self.assertEqual(layout.scratch_path(self.hw, inside, "--out"), inside.resolve())
        for outside in (self.hw / "motion" / "out.json", self.project / ".cad-work", self.root / "elsewhere"):
            with self.subTest(str(outside)), self.assertRaisesRegex(layout.LayoutError, "--out must be under"):
                layout.scratch_path(self.hw, outside, "--out")


class TreeAudit(TempProject):
    def codes(self, **references: str) -> dict[str, str]:
        return {p.path: p.code for p in layout.audit(self.hw, references).problems}

    def test_canonical_tree_has_no_problems(self) -> None:
        canonical_tree(self.hw)
        self.assertEqual(layout.audit(self.hw).problems, ())
        self.assertEqual(len(layout.audit(self.hw).bundles), 7)

    def test_sealed_directories_neither_gain_nor_lose_files(self) -> None:
        write(self.hw / "versions" / "v1" / "parts" / "LMP-0001.step")
        write(self.hw / "versions" / "v1" / "assembly.step")
        seal_version(self.hw, "v1")
        write(self.hw / "versions" / "v1" / "parts" / "LMP-0002.step")  # added after sealing
        (self.hw / "versions" / "v1" / "assembly.step").unlink()
        write(self.hw / "versions" / "v2" / "assembly.step")  # never sealed
        problems = {p.path: (p.code, p.severity) for p in layout.audit(self.hw).problems}
        self.assertEqual(problems, {"hw/versions/v1/parts/LMP-0002.step": ("layout.unlisted", "error"),
                                    "hw/versions/v1/assembly.step": ("layout.missing", "error"),
                                    "hw/versions/v2": ("layout.unsealed", "stage")})

    def test_listed_foreign_files_and_malformed_manifests(self) -> None:
        write(self.hw / "versions" / "v1" / "notes.txt")
        seal_version(self.hw, "v1")
        write(self.hw / "versions" / "v2" / "manifest.json", json.dumps({"label": "v3", "files": {}}))
        seal_version(self.hw, "v4")
        publish(self.hw, "bundle.checks", {"V": "v4", "S": "LMP-0001"}, {"result.json": "{}"})
        bundle = self.hw / "checks" / "v4" / "LMP-0001" / "manifest.json"
        bundle.write_text(bundle.read_text(encoding="utf-8").replace("hw/checks/v4/LMP-0001", "hw/checks/v4/LMP-0009"),
                          encoding="utf-8")
        self.assertEqual(self.codes(), {"hw/versions/v1/notes.txt": "layout.foreign",
                                        "hw/versions/v2/manifest.json": "layout.malformed_manifest",
                                        "hw/checks/v4/LMP-0001/manifest.json": "layout.malformed_manifest"})

    def test_exceptions_rules_and_strays(self) -> None:
        for rel in ("versions/.v2.partial-41/parts/LMP-0001.step", "versions/.latest.json.tmp", ".cad/.recheck.json.tmp",
                    "docs/.DS_Store", "parts/LMP-0001/__pycache__/model.cpython-312.pyc", ".gitignore",
                    "drawings/LMP-0001/sheet-1.svg", "renders/v3/iso.png", "concept/screenshots/x-1.png",
                    "parts/LMP-0001/.cad-work/hw/part.yaml", "notes.md", "parts/LMP-0001/helper.py", "print/flat.dat",
                    "specs/datasheet.pdf"):
            write(self.hw / rel)
        self.assertEqual(self.codes(**{"hw/specs/datasheet.pdf": "LMP-0008"}), {
            "hw/versions/.v2.partial-41": "layout.transient", "hw/versions/.latest.json.tmp": "layout.transient",
            "hw/.cad/.recheck.json.tmp": "layout.transient", "hw/docs/.DS_Store": "layout.metadata",
            "hw/parts/LMP-0001/__pycache__": "layout.metadata", "hw/drawings/LMP-0001/sheet-1.svg": "layout.legacy",
            "hw/renders/v3/iso.png": "layout.legacy", "hw/concept/screenshots/x-1.png": "layout.legacy",
            "hw/parts/LMP-0001/.cad-work": "layout.nested_scratch", "hw/notes.md": "layout.stray",
            "hw/parts/LMP-0001/helper.py": "layout.stray", "hw/print/flat.dat": "layout.stray",
            "hw/specs/datasheet.pdf": "layout.misplaced"})
        canonical = {p.path: p.canonical_location for p in layout.audit(self.hw, {"hw/specs/datasheet.pdf": "LMP-0008"}).problems}
        self.assertEqual(canonical["hw/notes.md"], "hw/docs/notes.md")
        self.assertEqual(canonical["hw/drawings/LMP-0001/sheet-1.svg"], "hw/drawings/<V>/LMP-0001/")
        self.assertEqual(canonical["hw/specs/datasheet.pdf"], "hw/parts/LMP-0008/sources/datasheet.pdf")
        self.assertEqual(canonical["hw/parts/LMP-0001/helper.py"], ".cad-work/migration/parts/LMP-0001/helper.py")

    def test_the_pair_cache_and_run_records_are_accepted_disposable_files(self) -> None:
        """The SQLite cache, its WAL and SHM, run records and their lock are accepted where their writers put
        them, are not sealed, earn no geometry or release role, and are disposable; interrupted claims and
        an earlier release's sweep lock are reported as transient."""
        accepted = (".cad/recheck.json", ".cad/.gitignore", ".cad/pairs-v2.sqlite", ".cad/pairs-v2.sqlite-wal",
                    ".cad/pairs-v2.sqlite-shm", ".cad/runs/.gitignore", ".cad/runs/.lock",
                    ".cad/runs/3f2b9c1e8d7a4b6c9e0f1a2b3c4d5e6f.json", ".cad/runs/sweep-v3.case_1.json")
        for rel in (*accepted, ".cad/runs/.3f2b9c1e.json.4242.tmp", "motion/v3/.sweep-sweep.json"):
            write(self.hw / rel)
        self.assertEqual(self.codes(), {"hw/.cad/runs/.3f2b9c1e.json.4242.tmp": "layout.transient",
                                        "hw/motion/v3/.sweep-sweep.json": "layout.transient"})
        for rel in accepted[2:]:
            if rel.endswith(".gitignore"):
                continue
            with self.subTest(rel):
                match = layout.classify(f"hw/{rel}")
                self.assertEqual((match.entry.kind, match.entry.manifest, match.entry.mutability),
                                 ("generated", None, "scratch"))
                self.assertNotIn(match.role, ("definition", "manufacture", "evidence"))
        self.assertIsNone(layout.classify("hw/.cad/pairs.sqlite"))  # the old global cache never lived in hw/

    def test_the_part_store_is_accepted_disposable_and_never_a_result(self) -> None:
        """Stored objects and build records sit where cad-model run writes them, are not sealed, earn no
        geometry role, and are no generated result for git; a half-written one is transient."""
        digest = "a" * 64
        accepted = (".cad/parts/.gitignore", f".cad/parts/{digest}", ".cad/builds/.gitignore",
                    f".cad/builds/{digest}.json")
        for rel in (*accepted, f".cad/parts/.{digest}.4242.tmp", f".cad/builds/.{digest}.json.4242.tmp"):
            write(self.hw / rel)
        self.assertEqual(self.codes(), {f"hw/.cad/parts/.{digest}.4242.tmp": "layout.transient",
                                        f"hw/.cad/builds/.{digest}.json.4242.tmp": "layout.transient"})
        for rel in (accepted[1], accepted[3]):
            with self.subTest(rel):
                match = layout.classify(f"hw/{rel}")
                self.assertEqual((match.entry.kind, match.entry.manifest, match.entry.mutability),
                                 ("generated", None, "scratch"))
                self.assertNotIn(match.role, ("definition", "manufacture", "evidence"))
                self.assertIsNone(layout.result_root(rel))
        for bad in (".cad/parts/abc", f".cad/parts/{digest}.step", f".cad/builds/{digest}"):
            self.assertIsNone(layout.classify(f"hw/{bad}"), bad)


class GitStorage(unittest.TestCase):
    """layout.json `storage`: which generated results git tracks, by the user's answer."""

    def test_every_sealed_output_is_a_result_and_nothing_else_is(self) -> None:
        lay = layout.load()
        for entry in lay.entries:
            for name in [spec.name for spec in entry.files] or [None]:
                rel = lay.example(entry, name).removeprefix("hw/")
                with self.subTest(entry=entry.id, path=rel):
                    if entry.kind == "generated" and entry.mutability in ("immutable", "pointer"):
                        self.assertIsNotNone(layout.result_root(rel))
                    else:  # the record, the BOM, the concept handoff, the recheck stamp, caches and scratch
                        self.assertIsNone(layout.result_root(rel))
        self.assertEqual(layout.result_root("motion/v3/assembly/pose.step"), "motion/v3")
        self.assertIsNone(layout.result_root("motion/cases/arm-load/plan.yaml"))
        self.assertIsNone(layout.result_root("analysis/cases/arm-load/case.yaml"))

    def test_unapproved_results_are_ignored_and_approved_ones_tracked_with_lfs(self) -> None:
        roots = layout.load().storage["results"]
        for answer in (None, False):
            with self.subTest(answer=answer):
                self.assertEqual(layout.git_storage(answer), {".gitignore": [f"/{root}/" for root in roots],
                                                              ".gitattributes": []})
        approved = layout.git_storage(True)
        self.assertEqual(approved[".gitignore"], [])
        self.assertEqual(len(approved[".gitattributes"]), 2 * len(roots))
        self.assertIn("versions/**/*.step filter=lfs diff=lfs merge=lfs -text", approved[".gitattributes"])
        self.assertIn("motion/v*/**/*.glb filter=lfs diff=lfs merge=lfs -text", approved[".gitattributes"])
        self.assertTrue(all(rule.split("/", 1)[0] in {r.split("/", 1)[0] for r in roots}
                            for rule in approved[".gitattributes"]))


class ValidatorLayout(TempProject):
    """validate.py on a copy of the lamp example: layout findings, their severity and the exit code."""

    def setUp(self) -> None:
        super().setUp()
        shutil.copytree(LAMP, self.hw)

    def set_flow(self, **flow: Any) -> None:
        path = self.hw / "product.yaml"
        product = yaml.safe_load(path.read_text(encoding="utf-8"))
        product["flow"].update(flow)
        path.write_text(yaml.safe_dump(product, sort_keys=False), encoding="utf-8")

    def freeze(self, stage: str) -> None:
        manifest = seal_version(self.hw, "v1") / "manifest.json"
        self.set_flow(stage=stage, frozen={"version": "v1", "manifest_sha256": sha(manifest), "decision": "DR-001"})

    def run_validator(self) -> tuple[int, dict[str, Any]]:
        result = subprocess.run([sys.executable, str(VALIDATOR), str(self.project)], capture_output=True, text=True,
                                timeout=60, check=False)
        return result.returncode, json.loads(result.stdout)

    def layout_findings(self) -> tuple[int, dict[str, dict[str, Any]]]:
        code, report = self.run_validator()
        found = {item["path"]: item for item in report["findings"] if "code" in item}
        others = [item for item in report["findings"] if "code" not in item]
        self.assertEqual(others, [], "only layout findings are expected")
        return code, found

    def test_stray_flat_print_step_warns_before_freeze_and_fails_from_freeze_on(self) -> None:
        stray = write(self.hw / "print" / "LMP-0004_flat.step")
        write(self.hw / "print" / "export_flat_plug.py")
        code, found = self.layout_findings()
        self.assertEqual(code, 0)
        item = found[str(stray)]
        self.assertEqual((item["code"], item["severity"], item["canonical_location"]),
                         ("layout.stray", "warning", "hw/versions/v1/manufacturing/LMP-0004/part.step"))
        self.assertIn("hw/print/LMP-0004_flat.step is not a managed CAD output", item["message"])
        self.assertIn("hw/parts/LMP-0004/model.py", item["action"])
        self.assertEqual(found[str(self.hw / "print" / "export_flat_plug.py")]["canonical_location"],
                         ".cad-work/migration/print/export_flat_plug.py")
        for label, setup in (("design_freeze", lambda: self.set_flow(stage="design_freeze")),
                             ("release", lambda: self.set_flow(stage="release")),
                             ("ECO at parts after a freeze", lambda: self.freeze("parts"))):
            with self.subTest(label):
                setup()
                code, found = self.layout_findings()
                self.assertEqual(code, 1)
                self.assertEqual(found[str(stray)]["severity"], "error")
                self.assertTrue(found[str(stray)]["canonical_location"].endswith("/manufacturing/LMP-0004/part.step"))

    def test_symlink_escape_is_an_error_at_every_stage(self) -> None:
        outside = write(self.root / "outside.md")
        (self.hw / "docs").mkdir()
        (self.hw / "docs" / "outside.md").symlink_to(outside)
        (self.hw / "docs" / "inside.md").symlink_to(self.hw / "bom.csv")
        (self.hw / "docs" / "escape").symlink_to(self.root, target_is_directory=True)
        code, found = self.layout_findings()
        self.assertEqual(code, 1)
        self.assertEqual({path[len(str(self.hw)) + 1:]: (item["code"], item["severity"]) for path, item in found.items()},
                         {"docs/outside.md": ("layout.symlink_escape", "error"),
                          "docs/escape": ("layout.symlink_escape", "error"),
                          "docs/inside.md": ("layout.symlink", "warning")})

    def test_empty_unknown_directory_is_reported(self) -> None:
        (self.hw / "print").mkdir()
        (self.hw / "decisions" / "drafts").mkdir()
        (self.hw / "docs").mkdir()  # an empty canonical folder is fine
        code, found = self.layout_findings()
        self.assertEqual(code, 0)
        self.assertEqual({path: item["code"] for path, item in found.items()},
                         {str(self.hw / "print"): "layout.empty_directory",
                          str(self.hw / "decisions" / "drafts"): "layout.empty_directory"})

    def test_unsafe_names_are_errors_before_freeze(self) -> None:
        write(self.hw / "docs" / "bad\nname.md")
        write(self.hw / "docs" / "trailing.md ")
        code, found = self.layout_findings()
        self.assertEqual(code, 1)
        self.assertEqual(sorted(item["code"] for item in found.values()), ["layout.unsafe_path"] * 2)

    def test_lamp_with_canonical_outputs_validates_clean_before_and_after_freeze(self) -> None:
        write(self.hw / "versions" / "v1" / "parts" / "LMP-0001.step")
        write(self.hw / "versions" / "v1" / "manufacturing" / "LMP-0001" / "part.step")
        seal_version(self.hw, "v1")
        write(self.hw / "versions" / "latest.json", json.dumps({"label": "v1"}))
        publish(self.hw, "bundle.renders", {"V": "v1", "S": "assembly"}, {"iso.png": "png\n"})
        write(self.hw / "docs" / "assembly-notes.md")
        write(self.hw / "parts" / "LMP-0005" / "sources" / "pin-quote.pdf")
        write(self.hw / ".cad" / "recheck.json", "{}")
        self.assertEqual(self.run_validator(), (0, {"ok": True, "findings": []}))
        self.freeze("design_freeze")
        self.assertEqual(self.run_validator(), (0, {"ok": True, "findings": []}))

    def test_frozen_anchor_must_name_the_exact_built_version(self) -> None:
        self.freeze("design_freeze")
        seal = self.hw / "versions" / "v1" / "manifest.json"
        seal.write_text(seal.read_text(encoding="utf-8") + " ", encoding="utf-8")
        self.set_flow(change={"decision": "DR-009", "baseline_version": "v2", "affected_parts": ["LMP-0099"]})
        code, report = self.run_validator()
        messages = [item["message"] for item in report["findings"]]
        self.assertEqual(code, 1)
        for expected in ("flow/frozen/manifest_sha256 is not the sha256 of versions/v1/manifest.json",
                         "flow/change/decision DR-009 does not exist", "flow/change/baseline_version v2 is not the frozen",
                         "flow/change/affected_parts: LMP-0099 has no parts/LMP-0099/part.yaml"):
            self.assertTrue(any(expected in m for m in messages), (expected, messages))

    def test_manufacture_belongs_to_custom_made_parts_with_a_volume_tolerance(self) -> None:
        def edit(pn: str, block: dict[str, Any]) -> None:
            path = self.hw / "parts" / pn / "part.yaml"
            path.write_text(path.read_text(encoding="utf-8") + yaml.safe_dump({"manufacture": block}), encoding="utf-8")
        edit("LMP-0001", {"relationship": "different", "state": "flat", "reason": "elastic_bending", "decision": "DR-002",
                          "volume_rel_tolerance": 0.002})
        edit("LMP-0005", {"relationship": "same", "mesh": {"linear_deflection_mm": 0.02}})
        self.assertEqual(self.run_validator(), (0, {"ok": True, "findings": []}))
        edit("LMP-0002", {"relationship": "different", "state": "flat", "reason": "elastic_bending", "decision": "DR-002"})
        edit("LMP-0008", {"relationship": "same"})
        edit("LMP-0003", {"relationship": "same", "volume_rel_tolerance": 0.1})
        code, report = self.run_validator()
        text = json.dumps(report["findings"])
        self.assertEqual(code, 1)
        self.assertIn("LMP-0002/part.yaml", text)
        self.assertIn("manufacture: only a custom-made part", text)
        self.assertIn("LMP-0003/part.yaml", text)


class Severity(unittest.TestCase):
    def test_blocking_fails_errors_and_unknown_severities_and_keeps_warnings(self) -> None:
        findings = [{"severity": "error"}, {"severity": "warning"}, {"severity": "info"}, {"severity": "fatal"}, {}]
        self.assertEqual(validate.blocking(findings), [{"severity": "error"}, {"severity": "fatal"}, {}])
        self.assertEqual(validate.blocking([{"severity": "warning"}, {"severity": "info"}]), [])

    def test_layout_strictness_follows_stage_frozen_anchor_and_releases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            hw = Path(directory)
            def product(**flow: Any) -> dict[str, Any]:
                return {"flow": {"stage": "layout", "recheck_from": "layout", **flow}}
            self.assertFalse(validate.layout_strict(product(), hw))
            self.assertFalse(validate.layout_strict(product(stage="reconcile"), hw))
            self.assertTrue(validate.layout_strict(product(stage="design_freeze"), hw))
            self.assertTrue(validate.layout_strict(product(stage="unknown"), hw))
            self.assertTrue(validate.layout_strict(None, hw))
            self.assertTrue(validate.layout_strict(product(frozen={"version": "v1"}), hw))
            write(hw / "releases" / "A" / "manifest.json", "{}")
            self.assertTrue(validate.layout_strict(product(), hw))


if __name__ == "__main__":
    unittest.main()
