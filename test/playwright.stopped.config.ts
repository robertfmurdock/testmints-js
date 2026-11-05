import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "playwright.stopped.spec.ts",
	workers: 1,
	reporter: [
		["list"],
		[
			"./playwright.reporter.ts",
			{ outputDir: process.env.TESTMINTS_STOPPED_OUTPUT },
		],
	],
});
