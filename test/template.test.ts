import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";

import { createTemplate, executeDefinition } from "../src/core.js";
import { mint } from "../src/vitest.js";

test(
	"concurrent scenarios reuse one credential while owning separate resources",
	mint({
		setup: () => {
			const preparations: string[] = [];
			const releases: string[] = [];
			const profileIds = ["ada", "grace"];
			const authenticate = async () => {
				preparations.push("sign in");
				await delay(0);
				return { token: "member-token" };
			};
			const bind = createTemplate({ shared: authenticate });
			const independent = createTemplate({ shared: authenticate });
			const unused = createTemplate({ shared: authenticate });
			const attempts = profileIds.map((id) =>
				bind({
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
			const standalone = independent(readCredential);
			unused(readCredential);
			return { preparations, releases, profileIds, attempts, standalone };
		},
		exercise: async ({ attempts, standalone, preparations }) => {
			const beforeExecution = preparations.length;
			await Promise.all(attempts.map((attempt) => executeDefinition(attempt)));
			const afterConcurrent = preparations.length;
			await executeDefinition(standalone);
			return { beforeExecution, afterConcurrent };
		},
		verify: (
			{ beforeExecution, afterConcurrent },
			{ preparations, releases, profileIds },
		) => {
			expect(beforeExecution).toBe(0);
			expect(afterConcurrent).toBe(1);
			expect(preparations).toEqual(["sign in", "sign in"]);
			expect(releases).toHaveLength(profileIds.length);
			expect(releases).toEqual(expect.arrayContaining(profileIds));
		},
	}),
);

test(
	"cancelling a waiting attempt leaves prepared credentials available to other attempts",
	mint({
		setup: () => {
			const controller = new AbortController();
			const openedProfiles: string[] = [];
			const bind = createTemplate({
				shared: async () => {
					controller.abort(new Error("attempt cancelled"));
					return { token: "member-token" };
				},
			});
			const scenario = bind({
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
	"a failed sign-in keeps its original error for concurrent and later dependents",
	mint({
		setup: () => {
			const failure = new Error("sign-in unavailable");
			const calls: string[] = [];
			const bind = createTemplate({
				shared: () => {
					calls.push("sign in");
					throw failure;
				},
			});
			const scenario = bind({
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
