# /// script
# requires-python = ">=3.11"
# dependencies = ["ruamel.yaml==0.18.16", "tomlkit==0.14.0"]
# ///
"""Install project-local OMP context and compose refresh hooks through prek."""

from __future__ import annotations

import argparse
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import tomlkit
from context import validate_includes
from ruamel.yaml import YAML

STAGES = ["post-commit", "post-checkout", "post-merge"]
START = "<!-- omp-agentic-scaffold:start -->"
END = "<!-- omp-agentic-scaffold:end -->"
IGNORES = ["/graphify-out/", "/repomix.xml", "/.repomix-*.xml"]
EXCLUDES = [
    "**/.env*",
    "**/*.pem",
    "**/*.key",
    "**/credentials*",
    "**/secrets*",
    "**/node_modules/**",
    "**/vendor/**",
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/.git/**",
    "**/.beads/**",
    ".omp/context.py",
    ".omp/mcp.json",
    ".agents/skills/graphify/**",
    "graphify-out/**",
    "repomix.xml",
    ".repomix-*.xml",
]


def safe(root: Path, path: Path) -> None:
    path.relative_to(root)
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f"Refusing symlink: {current}")
    if path.exists() and not path.is_file():
        raise ValueError(f"Not a regular file: {path}")


def marked(existing: str, body: str) -> str:
    block = f"{START}\n{body.rstrip()}\n{END}\n"
    if START not in existing and END not in existing:
        return existing.rstrip() + ("\n\n" if existing.strip() else "") + block
    if existing.count(START) != 1 or existing.count(END) != 1:
        raise ValueError("Ambiguous agentic-scaffold markers; repair before re-running")
    start, end = existing.index(START), existing.index(END)
    if end < start:
        raise ValueError("Reversed agentic-scaffold markers")
    return existing[:start] + block.rstrip("\n") + existing[end + len(END) :]


def run(argv: list[str], root: Path, timeout: int = 120) -> None:
    subprocess.run(argv, cwd=root, check=True, timeout=timeout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["inspect", "apply"])
    parser.add_argument("--root", default=".")
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument(
        "--notes", help="JSON file with project-specific agents and watchdog text"
    )
    parser.add_argument("--install-tools", action="store_true")
    parser.add_argument(
        "--docs-backend",
        choices=[
            "ollama",
            "openai",
            "claude",
            "gemini",
            "kimi",
            "deepseek",
            "azure",
            "bedrock",
        ],
    )
    parser.add_argument("--docs-model")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    root = Path(args.root).absolute()
    if root.is_symlink() or root.resolve() != root or not root.is_dir():
        raise ValueError("Root must be an existing canonical project directory")
    if bool(args.docs_backend) != bool(args.docs_model):
        raise ValueError(
            "Document indexing requires both an explicitly approved backend and model"
        )
    if not 10 <= args.timeout <= 1800:
        raise ValueError("Timeout must be between 10 and 1800 seconds")
    if args.action == "apply" or args.include:
        args.include = validate_includes(args.include)
    git_root = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    if git_root.returncode or Path(git_root.stdout.strip()).resolve() != root:
        raise ValueError(
            "Select the Git repository root; setup never initializes Git or a task database"
        )
    hooks_path = subprocess.run(
        ["git", "config", "--get", "core.hooksPath"],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    if hooks_path.returncode == 0:
        raise ValueError(
            "core.hooksPath is configured; reconcile its hook manager before scaffolding"
        )
    configs = [
        p
        for p in [
            root / "prek.toml",
            root / ".pre-commit-config.yaml",
            root / ".pre-commit-config.yml",
        ]
        if p.exists()
    ]
    if len(configs) > 1:
        raise ValueError(
            "Multiple prek/pre-commit configurations; choose the authoritative one first"
        )
    hook_config = configs[0] if configs else root / "prek.toml"
    targets = [
        root / p
        for p in [
            "AGENTS.md",
            "WATCHDOG.md",
            ".gitignore",
            ".graphifyignore",
            ".omp/context.py",
            ".omp/project-context.json",
            ".omp/repomix.json",
            ".omp/mcp.json",
        ]
    ] + [hook_config]
    for path in targets:
        safe(root, path)
    for output in [root / "graphify-out", root / "repomix.xml"]:
        if output.is_symlink():
            raise ValueError(f"Refusing symlinked output: {output}")
    graphify_skill = root / ".agents/skills/graphify/SKILL.md"
    safe(root, graphify_skill)
    available = {
        name: shutil.which(name)
        for name in [
            "uv",
            "prek",
            "graphify",
            "graphify-mcp",
            "repomix",
            "bun",
            "python3",
        ]
    }
    plan = {
        "root": str(root),
        "files": [str(p.relative_to(root)) for p in targets],
        "tools": available,
        "hooks": STAGES,
        "docs": {"backend": args.docs_backend, "model": args.docs_model},
        "repomix_include": args.include,
    }
    print(json.dumps(plan, indent=2))
    if args.action == "inspect":
        return 0
    if not args.notes:
        raise ValueError(
            "Apply requires --notes with evidence-derived project instructions"
        )
    notes = json.loads(Path(args.notes).read_text())
    for key in ["agents", "watchdog"]:
        if (
            not isinstance(notes.get(key), str)
            or not notes[key].strip()
            or START in notes[key]
            or END in notes[key]
        ):
            raise ValueError(
                f"notes.{key} must be nonempty text without managed markers"
            )
    owned = root / ".omp/project-context.json"
    if (
        owned.exists()
        and json.loads(owned.read_text()).get("managed_by") != "omp-agentic-scaffold"
    ):
        raise ValueError(
            "Existing context configuration is not owned by agentic-scaffold"
        )
    for target in [root / ".omp/context.py", root / ".omp/repomix.json"]:
        if target.exists() and not owned.exists():
            raise ValueError(f"Refusing to overwrite existing file: {target}")
    if args.install_tools:
        if not available["uv"]:
            raise ValueError("Install uv through the project's toolchain first")
        if not available["prek"]:
            run([available["uv"], "tool", "install", "prek"], root)
        run([available["uv"], "tool", "install", "graphifyy[mcp]==0.9.57"], root)
        if not available["repomix"]:
            if not available["bun"]:
                raise ValueError("Install bun through the project's toolchain first")
            run([available["bun"], "install", "--global", "repomix@1.18.0"], root)
        available = {name: shutil.which(name) for name in available}
    required = ["prek", "graphify", "graphify-mcp", "repomix", "python3"]
    if missing := [name for name in required if not available[name]]:
        raise ValueError(
            f"Missing tools: {', '.join(missing)}; approve --install-tools or install through the project toolchain"
        )
    agent_text = (
        notes["agents"].rstrip()
        + "\n\n## Repository context\n\nFor architecture, relationships, and impact questions, query the project Graphify\nMCP graph first. Use LSP for exact symbols/refactors and read source before edits.\nCheck `graphify-out/context-status.json`; missing or STALE means refresh with\n`python3 .omp/context.py refresh`. A committed HEAD match does not include later\nuncommitted edits: read changed source directly or refresh before relying on it.\n\nUse `repomix.xml` only for bulk review of its configured include patterns. It is\na bounded source snapshot, not exhaustive proof and not normal startup context.\nDo not import the graph, report, or XML into this file. Generated artifacts are\nignored; hooks refresh them after commit, branch checkout, and merge.\n"
    )
    content = {}
    for filename, text in [
        ("AGENTS.md", agent_text),
        ("WATCHDOG.md", notes["watchdog"]),
    ]:
        path = root / filename
        content[path] = marked(path.read_text() if path.exists() else "", text)
    for filename, additions in [(".gitignore", IGNORES), (".graphifyignore", EXCLUDES)]:
        path = root / filename
        original = path.read_text() if path.exists() else ""
        new = [line for line in additions if line not in original.splitlines()]
        content[path] = (
            original
            + ("\n" if original and not original.endswith("\n") else "")
            + "".join(line + "\n" for line in new)
        )
    runtime = {
        "managed_by": "omp-agentic-scaffold",
        "graphify": ["graphify"],
        "graphify_mcp": ["graphify-mcp"],
        "repomix": ["repomix"],
        "repomix_include": args.include,
        "timeout": args.timeout,
        "docs_backend": args.docs_backend,
        "docs_model": args.docs_model,
    }
    content[root / ".omp/context.py"] = (
        Path(__file__).with_name("context.py").read_text()
    )
    for path, obj in [
        (".omp/project-context.json", runtime),
        (
            ".omp/repomix.json",
            {
                "output": {"style": "xml", "parsableStyle": True, "tokenBudget": 40000},
                "security": {"enableSecurityCheck": True},
                "ignore": {
                    "useGitignore": True,
                    "useDefaultPatterns": True,
                    "customPatterns": EXCLUDES,
                },
            },
        ),
    ]:
        target = root / path
        if target.exists() and not (root / ".omp/project-context.json").exists():
            raise ValueError(f"Refusing to adopt existing configuration: {target}")
        content[target] = json.dumps(obj, indent=2) + "\n"
    mcp_path = root / ".omp/mcp.json"
    mcp = json.loads(mcp_path.read_text()) if mcp_path.exists() else {"mcpServers": {}}
    launcher = "import os,subprocess,sys; root=subprocess.check_output(['git','rev-parse','--show-toplevel'],text=True,timeout=10).strip(); os.execv(sys.executable,[sys.executable,os.path.join(root,'.omp','context.py'),'mcp'])"
    server = {"type": "stdio", "command": "python3", "args": ["-c", launcher]}
    servers = mcp.setdefault("mcpServers", {})
    if "graphify" in servers and servers["graphify"] != server:
        raise ValueError(
            "Existing Graphify MCP configuration differs; reconcile it before setup"
        )
    servers["graphify"] = server
    content[mcp_path] = json.dumps(mcp, indent=2) + "\n"
    hook = {
        "id": "omp-context-refresh",
        "name": "Refresh Graphify and Repomix context",
        "language": "system",
        "entry": "python3 .omp/context.py refresh",
        "always_run": True,
        "pass_filenames": False,
        "stages": STAGES,
    }
    yaml = YAML()
    original = hook_config.read_text() if hook_config.exists() else ""
    document = (
        tomlkit.parse(original)
        if hook_config.suffix == ".toml"
        else (yaml.load(original) or {})
    )
    repos = document.setdefault("repos", [])
    found = [
        h for repo in repos for h in repo.get("hooks", []) if h.get("id") == hook["id"]
    ]
    if len(found) > 1:
        raise ValueError("Duplicate omp-context-refresh hooks")
    if found:
        if not owned.exists():
            raise ValueError(
                "Existing omp-context-refresh hook is not owned by this scaffold"
            )
        found[0].update(hook)
    else:
        repos.append({"repo": "local", "hooks": [hook]})
    if hook_config.suffix == ".toml":
        content[hook_config] = tomlkit.dumps(document)
    else:
        stream = io.StringIO()
        yaml.dump(document, stream)
        content[hook_config] = stream.getvalue()
    with tempfile.TemporaryDirectory(prefix="omp-prek-") as temporary:
        candidate = Path(temporary) / hook_config.name
        candidate.write_text(content[hook_config])
        run([available["prek"], "validate-config", str(candidate)], root)
    for path, text in content.items():
        safe(root, path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    run([available["prek"], "validate-config", str(hook_config)], root)
    run(
        [
            available["prek"],
            "install",
            "--config",
            str(hook_config),
            *[arg for stage in STAGES for arg in ["--hook-type", stage]],
        ],
        root,
    )
    if not graphify_skill.exists():
        run(
            [available["graphify"], "install", "--project", "--platform", "agents"],
            root,
        )
    run(
        [available["python3"], str(root / ".omp/context.py"), "refresh"],
        root,
        args.timeout * 3 + 30,
    )
    print(
        "PASS: project instructions, Graphify MCP, scoped Repomix, and prek refresh hooks installed"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
    ) as exc:
        print(f"Agentic scaffolding FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
