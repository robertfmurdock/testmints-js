import { expect } from "vitest";

import { executeDefinition, validateDefinition } from "../src/index.js";
import { mintTest } from "../src/vitest.js";

async function captureError<T>(
	action: () => T | PromiseLike<T>,
): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected the action to fail.");
}

function validateUnknown(candidate: unknown) {
	// JavaScript callers can pass any value; this suite verifies the runtime boundary.
	// @ts-expect-error The public TypeScript API correctly refuses unknown input.
	return validateDefinition(candidate);
}

function aggregateError(error: unknown): AggregateError {
	expect(error).toBeInstanceOf(AggregateError);
	if (error instanceof AggregateError) return error;
	throw new Error("Expected an AggregateError.");
}

function emptyCalls(): string[] {
	return [];
}

mintTest(
	"definition validation rejects malformed definitions before a test can run",
	{
		setup: () => [
			() => validateUnknown(null),
			() => validateUnknown([]),
			() =>
				validateUnknown({
					setup: () => undefined,
					exercise: () => undefined,
				}),
			() =>
				validateUnknown({
					setup: () => undefined,
					exercise: () => undefined,
					verify: () => undefined,
					verfiy: () => undefined,
				}),
			() =>
				validateUnknown({
					setup: () => undefined,
					exercise: () => undefined,
					verify: () => undefined,
					teardown: true,
				}),
		],
		exercise: (invalid) =>
			invalid.map((definition) => captureError(definition)),
		verify: async (errors) => {
			for (const error of await Promise.all(errors)) {
				expect(error).toBeInstanceOf(TypeError);
			}
		},
	},
);

mintTest(
	"registration captures phase callbacks instead of later mutable changes",
	{
		setup: (): { calls: string[] } => ({ calls: [] }),
		exercise: async ({ calls }) => {
			const definition = {
				setup: () => 1,
				exercise: (input: number) => input + 1,
				verify: () => calls.push("original"),
			};
			const registered = validateDefinition(definition);
			definition.verify = () => calls.push("replacement");
			await executeDefinition(registered);
			return calls;
		},
		verify: (calls) => expect(calls).toEqual(["original"]),
	},
);

mintTest("the executor awaits setup, exercise, verify, and teardown in order", {
	setup: emptyCalls,
	exercise: async (calls) => {
		await executeDefinition(
			validateDefinition({
				setup: async () => {
					calls.push("setup");
					return 2;
				},
				exercise: async (input) => {
					calls.push(`exercise:${input}`);
					return input * 3;
				},
				verify: async (output, input) => {
					calls.push(`verify:${input}:${output}`);
				},
				teardown: async (input) => {
					calls.push(`teardown:${input}`);
				},
			}),
		);
		return calls;
	},
	verify: (calls) =>
		expect(calls).toEqual(["setup", "exercise:2", "verify:2:6", "teardown:2"]),
});

mintTest(
	"setup failure skips later phases and releases owned resources in reverse order",
	{
		setup: emptyCalls,
		exercise: async (calls) => ({
			calls,
			error: await captureError(() =>
				executeDefinition(
					validateDefinition({
						setup: async ({ scope }) => {
							await scope.using(
								"first",
								() => "first",
								(value) => calls.push(`release:${value}`),
							);
							await scope.using(
								"second",
								() => "second",
								(value) => calls.push(`release:${value}`),
							);
							throw new Error("setup failed");
						},
						exercise: () => calls.push("exercise"),
						verify: () => calls.push("verify"),
						teardown: () => calls.push("teardown"),
					}),
				),
			),
		}),
		verify: ({ calls, error }) => {
			expect(error).toEqual(
				expect.objectContaining({ message: "setup failed" }),
			);
			expect(calls).toEqual(["release:second", "release:first"]);
		},
	},
);

