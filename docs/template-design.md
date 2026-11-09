# Test templates

The initial slice is available through `createMint({ shared })` in the Vitest and Playwright
adapters. It covers reusable data such as credentials, saved browser state, or parsed fixtures.
The original Kotlin template use case was to avoid repeated authentication across related tests.
In JavaScript, a shared credential or saved authentication state lets each test use its own
runner-owned page or request client.

## Authoring

Use `<purpose>Mint` for configured functions returned by `createMint`. Names such as
`authenticatedMint`, `profileEditorMint`, and `workspaceMint` tell readers what context the
template supplies. When a test file uses several templates, names like `memberMint` and
`adminMint` make the choice visible at each call.

A project-local support module can export a single configured function as `mint` when its path
already names the purpose, as in `./support/authenticated-mint.js`.

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

Configured setup receives `(context, tools)`. The context comes from `shared` by default or from
the template's per-attempt `before` hook when configured. Setup chooses the data that flows into the
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

## Template lifecycle

Kotlin Testmints has two lifetimes. Its `beforeAll` overload prepares a lazy cached value. Its
`sharedSetup` and `sharedTeardown` pair runs around each test and retains both the test and
template teardown failures. JavaScript's `shared` corresponds to the first lifetime. Per-attempt
hooks and disposal of cached resources need separate ownership.

An ordinary shared initializer can return data or resources whose lifetime is managed externally.
Use a disposal registrar when the template should own the shared resources. The attempt scope
continues to own scenario resources.

### Per-attempt before and after

`attempt.before` turns shared data into context for scenario setup and the optional
`attempt.after`. Use the attempt scope for resources and `after` for work such as collecting
diagnostics before those resources close.

```ts
const workspaceMint = createMint({
  shared: () => authenticate(),
  attempt: {
    before: ({ accessToken }, { scope }) =>
      scope.using('workspace', () => openWorkspace(accessToken), workspace => workspace.close()),
    after: workspace => workspace.uploadDiagnostics(),
  },
})
```

Hooks run in setup and teardown on each attempt, including retries. When `before` succeeds,
`after` runs after scenario cleanup and before resources from `before` are released. Resources
already registered by a failing `before` still close. Cleanup failures are retained alongside
the primary failure.

### Disposal of cached resources

Pass a disposal registrar as the second argument to `createMint` to give shared preparation a
template-owned resource scope. Use `scope.using()` to pair acquisition with release. The registrar
receives one async disposal callback when the mint is created. In Vitest, a suite can pass
`afterAll` directly when it owns every test that uses the mint.

```ts
import { afterAll } from 'vitest'
import { createMint } from '@continuous-excellence/testmints-js/vitest'

const profileServiceMint = createMint({
  shared: ({ scope }) =>
    scope.using('profile service', startProfileService, service => service.close()),
}, afterAll)
```

For Playwright, create the mint in a worker fixture. Capture the registered callback and await it
in the fixture's `finally` block after `await use(configuredMint)`. Both runners report disposal
failures through their native teardown. A module import supplies no runner lifecycle boundary.

Disposal rejects new attempts, lets admitted attempts finish preparation and cleanup, and releases
shared resources once in reverse acquisition order. Closing an unused mint leaves preparation
lazy. A failed initializer rolls back partial acquisitions immediately and caches the failure,
including any rollback failures. Abrupt worker termination can prevent cleanup. Call or register
disposal from the owner outside the mint's own attempts because disposal waits for those attempts.

### Composition

Use `extend({ attempt })` to add per-attempt behavior. The child inherits shared preparation and
its `before` receives the parent's attempt context.

```ts
const workspaceReportMint = workspaceMint.extend({
  attempt: { before: workspace => ({ workspace, reportPath: 'summary.json' }) },
})
```

Use `extend({ shared })` to derive new shared data from the parent's. A managed child receives
its own shared scope.

```ts
const adminMint = profileServiceMint.extend({
  shared: (service, { scope }) =>
    scope.using('admin client', () => service.openAdminClient(), client => client.close()),
})
```

When a child defines both `shared` and `attempt`, its `before` receives the child shared value,
setup tools, and the parent attempt context. Hooks enter parent first and unwind child first.
Disposal closes descendants before their parent. Calling `adminMint.dispose()` closes that subtree.
