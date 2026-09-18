import { expect } from "vitest";

import { mintTest } from "../../src/vitest.js";

mintTest("writes an inspectable phase timeline", {
	setup: () => 2,
	exercise: (input) => input * 3,
	verify: (output) => expect(output).toBe(6),
});
