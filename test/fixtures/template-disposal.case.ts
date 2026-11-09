import { afterAll, expect, test } from "vitest";
import { createMint } from "../../src/vitest.js";

const serviceMint = createMint(
	{
		shared: ({ scope }) =>
			scope.using(
				"profile service",
				() => ({ port: 3000 }),
				() => {
					throw new Error("suite could not close the profile service");
				},
			),
	},
	afterAll,
);

test(
	"builds a profile URL before suite teardown",
	serviceMint({
		setup: ({ port }) => port,
		exercise: (port) => new URL(`http://localhost:${port}/profiles`),
		verify: (url, port) => expect(url.port).toBe(String(port)),
	}),
);
