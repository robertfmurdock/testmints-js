# Test templates: design investigation

Status: exploratory. This document captures the model under investigation, not an implemented API
or a commitment to particular signatures.

## Motivation

The original Kotlin Testmints supports templates that prepare shared context, compose additional
preparation, and provide that context to individual tests. An important use case was authenticating
a WDIO runner once so a family of tests could exercise application behavior without repeatedly
paying for authentication or embedding distracting authentication semantics in every scenario.

Ordinary per-test setup helpers solve reuse, but do not amortize expensive preparation. The feature
being investigated here combines typed setup composition with a project-local configured `mint`
import, including lazy shared preparation within a worker/process.

## Current model

Shared preparation runs lazily once per template instance in each worker/process. The first
dependent test starts preparation. Other dependent tests await the same pending initialization or
reuse its completed result. A template that is never used does not initialize.

This is instance-local sharing, not a global registry keyed by template name. Creating a second
template instance creates a separate preparation lifetime. The exact relationship between runner
module loading and instance lifetime must be established through adapter experiments.

Each test attempt still has fresh scenario setup, exercise, verify, teardown, and attempt-owned
resource cleanup. Shared context enters scenario setup; the scenario explicitly chooses the input
that flows into exercise and verification. Scenario inputs, the subject action, and expectations
remain visible in the individual test.

Templates do not coordinate across workers or processes. Each worker/process initializes its own
instance. More workers can mean more repeated preparation and less optimization. A replacement
worker initializes again. There is no once-per-run guarantee.

## Concurrency belongs to the user

Sharing a pending initialization prevents duplicate preparation within one instance. It does not
serialize dependent tests or make the prepared value safe for concurrent access.

The template imposes no locking, pooling, cloning, isolation, or scheduling policy. Shared context
is ordinary user-owned data: it might contain an authenticated session, saved credentials, a pool,
or a user-provided synchronization helper. Users can combine ordinary helpers and runner scheduling
facilities to address their actual resource constraints.

## Authoring direction

The preferred shape is a typed template factory that produces a configured `mint`, exported from a
project-local support module. The following is illustrative syntax only; names, signatures, and
tool placement remain open.

```ts
// support/authenticated-mint.ts
import { createMint } from '@continuous-excellence/testmints-js/vitest'

export const mint = createMint({
  shared: async () => authenticateRunner(),
})
```

```ts
import { expect, test } from 'vitest'
import { mint } from './support/authenticated-mint.js'

test('a member can change their name', mint({
  setup: async (session) => ({
    profile: await session.openProfile(),
    displayName: 'Ada',
  }),
  exercise: ({ profile, displayName }) => profile.changeName(displayName),
  verify: (profile, { displayName }) =>
    expect(profile.name).toBe(displayName),
}))
```

The template supplies infrastructure context without absorbing the complete scenario. Registration
stays visible and definitions remain complete; there is no terminal execution call to forget.
Normal examples should infer shared context, scenario input, and async output without casts or
explicit generic arguments.

A local import also gives projects a conventional entry point for a kind of test. Import lint rules
can enforce that convention where desired. Runtime validation cannot detect a test that bypasses
the configured import entirely.

## Composition

Template extension should support a more specialized kind of test built on an existing one, such
as an authenticated template extended with administrative prerequisites. Additional preparation
receives typed parent context and explicitly produces the context exposed by the child.

The exact composition API is open. A fluent `.extend()` and ordinary factory composition are
candidates. Neither should require class inheritance or implicit object-property merging.

Before implementation, define whether sibling extensions share their original parent instance,
when each layer initializes, and how resource ownership unwinds. The desirable direction is to reuse
an existing parent's preparation, initialize parent before child, and release dependent resources
before their prerequisites. These details need executable examples before becoming guarantees.

## Runner-independent semantics

Vitest and Playwright should expose the same template behavior: lazy instance-local preparation,
shared context, per-attempt setup, extension, and failure handling. The core should own the shared
lifecycle model; adapters should connect it to runner execution and lifecycle facilities.

The adapters may require different authoring syntax. In particular, Playwright requires runner
fixtures to remain visibly destructured in its callback. A template must preserve that integration
without changing its sharing semantics or capturing attempt-owned fixtures for a longer lifetime.

Worker creation, module loading, retries, and worker replacement can change how often a runner
creates template instances. Document those physical boundaries consistently rather than promising
cross-worker sharing or inventing a separate suite-bound lifetime.

## Cleanup and failure questions

Existing attempt-owned resource semantics remain intact: acquisition and release stay paired,
resources survive verification, and cleanup failures are retained alongside the primary failure.
A shared resource must not be registered in an individual attempt's scope, which would release it
too early.

Shared cleanup is a lifecycle design question to resolve, not a capability to advertise yet. If
supported, it should release initialized resources when their owning worker/process lifetime ends
normally, after dependent work finishes. Adapter experiments must establish a reliable completion
boundary and how cleanup failures reach the runner. Abrupt worker termination can prevent cleanup;
there must be no stronger guarantee.

Other unresolved contracts include:

- Whether initialization rejection is cached for the instance or can be retried explicitly. The
  implementation must not accidentally start a new authentication attempt for every dependent test.
- How preparation failures are attributed to dependent tests and retained without changing the
  original error or producing misleading passes.
- Which timeout and cancellation rules govern shared preparation when the triggering attempt ends
  but other tests still depend on it.
- How shared preparation and cleanup appear in reporting without pretending each attempt performed
  the shared work or introducing misleading phase durations.
- What happens when shared initialization partially acquires resources and then fails.
- Whether explicit invalidation or refresh has a concrete use case. It is not part of the initial
  model merely because a session could expire.

## Scope and relationship to existing direction

The project philosophy favors ordinary functions, explicit ownership, and visible scenario behavior.
The initial TypeScript proposal deferred general template inheritance and recommended local helpers
and configured imports. This investigation revisits that deferral for a concrete gap: heavyweight
preparation reused across a family of tests within a worker/process.

It does not propose global mutable template configuration, cross-process coordination, automatic
resource scheduling, assertion integration, or arbitrary wrappers that control whether a scenario
executes. Existing runner hooks and ordinary helpers remain useful alongside templates.

## Evidence needed before implementation commitments

Prototype the smallest shared lifecycle and both adapters before settling the public signatures.
Use realistic tests and compiler fixtures to establish:

- One authentication operation serves multiple dependent tests in the same instance; unused
  templates perform no preparation.
- Concurrent dependents await one initialization, while their scenario actions remain unscheduled
  by the template.
- Separate instances and separate workers prepare independently.
- Scenario setup runs for each attempt, including retries when the instance survives; worker
  replacement creates a fresh instance.
- Shared context and extension infer correctly, while incompatible data flow fails compilation.
- Preparation failure cannot become a pass, and attempt cleanup retains its current guarantees.
- The same observable lifecycle examples hold for Vitest and Playwright, including replacement and
  shutdown boundaries. Any shared cleanup proposal must demonstrate failure reporting and ordering.

A small real-world authentication example should show the intended benefit: less repeated expensive
work and clearer individual scenarios, without claiming that worker-local reuse optimizes every
runner configuration.
