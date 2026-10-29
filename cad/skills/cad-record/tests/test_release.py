#!/usr/bin/env python3
"""release.py: a frozen record releases one complete package; any gap refuses and writes nothing in hw/."""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

import yaml

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"
RELEASE = SCRIPTS / "release.py"
LAMP = SKILL.parent.parent / "examples" / "lamp-arm" / "hw"


def load(name: str, path: Path) -> Any:
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec and spec.loader
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


layout = load("cad_record_layout", SCRIPTS / "layout.py")
validate = load("cad_record_validate", SCRIPTS / "validate.py")
release = load("cad_record_release", RELEASE)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, text: str = "x\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def tree(root: Path) -> dict[str, str]:
    """Every file and directory below `root`: a file by its sha256, a directory as `dir`."""
    return {p.relative_to(root).as_posix(): ("dir" if p.is_dir() else sha(p)) for p in sorted(root.rglob("*"))}


def edit_yaml(path: Path, change: Callable[[dict[str, Any]], None]) -> None:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")


def edit_csv(path: Path, change: Callable[[list[dict[str, str]]], None]) -> None:
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        columns, rows = reader.fieldnames, list(reader)
    change(rows)
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    path.write_text(out.getvalue(), encoding="utf-8")


def publish(hw: Path, kind: str, subject: str, files: dict[str, str], status: str = "pass") -> Path:
    staged = layout.staging(hw, f"bundle.{kind}")
    for name, text in files.items():
        write(staged / name, text)
    return layout.publish(hw, f"bundle.{kind}", {"V": "v1", "S": subject}, staged, recipe={"subject": subject},
                          producer="test", status=status).path


DRAWING = {"sheet-1.svg": "svg\n", "sheet-1.pdf": "pdf\n", "sheet-1.png": "png\n", "coverage.json": "{}\n",
           "package.json": "{}\n"}


def build_version(hw: Path, omit: tuple[tuple[str, str], ...] = (), failed: dict[str, str] | None = None,
                  attach: tuple[str, ...] = ()) -> None:
    """hw/versions/v1 as cad-model run seals it: record snapshot, installed STEP per modelled part and
    the manufacturing outputs of every custom-made part. `omit` leaves (PN, file) out; `failed` marks
    a part's named manufacturing check failed; `attach` lists its `--attach REF=PARENT_REF` options."""
    folder = hw / "versions" / "v1"
    for name in ["product.yaml", "interfaces.yaml", "assembly.yaml"] + [
            p.relative_to(hw).as_posix() for p in sorted((hw / "parts").glob("*/part.yaml"))]:
        target = folder / "record" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((hw / name).read_bytes())
    for name in ("assembly.step", "assembly.glb", "part-map.json", "metrics.json"):
        write(folder / name, f"{name}\n")
    parts, made = {}, {}
    for model in sorted((hw / "parts").glob("*/model.py")):
        pn = model.parent.name
        write(folder / "parts" / f"{pn}.step", f"installed {pn}\n")
        parts[pn] = {"source_sha256": sha(model), "step": f"parts/{pn}.step"}
        record = yaml.safe_load((model.parent / "part.yaml").read_text(encoding="utf-8"))
        if not layout.custom_made(record):
            continue
        outputs = layout.manufacture_policy(record).outputs
        directory = folder / "manufacturing" / pn
        files = {name: sha(write(directory / name, f"{name} of {pn}\n"))
                 for name in outputs if name != "manufacturing.json" and (pn, name) not in omit}
        check = (failed or {}).get(pn)
        row = {"status": "fail" if check else "pass", "complete": not check, "blocking_failures": [check] if check else [],
               "checks": {"step": {"status": "pass"}, check or "placement": {"status": "fail" if check else "pass"}}}
        sidecar = {"schema_version": 1, "PN": pn, "process": record["process"], "outputs": list(outputs),
                   "path": f"manufacturing/{pn}", "files": files, **row}
        files["manufacturing.json"] = sha(write(directory / "manufacturing.json", json.dumps(sidecar, indent=2)))
        made[pn] = {"PN": pn, "process": record["process"], "path": f"manufacturing/{pn}", "files": files,
                    **{key: row[key] for key in ("status", "complete", "blocking_failures")}}
    inventory = {p.relative_to(folder).as_posix(): sha(p) for p in sorted(folder.rglob("*")) if p.is_file()}
    manifest = {"schema_version": 3, "label": "v1", "product_id": "lamp-arm", "attach": list(attach), "parts": parts,
                "record": {k: v for k, v in inventory.items() if k.startswith("record/")}, "manufacturing": made,
                "files": inventory}
    write(folder / "manifest.json", json.dumps(manifest, indent=2))
    write(hw / "versions" / "latest.json", json.dumps({"label": "v1", "manifest": "versions/v1/manifest.json"}))


