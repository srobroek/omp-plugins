# Secret Handling

- Prefer chezmoi-native secret handling over hardcoded values.
- For secret-backed values, use chezmoi's native integration with the user's
  credential manager or vault when the config supports it.
- Do not commit raw secrets into the source tree.
- If a file is sensitive, use the correct chezmoi private-file pattern instead of
  relying on convention alone.
