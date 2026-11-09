import assert from "node:assert/strict";

import { expect, test } from "vitest";

import { executeDefinition, validateDefinition } from "../src/index.js";

import { mint, runMint } from "../src/vitest.js";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function captureOutcome<T>(
	action: () => T | PromiseLike<T>,
): Promise<Outcome<T>> {
	try {
		return { ok: true, value: await action() };
	} catch (error) {
		return { ok: false, error };
	}
}

function mintUnknown(candidate: unknown) {
	// JavaScript callers can pass any value; this test verifies the runtime boundary.
	// @ts-expect-error The public TypeScript API correctly refuses unknown input.
	return mint(candidate);
}

test(
	"mint validates malformed definitions when its callback is created",
	mint({
		setup: () => ({ setup: () => undefined, exercise: () => undefined }),
		exercise: (definition) => captureOutcome(() => mintUnknown(definition)),
		verify: (outcome) => {
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("Expected definition validation to fail");
			expect(outcome.error).toBeInstanceOf(TypeError);
			expect(outcome.error).toMatchObject({
				message: "Testmint definition requires a callable verify phase.",
			});
		},
	}),
);

test(
	"ordinary Vitest assertions stay in verify",
	mint({
		setup: () => 15,
		exercise: (input) =>
			input % 3 === 0 && input % 5 === 0 ? "FizzBuzz" : String(input),
		verify: (output) => expect(output).toBe("FizzBuzz"),
	}),
);

test(
	"Node assertion failures propagate without integration",
	mint({
		setup: () => ({ left: 20, right: 22 }),
		exercise: ({ left, right }) =>
			captureOutcome(() =>
				executeDefinition(
					validateDefinition({
						setup: () => ({ left, right }),
						exercise: ({ left, right }) => left + right,
						verify: (output) => assert.equal(output, 43),
					}),
				),
			),
		verify: (outcome) => {
			// Record this with Vitest even if a broken executor swallows thrown assertions.
			expect.soft(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("Expected the Node assertion to fail");
			expect.soft(outcome.error).toBeInstanceOf(assert.AssertionError);
			expect.soft(outcome.error).toMatchObject({ actual: 42, expected: 43 });
		},
	}),
);

test(
	"expected rejection is data for ordinary verification",
	mint({
		setup: () => "expired-token",
		exercise: (token) =>
			captureOutcome(async () => {
				if (token === "expired-token") throw new Error("expired");
				return "authenticated";
			}),
		verify: async (outcome) => {
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("Expected authentication to fail");
			expect(outcome.error).toBeInstanceOf(Error);
		},
	}),
);

test(
	"command-style exercises can return undefined",
	mint({
		setup: (): { messages: string[] } => ({ messages: [] }),
		exercise: ({ messages }) => {
			messages.push("welcome");
		},
		verify: (output, { messages }) => {
			expect(output).toBeUndefined();
			expect(messages).toEqual(["welcome"]);
		},
	}),
);

test(
	"an exported report stays available through verification",
	mint({
		setup: () => ({ memberName: "Ada" }),
		exercise: ({ memberName }, { scope }) =>
			scope.using(
				"exported report",
				async () => ({ text: `Member: ${memberName}`, removed: false }),
				async (report) => {
					report.removed = true;
				},
			),
		verify: (report, { memberName }) => {
			expect(report.text).toBe(`Member: ${memberName}`);
			expect(report.removed).toBe(false);
		},
	}),
);

test(
	"sending a welcome email closes its mailer during teardown",
	mint({
		setup: (): {
			member: { email: string };
			mailer: { messages: string[]; closed: boolean };
		} => ({
			member: { email: "ada@example.test" },
			mailer: { messages: [], closed: false },
		}),
		exercise: async ({ member, mailer }) => {
			await executeDefinition(
				validateDefinition({
					setup: () => ({ member, mailer }),
					exercise: ({ member, mailer }) => {
						mailer.messages.push(`Welcome ${member.email}`);
					},
					verify: (_output, { mailer }) =>
						expect(mailer.messages).toEqual([`Welcome ${member.email}`]),
					teardown: async ({ mailer }) => {
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
						mailer.closed = true;
					},
				}),
			);
			return mailer;
		},
		verify: (mailer, { member }) => {
			expect(mailer.messages).toEqual([`Welcome ${member.email}`]);
			expect(mailer.closed).toBe(true);
		},
	}),
);

// This public API accepts the runner-owned context, which the native callback supplies.
test("explicit execution uses the active Vitest context", async (context) => {
	await runMint(
		{
			setup: () => 21,
			exercise: (input, { signal }) => ({ value: input * 2, signal }),
			verify: (output) => {
				expect(output.value).toBe(42);
				expect(output.signal).toBe(context.signal);
			},
		},
		context,
	);
});
