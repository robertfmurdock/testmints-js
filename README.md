# Testmints

Testmints gives ordinary tests an explicit shape: **setup → exercise → verify → teardown**.
It owns phase sequencing and locally acquired resource cleanup, while your test runner and assertion
library remain yours.

This is an early, private implementation of `@continuous-excellence/testmints`. The first slice
supports a runner-independent executor and Vitest registration; reporting artifacts, cancellation
integration, task groups, and additional runners are intentionally not available yet.

The test suite is first-class usage documentation: each test should show a realistic scenario while
also proving the library behavior it relies on.

```ts
import { expect } from 'vitest'
import { mintTest } from '@continuous-excellence/testmints/vitest'

mintTest('15 produces FizzBuzz', {
  setup: () => 15,
  exercise: (input) => fizzBuzz(input),
  verify: (output) => expect(output).toBe('FizzBuzz'),
})
```

Resources acquired through `scope.using()` survive verification and are released in reverse order,
including after a failed setup, exercise, or verification.

```ts
mintTest('a member can save their display name', {
  setup: async ({ scope }) => ({
    account: await scope.using('temporary account', createAccount, deleteAccount),
    displayName: 'Ada',
  }),
  exercise: ({ account, displayName }) => updateProfile(account.id, { displayName }),
  verify: (profile) => expect(profile.displayName).toBe('Ada'),
})
```

## Development

`npm run check` runs formatting/lint checks, type fixtures, and the test suite. Every test is both
evidence for the library and an example of its intended use. Core-contract scenarios also use
`mintTest`, exercising lower-level bootstrap primitives within that same test shape.

Contributors should begin with [the project philosophy](docs/project-philosophy.md).
