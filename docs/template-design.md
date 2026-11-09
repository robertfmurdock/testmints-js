# Test templates

The initial slice is available through `createMint({ shared })` in the Vitest and Playwright
adapters. It covers reusable data such as credentials, saved browser state, or parsed fixtures.
The original Kotlin template use case was to avoid repeated authentication across related tests.
In JavaScript, a shared credential or saved authentication state lets each test use its own
runner-owned page or request client.

## Authoring

Export a configured mint from a project-local support module.

```ts
// support/authenticated-mint.ts
import { createMint } from '@continuous-excellence/testmints-js/vitest'
import { authenticate, openProfile } from './profile-api.js'

export const mint = createMint({
  shared: () => authenticate(),
})

export { openProfile }
```

```ts
import { expect, test } from 'vitest'
import { mint, openProfile } from './support/authenticated-mint.js'

test('a member can change their name', mint({
  setup: async ({ accessToken }) => ({
    profile: await openProfile(accessToken),
    displayName: 'Ada',
  }),
  exercise: async ({ profile, displayName }) => {
    await profile.changeName(displayName)
    return profile.readName()
  },
  verify: (name, { displayName }) => expect(name).toBe(displayName),
}))
```

In Playwright, create the configured mint with the Playwright adapter and return or await its
promise from the runner callback. Keep fixtures destructured there. For example, if
`mint` shares a token obtained by signing in once:

```ts
test('a member can read their profile', ({ request }) =>
  mint({
    setup: ({ accessToken }) => ({
      headers: { Authorization: `Bearer ${accessToken}` },
      profilePath: '/api/profile',
    }),
    exercise: ({ headers, profilePath }) => request.get(profilePath, { headers }),
    verify: (response) => expect(response.ok()).toBe(true),
  }),
)
```

Configured setup receives `(shared, tools)`. It chooses the attempt data that flows into the
remaining phases. Its tools and scoped resources belong to that attempt. Vitest validates each
definition when creating the test callback. Playwright validates when the callback invokes mint.
A project that requires a particular configured import can enforce it with an import lint rule.

## Lifetime and concurrency

Preparation starts when the first attempt reaches configured setup. Concurrent attempts await the
same pending promise. Later attempts use its settled result, including rejection. A second factory
call creates a separate instance. A template used only to construct callbacks does no preparation.

The sharing boundary is the configured mint instance in memory. Runner file isolation, separate
workers, and worker replacement can each lead to new module evaluation and fresh instances. An
attempt always has fresh scenario setup and cleanup. A retry reuses shared preparation when the
runner preserves the instance. In the Playwright integration suite a failed attempt causes worker
replacement, so the retry prepares again and the next test in that worker reuses its result.

Treat shared data as read-only where practical. Tests can run concurrently with the same object.
If it wraps mutable state, the user owns synchronization and isolation. Use per-attempt fixtures
and resources for state that belongs to one test.

## Failure, cancellation, and reporting

A synchronous throw or rejected promise from the initializer fails each dependent attempt in setup
with the original reason. Scenario setup and the remaining scenario callbacks are skipped.
There is no automatic initialization retry within an instance. Retrying a scenario in a fresh
worker can create a new instance.

The shared initializer takes no attempt tools. Keep runner callbacks, attempt fixtures, and attempt
signals out of it. An attempt can time out while waiting under its runner's normal timeout rules.
Testmints leaves the shared promise running, and checks the attempt's signal before starting the
wait and after a successful wait. Where the runner exposes an abort signal, an aborted attempt
will skip scenario setup when the promise fulfills. Supply a deadline inside the initializer if
the shared operation itself needs one. Worker termination can interrupt pending work.

Setup reporting measures the attempt's elapsed setup time, including its wait for shared data.
It does not report a separate preparation event or attribute that wait to repeated sign-ins.

## Template lifecycle extensions

Kotlin Testmints has two lifetimes. Its `beforeAll` overload prepares a lazy cached value. Its
`sharedSetup` and `sharedTeardown` pair runs around each test and retains both the test and
template teardown failures. JavaScript's `shared` corresponds to the first lifetime. Per-attempt
hooks and disposal of cached resources need separate ownership.

The initializer has no Testmints resource scope. Use shared values that need no disposal, or values
whose lifetime is already managed externally. The initializer owns rollback of any partially
acquired resources if it throws. Use the attempt scope for scenario-owned resources and the
runner's own lifecycle facilities for resources those facilities own.

### Per-attempt before and after

An opt-in pair on the factory options can run a template's before hook after shared preparation
and before scenario setup. It receives the cached value and attempt tools and can return a new
attempt context. Scenario setup receives that context as its first argument. Without the pair,
setup continues to receive the cached value directly. For example, a before hook could open a
temporary workspace using shared credentials, and an after hook could collect diagnostics while
that workspace is still open.

Register the after hook in the attempt's existing cleanup stack when the before hook succeeds.
Scenario teardown and scenario resource releases then run first, followed by template after and
the resources acquired by template before. If before fails partway through, release the resources
it already registered. If scenario setup fails, the registered template after still runs.
Retain hook and release failures alongside the primary failure. The executor continues to own
phase execution, including on retries. The hooks can run inside the existing setup and teardown
reporting boundaries.

### Disposal of cached resources

An opt-in managed template can give `shared` a template-owned scope with the same acquisition and
release interface as the attempt scope. Existing zero-argument initializers still fit that
callback shape. Require a lifecycle owner when exposing the shared scope so there is a place to
register and await disposal. Roll back partial shared initialization immediately on rejection
and cache the original failure together with any rollback failures.

The owner must cover all attempts using the instance. For example, a file-local instance can
use a Vitest suite's `afterAll` when that suite owns every dependent test. A Playwright worker
fixture can create the instance and await its disposal after yielding it to tests. A module import
by itself supplies no such boundary. Before choosing the public API, prove these paths with a
real suite and a worker fixture, including a disposal failure reaching each runner.

Disposal closes the instance to new attempts, waits for in-flight preparation and attempts to
finish, and releases initialized resources once in reverse order. An unused instance can close
without starting preparation. The owner awaits disposal so failures surface through its runner
boundary. Abrupt worker termination can prevent cleanup.

The current core factory already owns the lazy promise independently of either adapter. For
disposal, that private state can also track attempts from before they wait for preparation
through the end of their cleanup, including template after. The runner adapter supplies the
completion boundary. Existing definitions, setup's two argument positions, and each runner's
registration syntax can stay as they are.

### Composition

A future composition API could build an administrative template from an authenticated one. The
working direction is for siblings derived from the same parent instance to reuse its preparation,
initialize each child lazily after its parent succeeds, and explicitly produce the child's context
from the parent's. Per-attempt hooks would enter parent first and unwind child first. A child
borrows the parent's cached value, so disposing that child releases its own resources while the
parent's owner keeps the parent alive for siblings and direct consumers. When one owner closes
the whole tree, it disposes children before their prerequisites. Extension and refresh remain
open until executable examples establish their ownership and failure behavior.
