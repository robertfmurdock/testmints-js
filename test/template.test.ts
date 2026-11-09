import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";

import { createTemplate, executeDefinition } from "../src/core.js";
import { createMint, mint } from "../src/vitest.js";

const profileLinkMint = createMint({
	shared: () => ({ baseUrl: "https://profiles.example.test/" }),
});

test(
	"a configured mint passes shared values into setup",
	profileLinkMint({
		setup: ({ baseUrl }) => ({ baseUrl, memberId: "ada" }),
		exercise: ({ baseUrl, memberId }) =>
			new URL(`members/${memberId}`, baseUrl),
		verify: (link, { baseUrl, memberId }) => {
			expect(link.origin).toBe(new URL(baseUrl).origin);
			expect(link.pathname).toBe(`/members/${memberId}`);
		},
	}),
);

let signIns = 0;
let profileOpens = 0;
const closedProfiles: number[] = [];
const collectedDiagnostics: number[] = [];
const profileEditorMint = createMint({
	shared: () => ({ accessToken: `member-token-${++signIns}` }),
	attempt: {
		before: ({ accessToken }, { scope }) =>
			scope.using(
				"profile editor",
				() => ({ accessToken, id: ++profileOpens, displayName: "" }),
				(editor) => closedProfiles.push(editor.id),
			),
		after: (editor) => {
			expect(closedProfiles).not.toContain(editor.id);
			collectedDiagnostics.push(editor.id);
		},
	},
});

test(
	"a Vitest retry opens a new profile editor with the same credentials",
	{ retry: 1 },
	profileEditorMint({
		setup: (editor) => {
			if (editor.id === 1)
				throw new Error("Profile form temporarily unavailable.");
			return { editor, displayName: "Ada" };
		},
		exercise: ({ editor, displayName }) => {
			editor.displayName = displayName;
		},
		verify: (_, { editor, displayName }) => {
			expect(editor.displayName).toBe(displayName);
			expect(editor.accessToken).toBe("member-token-1");
			expect(profileOpens).toBe(2);
			expect(closedProfiles).toEqual([1]);
			expect(collectedDiagnostics).toEqual([1]);
		},
	}),
);

// These cases drive individual attempts to control overlap, failure, and cancellation.
test(
	"concurrent scenarios reuse one credential while owning separate resources",
	mint({
		setup: () => {
			const signIns: string[] = [];
			const releases: string[] = [];
			const profileIds = ["ada", "grace"];
			const authenticate = async () => {
				signIns.push("sign in");
				await delay(0);
				return { token: "member-token" };
			};
			const memberTemplate = createTemplate({ shared: authenticate });
			const otherTemplate = createTemplate({ shared: authenticate });
			const unusedTemplate = createTemplate({ shared: authenticate });
			const attempts = profileIds.map((id) =>
				memberTemplate({
					setup: ({ token }, { scope }) =>
						scope.using(
							"profile editor",
							() => ({ id, token, closed: false }),
							(editor) => {
								editor.closed = true;
								releases.push(editor.id);
							},
						),
					exercise: (editor) => ({ id: editor.id, token: editor.token }),
					verify: (result, editor) => {
						expect(result).toEqual({ id, token: "member-token" });
						expect(editor.closed).toBe(false);
					},
				}),
			);
			const readCredential = {
				setup: ({ token }: { token: string }) => token,
				exercise: (token: string) => token,
				verify: (token: string) => expect(token).toBe("member-token"),
			};
			const standalone = otherTemplate(readCredential);
			unusedTemplate(readCredential);
			return { signIns, releases, profileIds, attempts, standalone };
		},
		exercise: async ({ attempts, standalone, signIns }) => {
			const beforeExecution = signIns.length;
			await Promise.all(attempts.map((attempt) => executeDefinition(attempt)));
			const afterConcurrent = signIns.length;
			await executeDefinition(standalone);
			return { beforeExecution, afterConcurrent };
		},
		verify: (
			{ beforeExecution, afterConcurrent },
			{ signIns, releases, profileIds },
		) => {
			expect(beforeExecution).toBe(0);
			expect(afterConcurrent).toBe(1);
			expect(signIns).toEqual(["sign in", "sign in"]);
			expect(releases).toHaveLength(profileIds.length);
			expect(releases).toEqual(expect.arrayContaining(profileIds));
		},
	}),
);

test(
	"a failed sign-in keeps its original error for concurrent and later dependents",
	mint({
		setup: () => {
			const failure = new Error("sign-in unavailable");
			const calls: string[] = [];
			const memberTemplate = createTemplate({
				shared: () => {
					calls.push("sign in");
					throw failure;
				},
			});
			const scenario = memberTemplate({
				setup: () => calls.push("open profile"),
				exercise: () => calls.push("save profile"),
				verify: () => calls.push("check profile"),
			});
			return { failure, calls, scenario };
		},
		exercise: async ({ scenario }) => {
			const concurrent = await Promise.allSettled([
				executeDefinition(scenario),
				executeDefinition(scenario),
			]);
			return concurrent.concat(
				await Promise.allSettled([executeDefinition(scenario)]),
			);
		},
		verify: (outcomes, { failure, calls }) => {
			expect(outcomes).toHaveLength(3);
			for (const outcome of outcomes) {
				expect(outcome.status).toBe("rejected");
				if (outcome.status === "rejected") expect(outcome.reason).toBe(failure);
			}
			expect(calls).toEqual(["sign in"]);
		},
	}),
);

test(
	"cancelling a waiting attempt leaves prepared credentials available to other attempts",
	mint({
		setup: () => {
			const controller = new AbortController();
			const openedProfiles: string[] = [];
			const memberTemplate = createTemplate({
				shared: async () => {
					controller.abort(new Error("attempt cancelled"));
					return { token: "member-token" };
				},
			});
			const scenario = memberTemplate({
				setup: ({ token }) => openedProfiles.push(token),
				exercise: () => undefined,
				verify: () => undefined,
			});
			return { controller, openedProfiles, scenario };
		},
		exercise: ({ controller, scenario }) =>
			Promise.allSettled([
				executeDefinition(scenario, { signal: controller.signal }),
				executeDefinition(scenario),
			]),
		verify: (outcomes, { controller, openedProfiles }) => {
			expect(outcomes).toEqual([
				{ status: "rejected", reason: controller.signal.reason },
				{ status: "fulfilled", value: undefined },
			]);
			expect(openedProfiles).toEqual(["member-token"]);
		},
	}),
);

test(
	"a failed template before hook releases what it opened and skips after",
	mint({
		setup: () => {
			const unavailable = new Error("workspace configuration failed");
			const calls: string[] = [];
			const workspaceTemplate = createTemplate({
				shared: () => ({ token: "member-token" }),
				attempt: {
					before: async ({ token }, { scope }) => {
						await scope.using(
							"workspace",
							() => ({ token }),
							(workspace) => calls.push(`close ${workspace.token}`),
						);
						throw unavailable;
					},
					after: () => calls.push("collect workspace diagnostics"),
				},
			});
			const scenario = workspaceTemplate({
				setup: () => calls.push("open profile"),
				exercise: () => calls.push("save profile"),
				verify: () => calls.push("check profile"),
			});
			return { unavailable, calls, scenario };
		},
		exercise: ({ scenario }) =>
			Promise.allSettled([executeDefinition(scenario)]),
		verify: (outcomes, { unavailable, calls }) => {
			expect(outcomes).toEqual([{ status: "rejected", reason: unavailable }]);
			expect(calls).toEqual(["close member-token"]);
		},
	}),
);
