import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { test as base, expect } from "@playwright/test";

import { createMint, mint } from "../src/playwright.js";

async function captureError(action: () => Promise<void>): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected the definition to fail.");
}

const test = base.extend<{ lifecycle: { calls: string[] } }>({
	lifecycle: async (
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring.
		{},
		use,
	) => {
		const lifecycle = { calls: ["fixture setup"] };
		await use(lifecycle);
		lifecycle.calls.push("fixture teardown");
		expect(lifecycle.calls).toEqual([
			"fixture setup",
			"setup",
			"exercise",
			"verify",
			"teardown",
			"release",
			"fixture teardown",
		]);
	},
});

test("definition validation rejects malformed definitions as the test begins", async () => {
	await expect(
		mint({
			setup: () => undefined,
			exercise: () => undefined,
			// @ts-expect-error Playwright callers still receive the core definition contract.
			verify: undefined,
		}),
	).rejects.toThrow("Testmint definition requires a callable verify phase.");
});

test("the Playwright adapter awaits setup, exercise, verify, and teardown in order", async () => {
	const calls: string[] = [];
	await mint({
		setup: async () => {
			await delay(0);
			calls.push("setup");
			return 2;
		},
		exercise: async (input) => {
			await delay(0);
			calls.push(`exercise:${input}`);
			return input * 3;
		},
		verify: async (output, input) => {
			await delay(0);
			calls.push(`verify:${input}:${output}`);
			expect(calls).toEqual(["setup", "exercise:2", "verify:2:6"]);
		},
		teardown: async (input) => {
			calls.push("teardown started");
			await delay(0);
			calls.push(`teardown:${input}`);
			expect(calls).toEqual([
				"setup",
				"exercise:2",
				"verify:2:6",
				"teardown started",
				"teardown:2",
			]);
		},
	});
	expect(calls).toEqual([
		"setup",
		"exercise:2",
		"verify:2:6",
		"teardown started",
		"teardown:2",
	]);
});

