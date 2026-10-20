---
name: cicd-skip-ci-text
description: Warn after a git commit, GitLab MR, or GitHub PR command contains one of the skip-CI markers that can suppress the required pipeline.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:(?:then|do|sudo|command|env|exec|time)\\s+)*?(?:git\\s+(?:-C\\s+\\S+\\s+)?commit|glab\\s+mr\\b|gh\\s+pr\\b)(?:(?!\\\\n)[^;|&\\n]){0,500}?(?:\\[skip\\s+ci\\]|\\[ci\\s+skip\\]|\\[no\\s+ci\\]|\\[skip\\s+actions\\])"]
scope: "tool:bash"
interruptMode: never
---

GitLab and GitHub skip the pipeline for any commit whose message contains this marker, even when the author quotes it as prose. Remove the marker when CI must run.

The rule reminds the agent after a matching bash command. Forge-side required pipelines and title checks enforce the policy; local guidance only advises.