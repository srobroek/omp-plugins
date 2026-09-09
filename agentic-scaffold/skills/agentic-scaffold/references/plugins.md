# Project plugins

`.omp/plugins.toml` is committed desired state. `plugins sync` reads marketplace registrations with `omp plugin marketplace list --json`, adds missing sources, and installs missing entries with `omp plugin install <plugin>@<marketplace> --scope project`. Verify with `omp plugin list --json` and check that entries report `scope: project`. `plugins sync --check` reports drift without changing anything. Never uninstall or alter user-scope plugins.
