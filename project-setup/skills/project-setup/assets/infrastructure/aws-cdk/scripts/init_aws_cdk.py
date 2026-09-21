#!/usr/bin/env python3
"""Create an AWS CDK v2 TypeScript application with the native CDK generator."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

VERSION = re.compile(r"^[1-9][0-9]*\.[0-9]+\.[0-9]+$")
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dest", required=True, help="new repository-relative CDK member")
    parser.add_argument("--cdk-version", required=True, help="exact stable aws-cdk version")
    return parser.parse_args()


def destination(root: Path, value: str) -> Path:
    raw = Path(value)
    if raw.is_absolute() or not raw.parts or any(part in {"", ".", ".."} for part in raw.parts):
        raise SystemExit("--dest must be a non-empty repository-relative path without dot segments")
    resolved = (root / raw).resolve()
    if root not in resolved.parents or not NAME.fullmatch(raw.name):
        raise SystemExit("--dest must stay under the repository and end in an identifier-like name")
    if resolved.exists():
        raise SystemExit(f"destination already exists: {raw}")
    return resolved


def main() -> None:
    args = parse_args()
    if not VERSION.fullmatch(args.cdk_version):
        raise SystemExit("--cdk-version must be an exact stable X.Y.Z version")

    root = Path.cwd().resolve()
    dest = destination(root, args.dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=".aws-cdk-init-", dir=dest.parent) as temporary:
        work = Path(temporary) / dest.name
        work.mkdir()
        command = [
            "bunx",
            "--package",
            f"aws-cdk@{args.cdk_version}",
            "cdk",
            "init",
            "app",
            "--language",
            "typescript",
            "--generate-only",
        ]
        subprocess.run(command, cwd=work, check=True)
        subprocess.run(["bun", "install"], cwd=work, check=True)
        os.replace(work, dest)

    print(
        json.dumps(
            {
                "cdk_version": args.cdk_version,
                "destination": str(dest.relative_to(root)),
                "generated": True,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
