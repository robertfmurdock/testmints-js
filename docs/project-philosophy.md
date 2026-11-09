# Testmints project philosophy

Use this document as a quick decision filter when changing Testmints. The design proposal explains
the broader product direction; these are the values that should be visible in the codebase today.

## Tests are the first-class examples

Every test should be a realistic, readable example of using Testmints and evidence that the behavior
is desirable. Test names describe a user-visible scenario or an intentional contract, not the test
harness. All runtime tests visibly register with Vitest using `test(name, mint(definition))` unless
that is genuinely impossible; calls to lower-level core APIs belong inside a `mint` phase when
those APIs are the behavior under evidence.

Organize related tests so readers can learn the feature in order. Start with the smallest complete
example, then build toward cases that introduce additional options, runner behavior, or failure
handling.

Prefer linear setup, exercise, verification, and teardown. Keep assertions in `verify` whenever the
scenario permits it. A test can have several assertions when they describe one scenario; do not
split or combine tests merely to satisfy an assertion-count rule.

Phase names make semantic claims, not just sections. Identify the feature-owning subject before
assigning phases. When the boundaries are incoherent, reconsider ownership: split distinct
scenarios, consolidate duplicate evidence, or move a contract into the test that already owns it.
Successful use of the syntax is not proof that those questions have been resolved.

One scenario has one visible subject action; repeat execution when repetition is itself the
contract. Arrange meaningful inputs once and carry them through exercise into verification rather
than restating them as disconnected literals. Helpers may arrange reusable worlds or name stable
assertions, but should leave the subject action visible.

Tests are release evidence, not coverage theater. Test the real public behavior at the narrowest
meaningful interface. Avoid tests that merely repeat implementation structure or source text.

For a regression, reproduce the known-bad behavior through the closest meaningful interface before
changing the implementation, then run the same evidence green. For a new or materially changed
behavioral contract, name a concrete broken implementation the test must detect and demonstrate
that it does, using a small reversible fault when practical. Confirm that the intended observable
assertion fails, not merely setup or an unrelated gate. If the real boundary cannot be exercised,
record the limitation and the nearest representative evidence.

## Make tests easy to read and hard to accidentally bypass

The four phases are the core authoring contract: setup produces local scenario data, exercise uses
the feature directly, verify establishes the observable property, and teardown performs explicit
end-of-attempt work. A complete object definition is intentional: there is no final `.run()` call to
forget.

Favor ordinary functions, plain data, and local helpers over hidden templates, inherited fixtures,
or mutable global test state. Reuse infrastructure through explicit helpers that accept ownership;
keep scenario inputs and expected behavior in the individual test.

Do not bundle or inspect assertion libraries. Users keep their runner and assertions; Testmints
only awaits ordinary throw/reject semantics and preserves native errors and diffs.

## Own the lifecycle honestly

The executor owns complete definitions, phase sequencing, awaited returned work, resource lifetime,
and cleanup ordering. Runner adapters own registration and runner-specific integration. Reporting is
observational and must never turn a failure into a pass, replace the original error, or prevent
cleanup.

Resources acquired with `scope.using()` remain available through verification and are released in
reverse acquisition order. Pair acquisition and release at the same point. Use `scope.defer()` only
when there is no natural acquired resource to pair with cleanup. Preserve the primary failure and
retain teardown/release failures rather than hiding them.

Keep shared restoration in ordinary runner lifecycle hooks. Scoped cleanup is for resources owned
by one scenario; adopting Testmints does not require repeating suite cleanup in every setup.

Await the subject's completion, or use a bounded wait for its observable result when completion is
not directly available. A tick, event-loop pump, or advance of controlled time does not establish
completion of unrelated asynchronous work. Keep actions outside retrying assertion callbacks.

Make narrow guarantees and prove them. Awaiting a phase cannot discover arbitrary detached promises
or forcibly stop ignored work; do not imply otherwise. A public capability should have a concrete,
desirable executable example before it earns its place.

## TypeScript should prevent ordinary mistakes

Treat the TypeScript API as a real contract, not documentation. Public typed APIs should accept only
valid input, infer phase data without explicit generics in ordinary examples, and reject incompatible
data flow at compile time. Keep runtime validation for JavaScript and untyped boundaries.

Do not add permissive overloads merely to simplify tests. Keep deliberate type suppression tightly
scoped to tests that model an untyped runtime boundary. Prefer type guards, narrow helper functions,
and explicit return types over assertions (`as`); a cluster of assertions is a signal to improve the
types or validation boundary.

Maintain compiler fixtures alongside runtime tests for inference and rejection behavior.

## Keep the first slice small

Every addition must make representative tests materially clearer, harder to misuse, safer around
async/resource lifetime, or more observable. Prefer existing language and runner facilities over a
new abstraction. Do not add assertion integration, global templates, a standalone runner, hosted
storage, or broad reporting infrastructure without evidence that the smaller design falls short.

When a behavior is deferred, do not leak a half-promise into the public API. Document the limitation
plainly and add the capability only when its lifecycle, errors, and examples are understood.

## Working agreement

Keep the implementation small and readable: name important intermediate concepts, isolate runtime
boundary checks, avoid clever branching, and refactor repeated test-harness mechanics into clear
helpers. Run `npm run check` before declaring changes to code, tests, or build configuration
complete. For reviews, planning, and prose-only edits, run checks when they help answer the task.
