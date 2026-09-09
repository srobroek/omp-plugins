from pathlib import Path
import tomllib

ROOT = Path(__file__).parents[1]
PROFILES = ROOT / "profiles"
EXPECTED = {"python-lib", "python-app", "ts-lib", "ts-app", "rust-lib", "rust-app", "go-lib", "go-app", "terraform", "web-ui"}


def test_profiles_parse_and_reference_layers():
    found = {p.stem for p in PROFILES.glob("*.toml") if p.stem != "agentic-repo"}
    assert EXPECTED <= found
    for path in PROFILES.glob("*.toml"):
        data = tomllib.loads(path.read_text())
        assert data["name"] == path.stem
        assert data["summary"]
        for layer in data["layers"]:
            assert (ROOT / "skills/agentic-scaffold/templates" / layer).is_dir(), (path, layer)
        commands = data["commands"]
        assert {"setup", "test", "lint", "fmt", "check"} <= commands.keys()


def test_plugin_sources_and_stack_mapping():
    for path in PROFILES.glob("*.toml"):
        if path.stem == "agentic-repo":
            continue
        data = tomllib.loads(path.read_text())
        plugins = data.get("plugins", {})
        assert "srobroek-omp" in plugins
        assert plugins["srobroek-omp"]["source"] == "srobroek/omp-plugins"
        names = set(plugins["srobroek-omp"]["plugins"])
        if path.stem != "web-ui": assert "architecture" in names
        if path.stem.startswith("python-"): assert "python" in names
        if path.stem.startswith("ts-"): assert "typescript" in names
        if path.stem.startswith("rust-"): assert "rust" in names
        if path.stem.startswith("go-"): assert "go" in names
        if path.stem.endswith("-app"): assert "backend" in names
        if path.stem == "terraform": assert "infrastructure" in names
    web = tomllib.loads((PROFILES / "web-ui.toml").read_text())["plugins"]
    assert web["impeccable"]["source"] == "pbakaus/impeccable"
    assert web["interface-design"]["source"] == "Dammyjay93/interface-design"
