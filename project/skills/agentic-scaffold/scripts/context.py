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
from pathlib import Path, PureWindowsPath
from xml.etree import ElementTree


def validate_includes(includes: object) -> list[str]:
    if not isinstance(includes, list) or not includes:
        raise ValueError("Explicit nonempty source include patterns are required")
    patterns = []
    for item in includes:
        if not isinstance(item, str):
            raise TypeError("Source include patterns must be strings")
        for pattern in item.split(","):
            pattern = pattern.strip()
            path = pattern.lstrip("!")
            parts = path.split("/")
            if (
                not path
                or path.startswith(("/", "-"))
                or PureWindowsPath(path).drive
                or "\\" in path
                or "\0" in path
                or ".." in parts
                or any(any(char in part for char in "{}()") for part in parts[:-1])
            ):
                raise ValueError(f"Unsafe source include pattern: {pattern!r}")
            patterns.append(pattern)
    if not any(not pattern.startswith("!") for pattern in patterns):
        raise ValueError("At least one positive source include pattern is required")
    return patterns


def write_status(path: Path, value: dict) -> None:
    handle, temporary = tempfile.mkstemp(prefix=".context-status-", dir=path.parent)
    try:
        with os.fdopen(handle, "w") as stream:
            stream.write(json.dumps(value) + "\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def validate_pack(path: Path, root: Path) -> None:
    document = ElementTree.parse(path)
    files = (
        document.findall("./files/file") if document.getroot().tag == "repomix" else []
    )
    if not files:
        raise ValueError(
            "Repomix produced no safe source files; retaining previous XML"
        )
    for file in files:
        name = file.get("path", "")
        source = root / name
        if (
            not name
            or Path(name).is_absolute()
            or PureWindowsPath(name).drive
            or ".." in Path(name).parts
            or not source.resolve().is_relative_to(root)
            or not source.is_file()
            or source.resolve() == root / ".omp/mcp.json"
        ):
            raise ValueError(f"Unsafe packed source path: {name!r}")


def run(
    argv: list[str], root: Path, timeout: int, env: dict[str, str] | None = None
) -> None:
    subprocess.run(argv, cwd=root, check=True, timeout=timeout, env=env)


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
        write_status(status, {"state": "STALE", "started": time.time()})
        includes = validate_includes(config["repomix_include"])
        for child in output.rglob("*"):
            if child.is_symlink():
                raise ValueError(f"Refusing symlinked Graphify output: {child}")
        graph_env = {**os.environ, "GRAPHIFY_OUT": str(output)}
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
        run(graph_args, root, config["timeout"], graph_env)
        run(
            [*config["graphify"], "cluster-only", ".", "--no-label", "--no-viz"],
            root,
            config["timeout"],
            graph_env,
        )
        graph = output / "graph.json"
        if graph.is_symlink() or not graph.is_file():
            raise ValueError("Graphify did not produce the project graph.json")
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
                    ",".join(includes),
                    "--ignore",
                    ".omp/mcp.json",
                    "--style",
                    "xml",
                    "--parsable-style",
                    "--output",
                    temporary,
                ],
                root,
                config["timeout"],
            )
            validate_pack(Path(temporary), root)
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
        write_status(
            status,
            {
                "state": "CURRENT",
                "head": head.stdout.strip() if head.returncode == 0 else None,
                "completed": time.time(),
                "docs_indexed": bool(config.get("docs_backend")),
            },
        )
        print("Context refreshed: graphify-out/graph.json and repomix.xml")
        return 0
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        OSError,
        ValueError,
        TypeError,
        ElementTree.ParseError,
        subprocess.SubprocessError,
    ) as exc:
        print(
            f"Context refresh FAILED; existing output is not proof of freshness: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1)
