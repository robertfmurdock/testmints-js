import { expect, test } from "@playwright/test";

import { createMint, mint } from "../src/playwright.js";

test("records failed verification before successful teardown", () =>
	mint({
		setup: () => "Ada",
		exercise: (name) => `Hello, ${name}`,
		verify: (greeting) => expect(greeting).toBe("Hello, Grace"),
		teardown: () => undefined,
	}));

function createServiceMint(
	registerDisposal: (dispose: () => Promise<void>) => void,
) {
	return createMint(
		{
			shared: ({ scope }) =>
				scope.using(
					"profile service",
					() => ({ port: 3000 }),
					() => {
						throw new Error("worker could not close the profile service");
					},
				),
		},
		registerDisposal,
	);
}

const workerTest = test.extend<
	object,
	{ serviceMint: ReturnType<typeof createServiceMint> }
>({
	serviceMint: [
		async (
			// biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring.
			{},
			use,
		) => {
			let dispose: (() => Promise<void>) | undefined;
			const serviceMint = createServiceMint((close) => {
				dispose = close;
			});
			try {
				await use(serviceMint);
			} finally {
				await dispose?.();
			}
		},
		{ scope: "worker" },
	],
});

workerTest(
	"reports a shared resource failure from worker teardown",
	({ serviceMint }) =>
		serviceMint({
			setup: ({ port }) => port,
			exercise: (port) => new URL(`http://localhost:${port}/profiles`),
			verify: (url, port) => expect(url.port).toBe(String(port)),
		}),
);
