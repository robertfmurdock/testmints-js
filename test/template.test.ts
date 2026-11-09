import { afterAll, expect, test } from "vitest";

import { createMint } from "../src/vitest.js";

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
	const sharedEvents: string[] = [];
	const adminSessions: string[][] = [];
	const serviceMint = createMint(
		{
			shared: ({ scope }) =>
				scope.using(
					"profile service",
					() => {
						sharedEvents.push("open service");
						return { baseUrl: "https://profiles.example.test/" };
					},
					() => sharedEvents.push("close service"),
				),
			attempt: {
				before: ({ baseUrl }) => ({
					memberPage: new URL("members/", baseUrl),
					events: ["start member session"],
				}),
				after: ({ events }) => events.push("end member session"),
			},
		},
		(dispose) =>
			afterAll(async () => {
				await dispose();
				if (adminSessions.length === 0) {
					expect(sharedEvents).toEqual(["open service", "close service"]);
				} else {
					expect(sharedEvents).toEqual([
						"open service",
						"open admin connection",
						"close admin connection",
						"close service",
					]);
					expect(adminSessions).toEqual([
						[
							"start member session",
							"start admin session",
							"end admin session",
							"end member session",
						],
					]);
				}
			}),
	);

	const adminMint = serviceMint.extend({
		shared: ({ baseUrl }, { scope }) =>
			scope.using(
				"admin connection",
				() => {
					sharedEvents.push("open admin connection");
					return { adminPage: new URL("admin/", baseUrl) };
				},
				() => sharedEvents.push("close admin connection"),
			),
		attempt: {
			before: ({ adminPage }, _tools, { memberPage, events }) => {
				events.push("start admin session");
				adminSessions.push(events);
				return { adminPage, memberPage, events };
			},
			after: ({ events }) => events.push("end admin session"),
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
