import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "playwright.worker.spec.ts",
	workers: 1,
});
