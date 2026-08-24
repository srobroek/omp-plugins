# chezmoi

Edit chezmoi-managed dotfiles at their authoritative source.

Locations are resolved only through `chezmoi source-path` and `chezmoi managed`.
This plugin does not assume a source-tree path.

## Skills

- `chezmoi-editor` — edit managed source, not live `$HOME` copies

## Extensions

- `chezmoi-guard` — blocks `edit`/`write` (and cheap `sed -i`) on chezmoi
  TARGET files under `$HOME` outside the repo cwd. Membership is a live
  `chezmoi managed --path-style=absolute` list, cached in memory and refreshed
  when a call targets the chezmoi source dir. Any uncertainty (missing binary,
  unmanaged path, timeout, spawn error) allows the call. After a successful
  source-dir edit, it prepends a `chezmoi apply` reminder (once per 10 minutes).

The legacy chezmoi-sync hook's ignore-list behaviour was not ported.

## Rules


## Agents

None.

## Tools

Registered by this plugin's extension modules:

- `chezmoi_status`
