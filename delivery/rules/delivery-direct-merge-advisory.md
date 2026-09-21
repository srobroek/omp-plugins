---
name: delivery-direct-merge-advisory
description: Warns when the top-level command of a bash call is a local git merge, which bypasses the reviewed GitHub or GitLab landing and cleanup path.
condition: ["(?i)^(?:\\{\\s*(?:\"[A-Za-z_][A-Za-z0-9_]*\"\\s*:\\s*(?:\"(?:[^\"\\\\]|\\\\.){0,400}\"|-?\\d+(?:\\.\\d+)?|true|false|null)\\s*,\\s*){0,4}\"command\"\\s*:\\s*\")?(?:[ \\t]|\\\\t)*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']{0,120}'|\\\\?\"[^\"\\\\]{0,120}\\\\?\"|[^\\s;&|\"'<>$()\\\\]{0,120})|(?:sudo|env)(?:(?:[ \\t]|\\\\t)+(?:--?[A-Za-z0-9][-A-Za-z0-9]{0,30}(?:=(?:'[^']{0,120}'|\\\\?\"[^\"\\\\]{0,120}\\\\?\"|[^\\s;&|\"'<>$()\\\\]{0,120}))?|[A-Za-z0-9_][-A-Za-z0-9_.@:/]{0,63})){0,3})(?:[ \\t]|\\\\t)+){0,4}(?:'|\\\\?\")?(?:[~./][^\\s;&|\"'<>$()\\\\]{0,160}/)?git(?:'|\\\\?\")?(?:[ \\t]|\\\\t)+(?:(?:(?:-C|-c|--git-dir|--work-tree|--exec-path|--namespace|--super-prefix|--config-env|--attr-source)(?:=|(?:[ \\t]|\\\\t)+)(?:'[^']{0,120}'|\\\\?\"[^\"\\\\]{0,120}\\\\?\"|[^\\s;&|\"'<>$()\\\\]{1,120})|-[Pp]|--no-pager|--paginate|--literal-pathspecs|--no-literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects|--bare|--no-optional-locks|--no-lazy-fetch|--no-advice)(?:[ \\t]|\\\\t)+){0,6}merge(?!(?:[ \\t]|\\\\t)+(?:'|\\\\?\")?(?:--(?:abort|continue|quit|help)|-h)\\b)(?:[ \\t]|\\\\t)+(?:(?:'|\\\\?\")?[A-Za-z0-9_./~@+^:]|(?:'|\\\\?\")?-{1,2}[A-Za-z0-9][-A-Za-z0-9]{0,30}(?=[ \\t]|\\\\t|=|'|\\\\?\"))"]
scope: "tool:bash"
interruptMode: never
---

This `git merge` is a local integration that bypasses the reviewed GitHub or GitLab landing path. Use `delivery_land` for a reviewed merge and `delivery_cleanup` for the resulting cleanup; do not use a reaper.

The rule is advisory-only and never blocks the command (`interruptMode: never`). It reads command text only: it cannot inspect the repository, current branch, merge target, remote, or whether the work was reviewed. Repetition follows `ttsr.repeatMode`; `after-gap` is what keeps an advisory on a routine command tolerable.

## What it reads

Only the command that starts the bash tool call, in both encodings a live match buffer can hold: the argument JSON's root `command` member, and the bare command string. Before `git` it accepts a bounded prefix — environment assignments with bare, single-quoted, or double-quoted values; `sudo` or `env` with bounded options; a quoted or path-qualified executable such as `/usr/bin/git` — and then Git's global options, including `-C <path>`, `-c <key>=<value>`, `-P`, `--no-pager`, `--literal-pathspecs`, `--no-replace-objects`, and `--git-dir=<path>`.

The buffer is re-tested as it streams and a fire cannot be retracted, so the verb alone is never enough. The rule fires only once `merge` is followed by whitespace and a first argument that has already settled: a ref or path character, or an option token that a delimiter has closed. Until then the same buffer can still turn into `git merge-base` or `git merge --abort`. A ref or path is recognized by its first character, one of `A-Za-z0-9_./~@+^:`, optionally behind an opening quote; an argument that starts with anything else, `$` among them, is left alone.

## What it never reads

A regex cannot parse shell, and for a routine command a false fire costs more than a miss. These forms are therefore out of scope by design, and each one is a deliberate false negative:

- an argument that has not arrived yet: a buffer that ends at `git merge`, at the same with a trailing space or tab, at `git merge -`, or inside an option such as `git merge --ab`, because each can still become `git merge-base` or `git merge --abort`;
- an option that no delimiter has closed, such as a bare command delta ending at `git merge --no-ff`; the serialized form fires there, because the closing quote of the `command` member proves the command ended;
- anything past a separator or inside a control structure: `cd repo && git merge topic`, `git status; git merge topic`, a pipe, a second line, and `if`/`while`/`for` bodies;
- nested shell: `bash -lc`, `sh -c`, `xargs`, `mise exec --`, command substitution, and backticks;
- heredoc bodies, including a heredoc that feeds a shell;
- quoted and structured data: `echo` prose, a commit message, the `i` (intent) argument, the `env` argument, and any nested JSON object that carries its own `command` key;
- a root argument object that places a JSON object or array before `command`;
- recovery and help — `--abort`, `--continue`, `--quit`, `--help`, `-h` — at any spacing and with the flag quoted;
- other verbs that merely start with the same letters: `git merge-base`, `git mergetool`, `git rebase`;
- the sanctioned forge path: GitHub `gh pr merge` and GitLab `glab mr merge`.
