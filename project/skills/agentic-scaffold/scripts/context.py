#!/usr/bin/env python3
"""Refresh ignored repository context or serve its project-bound Graphify MCP."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def run(argv: list[str], root: Path, timeout: int) -> None:
    subprocess.run(argv, cwd=root, check=True, timeout=timeout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["refresh", "mcp"])
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / ".omp/project-context.json").read_text())
    if args.action == "mcp":
        os.chdir(root)
        os.execvp(
            config["graphify_mcp"][0],
            [*config["graphify_mcp"], "--graph", str(root / "graphify-out/graph.json")],
        )
    output = root / "graphify-out"
    if output.is_symlink() or (root / "repomix.xml").is_symlink():
        raise ValueError("Refusing symlinked context output")
    output.mkdir(exist_ok=True)
    lock = output / ".refresh.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        print(
            "Context refresh already running or stale lock exists; retry after inspecting graphify-out/.refresh.lock",
            file=sys.stderr,
        )
        return 1
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(str(os.getpid()))
        status = output / "context-status.json"
        status.write_text(json.dumps({"state": "STALE", "started": time.time()}) + "\n")
        graph_args = [*config["graphify"], "extract", ".", "--no-cluster"]
        if config.get("docs_backend"):
            graph_args += [
                "--backend",
                config["docs_backend"],
                "--model",
                config["docs_model"],
                "--max-concurrency",
                "1",
            ]
        else:
            graph_args += ["--code-only"]
        run(graph_args, root, config["timeout"])
        run(
            [*config["graphify"], "cluster-only", ".", "--no-label", "--no-viz"],
            root,
            config["timeout"],
        )
        if config["repomix_include"]:
            handle, temporary = tempfile.mkstemp(
                prefix=".repomix-", suffix=".xml", dir=root
            )
            os.close(handle)
            try:
                run(
                    [
                        *config["repomix"],
                        ".",
                        "--config",
                        ".omp/repomix.json",
                        "--include",
                        ",".join(config["repomix_include"]),
                        "--output",
                        temporary,
                    ],
                    root,
                    config["timeout"],
                )
                os.replace(temporary, root / "repomix.xml")
            finally:
                Path(temporary).unlink(missing_ok=True)
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        status.write_text(
            json.dumps(
                {
                    "state": "CURRENT",
                    "head": head.stdout.strip() if head.returncode == 0 else None,
                    "completed": time.time(),
                    "docs_indexed": bool(config.get("docs_backend")),
                }
            )
            + "\n"
        )
        print("Context refreshed: graphify-out/graph.json and repomix.xml")
        return 0
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(
            f"Context refresh FAILED; existing output is not proof of freshness: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1)