def frozen_lamp(hw: Path, *, before_build: Callable[[Path], None] | None = None, omit: tuple[tuple[str, str], ...] = (),
                failed: dict[str, str] | None = None, skip_bundles: tuple[str, ...] = (), attach: tuple[str, ...] = ()) -> None:
    """The lamp example, reconciled for release (released revisions, verification passed with
    evidence), built as v1, frozen at it, every required bundle published, and DR-005 approving it."""
    shutil.copytree(LAMP, hw)
    for part in sorted((hw / "parts").glob("*/part.yaml")):
        edit_yaml(part, lambda data: data.update(rev="A"))
    edit_csv(hw / "bom.csv", lambda rows: [row.update(rev="A") for row in rows])
    write(hw / "analysis" / "cases" / "arm-load" / "case.yaml", "id: arm-load\n")
    write(hw / "docs" / "inspection.md", "# Inspection record\n")
    if before_build:
        before_build(hw)
    build_version(hw, omit, failed, attach)
    edit_yaml(hw / "product.yaml", lambda data: data["flow"].update(
        stage="release", frozen={"version": "v1", "manifest_sha256": sha(hw / "versions" / "v1" / "manifest.json"),
                                 "decision": "DR-004"}))
    write(hw / "decisions" / "DR-005.md", "# DR-005 Release A\n\nApproved: release v1 as revision A.\n")
    evidence = {"REQ-002": "sweep hw/motion/v1/elbow-sweep", "REQ-004": "hw/analysis/v1/arm-load/results.json"}
    edit_csv(hw / "verification.csv", lambda rows: [row.update(result="pass", evidence=evidence.get(
        row["requirement_id"], "hw/docs/inspection.md")) for row in rows])
    for part in sorted((hw / "versions" / "v1" / "record" / "parts").glob("*/part.yaml")):
        pn = part.parent.name
        if "drawing" in yaml.safe_load(part.read_text(encoding="utf-8")) and pn not in skip_bundles:
            publish(hw, "drawings", pn, DRAWING)
    publish(hw, "drawings", "assembly", DRAWING)
    publish(hw, "analysis", "arm-load", {"results.json": '{"status": "pass"}\n'})
    publish(hw, "motion", "elbow-sweep", {"result.json": '{"status": "pass"}\n', "worst.step": "worst\n"})


class ReleaseCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-release-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.count = 0

    def project(self, **options: Any) -> Path:
        self.count += 1
        hw = self.root / f"project-{self.count}" / "hw"
        frozen_lamp(hw, **options)
        return hw

    def release(self, hw: Path, rev: str = "A", version: str = "v1", decision: str = "DR-005") -> tuple[int, dict[str, Any]]:
        return release.run(hw, rev, version, decision)


