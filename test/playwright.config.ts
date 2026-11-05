import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "playwright.primary.spec.ts",
	retries: 1,
	reporter: [
		[
			"json",
			{ outputFile: resolve(".testmints-playwright-fixture/native.json") },
		],
		["list"],
		[
			"./playwright.reporter.ts",
			{ outputDir: ".testmints-playwright-fixture" },
		],
	],
	use: { browserName: "chromium", headless: true },
});
