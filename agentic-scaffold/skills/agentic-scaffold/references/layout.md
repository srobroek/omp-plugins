# Layer layout

Profiles list ordered layer directories. `.tmpl` files use `string.Template`; `__name__` path segments become the package name. `.block` files update only their managed marker block and preserve all other text. A missing destination file is created; an existing unmarked file is a conflict. Keep language, CI, and release layers independent of the engine.
