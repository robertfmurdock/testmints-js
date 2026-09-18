import { mintTest } from "../../src/vitest.js";

mintTest("infers anonymous setup values", {
	setup: async () => ({ id: "ada", active: true }),
	exercise: ({ id, active }) => (active ? id.length : 0),
	verify: (length, input) => {
		const _: number = length;
		const name: string = input.id;
		void _;
		void name;
	},
});

mintTest("permits void exercise output", {
	setup: (): { messages: string[] } => ({ messages: [] }),
	exercise: ({ messages }) => {
		messages.push("welcome");
	},
	verify: (output, input) => {
		void output;
		const messages: string[] = input.messages;
		void messages;
	},
});

mintTest("rejects incompatible phase data", {
	setup: () => ({ id: "ada" }),
	// @ts-expect-error setup data has no numeric `missing` property
	exercise: (input) => input.missing,
	verify: () => undefined,
});

mintTest("infers resource and teardown values", {
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
});
