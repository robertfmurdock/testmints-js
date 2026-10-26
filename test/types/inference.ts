import { test } from "vitest";

import { mint } from "../../src/vitest.js";

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