test("a setup failure skips later phases and releases owned resources in reverse order", async () => {
	const calls: string[] = [];
	const error = await captureError(() =>
		mint({
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
	);
	expect(error).toMatchObject({ message: "setup failed" });
	expect(calls).toEqual(["release:second", "release:first"]);
});

test("an exercise failure skips verification but runs teardown and resource cleanup", async () => {
	const calls: string[] = [];
	const error = await captureError(() =>
		mint({
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
	);
	expect(error).toMatchObject({ message: "exercise failed" });
	expect(calls).toEqual(["exercise", "teardown:fixture", "release:fixture"]);
});

test("a verification failure retains teardown and release failures", async () => {
	const primary = new Error("primary");
	const teardown = new Error("teardown");
	const cleanup = new Error("cleanup");
	const error = await captureError(() =>
		mint({
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
	);
	expect(error).toBeInstanceOf(AggregateError);
	if (error instanceof AggregateError)
		expect(error.errors).toEqual([primary, teardown, cleanup]);
});

test("deferred cleanup follows explicit teardown exactly once", () => {
	const calls: string[] = [];
	return mint({
		setup: ({ scope }) => {
			scope.defer("temporary directory", () => calls.push("remove directory"));
			return { directory: "tmp/report" };
		},
		exercise: ({ directory }) => `${directory}/report.txt`,
		verify: (path) => expect(path).toBe("tmp/report/report.txt"),
		teardown: ({ directory }) => calls.push(`close:${directory}`),
	}).then(() =>
		expect(calls).toEqual(["close:tmp/report", "remove directory"]),
	);
});

test("active phases share a signal while cleanup receives a fresh signal", () => {
	const active: AbortSignal[] = [];
	let cleanup: AbortSignal | undefined;
	return mint({
		setup: ({ signal }) => {
			active.push(signal);
			return undefined;
		},
		exercise: (_input, { signal }) => active.push(signal),
		verify: (_output, _input, { signal }) => active.push(signal),
		teardown: (_input, { signal }) => {
			cleanup = signal;
		},
	}).then(() => {
		expect(active).toHaveLength(3);
		expect(active[0]).toBe(active[1]);
		expect(active[1]).toBe(active[2]);
		expect(cleanup).not.toBe(active[0]);
		expect(cleanup?.aborted).toBe(false);
	});
});

test("ordinary Playwright and Node assertions stay in verification", () =>
	mint({
		setup: () => ({ left: 20, right: 22 }),
		exercise: ({ left, right }) => left + right,
		verify: (output) => {
			expect(output).toBe(42);
			assert.equal(output, 42);
		},
	}));

test("command-style exercises can return undefined", () =>
	mint({
		setup: (): { messages: string[] } => ({ messages: [] }),
		exercise: ({ messages }) => {
			messages.push("welcome");
		},
		verify: (output, { messages }) => {
			expect(output).toBeUndefined();
			expect(messages).toEqual(["welcome"]);
		},
	}));

test("an acquired resource stays available through verification", () =>
	mint({
		setup: () => ({ memberName: "Ada" }),
		exercise: ({ memberName }, { scope }) =>
			scope.using(
				"exported report",
				() => ({ text: `Member: ${memberName}`, removed: false }),
				(report) => {
					report.removed = true;
				},
			),
		verify: (report) => {
			expect(report.text).toContain("Ada");
			expect(report.removed).toBe(false);
		},
	}));

test("expected rejection remains data for ordinary verification", () =>
	mint({
		setup: () => "expired-token",
		exercise: async (token) => {
			try {
				if (token === "expired-token") throw new Error("expired");
				return { ok: true as const, value: "authenticated" };
			} catch (error) {
				return { ok: false as const, error };
			}
		},
		verify: (outcome) => {
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.error).toBeInstanceOf(Error);
		},
	}));

let preparations = 0;
const sharedMarkupMint = createMint({
	shared: async () => ({ pageContent: `<main>hello ${++preparations}</main>` }),
});

test("a page fixture renders shared template markup", ({ page }) =>
	sharedMarkupMint({
		setup: async ({ pageContent }) => {
			await page.setContent(pageContent);
			return page.getByRole("main");
		},
		exercise: (main) => main.textContent(),
		verify: (content) => expect(content).toBe("hello 1"),
	}));

test("a retry receives a fresh Testmints attempt", () =>
	sharedMarkupMint({
		setup: ({ pageContent }) => {
			if (test.info().retry === 0) throw new Error("retry once");
			return pageContent;
		},
		exercise: (value) => value,
		verify: (value) => {
			expect(value).toBe("<main>hello 1</main>");
			expect(preparations).toBe(1);
		},
	}));

test("a Playwright page and custom fixture remain available through every Testmints phase", ({
	page,
	lifecycle,
}) =>
	sharedMarkupMint({
		setup: async ({ pageContent }, { scope }) => {
			lifecycle.calls.push("setup");
			await page.setContent(pageContent);
			await scope.using(
				"report",
				() => "report",
				() => {
					lifecycle.calls.push("release");
				},
			);
			return page.getByRole("main");
		},
		exercise: async (main) => {
			lifecycle.calls.push("exercise");
			return main.textContent();
		},
		verify: (content) => {
			lifecycle.calls.push("verify");
			expect(content).toBe("hello 1");
			expect(preparations).toBe(1);
		},
		teardown: () => lifecycle.calls.push("teardown"),
	}));

test("disposing an unused mint leaves its sibling usable", async () => {
	let retiredStarts = 0;
	const closedDirectories: URL[] = [];
	const serviceMint = createMint({
		shared: () => ({ baseUrl: "https://profiles.example.test/" }),
		attempt: {
			before: ({ baseUrl }) => ({ members: new URL("members/", baseUrl) }),
		},
	});
	const retiredMint = serviceMint.extend({
		shared: () => ({ initialization: ++retiredStarts }),
	});
	const directoryMint = serviceMint.extend({
		attempt: {
			before: ({ members }, { scope }) =>
				scope.using(
					"member directory",
					() => ({ directory: members }),
					({ directory }) => closedDirectories.push(directory),
				),
		},
	});

	await retiredMint.dispose();
	await directoryMint({
		setup: ({ directory }) => ({ directory, memberId: "ada" }),
		exercise: ({ directory, memberId }) => new URL(memberId, directory),
		verify: (link, { memberId }) => {
			expect(link.pathname).toBe(`/members/${memberId}`);
			expect(retiredStarts).toBe(0);
		},
	});
	expect(closedDirectories.map((directory) => directory.pathname)).toEqual([
		"/members/",
	]);
	await serviceMint.dispose();
});

test("template diagnostics run after scenario cleanup and retain the verification failure", async () => {
	const events: string[] = [];
	const failedVerification = new Error("profile display name is stale");
	const failedDiagnostics = new Error("diagnostics upload failed");
	const workspaceMint = createMint({
		attempt: {
			before: ({ scope }) =>
				scope.using(
					"workspace",
					() => ({ token: "member-token", open: true }),
					(workspace) => {
						workspace.open = false;
						events.push("close workspace");
					},
				),
			after: (workspace) => {
				expect(workspace.open).toBe(true);
				events.push("collect diagnostics");
				throw failedDiagnostics;
			},
		},
	});
	const error = await captureError(() =>
		workspaceMint({
			setup: async ({ token }, { scope }) => ({
				expectedName: "Ada",
				profile: await scope.using(
					"profile editor",
					() => ({ token, displayName: "Ada Lovelace" }),
					() => events.push("close profile editor"),
				),
			}),
			exercise: ({ profile }) => profile.displayName,
			verify: (displayName, { expectedName }) => {
				if (displayName !== expectedName) throw failedVerification;
			},
			teardown: () => events.push("save scenario log"),
		}),
	);
	expect(error).toBeInstanceOf(AggregateError);
	if (error instanceof AggregateError)
		expect(error.errors).toEqual([failedVerification, failedDiagnostics]);
	expect(events).toEqual([
		"save scenario log",
		"close profile editor",
		"collect diagnostics",
		"close workspace",
	]);
});
