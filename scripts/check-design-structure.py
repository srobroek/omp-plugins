#!/usr/bin/env python3
"""Structural checks over the design package that no generator or contract gate covers.

Each check states what it proves. A failure names the file and the expectation.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
DESIGN = REPO / "design"

failures: list[str] = []
notes: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'OK  ' if ok else 'FAIL'} {label}{f' -- {detail}' if detail else ''}")
    if not ok:
        failures.append(f"{label}: {detail}")


# 1. Every skill:// reference into a references/ directory resolves on disk.
#    Catches a deleted reference whose link survived; an unresolvable skill:// throws.
missing: list[str] = []
for skill_md in sorted(DESIGN.glob("skills/*/SKILL.md")):
    for ref in re.findall(r"skill://([\w./-]+)", skill_md.read_text(encoding="utf-8")):
        if "/references/" not in ref:
            continue  # a bare skill:// name, checked separately below
        target = DESIGN / "skills" / ref
        if not target.is_file():
            missing.append(f"{skill_md.relative_to(REPO)} -> skill://{ref}")
check("every skill:// reference resolves", not missing, "; ".join(missing))

# 2. Every bare skill:// name refers to a skill this package actually ships.
shipped = {p.parent.name for p in DESIGN.glob("skills/*/SKILL.md")}
unknown: list[str] = []
for md in sorted(DESIGN.rglob("*.md")):
    for ref in re.findall(r"skill://([\w.-]+)(?![\w./-])", md.read_text(encoding="utf-8")):
        if ref not in shipped:
            unknown.append(f"{md.relative_to(REPO)} -> skill://{ref}")
check("every bare skill:// names a shipped skill", not unknown, "; ".join(unknown))

# 3. Frontmatter name equals the directory name for every skill.
mismatched: list[str] = []
for skill_md in sorted(DESIGN.glob("skills/*/SKILL.md")):
    text = skill_md.read_text(encoding="utf-8")
    match = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
    got = match.group(1).strip().strip('"').strip("'") if match else None
    if got != skill_md.parent.name:
        mismatched.append(f"{skill_md.parent.name} declares {got!r}")
check("skill frontmatter name equals its directory", not mismatched, "; ".join(mismatched))

# 4. Vendored skills carry their licence obligations.
VENDORED = {
    "ux-copy": ("Apache License", "anthropics/knowledge-work-plugins"),
    "wireloom": ("MIT License", "StardockCorp/Wireloom"),
}
for name, (licence_marker, upstream) in VENDORED.items():
    base = DESIGN / "skills" / name
    problems = []
    for required in ("SKILL.md", "LICENSE", "NOTICE"):
        if not (base / required).is_file():
            problems.append(f"missing {required}")
    if (base / "LICENSE").is_file() and licence_marker not in (base / "LICENSE").read_text(encoding="utf-8"):
        problems.append(f"LICENSE lacks {licence_marker!r}")
    if (base / "SKILL.md").is_file():
        body = (base / "SKILL.md").read_text(encoding="utf-8")
        if "MODIFIED" not in body.upper():
            problems.append("SKILL.md carries no modification notice")
        if upstream not in body:
            problems.append(f"SKILL.md does not name {upstream}")
    check(f"vendored {name} carries its obligations", not problems, "; ".join(problems))

# ux-copy must carry no LINK to the connector doc it cannot reach. Its modification notice
# names that file in prose, which Apache-2.0 4(b) requires, so match the markdown link
# form rather than any mention.
uxcopy = (DESIGN / "skills" / "ux-copy" / "SKILL.md").read_text(encoding="utf-8")
check("ux-copy drops the unresolvable connector link", "](../../CONNECTORS.md)" not in uxcopy)

# 5. No wrapper routes to an upstream this marketplace does not advertise. Routing to one
#    would leave the refuse path with no install command, so the wrapper refuses forever.
#    Checked only inside the routing table, so prose recording a deliberate exclusion is fine.
FORBIDDEN_UPSTREAM = {"animation-principles", "state-machine", "layout-grid", "wireframe-generator"}
found_forbidden: list[str] = []
for ref in sorted(DESIGN.glob("skills/*/references/upstream.md")):
    rows = [ln for ln in ref.read_text(encoding="utf-8").splitlines() if ln.lstrip().startswith("|")]
    for name in FORBIDDEN_UPSTREAM:
        if any(re.search(rf"`{re.escape(name)}`", row) for row in rows):
            found_forbidden.append(f"{ref.relative_to(REPO)} routes to `{name}`")
for skill_md in sorted(DESIGN.glob("skills/*/SKILL.md")):
    rows = [ln for ln in skill_md.read_text(encoding="utf-8").splitlines() if ln.lstrip().startswith("|")]
    for name in FORBIDDEN_UPSTREAM:
        if any(re.search(rf"`{re.escape(name)}`", row) for row in rows):
            found_forbidden.append(f"{skill_md.relative_to(REPO)} routes to `{name}`")
check("no wrapper routes to an unadvertised upstream", not found_forbidden, "; ".join(found_forbidden))

# 6. Every advertised install command names a real catalog entry.
catalog = json.loads((REPO / ".omp-plugin" / "marketplace.json").read_text(encoding="utf-8"))
entries = {p["name"] for p in catalog["plugins"]}
bad_installs: list[str] = []
for md in sorted(DESIGN.rglob("*.md")):
    for entry in re.findall(r"omp plugin install ([\w.-]+)@srobroek-omp", md.read_text(encoding="utf-8")):
        if entry not in entries:
            bad_installs.append(f"{md.relative_to(REPO)} -> {entry}")
check("every advertised install names a catalog entry", not bad_installs, "; ".join(bad_installs))

# 7. Formula inventory matches what the README documents.
formulas = sorted(p.stem.replace(".formula", "") for p in DESIGN.glob("formulas/*.formula.toml"))
poured = [f for f in formulas if not f.startswith("mol-")]
bonded = [f for f in formulas if f.startswith("mol-")]
check("three poured tiers carry no mol- prefix", len(poured) == 3, f"poured={poured}")
check("seven bondable mols carry the prefix", len(bonded) == 7, f"bonded={bonded}")
check("retired mol-design-node is gone", "mol-design-node" not in formulas)

readme = (DESIGN / "README.md").read_text(encoding="utf-8")
undocumented = [f for f in formulas if f"`{f}`" not in readme]
check("README documents every formula", not undocumented, f"missing={undocumented}")
undocumented_skills = [s for s in sorted(shipped) if f"`{s}`" not in readme]
check("README documents every skill", not undocumented_skills, f"missing={undocumented_skills}")

# 8. Probe both catalog input modes without touching the checkout.
with TemporaryDirectory(prefix="omp-catalog-probe-") as temporary:
    probe = Path(temporary)
    (probe / "scripts").mkdir()
    for script in ("build-catalog.py", "sync-plugin-manifests.py"):
        shutil.copy2(REPO / "scripts" / script, probe / "scripts" / script)
    for manifest in REPO.glob("*/.omp-plugin/plugin.json"):
        target = probe / manifest.relative_to(REPO)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(manifest, target)
    third_party = REPO / "scripts" / "third-party-plugins.json"
    for include_third_party in (False, True):
        if include_third_party:
            if not third_party.is_file():
                continue
            shutil.copy2(third_party, probe / "scripts" / third_party.name)
        label = f"catalog builds {'with' if include_third_party else 'without'} third-party entries"
        output = probe / ".omp-plugin" / "marketplace.json"
        output.unlink(missing_ok=True)
        try:
            result = subprocess.run(
                [sys.executable, "scripts/build-catalog.py"],
                cwd=probe, capture_output=True, text=True, timeout=60,
            )
            if result.returncode != 0:
                check(label, False, f"exit {result.returncode}: {result.stderr.strip() or result.stdout.strip()}")
                continue
            generated = json.loads(output.read_text(encoding="utf-8"))
            plugins = generated["plugins"]
            if not isinstance(plugins, list):
                raise ValueError("plugins must be a list")
            if include_third_party:
                expected = json.loads(third_party.read_text(encoding="utf-8"))["plugins"]
                actual = {p["name"] for p in plugins if not isinstance(p["source"], str)}
                ok = actual == {p["name"] for p in expected}
            else:
                expected_local = {
                    json.loads(p.read_text(encoding="utf-8"))["name"]
                    for p in probe.glob("*/.omp-plugin/plugin.json")
                    if json.loads(p.read_text(encoding="utf-8")).get("publish") is not False
                }
                ok = (
                    all(isinstance(p["source"], str) for p in plugins)
                    and {p["name"] for p in plugins} == expected_local
                )
            check(label, ok, f"{len(plugins)} entries")
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as err:
            check(label, False, str(err))

# 9. Report wrapper sizes rather than asserting a target, so the number is visible.
for skill_md in sorted(DESIGN.glob("skills/*/SKILL.md")):
    lines = len([ln for ln in skill_md.read_text(encoding="utf-8").splitlines() if ln.strip()])
    notes.append(f"{skill_md.parent.name}: {lines} non-empty lines")

print()
print("skill sizes:")
for note in notes:
    print(f"  {note}")

print()
if failures:
    for line in failures:
        print(f"FAIL {line}")
    raise SystemExit(1)
print("PASS: every structural check holds")
