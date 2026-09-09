from pathlib import Path
import tomllib

ROOT = Path(__file__).parents[1]
PROFILES = ROOT / "profiles"
TEMPLATES = ROOT / "skills/agentic-scaffold/templates"
EXPECTED = {"agentic-repo", "python-lib", "python-app", "ts-lib", "ts-app", "rust-lib", "rust-app", "go-lib", "go-app", "terraform", "web-ui"}


def test_profiles_are_thin_and_reference_layers():
    found = {p.stem for p in PROFILES.glob("*.toml")}
    assert EXPECTED <= found
    for path in PROFILES.glob("*.toml"):
        data = tomllib.loads(path.read_text())
        assert data["name"] == path.stem
        assert data["summary"]
        assert isinstance(data["layers"], list)
        assert "plugins" not in data
        for layer in data["layers"]:
            layer_dir = TEMPLATES / layer
            assert (layer_dir / "layer.toml").is_file(), (path, layer)
            assert (layer_dir / "README.md").is_file(), (path, layer)
        assert {"setup", "test", "lint", "fmt", "check"} <= data["commands"].keys()


def test_layer_ownership_and_conflicts_are_symmetric():
    configs = {str(p.parent.relative_to(TEMPLATES)): tomllib.loads(p.read_text()) for p in TEMPLATES.glob("**/layer.toml")}
    assert configs
    for name, data in configs.items():
        for other in data.get("conflicts_with", []):
            assert name in configs[other].get("conflicts_with", []), (name, other)
    for path in PROFILES.glob("*.toml"):
        data = tomllib.loads(path.read_text())
        owners = {}
        for layer in data["layers"]:
            for owned in configs[layer].get("owns", []):
                owners.setdefault(owned, []).append(layer)
        assert all(len(values) == 1 for values in owners.values()), (path, owners)


def test_plugin_sources_live_in_layers():
    python = tomllib.loads((TEMPLATES / "lang/python/layer.toml").read_text())
    assert python["plugins"]["srobroek-omp"]["source"] == "srobroek/omp-plugins"
    assert "python" in python["plugins"]["srobroek-omp"]["plugins"]
    web = tomllib.loads((TEMPLATES / "web-ui/layer.toml").read_text())["plugins"]
    assert web["impeccable"]["source"] == "pbakaus/impeccable"
    assert web["interface-design"]["source"] == "Dammyjay93/interface-design"
