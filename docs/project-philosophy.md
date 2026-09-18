# Testmints project philosophy

Use this document as a quick decision filter when changing Testmints. The design proposal explains
the broader product direction; these are the values that should be visible in the codebase today.

## Tests are the first-class examples

Every test should be a realistic, readable example of using Testmints and evidence that the behavior
is desirable. Test names describe a user-visible scenario or an intentional contract, not the test
harness. All runtime tests use `mintTest` unless that is genuinely impossible; calls to lower-level
core APIs belong inside a `mintTest` phase when those APIs are the behavior under evidence.

Prefer linear setup, exercise, verification, and teardown. Keep assertions in `verify` whenever the
scenario permits it. A test can have several assertions when they describe one scenario; do not
split or combine tests merely to satisfy an assertion-count rule.

Tests are release evidence, not coverage theater. Test the real public behavior at the narrowest
meaningful interface. Avoid tests that merely repeat implementation structure or source text.

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
helpers. Run `npm run check` before declaring a change complete.
