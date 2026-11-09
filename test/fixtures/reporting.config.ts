import { defineConfig } from "vitest/config";

import { testmintsVitest } from "../../src/vitest.js";

export default defineConfig({
	test: {
		include: [
			"test/fixtures/reporting.case.ts",
			"test/fixtures/reporting.failed.case.ts",
			"test/fixtures/template-disposal.case.ts",
		],
	},
	plugins: [testmintsVitest({ outputDir: ".testmints-fixture" })],
});
