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
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def plugins_with_deps() -> list[Path]:
    found = []
    for pkg in sorted(REPO.glob("*/package.json")):
        data = json.loads(pkg.read_text(encoding="utf-8"))
        if data.get("dependencies"):
            found.append(pkg.parent)
    return found


def sources(plugin: Path) -> list[Path]:
    data = json.loads((plugin / "package.json").read_text(encoding="utf-8"))
    entries = data.get("omp", {}).get("extensions", [])
    out = []
    for entry in entries:
        # Both shapes are valid inputs: ./extensions/foo.ts (source) or ./dist/foo.js
        # (already-wired bundle output whose source sits in extensions/).
        name = Path(entry).stem
        src = plugin / "extensions" / f"{name}.ts"
        if src.is_file():
            out.append(src)
    return out


def bundle(plugin: Path, write: bool) -> list[str]:
    problems: list[str] = []
    subprocess.run(
        ["bun", "install", "--silent"],
        cwd=plugin,
        check=True,
        capture_output=True,
        timeout=300,
    )
    for src in sources(plugin):
        out_name = f"{src.stem}.js"
        committed = plugin / "dist" / out_name
        result = subprocess.run(
            [
                "bun", "build", "--target=bun", str(src),
                "--outdir", str(plugin / ("dist" if write else ".dist-check")),
                "--external", "@oh-my-pi/*",
            ],
            cwd=plugin,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            problems.append(f"{src}: bun build failed: {result.stderr.strip()[:200]}")
            continue
        if not write:
            fresh = plugin / ".dist-check" / out_name
            if not committed.is_file():
                problems.append(f"{committed.relative_to(REPO)}: missing; run scripts/build-extensions.py")
            elif hashlib.sha256(committed.read_bytes()).digest() != hashlib.sha256(fresh.read_bytes()).digest():
                problems.append(f"{committed.relative_to(REPO)}: stale; run scripts/build-extensions.py")
    check_dir = plugin / ".dist-check"
    if check_dir.is_dir():
        for f in check_dir.iterdir():
            f.unlink()
        check_dir.rmdir()
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify committed bundles are current")
    args = parser.parse_args()

    targets = plugins_with_deps()
    if not targets:
        print("no plugin declares dependencies; nothing to bundle")
        return 0

    problems: list[str] = []
    for plugin in targets:
        problems += bundle(plugin, write=not args.check)
        if not args.check:
            print(f"bundled {plugin.name}: {[s.name for s in sources(plugin)]}")

    if problems:
        for p in problems:
            print(f"  FAIL {p}", file=sys.stderr)
        return 1
    if args.check:
        print(f"PASS: bundles current for {len(targets)} plugin(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
