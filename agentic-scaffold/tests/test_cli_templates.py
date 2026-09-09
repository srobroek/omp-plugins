from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"


def test_inspect_is_json(tmp_path: Path) -> None:
    result = subprocess.run([sys.executable, str(CLI), "inspect", "--root", str(tmp_path)], text=True, capture_output=True, check=False)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["root"] == str(tmp_path)
    assert "missing_tools" in payload


def test_profiles_list_is_json() -> None:
    result = subprocess.run([sys.executable, str(CLI), "profiles", "list"], text=True, capture_output=True, check=False)
    assert result.returncode == 0
    assert any(item["name"] == "agentic-repo" for item in json.loads(result.stdout)["profiles"])
