import { afterAll, test } from "vitest";

import { createMint as createPlaywrightMint } from "../../src/playwright.js";
import { createMint, mint } from "../../src/vitest.js";

test(
	"infers anonymous setup values",
	mint({
		setup: async () => ({ id: "ada", active: true }),
		exercise: ({ id, active }) => (active ? id.length : 0),
		verify: (length, input) => {
			const _: number = length;
			const name: string = input.id;
			void _;
			void name;
		},
	}),
);

test(
	"permits void exercise output",
	mint({
		setup: (): { messages: string[] } => ({ messages: [] }),
		exercise: ({ messages }) => {
			messages.push("welcome");
		},
		verify: (output, input) => {
			void output;
			const messages: string[] = input.messages;
			void messages;
		},
	}),
);

test(
	"rejects incompatible phase data",
	mint({
		setup: () => ({ id: "ada" }),
		// @ts-expect-error setup data has no numeric `missing` property
		exercise: (input) => input.missing,
		verify: () => undefined,
	}),
);

test(
	"infers resource and teardown values",
	mint({
		setup: async ({ scope }) => ({
			connection: await scope.using(
				"connection",
				() => ({ id: "db-1" }),
				(connection) => {
					const _: string = connection.id;
					void _;
				},
			),
		}),
		exercise: ({ connection }) => connection.id,
		verify: (id) => {
			const _: string = id;
			void _;
		},
		teardown: ({ connection }) => {
			const _: string = connection.id;
			void _;
		},
	}),
);

const authenticatedMint = createMint({
	shared: async () => ({ token: "member-token" }),
});

test(
	"infers configured Vitest phase data",
	authenticatedMint({
		setup: ({ token }, { signal }) => ({ token, signal }),
		exercise: async ({ token }) => token.length,
		verify: (length, input) => {
			const size: number = length;
			const signal: AbortSignal = input.signal;
			void size;
			void signal;
		},
	}),
);

function checkPlaywrightTemplateTypes() {
	const serverMint = createPlaywrightMint({ shared: () => ({ port: 3000 }) });
	return serverMint({
		setup: (server) => {
			// @ts-expect-error The configured context contains a port, not a URL.
			void server.url;
			return server.port;
		},
		exercise: (port) => `http://localhost:${port.toFixed()}`,
		verify: (url) => {
			const address: string = url;
			void address;
		},
	});
}
void checkPlaywrightTemplateTypes;

function checkDisposalRegistrarTypes() {
	const options = { shared: () => ({ port: 3000 }) };
	const asyncRegistration = async () => {};
	// @ts-expect-error Vitest requires disposal registration during mint creation.
	createMint(options, asyncRegistration);
	// @ts-expect-error Playwright requires disposal registration during mint creation.
	createPlaywrightMint(options, asyncRegistration);
}
void checkDisposalRegistrarTypes;

const profileSessionMint = createMint(
	{
		attempt: {
			before: ({ signal }) => ({ signal }),
			after: ({ signal }) => signal.throwIfAborted(),
		},
	},
	afterAll,
);

const profileIndexMint = profileSessionMint.extend({
	shared: (parent, { scope }) => {
		const inherited: undefined = parent;
		void inherited;
		return scope.using(
			"profile index",
			() => new Map<string, URL>(),
			() => {},
		);
	},
	attempt: {
		before: (index, _tools, { signal }) => ({ index, signal }),
	},
});

test(
	"infers shared and attempt context separately for descendants of an attempt-only mint",
	profileIndexMint({
		setup: ({ index, signal }) => {
			signal.throwIfAborted();
			// @ts-expect-error The profile index maps names to URLs.
			index.set("ada", 42);
			return index.get("ada");
		},
		exercise: (profile) => profile?.pathname,
		verify: (path) => {
			const profilePath: string | undefined = path;
			void profilePath;
		},
	}),
);

const workspaceMint = createMint({
	shared: async () => ({ token: "member-token" }),
	attempt: {
		before: async ({ token }, { scope }) =>
			scope.using(
				"workspace",
				() => ({ id: token.length }),
				() => undefined,
			),
		after: ({ id }, { signal }) => {
			const workspaceId: number = id;
			const cleanupSignal: AbortSignal = signal;
			void workspaceId;
			void cleanupSignal;
		},
	},
});

const auditMint = workspaceMint.extend({
	shared: (credentials) => {
		// @ts-expect-error Shared initialization receives credentials, not the attempt workspace.
		void credentials.id;
		return { auditToken: credentials.token };
	},
	attempt: {
		before: ({ auditToken }, _tools, parentWorkspace) => ({
			auditToken,
			workspaceId: parentWorkspace.id,
		}),
		after: ({ workspaceId }) => {
			const id: number = workspaceId;
			void id;
		},
	},
});

const memberWorkspaceMint = workspaceMint.extend({
	attempt: { before: ({ id }) => ({ memberWorkspaceId: id }) },
});

const workspaceReportMint = memberWorkspaceMint.extend({
	shared: ({ token }) => ({ reportToken: token }),
	attempt: {
		before: ({ reportToken }, _tools, { memberWorkspaceId }) => ({
			reportToken,
			memberWorkspaceId,
		}),
	},
});

test(
	"an attempt-only layer preserves shared context for later extensions",
	workspaceReportMint({
		setup: ({ memberWorkspaceId, reportToken }) => ({
			memberWorkspaceId,
			reportToken,
		}),
		exercise: ({ memberWorkspaceId, reportToken }) =>
			memberWorkspaceId + reportToken.length,
		verify: (length) => {
			const size: number = length;
			void size;
		},
	}),
);

test(
	"infers child setup from its hook and the parent's attempt context",
	auditMint({
		setup: ({ workspaceId }) => workspaceId,
		exercise: (id) => id.toFixed(),
		verify: (label) => {
			const name: string = label;
			void name;
		},
	}),
);

test(
	"infers the attempt context separately from shared credentials",
	workspaceMint({
		setup: (workspace) => {
			// @ts-expect-error Scenario setup receives the workspace from before.
			void workspace.token;
			return workspace.id;
		},
		exercise: (id) => id.toFixed(),
		verify: (label) => {
			const name: string = label;
			void name;
		},
	}),
);
