---
name: typescript-state-data
description: React server vs client state, QueryState facade, error normalization, IPC fetch seam
---

# TypeScript State & Data

- Keep server/async state (data fetched over network or IPC, plus its loading and
  error status) independent from client/UI state (selection, panel open/closed,
  theme, transient form state). Storing server responses in a UI store is only
  correct when the denormalisation is deliberate.
- Expose `QueryState<T> = { data: T | undefined; loading: boolean; error: string |
  null }` from store modules. Do NOT leak library-internal result shapes (raw
  `QueryObserverResult`, Apollo `ApolloQueryResult`) into component props or
  context values -- that couples every consumer to the data library.
- Normalise errors once: one `errMessage(unknown): string` with structural guards
  and an ordered fallback chain, one `isContractError(unknown)` type guard, one
  build-checked `code → message` map. Both query and mutation layers import from
  it; scattered `e?.message ?? String(e)` is the smell.
- Funnel IPC and fetch calls through one typed dispatch seam. Keep `queryFn` and
  `mutationFn` idiomatic (return data or throw) and put unwrapping,
  deserialisation, and error coercion inside the seam, not in each hook.
