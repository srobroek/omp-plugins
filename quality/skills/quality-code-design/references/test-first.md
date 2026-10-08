# Test-first loop

Read when the user asks for test-first work, red-green-refactor, or TDD. What makes a
test worth keeping (public behavior, independent expected values, fidelity, mocks only at
boundaries) is in [verification.md](verification.md); this guide covers the loop.

## Vertical slices

**Do:** work in tracer bullets: one test, one minimal implementation, repeat. Each test
answers to what the previous cycle taught you.
**Do not:** write all the tests first and then all the implementation. Bulk tests verify
imagined behavior: they test the shape of things, commit to a test structure before the
implementation is understood, and stay green through real changes.

## Red, green, refactor

1. **Red:** write the failing test first and watch it fail for the expected reason. A test
   that passes before the change proves nothing about it.
2. **Green:** write only enough code to pass it. No anticipated future tests, no
   speculative features.
3. **Refactor:** with the tests green, simplify the code this cycle touched, within the
   change's scope. Re-run the tests after each step.

## Make boundaries mockable

At a system boundary, inject the client and give each external operation its own
function, rather than one generic fetcher the mock must branch inside.

Bad:

```ts
const api = { fetch: (endpoint: string, options?: RequestInit) => fetch(endpoint, options) };
// Each test's mock switches on endpoint and method to fake the right response.
```

Good:

```ts
const api = {
  getUser: (id: string) => fetch(`/users/${id}`),
  getOrders: (userId: string) => fetch(`/users/${userId}/orders`),
  createOrder: (data: NewOrder) => fetch("/orders", { method: "POST", body: JSON.stringify(data) }),
};
function processPayment(order: Order, paymentClient: PaymentClient) {
  return paymentClient.charge(order.total);
}
```

Why: each mock returns one shape with no conditional logic, a test shows which endpoints
it exercises, and each endpoint keeps its own types. Whether the boundary deserves a port
at all follows the seam rule in [deep-modules.md](deep-modules.md).

**Exception:** a one-off script calling one endpoint needs no client object; call it
directly and test the script's observable result.
