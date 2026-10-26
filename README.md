# Testmints

> **Status: incubating and experimental. Do not integrate Testmints into a project at this time.**
> Its API, behavior, artifact format, package availability, and release policy may change or be
> withdrawn without compatibility guarantees.

Testmints gives ordinary tests an explicit shape: **setup → exercise → verify → teardown**.
It owns phase sequencing and locally acquired resource cleanup, while your test runner and assertion
library remain yours.

This is an early implementation of `@continuous-excellence/testmints-js`. It supports a
runner-independent executor, Vitest registration, and an opt-in local phase stream. Cancellation
policy, task groups, browser reporting, and additional runners are intentionally not available yet.

The test suite is first-class usage documentation: each test should show a realistic scenario while
also proving the library behavior it relies on.

```ts
import { expect, test } from 'vitest'
import { mint } from '@continuous-excellence/testmints-js/vitest'

test('15 produces FizzBuzz', mint({
  setup: () => 15,
  exercise: (input) => fizzBuzz(input),
  verify: (output) => expect(output).toBe('FizzBuzz'),
}))
```

`mint` validates the complete definition when the test file is collected, while keeping Vitest's
`test` or `it` call visible to test explorers and source scanners. When an explicit callback is
clearer—for example, in a parameterized test—use `runMint(definition, context)` inside the Vitest
callback instead.

## Local phase artifacts with Vitest

Enable the Node/Vitest reporting plugin in `vitest.config.ts`. Existing `mint` callbacks need no
per-test configuration.

```ts
import { defineConfig } from 'vitest/config'
import { testmintsVitest } from '@continuous-excellence/testmints-js/vitest'

export default defineConfig({
  plugins: [testmintsVitest()],
})
```

Each Vitest process writes a run directory under `.testmints/` (or the supplied `outputDir`). Each
worker appends only to its own NDJSON file. The run manifest records whether reporting completed;
reporting problems are visible but never turn a test pass into a failure or prevent cleanup.

Inspect a completed run with the package command:

```sh
testmints inspect .testmints/run-…
```

```text
a member can save their display name — FAILED
  setup        41 ms  passed
  exercise    184 ms  passed
  verify        2 ms  failed — expected "Ada", received "Grace"
  teardown     18 ms  passed
```

The first reporter is deliberately Node/Vitest-only. It records Testmints phase boundaries and
does not inspect assertion libraries, capture arbitrary data, or promise cancellation beyond the
runner signal passed to active phases.

Resources acquired through `scope.using()` survive verification and are released in reverse order,
including after a failed setup, exercise, or verification.

```ts
test('a member can save their display name', mint({
  setup: async ({ scope }) => ({
    account: await scope.using('temporary account', createAccount, deleteAccount),
    displayName: 'Ada',
  }),
  exercise: ({ account, displayName }) => updateProfile(account.id, { displayName }),
  verify: (profile) => expect(profile.displayName).toBe('Ada'),
}))
```

## Development

`npm run check` runs formatting/lint checks, type fixtures, and the test suite. Every test is both
evidence for the library and an example of its intended use. Core-contract scenarios also use
visible Vitest registration with `mint`, exercising lower-level bootstrap primitives within that
same test shape.

Contributors should begin with [the project philosophy](docs/project-philosophy.md). The
[library direction log](docs/library-direction.md) captures longer-term design questions that are
not current commitments. Maintainers can follow the [publishing guide](docs/publishing.md) for the
one-time `0.0.0` bootstrap and the subsequent trunk-based release flow.
