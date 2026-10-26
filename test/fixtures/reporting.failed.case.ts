import { expect, test } from "vitest";

import { mint } from "../../src/vitest.js";

test(
	"shows verification failure after an exported report is created",
	mint({
		setup: () => ({ expectedText: "Member: Ada" }),
		exercise: (_input, { scope }) =>
			scope.using(
				"exported report",
				() => ({ text: "Member: Grace", removed: false }),
				(report) => {
					report.removed = true;
				},
			),
		verify: (report, { expectedText }) =>
			expect(report.text).toBe(expectedText),
	}),
);
