import { expect, test } from "vitest";

import { mint } from "../../src/vitest.js";

test(
	"writes an inspectable phase timeline",
	mint({
		setup: () => 2,
		exercise: (input) => input * 3,
		verify: (output) => expect(output).toBe(6),
	}),
);
