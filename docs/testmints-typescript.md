# Testmints for JavaScript and TypeScript: Readable Tests, Observable Execution

## Core Idea

A small library that gives ordinary tests an explicit shape: **Setup → Exercise → Verify → Teardown**. That shape makes the intent easier to read, makes important omissions harder to overlook, and produces a live stream describing what the test actually did.

The author writes ordinary functions, calls the feature directly, and keeps their existing assertions and test runner. Testmints supplies the phase contract, manages the async lifecycle, and emits structured events. **Bring your own test runner (BYOTR) and bring your own assertion library (BYOAL) are architectural requirements.** Vitest is the first runner integration, not the definition of what an assertion or a test must look like.

In practice, that means expected rejections can be checked beside other assertions, resources stay alive through verification, and shared infrastructure can clean up even when setup only partly succeeds.

The central design constraint is **“it is difficult to miss a step by accident.”** Catch structural omissions early, keep owned resources alive for the attempt, and make async ownership explicit.

The initial product is a library and local NDJSON stream, with a useful terminal inspector. No service is required to write, run, or understand a test. Reporting systems can consume the events later.

## Architectural Commitments and Design Proposals

This document is a foundation for implementation, not a frozen API specification. Commit to the following boundaries:

- The core owns complete phase definitions, explicit data flow, awaited execution, cleanup sequencing, and phase lifecycle events.
- Runner adapters own registration and translation to runner lifecycle facilities. Assertions remain ordinary user code and require no Testmints adapter, observer, registration, or counter.
- The executor propagates failures to its caller. Instrumentation cannot turn failure into success, replace an original error, or prevent cleanup.
- Events are independent of any runner, storage system, or viewer. A sink consumes events without becoming the authority on test behavior.
- Phase data, resources, and execution identity are local to one attempt. There is no mutable global “current test.”
- JavaScript gets runtime definition validation; TypeScript adds useful static checks. Neither is promised semantic proof of a test or universal control of detached async work.

The examples pitch a complete-definition API because it removes an accidental non-execution path. Exact names, overloads, package layout, task helpers, event fields, and adapter configuration should be shaped by working prototypes. Changes to those details are expected; changes to the boundaries above require an explicit architectural decision.

An expansion earns its place only when representative tests show a substantial improvement in clarity, omission prevention, async execution, or phase observability. Prefer existing language and runner facilities. Keep a capability outside Testmints when achieving it would require knowledge of assertion internals, application semantics, or a new scheduling/reporting platform. A basic test should require understanding only functions and the test phases.

## Philosophical Foundation

The proposal draws from these repository sources:

- [The Quality of a Test](../Essays/TheQualityOfTest.md): correctness, accurate communication, self-containment, realistic usage, brevity, and one scenario—in that order. Readability wins over aggressive DRY. A test should demonstrably fail when its intended property is broken.
- [The Flavor of Mint](../Essays/TheFlavorOfMint.md): four-phase structure, explicit inputs and outputs, ordinary reusable functions, and phase-level timing and failure reporting. Structure should improve readability without burying the test in ceremony.
- [Testmints Retro](../Essays/TestmintsRetro.md): local setup and simple data comparisons worked well; expectations belong near verification; complex diff presentation and accidentally bypassed templates need improvement. Async support was heavily used. Reporting was underused, and the larger aspiration became a live structured testing stream.
- [The Test Ascent](../Essays/TheTestAscent.md): a junior developer should need little more than basic functions to write a valuable test. The same principles apply from unit tests to system tests. Cost of entry, cost of exit, and a team's ability to maintain its tests matter more than allegiance to a framework.
- [Kotlin Retro](../Essays/KotlinRetro.md) and [its notes](../KotlinRetroNotes.md): portability, async support, and lifecycle integration were meaningful parts of the original project. Preserve their purpose rather than translate Kotlin receiver syntax literally.

These principles put limits on the tool itself. It can enforce a complete test structure, but it cannot prove that a test communicates well or checks the right property. “One scenario” is a design nudge, not an arbitrary one-assertion restriction. A long setup can be useful architectural feedback; automatically hiding it in a fixture would suppress that feedback.

## What Writing a Test Looks Like

The Vitest adapter below is implemented in the current package. Example application functions stand
in for the user's real code.

### The smallest useful test

