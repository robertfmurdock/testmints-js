import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		expect: { requireAssertions: true },
		exclude: ["test/**/*.spec.ts"],
	},
});
