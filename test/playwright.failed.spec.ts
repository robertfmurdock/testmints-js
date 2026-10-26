import { expect, test } from "@playwright/test";

import { mint } from "../src/playwright.js";

test("records failed verification before successful teardown", () =>
	mint({
		setup: () => "Ada",
		exercise: (name) => `Hello, ${name}`,
		verify: (greeting) => expect(greeting).toBe("Hello, Grace"),
		teardown: () => undefined,
	}));