```ts
import { expect, test } from 'vitest'
import { mint } from '@testmints/vitest'

test('15 produces FizzBuzz', mint({
  setup: () => 15,
  exercise: input => fizzBuzz(input),
  verify: output => {
    expect(output).toBe('FizzBuzz')
  },
}))
```

There is no `.run()` to forget. Vitest visibly registers the test while `mint` synchronously
validates the complete definition and supplies its awaited runner callback. Each execution,
including a retry, calls setup afresh.

For the occasional test that benefits from an explicit callback, use
`test(name, context => runMint(definition, context))`. The callback factory remains the normal
form; it keeps validation at collection time and the scenario definition visually compact.

The exercise visibly uses the feature. Expected output appears in verification, not among inputs. The example is also valid JavaScript after changing the file extension; TypeScript users get inferred input and result types.

The assertion import is independent of the runner. This is equally valid with the same Vitest adapter:

```ts
import assert from 'node:assert/strict'

test('15 produces FizzBuzz', mint({
  setup: () => 15,
  exercise: input => fizzBuzz(input),
  verify: output => assert.equal(output, 'FizzBuzz'),
}))
```

No assertion integration is required. A hand-written check that throws on mismatch also works.

### Expected failure is an ordinary exercise result

Use a local helper when rejection is the behavior under test:

```ts
type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

async function captureOutcome<T>(
  action: () => T | PromiseLike<T>,
): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    return { ok: false, error }
  }
}

test('an expired token is rejected', mint({
  setup: () => ({ token: 'expired-token' }),
  exercise: ({ token }) => captureOutcome(() => authenticate(token)),
  verify: outcome => {
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('Expected authentication to fail')
    expect(outcome.error).toBeInstanceOf(TokenExpiredError)
  },
}))
```

The thunk lets the same helper capture a synchronous throw or a promise rejection; success carries the returned value. Assertions stay in verification, and an unexpected success fails there. This is ordinary user code, with no assertion-library integration. Only the wrapped operation becomes data: an uncaptured exercise throw or rejection still skips verification and triggers cleanup. Capturing an outcome does not own detached work.

### Async resources, with cleanup paired with acquisition

```ts
test('a member can save their display name', mint({
  setup: async ({ scope, signal }) => {
    const account = await scope.using(
      'temporary account',
      () => createTestAccount({ signal }),
      (account, { signal }) => deleteTestAccount(account.id, { signal }),
    )
    return { account, displayName: 'Ada' }
  },

  exercise: ({ account, displayName }, { signal }) =>
    updateProfile(account.id, { displayName }, { signal }),

  verify: profile => {
    expect(profile.displayName).toBe('Ada')
  },
}))
```

The release function is mandatory when using `scope.using`. Registering it is part of acquiring the resource, not a separate statement the author must remember. The account survives through verification and is deleted afterward, including on assertion failure. If a later setup operation fails, already acquired resources are still released.

Exercise returns its promise directly. An `async` callback with `await` is equally valid; separate “sync” and “async” libraries add no value here.

### Resources created by exercise live through verification

```ts
test('an exported report contains the member name', mint({
  setup: () => ({ memberName: 'Ada' }),
  exercise: ({ memberName }, { scope, signal }) => scope.using(
    'exported report',
    () => exportReport({ memberName }, { signal }),
    (report, { signal }) => report.remove({ signal }),
  ),
  verify: async report => {
    expect(await report.readText()).toContain('Ada')
  },
}))
```

Exercise receives the same attempt scope as setup. The report remains readable throughout verification; `remove` runs afterward even if the assertion fails. A deliberately broken export should demonstrate both the native assertion failure and the subsequent release. Returning the resource from exercise alone would not register cleanup.

### Two scenarios sharing infrastructure

```ts
function withTestDatabase(scope: ResourceScope, signal: AbortSignal) {
  return scope.using(
    'test database',
    () => createTestDatabase({ signal }),
    (database, { signal }) => database.drop({ signal }),
  )
}

test('a saved member can be found', mint({
  setup: async ({ scope, signal }) => ({
    database: await withTestDatabase(scope, signal),
    member: { id: 'ada', name: 'Ada' },
  }),
  exercise: async ({ database, member }) => {
    await database.save(member)
    return database.find(member.id)
  },
  verify: member => expect(member).toEqual({ id: 'ada', name: 'Ada' }),
}))

test('an unknown member is absent', mint({
  setup: async ({ scope, signal }) => ({
    database: await withTestDatabase(scope, signal),
    missingId: 'unknown-member',
  }),
  exercise: ({ database, missingId }) => database.find(missingId),
  verify: member => expect(member).toBeNull(),
}))
```

