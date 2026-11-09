import { expect, test } from "@playwright/test";

import { createMint } from "../src/playwright.js";

const members = [
	{ id: "ada", displayName: "Ada" },
	{ id: "grace", displayName: "Grace" },
];

function createDirectoryMint(
	registerDisposal: (dispose: () => Promise<void>) => void,
) {
	return createMint(
		{
			shared: ({ scope }) =>
				scope.using(
					"profile directory",
					() => {
						console.log("profile directory: open");
						const profiles = new Map(
							members.map(({ id, displayName }) => [id, displayName]),
						);
						return {
							read: (id: string) => {
								console.log("profile directory: read");
								return profiles.get(id);
							},
							close: () => {
								profiles.clear();
								console.log("profile directory: close");
							},
						};
					},
					(directory) => directory.close(),
				),
		},
		registerDisposal,
	);
}

const directoryTest = test.extend<
	object,
	{ directoryMint: ReturnType<typeof createDirectoryMint> }
>({
	directoryMint: [
		async (
			// biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring.
			{},
			use,
		) => {
			let dispose: (() => Promise<void>) | undefined;
			const directoryMint = createDirectoryMint((close) => {
				dispose = close;
			});
			try {
				await use(directoryMint);
			} finally {
				await dispose?.();
			}
		},
		{ scope: "worker" },
	],
});

for (const member of members) {
	directoryTest(
		`reads ${member.displayName}'s profile from the worker directory`,
		({ directoryMint }) =>
			directoryMint({
				setup: (directory) => ({ directory, member }),
				exercise: ({ directory, member }) => directory.read(member.id),
				verify: (name, { member }) => expect(name).toBe(member.displayName),
			}),
	);
}