class Release(ReleaseCase):
    def test_the_fixture_is_a_clean_frozen_record(self) -> None:
        hw = self.project()
        self.assertEqual(validate.blocking(validate.validate_project(hw)), [])

    def test_a_complete_frozen_record_releases_a_verified_package(self) -> None:
        hw = self.project()
        result = subprocess.run([sys.executable, str(RELEASE), str(hw), "--rev", "A", "--version", "v1",
                                 "--decision", "DR-005"], capture_output=True, text=True, timeout=120, check=False)
        report = json.loads(result.stdout)
        self.assertEqual((result.returncode, report["status"]), (0, "released"), report.get("findings"))
        package = hw / "releases" / "A"
        manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
        findings: list[dict[str, Any]] = []
        self.assertTrue(validate.validate_document(manifest, "release-manifest.schema.json", "manifest", findings), findings)
        self.assertEqual((manifest["schema_version"], manifest["rev"], manifest["approval"], manifest["frozen"]["version"]),
                         (2, "A", "DR-005", "v1"))
        self.assertEqual(manifest["frozen"]["manifest_sha256"], sha(hw / "versions" / "v1" / "manifest.json"))
        self.assertEqual(layout.verify(package), [])
        for name, item in manifest["files"].items():
            self.assertEqual(sha(layout.locate(hw, item["original"])), item["sha256"], name)
        self.assertEqual(report["manifest_sha256"], sha(package / "manifest.json"))
        self.assertEqual(manifest["manufacturing"]["LMP-0001"],
                         {"process": "fdm", "quantity": 1, "files": ["manufacturing/LMP-0001/part.step",
                                                                     "manufacturing/LMP-0001/part.stl",
                                                                     "manufacturing/LMP-0001/manufacturing.json"]})
        self.assertEqual(manifest["manufacturing"]["LMP-0002"]["files"],
                         ["manufacturing/LMP-0002/part.step", "manufacturing/LMP-0002/manufacturing.json"])
        selected = {item["path"]: item["manifest_sha256"] for item in manifest["bundles"]}
        self.assertEqual(set(selected), {f"hw/drawings/v1/LMP-00{n:02d}" for n in range(1, 11)}
                         | {"hw/drawings/v1/assembly", "hw/analysis/v1/arm-load", "hw/motion/v1/elbow-sweep"})
        for path, manifest_sha in selected.items():
            self.assertEqual(sha(layout.locate(hw, path) / "manifest.json"), manifest_sha)
        for name in ("definition/assembly.step", "definition/record/assembly.yaml", "drawings/assembly/sheet-1.pdf",
                     "analysis/arm-load/results.json", "motion/elbow-sweep/worst.step", "bom.csv", "verification.csv",
                     "docs/inspection.md"):
            self.assertTrue((package / name).is_file(), name)
        self.assertEqual(manifest["checks"]["verification/REQ-002"], "pass")
        self.assertEqual(list((hw.parent / ".cad-work" / "release-A").iterdir()), [], "the stage became the package")
        self.assertEqual(validate.blocking(validate.validate_project(hw)), [], "the released record still validates")

    def test_a_catalogue_buy_is_exempt_and_a_made_to_drawing_part_is_included(self) -> None:
        hw = self.project()
        code, report = self.release(hw)
        self.assertEqual(code, 0, report.get("findings"))
        package = hw / "releases" / "A"
        manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(manifest["manufacturing"]), [f"LMP-000{n}" for n in range(1, 8)])
        self.assertEqual(manifest["manufacturing"]["LMP-0005"],
                         {"process": "cnc", "quantity": 1, "files": ["manufacturing/LMP-0005/part.step",
                                                                     "manufacturing/LMP-0005/manufacturing.json"]})
        catalogue = ("LMP-0008", "LMP-0009", "LMP-0010", "LMP-0011")
        self.assertEqual([name for name in manifest["files"]
                          if name.startswith(tuple(f"manufacturing/{pn}/" for pn in catalogue))], [])
        self.assertTrue((package / "definition" / "record" / "parts" / "LMP-0008" / "part.yaml").is_file(),
                        "a catalogue buy carries its procurement definition")
        self.assertTrue((package / "drawings" / "LMP-0008" / "sheet-1.pdf").is_file(), "its vendor specification sheet")

    def test_a_repeated_part_gives_one_output_with_its_occurrence_count(self) -> None:
        def make_ring(hw: Path) -> None:
            def custom(data: dict[str, Any]) -> None:
                data.update(make_buy="make", process="cnc")
                del data["procurement"]
            edit_yaml(hw / "parts" / "LMP-0011" / "part.yaml", custom)
            edit_csv(hw / "bom.csv", lambda rows: [row.update(
                make_buy="make", process="cnc", **dict.fromkeys(validate.BOM_PROCUREMENT_COLUMNS[1:], ""))
                for row in rows if row["PN"] == "LMP-0011"])

        hw = self.project(before_build=make_ring)
        code, report = self.release(hw)
        self.assertEqual(code, 0, report.get("findings"))
        manifest = json.loads((hw / "releases" / "A" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["manufacturing"]["LMP-0011"],
                         {"process": "cnc", "quantity": 3, "files": ["manufacturing/LMP-0011/part.step",
                                                                     "manufacturing/LMP-0011/manufacturing.json"]})
        self.assertEqual(sorted(n for n in manifest["files"] if n.startswith("manufacturing/LMP-0011/")),
                         ["manufacturing/LMP-0011/manufacturing.json", "manufacturing/LMP-0011/part.step"])

    def test_a_version_built_with_attach_releases(self) -> None:
        def unjoin(hw: Path) -> None:  # members cad-model attaches at run time instead of by a joint
            edit_yaml(hw / "assembly.yaml", lambda data: data.update(
                joints=[joint for joint in data["joints"] if joint["id"] not in ("J-009", "J-012")]))

        hw = self.project(before_build=unjoin, attach=("LMP-0010=LMP-0004", "@ring-head=LMP-0007"))
        self.assertEqual(validate.blocking(validate.validate_project(hw)), [])
        code, report = self.release(hw)
        self.assertEqual(code, 0, report.get("findings"))
        manifest = json.loads((hw / "releases" / "A" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["manufacturing"]["LMP-0007"]["quantity"], 1)

    def test_a_released_original_may_go_but_its_package_copy_may_not(self) -> None:
        hw = self.project()
        write(hw / "docs" / "notes.md", "# Notes\n")
        self.assertEqual(self.release(hw)[0], 0)
        (hw / "docs" / "notes.md").unlink()
        self.assertEqual(validate.blocking(validate.validate_project(hw)), [], "release A holds its own copy")
        (hw / "releases" / "A" / "docs" / "notes.md").unlink()
        self.assertIn("releases/A/docs/notes.md", json.dumps(validate.blocking(validate.validate_project(hw))))


class Refusal(ReleaseCase):
    """Each gap refuses with a finding that names it, and hw/ is byte-identical afterwards."""

    def refused(self, hw: Path, path: str, code: str, text: str, **arguments: str) -> None:
        before = tree(hw)
        result, report = self.release(hw, **arguments)
        self.assertEqual((result, report["status"]), (1, "refused"))
        self.assertTrue(any(item["path"] == path and item.get("code") == f"release.{code}" and text in item["message"]
                            for item in report["findings"]), json.dumps(report["findings"], indent=1))
        self.assertEqual(tree(hw), before, "a refused release writes nothing in hw/")

    def test_a_missing_fdm_stl_refuses(self) -> None:
        hw = self.project(omit=(("LMP-0001", "part.stl"),))
        self.refused(hw, "hw/versions/v1/manufacturing/LMP-0001/part.stl", "missing", "a fdm part needs part.step, part.stl")
        self.assertFalse((hw / "releases").exists())

    def test_a_failed_manufacturing_check_refuses(self) -> None:
        hw = self.project(failed={"LMP-0004": "bed_contact"})
        self.refused(hw, "hw/versions/v1/manufacturing/LMP-0004/manufacturing.json", "failed", "bed_contact failed")

    def test_a_tampered_bundle_refuses(self) -> None:
        hw = self.project()
        write(hw / "drawings" / "v1" / "LMP-0002" / "sheet-1.svg", "edited\n")
        self.refused(hw, "hw/drawings/v1/LMP-0002", "tampered", "sheet-1.svg changed after it was sealed")

    def test_a_missing_drawing_refuses(self) -> None:
        hw = self.project(skip_bundles=("LMP-0006",))
        self.refused(hw, "hw/drawings/v1/LMP-0006", "missing", "LMP-0006 declares drawing intent")

    def test_a_changed_current_record_refuses(self) -> None:
        hw = self.project()
        edit_yaml(hw / "parts" / "LMP-0003" / "part.yaml", lambda data: data.update(finish="Anodized"))
        self.refused(hw, "hw/parts/LMP-0003/part.yaml", "changed", "differs from v1/record/parts/LMP-0003/part.yaml")
        hw = self.project()
        model = hw / "parts" / "LMP-0002" / "model.py"
        model.write_text(model.read_text(encoding="utf-8") + "\n# edited\n", encoding="utf-8")
        self.refused(hw, "hw/parts/LMP-0002/model.py", "changed", "is not the model v1 built")

    def test_a_wrong_version_refuses(self) -> None:
        hw = self.project()
        self.refused(hw, "hw/product.yaml", "frozen", "flow.frozen names v1, not v2", version="v2")

    def test_an_existing_revision_is_never_overwritten(self) -> None:
        hw = self.project()
        self.assertEqual(self.release(hw)[0], 0)
        self.refused(hw, "hw/releases/A", "exists", "a used revision is never overwritten")

    def test_a_missing_decision_refuses(self) -> None:
        hw = self.project()
        self.refused(hw, "hw/decisions/DR-099.md", "decision", "DR-099 does not exist", decision="DR-099")

    def test_unverified_requirements_and_missing_evidence_refuse(self) -> None:
        hw = self.project()
        edit_csv(hw / "verification.csv", lambda rows: rows[0].update(result="planned"))
        before = tree(hw)
        code, report = self.release(hw)
        self.assertEqual(code, 1)
        self.assertIn("release verification result must be pass or waived", json.dumps(report["findings"]))
        self.assertEqual(tree(hw), before)
        hw = self.project()
        edit_csv(hw / "verification.csv", lambda rows: rows[1].update(evidence="hw/motion/v1/elbow-limits"))
        self.refused(hw, "hw/motion/v1/elbow-limits", "missing", "REQ-002 cites it")

    def test_cited_evidence_inside_the_frozen_version_or_a_bundle_must_exist(self) -> None:
        for evidence in ("hw/analysis/v1/arm-load/result.json", "hw/versions/v1/x.step"):
            with self.subTest(evidence=evidence):
                hw = self.project()
                edit_csv(hw / "verification.csv", lambda rows: [row.update(evidence=evidence) for row in rows
                                                                if row["requirement_id"] == "REQ-004"])
                with (hw / "verification.csv").open(newline="", encoding="utf-8") as stream:
                    line = next(n for n, row in enumerate(csv.DictReader(stream), start=2) if row["requirement_id"] == "REQ-004")
                self.refused(hw, f"hw/verification.csv:{line}", "missing", f"REQ-004 evidence {evidence} does not exist")

    def test_a_bad_argument_is_a_usage_error(self) -> None:
        hw = self.project()
        result = subprocess.run([sys.executable, str(RELEASE), str(hw), "--rev", "I", "--version", "v1",
                                 "--decision", "DR-005"], capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("REV 'I' does not match", json.loads(result.stdout)["message"])


if __name__ == "__main__":
    unittest.main()
