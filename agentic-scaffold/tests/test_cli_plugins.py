from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(CLI), *args], cwd=cwd, env=env, text=True, capture_output=True, check=False)


def test_plugins_sync_check_uses_project_manifest_and_hooks_compose(tmp_path: Path) -> None:
    rendered = run("render", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "demo", "--var", "web_ui=true", "--var", "speckit=true")
    assert rendered.returncode == 0, rendered.stderr
    log = tmp_path / "omp.log"
    shim = tmp_path / "omp"
    shim.write_text("""#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$OMP_LOG"
if [ "$1 $2 $3 $4" = 'plugin marketplace list --json' ]; then printf '{\"marketplaces\":[{\"name\":\"srobroek-omp\",\"source\":\"srobroek/omp-plugins\"},{\"name\":\"impeccable\",\"source\":\"pbakaus/impeccable\"},{\"name\":\"interface-design\",\"source\":\"Dammyjay93/interface-design\"}]}' ; fi
if [ "$1 $2" = 'plugin install' ]; then
  mkdir -p .omp/plugins
  printf '%s' '{"version":2,"plugins":{"browser-tools@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"design@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"diagram@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"styleseed@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"ui-skills@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"platform-design-skills@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"web-quality-skills@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"ui-ux-pro-max@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"modern-web-guidance@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"effective-html@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"frontend-slides@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"web-asset-generator@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"speckit@srobroek-omp":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"impeccable@impeccable":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}],"interface-design@interface-design":[{"scope":"project","installPath":"/tmp/plugin","version":"0.1.0"}]}}' > .omp/plugins/installed_plugins.json
fi
""")
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "OMP_LOG": str(log)}
    result = run("plugins", "sync", "--root", str(tmp_path), env=env)
    assert result.returncode == 0, result.stderr
    assert "plugin install" in log.read_text()
    result = run("plugins", "sync", "--check", "--root", str(tmp_path), env=env)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["drift"] == []

    config = (tmp_path / ".pre-commit-config.yaml").read_text()
    assert "conventional-pre-commit" in config
    assert "omp-context-refresh" in config