mintTest(
	"exercise failure skips verify but runs teardown and resource cleanup",
	{
		setup: emptyCalls,
		exercise: async (calls) => ({
			calls,
			error: await captureError(() =>
				executeDefinition(
					validateDefinition({
						setup: async ({ scope }) => ({
							resource: await scope.using(
								"fixture",
								() => "fixture",
								(value) => calls.push(`release:${value}`),
							),
						}),
						exercise: () => {
							calls.push("exercise");
							throw new Error("exercise failed");
						},
						verify: () => calls.push("verify"),
						teardown: ({ resource }) => calls.push(`teardown:${resource}`),
					}),
				),
			),
		}),
		verify: ({ calls, error }) => {
			expect(error).toEqual(
				expect.objectContaining({ message: "exercise failed" }),
			);
			expect(calls).toEqual([
				"exercise",
				"teardown:fixture",
				"release:fixture",
			]);
		},
	},
);

mintTest("verification failure retains teardown and release failures", {
	setup: () => ({
		primary: new Error("primary"),
		teardown: new Error("teardown"),
		cleanup: new Error("cleanup"),
	}),
	exercise: ({ primary, teardown, cleanup }) =>
		captureError(() =>
			executeDefinition(
				validateDefinition({
					setup: async ({ scope }) => {
						await scope.using(
							"resource",
							() => "resource",
							() => {
								throw cleanup;
							},
						);
						return undefined;
					},
					exercise: () => undefined,
					verify: () => {
						throw primary;
					},
					teardown: () => {
						throw teardown;
					},
				}),
			),
		),
	verify: (error, { primary, teardown, cleanup }) => {
		expect(aggregateError(error).errors).toEqual([primary, teardown, cleanup]);
	},
});

mintTest("deferred cleanup follows explicit teardown exactly once", {
	setup: emptyCalls,
	exercise: async (calls) => {
		await executeDefinition(
			validateDefinition({
				setup: ({ scope }) => {
					scope.defer("temporary directory", () =>
						calls.push("remove directory"),
					);
					return { directory: "tmp/report" };
				},
				exercise: ({ directory }) => `${directory}/report.txt`,
				verify: (path) => expect(path).toBe("tmp/report/report.txt"),
				teardown: ({ directory }) => calls.push(`close:${directory}`),
			}),
		);
		return calls;
	},
	verify: (calls) =>
		expect(calls).toEqual(["close:tmp/report", "remove directory"]),
});

mintTest(
	"adapter callers share their signal with active phases while cleanup gets a fresh signal",
	{
		setup: (): { controller: AbortController; active: AbortSignal[] } => ({
			controller: new AbortController(),
			active: [],
		}),
		exercise: async ({ controller, active }) => {
			let cleanup: AbortSignal | undefined;
			await executeDefinition(
				validateDefinition({
					setup: ({ signal }) => {
						active.push(signal);
						return undefined;
					},
					exercise: (_input, { signal }) => active.push(signal),
					verify: (_output, _input, { signal }) => active.push(signal),
					teardown: (_input, { signal }) => {
						cleanup = signal;
					},
				}),
				{ signal: controller.signal },
			);
			return cleanup;
		},
		verify: (cleanup, { controller, active }) => {
			expect(active).toEqual([
				controller.signal,
				controller.signal,
				controller.signal,
			]);
			expect(cleanup).not.toBe(controller.signal);
			expect(cleanup?.aborted).toBe(false);
		},
	},
);

mintTest(
	"event sinks observe successful boundaries and remain observational when broken",
	{
		setup: emptyCalls,
		exercise: async (events) => {
			await executeDefinition(
				validateDefinition({
					setup: () => "Ada",
					exercise: (name) => `Hello, ${name}`,
					verify: (greeting) => expect(greeting).toBe("Hello, Ada"),
					teardown: () => undefined,
				}),
				{
					sink: {
						emit: (event) => void events.push(`${event.phase}:${event.status}`),
					},
				},
			);
			await executeDefinition(
				validateDefinition({
					setup: () => undefined,
					exercise: () => undefined,
					verify: () => undefined,
				}),
				{ sink: { emit: () => Promise.reject(new Error("sink unavailable")) } },
			);
			return events;
		},
		verify: (events) =>
			expect(events).toEqual([
				"setup:started",
				"setup:passed",
				"exercise:started",
				"exercise:passed",
				"verify:started",
				"verify:passed",
				"teardown:started",
				"teardown:passed",
			]),
	},
);
