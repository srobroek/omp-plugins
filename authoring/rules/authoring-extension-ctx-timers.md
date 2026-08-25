---
name: authoring-extension-ctx-timers
description: In an OMP extension module, schedule with ctx.setTimeout/ctx.setInterval; a raw timer whose callback throws kills the session.
scope: "tool:edit(**/extensions/*.ts), tool:write(**/extensions/*.ts)"
interruptMode: never
astCondition:
  - "setTimeout($$$ARGS)"
  - "setInterval($$$ARGS)"
---
This applies to extension modules -- the files OMP loads through
`package.json` `omp.extensions`. There, `ctx.setTimeout` and `ctx.setInterval`
contain a throwing callback and clear themselves on `session_shutdown`. A raw
`setTimeout`/`setInterval` callback that throws surfaces as
`uncaughtException` and takes the whole session with it, long after the code
that scheduled it returned.

```ts
ctx.setInterval(() => refresh(), 30_000);
```

`ctx` is the handler context OMP passes in; reach for it wherever one is in
scope. A helper with no `ctx` available keeps its raw timer only with a callback
that cannot throw -- wrap the body in `try`/`catch` and say why in a comment,
because the next reader has to re-derive that argument otherwise.

Rest of the extension contract: `skill://omp-extension-safety`.
