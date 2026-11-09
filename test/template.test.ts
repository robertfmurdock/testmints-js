import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect, test } from "vitest";

import {
	bindTemplate,
	createTemplate,
	executeDefinition,
	type SetupTools,
	type SharedTools,
} from "../src/core.js";
import { createMint, mint } from "../src/vitest.js";

const profileLinkMint = createMint({
	shared: () => ({ baseUrl: "https://profiles.example.test/" }),
});

const draftMint = createMint({
	attempt: {
		before: ({ scope }) =>
			scope.using(
				"profile draft",
				() => new Map<string, string>(),
				(draft) => draft.clear(),
			),
	},
});

test(
	"a mint with only attempt hooks opens a draft for the scenario",
	draftMint({
		setup: (draft) => ({ draft, displayName: "Ada" }),
		exercise: ({ draft, displayName }) => draft.set("displayName", displayName),
		verify: (draft, { displayName }) =>
			expect(draft.get("displayName")).toBe(displayName),
	}),
);

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

const auditLinkMint = profileLinkMint.extend({
	attempt: {
		before: ({ baseUrl }) => ({ auditPage: new URL("audit/", baseUrl) }),
	},
});

test(
	"an attempt-only extension derives an audit page from its parent",
	auditLinkMint({
		setup: ({ auditPage }) => ({ auditPage, entry: "sign-ins" }),
		exercise: ({ auditPage, entry }) => new URL(entry, auditPage),
		verify: (link, { entry }) => expect(link.pathname).toBe(`/audit/${entry}`),
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

test.describe("a suite owns a shared service and its specialized mints", () => {
	const events: string[] = [];
	const serviceMint = createMint(
		{
			shared: ({ scope }) =>
				scope.using(
					"profile service",
					() => {
						events.push("open service");
						return { baseUrl: "https://profiles.example.test/" };
					},
					() => events.push("close service"),
				),
			attempt: {
				before: ({ baseUrl }) => {
					events.push("start member session");
					return { memberPage: new URL("members/", baseUrl) };
				},
				after: () => events.push("end member session"),
			},
		},
		(dispose) =>
			afterAll(async () => {
				await dispose();
				const sharedEvents = events.filter(
					(event) => event.startsWith("open ") || event.startsWith("close "),
				);
				const adminStart = events.indexOf("start admin session");
				if (adminStart === -1) {
					expect(sharedEvents).toEqual(["open service", "close service"]);
				} else {
					expect(sharedEvents).toEqual([
						"open service",
						"open admin connection",
						"close admin connection",
						"close service",
					]);
					expect(events.slice(adminStart - 2, adminStart + 3)).toEqual([
						"start member session",
						"open admin connection",
						"start admin session",
						"end admin session",
						"end member session",
					]);
				}
			}),
	);

	const adminMint = serviceMint.extend({
		shared: ({ baseUrl }, { scope }) =>
			scope.using(
				"admin connection",
				() => {
					events.push("open admin connection");
					return { adminPage: new URL("admin/", baseUrl) };
				},
				() => events.push("close admin connection"),
			),
		attempt: {
			before: ({ adminPage }, _tools, { memberPage }) => {
				events.push("start admin session");
				return { adminPage, memberPage };
			},
			after: () => events.push("end admin session"),
		},
	});

	const auditMint = serviceMint.extend({
		attempt: {
			before: ({ memberPage }) => ({
				auditPage: new URL("../audit/", memberPage),
			}),
		},
	});

	test(
		"an administrator can build a member management link",
		adminMint({
			setup: (session) => ({ ...session, memberId: "ada" }),
			exercise: ({ adminPage, memberId }) => new URL(memberId, adminPage),
			verify: (link, { memberPage, memberId }) => {
				expect(link.origin).toBe(memberPage.origin);
				expect(link.pathname).toBe(`/admin/${memberId}`);
			},
		}),
	);

	test(
		"a reviewer can build a link to the sign-in audit",
		auditMint({
			setup: ({ auditPage }) => ({ auditPage, entry: "sign-ins" }),
			exercise: ({ auditPage, entry }) => new URL(entry, auditPage),
			verify: (link, { entry }) =>
				expect(link.pathname).toBe(`/audit/${entry}`),
		}),
	);

	test(
		"a member can build a profile link",
		serviceMint({
			setup: ({ memberPage }) => ({ memberPage, memberId: "ada" }),
			exercise: ({ memberPage, memberId }) => new URL(memberId, memberPage),
			verify: (link, { memberId }) =>
				expect(link.pathname).toBe(`/members/${memberId}`),
		}),
	);
});

function gate() {
	let open: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

// These cases drive individual attempts to control overlap, failure, and cancellation.
test(
	"a failed admin connection still collects diagnostics and closes the member session",
	mint({
		setup: () => {
			const unavailable = new Error("admin service unavailable");
			const events: string[] = [];
			const memberTemplate = bindTemplate({
				shared: () => ({ token: "member-token" }),
				attempt: {
					before: (_credentials: unknown, { scope }: SetupTools) =>
						scope.using(
							"member session",
							() => events.push("open member session"),
							() => events.push("close member session"),
						),
					after: () => events.push("collect member diagnostics"),
				},
			});
			const adminTemplate = memberTemplate.extend({
				shared: () => {
					events.push("connect to admin service");
					throw unavailable;
				},
				attempt: { before: () => events.push("open admin session") },
			});
			const scenario = adminTemplate.bind({
				setup: () => events.push("open admin profile"),
				exercise: () => undefined,
				verify: () => undefined,
			});
			return { unavailable, events, scenario };
		},
		exercise: ({ scenario }) =>
			Promise.allSettled([executeDefinition(scenario)]),
		verify: ([outcome], { unavailable, events }) => {
			expect(events).toEqual([
				"open member session",
				"connect to admin service",
				"collect member diagnostics",
				"close member session",
			]);
			expect(outcome?.status === "rejected" && outcome.reason).toBe(
				unavailable,
			);
		},
	}),
);

test(
	"disposal lets an active attempt finish cleanup and rejects new attempts",
	mint({
		setup: () => {
			const events: string[] = [];
			const started = gate();
			const finish = gate();
			const template = bindTemplate(
				{
					shared: ({ scope }: SharedTools) =>
						scope.using(
							"service",
							() => undefined,
							() => events.push("close service"),
						),
				},
				() => undefined,
			);
			const scenario = template.bind({
				setup: () => undefined,
				exercise: async () => {
					started.open();
					await finish.promise;
				},
				verify: () => undefined,
				teardown: () => events.push("close request"),
			});
			const lateRequest = template.bind({
				setup: () => undefined,
				exercise: () => undefined,
				verify: () => undefined,
			});
			return { events, started, finish, template, scenario, lateRequest };
		},
		exercise: async ({ started, finish, template, scenario, lateRequest }) => {
			const active = executeDefinition(scenario);
			await started.promise;
			const disposal = template.dispose();
			const duplicate = template.dispose();
			const [lateAttempt] = await Promise.allSettled([
				executeDefinition(lateRequest),
			]);
			finish.open();
			await Promise.all([active, disposal, duplicate]);
			return lateAttempt;
		},
		verify: (lateAttempt, { events }) => {
			expect(lateAttempt).toMatchObject({
				status: "rejected",
				reason: { message: "Cannot use a disposed Testmint template." },
			});
			expect(events).toEqual(["close request", "close service"]);
		},
	}),
);

test(
	"an interrupted teardown wrapper still releases the active request",
	mint({
		setup: () => {
			const interruption = new Error("runner could not open the teardown step");
			const events: string[] = [];
			const template = bindTemplate({ shared: () => undefined });
			const scenario = template.bind({
				setup: (_, { scope }) =>
					scope.using(
						"request",
						() => undefined,
						() => events.push("close request"),
					),
				exercise: () => undefined,
				verify: () => undefined,
			});
			return { events, interruption, scenario };
		},
		exercise: ({ scenario, interruption }) =>
			Promise.allSettled([
				executeDefinition(scenario, {
					executePhase: (phase, callback) => {
						if (phase === "teardown") throw interruption;
						return callback();
					},
				}),
			]),
		verify: (outcomes, { events, interruption }) => {
			expect(outcomes).toEqual([{ status: "rejected", reason: interruption }]);
			expect(events).toEqual(["close request"]);
		},
	}),
);

test(
	"failed shared preparation rolls back and retains its cleanup failure",
	mint({
		setup: () => {
			const unavailable = new Error("service configuration failed");
			const closeFailure = new Error("service close failed");
			const events: string[] = [];
			const template = bindTemplate(
				{
					shared: async ({ scope }: SharedTools) => {
						await scope.using(
							"service",
							() => undefined,
							() => {
								events.push("close service");
								throw closeFailure;
							},
						);
						throw unavailable;
					},
				},
				() => undefined,
			);
			const scenario = template.bind({
				setup: () => events.push("open request"),
				exercise: () => undefined,
				verify: () => undefined,
			});
			return { unavailable, closeFailure, events, template, scenario };
		},
		exercise: async ({ template, scenario, events }) => {
			const [first] = await Promise.allSettled([executeDefinition(scenario)]);
			const [later] = await Promise.allSettled([executeDefinition(scenario)]);
			const beforeDisposal = [...events];
			await template.dispose();
			return { first, later, beforeDisposal };
		},
		verify: (
			{ first, later, beforeDisposal },
			{ unavailable, closeFailure, events },
		) => {
			expect(first).toMatchObject({
				status: "rejected",
				reason: { errors: [unavailable, closeFailure] },
			});
			expect(later).toEqual(first);
			expect(beforeDisposal).toEqual(["close service"]);
			expect(events).toEqual(beforeDisposal);
		},
	}),
);

test(
	"preparation starts only when a template instance is used",
	mint({
		setup: () => {
			const signIns: string[] = [];
			const signIn = () => {
				signIns.push("sign in");
				return { token: "member-token" };
			};
			const profile = {
				setup: ({ token }: { token: string }) => token,
				exercise: (token: string) => `Bearer ${token}`,
				verify: (authorization: string) =>
					expect(authorization).toBe("Bearer member-token"),
			};
			const first = createTemplate({ shared: signIn })(profile);
			const second = createTemplate({ shared: signIn })(profile);
			createTemplate({ shared: signIn })(profile);
			return { signIns, first, second };
		},
		exercise: async ({ signIns, first, second }) => {
			const beforeExecution = signIns.length;
			await executeDefinition(first);
			await executeDefinition(second);
			return beforeExecution;
		},
		verify: (beforeExecution, { signIns }) => {
			expect(beforeExecution).toBe(0);
			expect(signIns).toEqual(["sign in", "sign in"]);
		},
	}),
);

async function beforeDeadline(observation: Promise<unknown>): Promise<boolean> {
	const deadline = new AbortController();
	try {
		return await Promise.race([
			observation.then(() => true),
			delay(1_000, false, { signal: deadline.signal }),
		]);
	} finally {
		deadline.abort();
	}
}

test(
	"concurrent scenarios wait for one sign-in and exercise independently",
	mint({
		setup: () => {
			const profileIds = ["ada", "grace"];
			const releases: string[] = [];
			const editing: string[] = [];
			const signIns: string[] = [];
			const signInStarted = gate();
			const finishSignIn = gate();
			const bothEditing = gate();
			const finishEditing = gate();
			const token = "member-token";
			const memberTemplate = createTemplate({
				shared: async () => {
					signIns.push("sign in");
					signInStarted.open();
					await finishSignIn.promise;
					return { token };
				},
			});
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
					exercise: async (editor) => {
						editing.push(editor.id);
						if (editing.length === profileIds.length) bothEditing.open();
						await finishEditing.promise;
						return editor.token;
					},
					verify: (accessToken, editor) => {
						expect(accessToken).toBe(token);
						expect(editor.closed).toBe(false);
					},
				}),
			);
			return {
				attempts,
				profileIds,
				releases,
				signIns,
				signInStarted,
				finishSignIn,
				bothEditing,
				finishEditing,
			};
		},
		exercise: async ({
			attempts,
			signInStarted,
			finishSignIn,
			bothEditing,
			finishEditing,
		}) => {
			const bothSettingUp = gate();
			let setupsStarted = 0;
			const executions = Promise.allSettled(
				attempts.map((attempt) =>
					executeDefinition(attempt, {
						executePhase: (phase, callback) => {
							const result = callback();
							if (phase === "setup" && ++setupsStarted === attempts.length)
								bothSettingUp.open();
							return result;
						},
					}),
				),
			);
			const setupsEnteredWhileSigningIn = await beforeDeadline(
				Promise.all([signInStarted.promise, bothSettingUp.promise]),
			);
			finishSignIn.open();
			const exercisesOverlapped = await beforeDeadline(bothEditing.promise);
			finishEditing.open();
			return {
				setupsEnteredWhileSigningIn,
				exercisesOverlapped,
				outcomes: await executions,
			};
		},
		verify: (
			{ setupsEnteredWhileSigningIn, exercisesOverlapped, outcomes },
			{ profileIds, releases, signIns },
		) => {
			expect(
				setupsEnteredWhileSigningIn,
				"both setups entered while sign-in was pending",
			).toBe(true);
			expect(exercisesOverlapped, "both exercises reached the barrier").toBe(
				true,
			);
			expect(outcomes).toEqual(
				profileIds.map(() => ({ status: "fulfilled", value: undefined })),
			);
			expect(signIns).toEqual(["sign in"]);
			expect([...releases].sort()).toEqual([...profileIds].sort());
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
