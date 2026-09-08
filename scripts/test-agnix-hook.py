#!/usr/bin/env python3
"""Exercise the staged agnix checker through its real Git index inputs."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def git(root: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        ["git", *args], cwd=root, env=merged_env, capture_output=True, text=True, check=True
    )


def checker(root: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        [str(root / "scripts" / "check-agnix-staged.sh")],
        cwd=root,
        env=merged_env,
        capture_output=True,
        text=True,
    )


def assert_rejected(label: str, result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode == 0:
        raise AssertionError(f"{label} unexpectedly passed\n{result.stdout}\n{result.stderr}")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="agnix-hook-test-") as temporary:
        root = Path(temporary)
        git(root, "init", "--quiet")
        git(root, "config", "user.name", "agnix hook test")
        git(root, "config", "user.email", "agnix-hook-test@example.invalid")
        (root / "scripts").mkdir()
        shutil.copy2(REPO / ".agnix.toml", root / ".agnix.toml")
        shutil.copy2(REPO / "scripts" / "check-agnix-staged.sh", root / "scripts" / "check-agnix-staged.sh")
        (root / "scripts" / "check-agnix-staged.sh").chmod(0o755)
        (root / "skills" / "valid").mkdir(parents=True)
        (root / "skills" / "valid" / "SKILL.md").write_text(
            "---\nname: valid\ndescription: Check a valid skill\n---\nBody\n", encoding="utf-8"
        )
        git(root, "add", "--all", "--")
        git(root, "commit", "--quiet", "-m", "base")
        base = git(root, "rev-parse", "HEAD").stdout.strip()

        malformed = root / "skills" / "bad\nname" / "SKILL.md"
        malformed.parent.mkdir(parents=True)
        malformed.write_text(
            "---\nname: [broken\ndescription: This frontmatter is invalid\n---\nBody\n",
            encoding="utf-8",
        )
        git(root, "add", "--all", "--")
        assert_rejected("malformed staged instruction", checker(root))
        git(root, "commit", "--quiet", "-m", "malformed fixture")

        index = root / "temporary-index"
        environment = {"GIT_INDEX_FILE": str(index), "AGNIX_DIFF_BASE": base}
        git(root, "read-tree", "HEAD", env=environment)
        assert_rejected("malformed CI instruction", checker(root, env=environment))

    print("agnix hook regression cases passed")


if __name__ == "__main__":
    main()