Each attempt gets its own database and cleanup registration; scenario inputs stay in each test. The helper accepts ownership explicitly instead of hiding it in a global fixture. Suite-wide fixtures remain runner-owned: use runner facilities for their creation and disposal, and do not register a shared suite resource for release after each attempt.

### Explicit teardown and side-effect verification

```ts
test('sending a welcome email uses the member address', mint({
  setup: () => ({
    member: { email: 'ada@example.test' },
    mailer: createRecordingMailer(),
  }),
  exercise: ({ member, mailer }) => sendWelcome(member, mailer),
  verify: (_result, { mailer }) => {
    expect(mailer.messages).toEqual([
      { to: 'ada@example.test', subject: 'Welcome' },
    ])
  },
  teardown: ({ mailer }) => mailer.close(),
}))
```

Exercise may legitimately return `undefined`; verification can inspect the setup context for observable side effects. Do not ban command-style APIs to make the generic signatures look tidier. Explicit teardown is supported, but for acquired resources the acquisition/release pairing above is the recommended default.

## Key Design Decisions and Reasoning

### A complete definition, with execution owned by the adapter

Prefer the object of phase functions over a fluent execution builder. A builder can encode phase ordering beautifully in TypeScript while allowing a perfectly legal unused intermediate expression in JavaScript. Garbage collection is not a reliable way to detect that forgotten final call.

Require callable `setup`, `exercise`, and `verify` properties. An input-free test can use `setup: () => undefined`. Teardown is optional: pure tests have nothing to clean up. Managed cleanup still occupies the teardown lifecycle, and the event stream records an empty teardown when there is no work.

Validate the definition during registration, before any phase executes. Reject missing required functions, unknown keys such as `verfiy`, and non-function values. Copy validated callback references into an internal immutable definition so later mutation cannot change a registered test. Keep runner options separate from phase keys.

TypeScript catches missing properties and incompatible phase data. Runtime validation protects JavaScript users, untyped imports, and values that bypass static checks. Do not claim parity where the language cannot provide it: duplicate object keys have already collapsed by runtime, and runtime cannot infer an author's intended input type. Duplicate keys belong to compiler/linter checks; an object spread overriding `verify` requires review or an optional lint rule.

### The type model should explain the data flow

Conceptually:

```ts
type Awaitable<T> = T | PromiseLike<T>

// Signal and event-helper details are omitted from this scope sketch.
interface SetupTools extends PhaseTools { scope: ResourceScope }
interface ExerciseTools extends PhaseTools { scope: ResourceScope }
interface ResourceScope {
  using<T>(
    name: string,
    acquire: () => Awaitable<T>,
    release: (resource: T, tools: CleanupTools) => Awaitable<unknown>,
  ): Promise<T>
  defer(name: string, release: (tools: CleanupTools) => Awaitable<unknown>): void
}

interface TestmintDefinition<Input, Output> {
  setup: (tools: SetupTools) => Awaitable<Input>
  exercise: (input: Input, tools: ExerciseTools) => Awaitable<Output>
  verify: (
    output: Output,
    input: Input,
    tools: PhaseTools,
  ) => Awaitable<unknown>
  teardown?: (input: Input, tools: CleanupTools) => Awaitable<unknown>
}
```

`SetupTools` and `ExerciseTools` both extend `PhaseTools` with `scope: ResourceScope`, referring to the same attempt-owned scope. `PhaseTools` provides a signal and explicit event helpers; verification receives these tools without acquisition access. `CleanupTools` provides the cleanup signal and event helpers. Tools never merge into the user's data object, avoiding collisions with application properties such as `signal`.

This is the public contract sketch. Prototype inference with real compiler tests before publishing signatures: anonymous setup objects, async return values, named helpers, and `undefined` outputs must work without `any`, casts, or manual generic arguments in basic examples. Verify and teardown results are awaited but otherwise ignored; `unknown` accommodates assertion libraries that return chain objects or values on success.

### Assertions are user code: BYOAL without integration

