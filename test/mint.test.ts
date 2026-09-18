import assert from "node:assert/strict";

import { expect } from "vitest";

import { mintTest } from "../src/vitest.js";

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

mintTest("ordinary Vitest assertions stay in verify", {
	setup: () => 15,
	exercise: (input) =>
		input % 3 === 0 && input % 5 === 0 ? "FizzBuzz" : String(input),
	verify: (output) => expect(output).toBe("FizzBuzz"),
});

mintTest("Node assertions work without integration", {
	setup: () => ({ left: 20, right: 22 }),
	exercise: ({ left, right }) => left + right,
	verify: (output) => assert.equal(output, 42),
});

mintTest("expected rejection is data for ordinary verification", {
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
});

mintTest("command-style exercises can return undefined", {
	setup: (): { messages: string[] } => ({ messages: [] }),
	exercise: ({ messages }) => {
		messages.push("welcome");
	},
	verify: (_output, { messages }) => expect(messages).toEqual(["welcome"]),
});

mintTest("an exported report stays available through verification", {
	setup: () => ({ memberName: "Ada" }),
	exercise: ({ memberName }, { scope }) =>
		scope.using(
			"exported report",
			async () => ({ text: `Member: ${memberName}`, removed: false }),
			async (report) => {
				report.removed = true;
			},
		),
	verify: (report) => {
		expect(report.text).toContain("Ada");
		expect(report.removed).toBe(false);
	},
});

mintTest("sending a welcome email closes its mailer during teardown", {
	setup: (): {
		member: { email: string };
		mailer: { messages: string[]; closed: boolean };
	} => ({
		member: { email: "ada@example.test" },
		mailer: { messages: [], closed: false },
	}),
	exercise: ({ member, mailer }) => {
		mailer.messages.push(`Welcome ${member.email}`);
	},
	verify: (_output, { mailer }) =>
		expect(mailer.messages).toEqual(["Welcome ada@example.test"]),
	teardown: ({ mailer }) => {
		mailer.closed = true;
		expect(mailer.closed).toBe(true);
	},
});
