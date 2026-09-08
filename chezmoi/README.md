# chezmoi

Edit chezmoi-managed dotfiles at their authoritative source.

The plugin resolves locations only through `chezmoi source-path` and `chezmoi managed`. It does not assume a source-tree path.

## Skills

- `chezmoi-editor`: edit managed source, not live `$HOME` copies.

## Extensions

### `chezmoi-guard`

Blocks `edit`/`write` and simple `sed -i` commands on chezmoi target files under `$HOME`. The guard also covers calls whose cwd is `$HOME` and existing symlink aliases.

The guard identifies managed files through `chezmoi managed --path-style=absolute` and caches the list in memory. When a call targets the chezmoi source directory, it refreshes the list.

The guard allows the call in these cases:

- Missing binary.
- Unmanaged path.
- Timeout.
- Spawn error.

After a successful edit in the source directory, the guard prepends a `chezmoi apply` reminder. Reminders appear at most once per 10 minutes.

### `secret-commit-gate`

Blocks a `bash` `git commit` whose candidate files include a plaintext credential in the chezmoi source tree. `SECRET_NAMES` in the module defines the filename patterns.

The gate exempts `.tmpl` files and `encrypted_` files. Values in `.tmpl` files render from the vault at apply time. It also exempts repository tooling outside the source directory.

The gate recognizes `git`, `dgit`, and absolute git paths through literal `env`/`command`/`exec` prefixes. It follows `-C <dir>` and `cd`.

- Ordinary commits inspect staged changes.
- `-a` inspects tracked working-tree changes against HEAD.
- Literal path-limited commits inspect only those paths.

NUL-delimited Git output preserves filenames. Candidate inspection excludes deletions.

A missing binary, missing chezmoi source, or git failure allows the commit. Interactive commits, pathspec files, and dynamic or nonliteral pathspecs are outside candidate inspection. These guards recognize common literal commands, not arbitrary shell programs; they are not a shell sandbox.

The plugin does not implement the legacy chezmoi-sync hook's ignore-list behavior.

## Tools

The plugin's extension modules register `chezmoi_status`.

`chezmoi_status` runs `chezmoi status` and `chezmoi diff` using the session cwd. If either command fails, the tool reports failure.
