# Chezmoi Conventions

## Source-file name prefixes

Attributes stack in a fixed order (for example `private_executable_dot_foo` or
`run_once_before_install.sh.tmpl`); `chezmoi add` writes them for you.

| Prefix / suffix | Meaning |
|---|---|
| `dot_` | target name starts with `.` |
| `private_` | `0600` file or `0700` directory; permissions only, not encryption |
| `readonly_` | write permission removed |
| `executable_` | executable file |
| `empty_` | keep the file even when it is empty |
| `encrypted_` | encrypted in source; written by `chezmoi add --encrypt` |
| `create_` | write the target only when it does not exist yet |
| `modify_` | script that receives the current target on stdin and prints the new contents |
| `remove_` | remove the target |
| `symlink_` | target is a symlink; file contents are the link destination |
| `exact_` | directory: remove target entries not present in source |
| `external_` | directory: ignore attributes in child entries |
| `literal_` | stop attribute parsing; the rest of the name is literal |
| `run_` | script run by `chezmoi apply` |
| `once_` | with `run_`: run once per content hash |
| `onchange_` | with `run_`: run when contents change |
| `before_` / `after_` | with `run_`: run before or after updating targets |
| `.tmpl` | Go template rendered at apply time |
| `.literal` | suffix: stop suffix parsing |

Resolve the source tree with `chezmoi source-path` (or `chezmoi source-path
<target>` for one target); it is not at a fixed location.