The contract is the ordinary throw/reject convention: verification fails if its callback throws or its returned promise rejects. Testmints invokes and awaits it, preserving the failure. Successful return values have no pass/fail meaning. Predicate-style libraries can be used inside a throwing check, just as they would in an ordinary runner test.

Do not count assertions, inspect matcher state, reject successful assertion return values, or require an assertion observer. Those mechanisms would make the library know which assertions users are allowed to write. Existing runner features such as assertion counts or soft-assertion finalization remain the user's choice and the runner's responsibility.

This leaves a deliberate boundary: `verify: () => {}` and `verify: result => result === expected` can complete successfully without establishing anything. Required verification prevents an omitted phase; it cannot prevent meaningless verification. Examples must show actual assertions, and review/test-driving must establish that the test fails when its property is broken. An optional lint recipe can flag obvious mistakes, but it is not a runtime promise or a prerequisite for BYOAL.

Preserve native assertion errors and their actual/expected fields, stack traces, and IDE diffs. The original retrospective already identifies poor comparison output as a failure: replacing a mature runner's diff with JSON would repeat it. Multiple assertions remain valid when they describe one scenario.

Runner-level failures may be reported after the verify callback returns—for example, a runner can finalize soft assertions later. Keep phase completion and the runner's final test outcome distinct in the event stream. Do not inspect the assertion library to manufacture an earlier verdict.

### Cleanup is local and cannot depend on reaching the end of setup

`scope.using(name, acquire, release)` records release immediately after acquisition fulfills, before handing the resource back. The scope tracks acquisitions it starts, so even a mistakenly unawaited `using` call cannot escape ownership. Closing a scope waits for its tracked acquisitions to settle and releases acquired resources in reverse acquisition-completion order. Reject new acquisitions once closing begins.

If acquisition allocates something and then rejects without returning it, the acquisition function still owns that partial allocation. No library can release a resource it never received. Helpers should acquire one owned resource at a time or unwind their own partial state.

The scope stays open across setup, exercise, and verification; resources acquired in either setup or exercise have the same attempt lifetime. Normal execution is setup, exercise, verify, optional explicit teardown, then managed releases. Explicit teardown receives input only when setup completed successfully. Managed releases run even after partial setup failure and still run when explicit teardown throws. Each registered release is invoked at most once per attempt; repeat calls to the internal finalizer do not repeat releases.

Retain `scope.defer(name, release)` for cleanup that is not naturally expressed as acquisition. It registers synchronously. Document why pairing acquisition with release is safer than writing the two actions at separate points.

