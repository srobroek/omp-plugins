# Greenfield

1. Create and `git init` the destination.
2. Inspect it and choose `agentic-repo` or a stack profile.
3. Plan, review the file map, then render.
4. Run `python3 skills/agentic-scaffold/scripts/scaffold.py tools install --root <root> --yes`.
5. Run `python3 skills/agentic-scaffold/scripts/scaffold.py hooks install --root <root>`.
6. Run `python3 skills/agentic-scaffold/scripts/scaffold.py plugins sync --root <root>`.
7. Run `just check`; inspect project-scope plugins and run the fresh-session probe from SKILL.md.
