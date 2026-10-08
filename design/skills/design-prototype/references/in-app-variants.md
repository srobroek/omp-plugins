# In-app variants

Read when the route is "structurally different variants of an existing page, inside the
real app". The variants live in application code, so this route runs in the worktree and
delivery workflow of the change that asked for it.

## Build

1. State the question and pick N: default 3, at most 5. Write the plan in one line at the
   top of the switcher file, for example "three variants of the settings page, switchable
   via `?variant=`, on the existing `/settings` route".
2. Host the variants on the existing route, selected by the `?variant=` search param. Data
   fetching, params, and auth stay above the switch; only the rendered subtree changes.
   Use a throwaway route under the project's routing convention only when nothing could
   host the variants, and name it with the word `prototype`.
3. Make the variants structurally different: layout, information hierarchy, and primary
   affordance, not colour or copy. Use the project's component library. Read-only data;
   point any mutation at a stub.
4. Add one floating switcher: previous and next arrows plus the variant label, updating the
   URL param through the framework's router; the arrow keys cycle variants except while an
   input, textarea, or contenteditable element has focus.

## Gate the whole prototype

Put the variant components, the `?variant=` branch, and the switcher behind one dev-only
flag, for example an explicit `PROTOTYPE_VARIANTS` flag that is also false whenever
`NODE_ENV` is `production`. With the flag off, the route renders exactly what it renders
without the prototype, whatever `?variant=` says. Hiding only the switcher is not a gate:
a crafted `?variant=` URL would still render an experiment.

## HTTP render check

Run the dev server as a supervised `bash` service with a unique name, such as
`prototype-variants-<port>`. Fetch every variant URL and the flag-off case before
reporting:

```
curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:<port>/settings?variant=B"
```

Report each status beside its URL; a URL without a measured 200 is NOT SERVED. Then drive
each variant with `skill://ui-review` at 1440, 768, and 375, and stop the service.

## After the choice

Record which variant won and why. The winning variant was written under prototype
constraints: rewrite it properly, with tests, when folding it into the page. Remove the
losing variants, the switcher, and the flag in the same change.
