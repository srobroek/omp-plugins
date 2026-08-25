---
name: authoring-extension-argv-exec
description: In an OMP extension module, spawn an argv array with an explicit timeout; a shell command string is an injection seam.
scope: "tool:edit(**/extensions/*.ts), tool:write(**/extensions/*.ts)"
interruptMode: never
astCondition:
  - "exec($$$ARGS)"
  - "execSync($$$ARGS)"
  - "spawn($A)"
---
This applies to extension modules -- the files OMP loads through
`package.json` `omp.extensions`. An extension's inputs are tool arguments and
repository content, so any of them can reach a shell string. `exec` and
`execSync` take a command line in every arity and have no argv form at all;
`spawn` with one argument is the same shape.

```ts
const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
	stdout: "pipe",
	stderr: "pipe",
	timeout: 5_000,
});
```

Argv array, explicit timeout, prefiltered so it never runs on unrelated calls.
A genuine shell feature (a pipeline, a glob) goes through an explicit
`["sh", "-c", …]` argv with every interpolated value quoted, not through a
string handed to `exec`.

Pattern shape: `exec`/`execSync` match at any arity because both are
shell-only. `spawn` matches at arity one only, so the sanctioned
`spawn(cmd, argv, opts)` stays silent. Receiver calls (`re.exec(line)`,
`Bun.spawnSync(argv)`) are structurally different and never match.

Rest of the extension contract: `skill://omp-extension-safety`.
