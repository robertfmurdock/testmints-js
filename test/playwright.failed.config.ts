import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "playwright.failed.spec.ts",
	reporter: [
		["list"],
		[
			"./playwright.reporter.ts",
			{ outputDir: ".testmints-playwright-failed-fixture" },
		],
	],
});
