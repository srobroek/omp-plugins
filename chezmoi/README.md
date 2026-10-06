# chezmoi

Edit chezmoi-managed dotfiles at their authoritative source.

The plugin resolves locations only through `chezmoi source-path` and `chezmoi managed`. It does not assume a source-tree path.

## Skills

- `chezmoi-editor`: edit managed source, not live `$HOME` copies.


## Extensions

### `chezmoi-guard`

Refuses a write to a chezmoi-managed target under `$HOME`, because the next `chezmoi apply` overwrites it from source. The refusal names the source path to edit instead (`chezmoi source-path <target>`).

The guard reads write targets from:

- `edit`/`write`/`apply_patch`: `path`, `file_path`, `paths`, hashline `[PATH#TAG]` section headers (every section of a multi-file edit) and `MV DEST`, and apply_patch `*** Add|Update|Delete|Edit File:` and `*** Move to:` headers.
- `bash`: `>`, `>>` and `>|` redirects, `tee`, `cp`/`mv` destinations (including `-t DIR` and an existing destination directory), `sed -i`/`gsed -i` and `perl -i`. Leading `sudo`, `doas`, `env`, `command`, `exec`, `nohup`, `time` and `VAR=value` prefixes are skipped. Relative paths resolve against the call's cwd and a literal `cd DIR` earlier in the same command; a `cd` inside `( … )` ends with the group.

It also covers existing symlink aliases of a managed target.

The guard identifies managed files through `chezmoi managed --path-style=absolute`. It re-reads the list after 5 seconds, after an edit inside the chezmoi source directory, and after any `bash` command that runs `chezmoi` (for example `chezmoi add`).

The guard allows the call in these cases:

- Missing binary.
- Unmanaged path.
- Timeout.
- Spawn error.

The guard reads literal words only; it is not a shell sandbox. It does not see writes behind variables other than `$HOME`, command substitution, `sh -c`/`eval` strings, scripts, or other tools (`install`, `rsync`, `dd`, editors).

The plugin does not implement the legacy chezmoi-sync hook's ignore-list behavior.
