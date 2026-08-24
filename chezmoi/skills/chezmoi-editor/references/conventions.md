# Chezmoi Conventions

## Source-file name prefixes

| Prefix / suffix | Meaning |
|---|---|
| `dot_` | dotfile |
| `private_` | `0600` file |
| `executable_` | executable script |
| `readonly_` | read-only file |
| `.tmpl` | Go-template-managed file |

Resolve the source tree with `chezmoi source-path` (or `chezmoi source-path
<target>` for one target); it is not at a fixed location.
