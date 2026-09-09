# Architecture

`scaffold.py` is the single runtime boundary. It loads a profile with `tomllib`, resolves ordered layer directories, builds a deterministic file map, and renders only missing files or managed marker blocks. It does not import Copier, Jinja, YAML, or a network client.

A layer is a directory under `skills/agentic-scaffold/templates/` (or a compatible external layer root). Plain files are copied byte-for-byte. `.tmpl` files use `string.Template.substitute`; `__name__` in path segments becomes the package name. A `.block` file contributes a rendered fragment to a marker block named for its layer. Existing text outside the markers is retained.

Profiles are TOML with `name`, `summary`, ordered `layers`, `[vars]`, `[plugins.<marketplace>]`, and `[commands]`. `.omp/plugins.toml` is desired state. `plugins sync` reconciles machine-global marketplace registration and project-scope installs while never changing user-scope installations.

Context refresh delegates to the copied upstream context implementation. It validates include patterns, rejects symlinked output, takes a lock, runs Graphify and Repomix, validates the XML pack, and writes a status record. Formulas define the human-gated greenfield and brownfield workflows; every step retains an unconditional predecessor.
