# Library direction log

This is a compact record of durable design directions and unanswered questions. It is not a roadmap
or a promise of future API. Promote an item to an implementation only with a concrete, desirable
executable example.

## TypeScript design

- Prefer structural public contracts: plain data, ordinary functions, and inference over class
  hierarchies or nominal membership.
- Keep types with the behavior that owns them. Split modules when concepts have independent reasons
  to change, rather than following a one-type-per-file rule.
- A closed class is appropriate for a small mutable lifecycle boundary. `AttemptScope` is the model:
  it protects private state and its transitions, but is not a base type or an extension mechanism.

## Verification and failure representation

The current public contract deliberately uses ordinary throws and rejected promises as test failure.
`Result` and `Either` values can already be tested as ordinary phase data, but returning a failed
value from `verify` does not currently fail the test.

Do not infer a universal `Result` or `Either` shape: established libraries and local applications
encode those values differently, and ordinary application data must not accidentally become a test
failure.

Non-throwing assertion systems are a plausible future integration. If explored, their failures
should be recorded during the existing `verify` phase and finalized when it completes; this is not a
fifth user-visible lifecycle phase. The integration should make finalization difficult to omit once
chosen, while retaining explicit scenario setup and avoiding global mutable test templates.

Before adding a general core abstraction, prove it through a concrete adapter or user scenario and
show that it:

- preserves all recorded verification failures;
- continues to run teardown and resource cleanup;
- retains cleanup failures alongside verification failures; and
- provides diagnostics that remain useful in the target runner.
