#!/usr/bin/env python3
"""Bundle extension modules whose plugin declares real dependencies.

Plugins without `dependencies` keep `omp.extensions` pointed at their `.ts` sources:
OMP imports those directly with Bun and nothing needs building. A plugin WITH
dependencies cannot rely on `node_modules` existing on the consumer's machine
(git installs run no install step), so its entries point at committed `dist/`
bundles instead, and this script produces them: `bun install` then one
`bun build --target=bun` per extension source, with `@oh-my-pi/*` left external
(the host provides it).

`--check` verifies the committed bundles are current; CI runs that on every push
and the release workflow runs the write mode.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent


def plugins_with_deps(check: bool = False) -> list[Path]:
    found = []
    candidates = {pkg.parent for pkg in REPO.glob("*/package.json")}
    candidates.update(path.parent.parent for path in REPO.glob("*/.omp-plugin/plugin.json"))
    for plugin in sorted(candidates):
        data = json.loads((plugin / "package.json").read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"{plugin}: package.json must be an object")
        dependencies = data.get("dependencies", {})
        if not isinstance(dependencies, dict):
            raise ValueError(f"{plugin}: dependencies must be an object")
        declared = sources(plugin)
        if check and dependencies:
            for src in declared:
                bundle_path = plugin / "dist" / f"{src.stem}.js"
                if not bundle_path.is_file():
                    raise ValueError(f"{plugin}: missing bundle {bundle_path}")
        if dependencies:
            found.append(plugin)
    return found


def sources(plugin: Path) -> list[Path]:
    data = json.loads((plugin / "package.json").read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{plugin}: package.json must be an object")
    omp = data.get("omp", {})
    if not isinstance(omp, dict) or not isinstance(omp.get("extensions", []), list):
        raise ValueError(f"{plugin}: omp.extensions must be a list")
    out = []
    for entry in omp.get("extensions", []):
        if not isinstance(entry, str):
            raise ValueError(f"{plugin}: unsupported extension entry {entry!r}")
        path = Path(entry)
        if (
            path.is_absolute()
            or len(path.parts) != 2
            or (path.parts[0], path.suffix) not in {("extensions", ".ts"), ("dist", ".js")}
            or not path.stem
        ):
            raise ValueError(f"{plugin}: unsupported extension entry {entry!r}")
        if data.get("dependencies") and path.parts[0] != "dist":
            raise ValueError(f"{plugin}: dependency plugin extension {entry!r} must point to packaged dist/*.js")
        src = plugin / "extensions" / f"{path.stem}.ts"
        if not src.is_file():
            raise ValueError(f"{plugin}: missing source for {entry!r}: {src}")
        if path.parts[0] == "dist" and not data.get("dependencies") and not (plugin / path).is_file():
            raise ValueError(f"{plugin}: missing bundle for {entry!r}")
        if src in out:
            raise ValueError(f"{plugin}: duplicate extension source {src}")
        out.append(src)
    return out


def bundle(plugin: Path, write: bool) -> list[str]:
    try:
        declared = sources(plugin)
    except (ValueError, OSError) as err:
        return [str(err)]
    if not declared:
        return []
    problems: list[str] = []
    with TemporaryDirectory(prefix="omp-dist-check-") as temporary:
        working = plugin
        if not write:
            working = Path(temporary) / plugin.name
            shutil.copytree(
                plugin, working,
                ignore=shutil.ignore_patterns("node_modules", "dist", ".dist-check", ".git"),
            )
        subprocess.run(
            ["bun", "install", "--frozen-lockfile", "--silent"],
            cwd=working, check=True, capture_output=True, timeout=300,
        )
        for src in declared:
            out_name = f"{src.stem}.js"
            committed = plugin / "dist" / out_name
            result = subprocess.run(
                [
                    "bun", "build", "--target=bun", str(working / src.relative_to(plugin)),
                    "--outdir", str(working / "dist"),
                    "--external", "@oh-my-pi/*",
                ],
                cwd=working, capture_output=True, text=True, timeout=300,
            )
            if result.returncode != 0:
                problems.append(f"{src}: bun build failed: {result.stderr.strip()[:200]}")
                continue
            fresh = working / "dist" / out_name
            if not fresh.is_file():
                problems.append(f"{src}: bun build produced no {out_name}")
            elif not write:
                if not committed.is_file():
                    problems.append(f"{committed}: missing; run scripts/build-extensions.py")
                elif hashlib.sha256(committed.read_bytes()).digest() != hashlib.sha256(fresh.read_bytes()).digest():
                    problems.append(f"{committed}: stale; run scripts/build-extensions.py")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify committed bundles are current")
    args = parser.parse_args()

    try:
        targets = plugins_with_deps(check=args.check)
    except (ValueError, OSError) as err:
        print(f"FAIL: {err}", file=sys.stderr)
        return 1
    if not targets:
        print("no plugin declares dependencies; nothing to bundle")
        return 0

    problems: list[str] = []
    for plugin in targets:
        try:
            plugin_problems = bundle(plugin, write=not args.check)
        except (OSError, ValueError, subprocess.SubprocessError) as err:
            plugin_problems = [f"{plugin}: {err}"]
        problems += plugin_problems
        if not args.check and not plugin_problems:
            print(f"bundled {plugin.name}")

    if problems:
        for p in problems:
            print(f"  FAIL {p}", file=sys.stderr)
        return 1
    if args.check:
        print(f"PASS: bundles current for {len(targets)} plugin(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
