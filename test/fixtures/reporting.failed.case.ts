import { expect } from "vitest";

import { mintTest } from "../../src/vitest.js";

mintTest("shows verification failure after an exported report is created", {
	setup: () => ({ expectedText: "Member: Ada" }),
	exercise: (_input, { scope }) =>
		scope.using(
			"exported report",
			() => ({ text: "Member: Grace", removed: false }),
			(report) => {
				report.removed = true;
			},
		),
	verify: (report, { expectedText }) => expect(report.text).toBe(expectedText),
});