Resource ownership is justified here because teardown is a core phase and partial setup is a concrete hole in an end-only cleanup API. The `scope.using` spelling and registration API remain proposals. Accommodate standard `Symbol.dispose`/`Symbol.asyncDispose` resources where supported; prototype whether a standard disposal stack can implement the required lifetime before creating a custom equivalent. A lexical `await using` inside setup alone disposes at the end of setup, too early for exercise and verify. The needed lifetime is the entire attempt. See [TypeScript resource management](https://www.typescriptlang.org/docs/handbook/variable-declarations.html#await-using-declarations).

### Reuse without invisible test semantics

The database examples above are the primary reuse model: ordinary builders and helper functions. Omit a general template inheritance system from v1.

For teams that require a configured test harness, expose one project-local `mint` import and provide an ESLint import restriction recipe for the relevant test directories. This addresses the retrospective's “forgot the mandatory template” problem at the project boundary. Runtime validation cannot discover that somebody registered an ordinary runner callback instead, so do not pretend it can.

## Safe Async Support

### What the executor can guarantee

Every returned value is awaited, including thenables, verification, and release callbacks. A phase starts only after the previous phase and its owned work have settled. Use the outcome helper above when failure is expected; uncaptured rejection remains an exercise failure.

Failure in setup skips exercise and verify. Failure in exercise skips verify. Cleanup follows both paths. Keep the original error object when there is one failure; use `AggregateError` when multiple failures occur, retaining the primary failure first and cleanup errors in execution order. Cleanup failure by itself fails the test.

Do not add a callback-style `done` API. Having both callback completion and promise completion creates two competing meanings of “finished.”

### Awaiting the callback does not catch every forgotten promise

This remains incorrect:

```ts
verify: async profile => {
  checkPersistedProfile(profile) // missing await or return
}
```

The outer callback finishes before its detached work. JavaScript has no general portable facility that lets a wrapper discover every promise created inside arbitrary code and establish which work belongs to the test. Unhandled-rejection reporting helps, but a promise may succeed late or have its rejection swallowed.

Ship a recommended typed lint configuration using [no-floating-promises](https://typescript-eslint.io/rules/no-floating-promises/) and [no-misused-promises](https://typescript-eslint.io/rules/no-misused-promises/), with `ignoreVoid: false` for test files. Offer checked-JavaScript setup instructions where type information is available. Linting complements runtime behavior; runtime cannot recover missing information from plain untyped JavaScript.

For deliberately concurrent work, evaluate a small phase-owned `tasks.all` helper in the async spike. It is a candidate extension, not a required v1 API:

```ts
exercise: ({ service }, { tasks }) => tasks.all([
  ({ signal }) => service.read('first', { signal }),
  ({ signal }) => service.read('second', { signal }),
])
```

If included, its ownership contract must be precise: each submitted callback belongs to the current phase, results preserve submission order, and the phase joins every submitted task before completion—even if the helper's returned promise was dropped. Child failure requests sibling cancellation, and all children settle before resource cleanup. The prototype must also settle how callers intentionally handle a child failure, so an observed rejection does not unexpectedly become a second failure at phase exit. This addresses the cleanup race that can follow `Promise.all` rejecting while siblings are still running. Compare its benefit with ordinary awaited functions and explicit settling of concurrent promises before committing to a task API. Sequential code needs no task abstraction.

Also evaluate work launched *inside the feature* through a dependency injected during setup. The feature may return before that work finishes:

```ts
// Optional prototype only: exerciseTasks and launch are provisional names.
test('saving a member updates the search index', mint({
  setup: ({ exerciseTasks }) => {
    const index = createRecordingIndex()
    const service = createMemberService({
      index,
      launch: work => exerciseTasks.launch(work),
    })
    return { service, index, member: { id: 'ada', name: 'Ada' } }
  },
  exercise: ({ service, member }) => service.save(member),
  verify: (_result, { index }) => {
    expect(index.entries).toEqual([{ id: 'ada', name: 'Ada' }])
  },
}))
```

In this spike, `service.save` uses the injected launcher to submit its index update. Setup receives a capability bound explicitly to the upcoming exercise, without a mutable global current phase. The proposed `SetupTools` extension is optional and absent from the baseline type sketch. Define when submission opens and closes: constructing the dependency during setup is allowed, launching exercise work during setup or after exercise closes is rejected. Work submitted while exercise is active remains owned even when the feature returns no task handle. Verification and the exercise-end event wait for all owned work. On callback or child failure, request cancellation, settle all owned children, skip verification, then clean up. Test submissions from running children and intentional rejection handling before choosing exact task APIs. Arbitrary work launched through other dependencies remains outside this guarantee.

Long-lived background services should be represented as resources with explicit shutdown-and-join release functions. They are not detached promises that the test hopes will stop on their own.

### Cancellation and timeouts require honest boundaries

An `AbortSignal` requests cancellation; it cannot kill arbitrary promises or synchronous code. A timeout implemented as `Promise.race` does not stop the losing work. Immediately cleaning up its resources can create a second bug while obscuring the first.

Adapters translate supported runner cancellation into the execution signal. On cancellation, stop starting ordinary phases, request owned work to stop, and settle it before cleanup. Give cleanup a separate signal and a bounded cleanup budget; reusing the already-aborted execution signal would cause abort-aware deletion or close operations to reject immediately.

The runner owns the hard execution boundary. Adapter configuration must account for execution and cleanup allowances within that boundary. If work ignores cancellation or the runner kills its worker, in-process cleanup cannot be guaranteed. Record the attempt as interrupted/incomplete where the parent reporter can do so; never fabricate successful teardown. Do not claim every runner exposes identical cancellation or cleanup hooks.

The first adapter must demonstrate cooperative cancellation and runner hard-timeout behavior in integration tests before this becomes a shipping guarantee. An adapter without appropriate hooks documents its limitation. External resources that must survive process crashes safely still need their own expiry or isolation strategy.

## Core Architecture: Bring Your Own Test Runner

Use TypeScript with published JavaScript and declaration files. Keep the core independent of Node filesystem APIs and runner packages; initially validate Node execution, and treat browser execution as a separate adapter target. Choose the supported Node LTS baseline when implementation starts rather than carrying forward an aging version number from this idea document.

The logical boundaries are:

| Component | Responsibility |
|---|---|
| Core | Definition validation, phase sequencing, awaited callbacks, resource lifetime, failure preservation |
| Event contract | Versioned events and JSON Schema; no runner-specific task objects |
| Runner adapter | Registration, fixture access, identity, retries, supported cancellation, final runner outcome |
| NDJSON sink and inspector | Live local artifacts, validation, readable phase summaries |

These can begin as package exports rather than four separately released packages. Package names in examples are provisional.

The runner retains discovery, filtering, watch mode, worker scheduling, retries, coverage, and native reporting. Testmints must preserve test titles, source locations, and IDE navigation. Retry attempts get fresh scopes and distinct event identities; Testmints does not introduce automatic phase retries that might hide failures or repeat side effects.

The adapter SDK exposes `validateDefinition`, an awaited `executeDefinition`, and event/context contracts. Its registration callback returns execution to the runner directly:

```ts
// Adapter-author sketch, not the ordinary test-author API.
function registerMint(name, definition) {
  const validated = validateDefinition(definition)
  runner.register(name, runnerContext =>
    executeDefinition(validated, adaptContext(runnerContext)),
  )
}
```

Execution throws failures back to the runner; it does not return a failure record that an adapter can accidentally ignore. A conformance suite checks adapter lifecycle and declared capabilities. Importing an adapter and adding one reporter configuration should enable the local stream; if reporting is configured but its connection fails, disclose that failure instead of silently producing partial telemetry.

Vitest is first because general JavaScript/TypeScript unit and integration tests are the immediate target. Core phase events originate in the test execution context; runner reporters supply discovery and final outcomes. A reporter alone cannot infer where a user's exercise begins. Avoid depending on private task internals when public registration/reporting hooks suffice. Pin and test the adapter's supported runner range.

## Structured Testing: An Event Stream You Can Use

### Semantics before storage

Emit run/test lifecycle, phase start/end, explicit diagnostics, attachment references, and errors as they occur. Label errors by phase. Existing runner error metadata may be carried through as optional data without an assertion-specific dependency. An error in verify is not automatically an assertion failure: the verification code itself might have crashed.

Separate stable-within-source test identity from run ID, worker ID, and attempt ID. Include source location and title, a per-producer sequence number, phase/span IDs, timestamps, and monotonic durations. A renamed or moved test is not promised permanent historical identity. Cross-worker wall clocks do not establish causality; merging streams preserves producer order without inventing a total execution order.

```json
{"v":1,"kind":"phase.start","runId":"r1","testId":"profile-save","attemptId":"a1","workerId":"w1","seq":12,"phase":"exercise","spanId":"s3","timestamp":"2026-09-05T14:00:00.000Z"}
{"v":1,"kind":"phase.end","runId":"r1","testId":"profile-save","attemptId":"a1","workerId":"w1","seq":13,"phase":"exercise","spanId":"s3","timestamp":"2026-09-05T14:00:00.184Z","status":"passed","durationMs":184}
```

The JSON illustrates the required information, not a frozen version-1 wire schema or a claimed industry standard. Commit to correlated phase boundaries, attempt identity, ordering within a producer, durations, error provenance, and honest incomplete outcomes. Decide field names, schema representation, and compatibility rules after an end-to-end prototype and comparison with Cucumber Messages, before publishing the protocol. Include skipped phases with reasons; distinguish runner skip, retry, expected failure, cancellation, and incomplete execution. A parent reporter can report worker termination without pretending that worker emitted its missing phase-end event.

The retrospective's “every event” aspiration becomes an extensible explicit event API and runner hooks. Arbitrary console output, HTTP calls, and third-party assertions are not automatically observable or reliably attributable. Prefer explicit context for attribution; Node-specific ambient context can be an optional bridge rather than a core dependency.

### Local artifacts first

Local NDJSON is the first delivery format. The initial implementation direction is a separate file per producer/worker instance, with parent-run metadata sufficient to associate the files. Worker restarts need distinct producer identities. Append incrementally so developers can tail progress and inspect the last completed phase after a crash. Keep attachments in adjacent artifact files, referenced by events rather than embedded as large base64 strings. Exact file layout, manifest shape, and merge commands belong to implementation; concurrent writers must never corrupt each other's records.

Require bounded buffering and normal-shutdown flushing; choose queue sizes and backpressure behavior through measurement. A configured sink failure must be visible and mark reporting incomplete; it must not suppress the original test failure or prevent cleanup. Whether required-artifact failure also fails CI is a reporting configuration decision to settle with the first adapter, separate from test correctness. A process kill can truncate the last line: the inspector reports the incomplete tail and retains preceding valid events.

No implicit network exporter or input/output dumps. Explicit diagnostics and attachment helpers support redaction before writing. Errors and stacks may themselves contain sensitive values and must pass through the same configured redaction boundary. Telemetry should not require serializing arbitrary setup objects, which may contain functions, cycles, clients, or credentials.

### Make the reporting valuable on day one

The first inspector should answer: which phase failed, which phases never ran, whether cleanup succeeded, and where time went. Show setup/exercise/verify/teardown durations separately and retain native runner diffs. Include an example terminal output in the implementation README:

```text
a member can save their display name — FAILED
  setup       41 ms   passed
  exercise   184 ms   passed
  verify       2 ms   failed — expected "Ada", received "Grace"
  teardown    18 ms   passed — temporary account released
```

Historical analysis can consume saved CI artifacts. A Trust Dashboard integration, if useful later, should read those authoritative artifacts and link to the run. This proposal does not make the dashboard maintain a second history of test observations.

## Existing Tools and What to Borrow

Research checked September 5, 2026. These are overlapping capabilities, not evidence that no alternative could satisfy a team's needs.

| Tool | Existing capability | Consequence for this proposal |
|---|---|---|
| [Vitest](https://vitest.dev/api/test) and [reporters](https://vitest.dev/api/advanced/reporters) | Promise-aware tests, fixtures, runner lifecycle and custom reporting | Use as the first host; preserve its assertions and runner features. Add explicit phase semantics and portable events. |
| [Playwright reporters](https://playwright.dev/docs/api/class-reporter) and [TestInfo](https://playwright.dev/docs/api/class-testinfo) | Live step callbacks, per-attempt results, output, attachments | The closest low-effort option for browser tests may be ordinary Playwright steps. A Testmints adapter must add enough omission prevention and cross-runner consistency to justify itself. |
| [Allure steps](https://allurereport.org/docs/steps/) | Structured steps with timing, status, attachments, and fixture presentation | Reuse report consumers where practical. Rich phase visualization is already solved in substantial part; the remaining hypothesis is the authoring contract and transport portability. |
| [ReportPortal](https://reportportal.io/docs/work-with-reports/ViewLaunches/) | Launch/suite/test/step/log hierarchy in a centralized reporting platform | An optional consumer for teams already invested in it; no reason to build a competing storage platform for the MVP. |
| [Cucumber Messages](https://github.com/cucumber/messages) | A protocol for execution and related information, with NDJSON support | A direct precedent the proposal must acknowledge. Evaluate event mappings before freezing a new schema; do not claim structured test streams are a novel invention. |
| [Serenity/JS Screenplay](https://serenity-js.org/handbook/design/screenplay-pattern/) | Reusable tasks, interactions, and questions for acceptance-test expression | A credible alternative when that abstraction matches team intent. Testmints favors direct feature calls and plain data to keep small tests accessible. |
| [StrykerJS](https://stryker-mutator.io/docs/stryker-js/introduction/) | Mutation testing to assess whether tests detect code changes | Complements the top philosophical priority: demonstrate failure. Complete phases alone cannot establish test adequacy. |

The pitch is therefore a combination: a small four-phase authoring contract, owned async/resource lifetimes, omissions caught at the earliest feasible boundary, and portable live events. Each component exists elsewhere in some form. Validate the value of their combination before expanding the surface area.

If conventional runner APIs plus a few helpers and Allure already meet the objectives in representative tests, that is a successful research result. The library earns its existence through demonstrably clearer and harder-to-misuse tests.

## Road to MVP

### Stage 0 — Prove the authoring design

Implement a disposable syntax/type spike with a pure test, async service test, partial setup failure, command returning void, and complex data comparison. Test plain JavaScript and strict TypeScript. Compare the complete-definition API with ordinary runner code and a fluent alternative, including missing-step mistakes. Ask a less-experienced developer to explain and modify each example.

Acceptance: basic examples infer correctly and require no explicit generics, the feature remains visible, missing phases fail before work starts, and there is no completion call to remember. Demonstrate unchanged use of Vitest assertions, Node assertions, and a custom throwing/async check under the same adapter. Investigate the runner's cancellation hooks and native error presentation here. Do not bury unresolved integration limits under the word “adapter.”

### Stage 1 — Core execution and async ownership

Build the validated definition, executor, resource lifetime handling, and error preservation. Keep instrumentation behind a small sink interface. Test lifecycle semantics independently of a real runner, using controlled promises and injected clocks rather than sleep-based timing assertions. Evaluate task-group support separately against the expansion criterion; it must not hold the basic executor hostage.

### Stage 2 — Vitest and a useful local stream

Add registration, runner identity, native failure presentation, and the NDJSON writer. Include one documented reporter configuration and a minimal inspector. Show a real failure and cleanup timeline. Reporting should be discoverable immediately, addressing the old lifecycle feature's near-invisible adoption path.

### Stage 3 — Prove portability

Run the adapter conformance suite against a second independent runner before calling the architecture portable. A minimal `node:test` integration is the proposed low-cost proof; Playwright is the next candidate when browser examples warrant it. Keep runner fixture acquisition distinct from semantic setup in reports. The second runner is an architectural test, not a commitment to ship a large adapter catalog in v1.

### Stage 4 — Validate consumers before building more UI

Compare the event schema with Cucumber Messages, demonstrate one report-system mapping, and document CI artifact collection. Add static viewing, OpenTelemetry export, source-linked examples, or historical phase comparisons only when actual consumers justify them.

## Acceptance Cases and Honest Limits

| Concern | Required evidence |
|---|---|
| Missing or malformed phases | Type fixtures and plain-JS runtime tests; no setup side effects on invalid definitions |
| BYOAL | Existing throwing assertions, async rejection, successful chain/value returns, and custom checks work without registration or observation; empty callbacks and bare predicates are documented limits |
| Type flow | Anonymous objects, async values, named helpers, void output, and incorrect input/output use checked by the compiler |
| Expected rejection | `captureOutcome` handles synchronous throws, rejected promises, and success; verification checks the error and fails on unexpected success; uncaptured exercise failures still skip verify |
| Async phase ordering | Rejected thenables and delayed verification cannot yield a premature pass; if included, an injected exercise launcher delays exercise-end until owned children settle and starts verification only on exercise success |
| Concurrent-work extension, if included | Dropped group promise remains owned; rejection handling is explicit; sibling failure never starts cleanup while owned work remains active |
| Partial setup | Earlier resources released after later setup failure; unresolved acquisitions remain owned |
| Exercise-created resource | Resource is usable during verify and released after assertion failure; setup and exercise share one scope |
| Reporter failure | Throwing phase/event sink cannot skip user work, prevent cleanup, or replace the primary failure; reporting is marked incomplete |
| Multiple failures | Original assertion/diff preserved; all attempted cleanup failures retained; no duplicate release |
| Cancellation | Cooperative stop, separate cleanup allowance, and hard worker termination tested as different outcomes |
| Parallel tests and retries | No shared current-test state; fresh scopes and distinct attempts; final runner failure remains visible even after verify completed |
| Events and artifacts | Start/end correlation, skipped phases, backpressure, sink failure, interrupted tail, worker restart, and redaction covered |
| BYOTR | Same core behavior under two runners; capability differences documented and conformance-tested |
| Philosophy | Human readability comparison and deliberately broken feature demonstrate more than a structurally green test |

## Deferred and Still to Validate

Keep assertions and spies external despite their popularity in the original suite; preserve their good data-oriented usage through examples and native diffs. General fixture/template inheritance, a hosted collector, a database, a dashboard, and a standalone runner are outside the first implementation.

Before publishing, settle compiler-tested signatures, supported runner versions, resource-disposal interoperability, and exact timeout integration. Evaluate Cucumber message reuse against the required phase/resource events before committing the event schema. Decide whether a task helper earns its complexity through the async examples. Select a permissive license and available package names at project creation. None of these decisions should weaken BYOTR or BYOAL.

The non-negotiable limitation is that arbitrary detached JavaScript work cannot be made safe by wrapping its parent callback. The useful promise is narrower and testable: complete definitions, awaited phase boundaries, owned tasks and resources, clear runtime errors, and visible disclosure wherever the runner or language cannot provide the stronger guarantee.
