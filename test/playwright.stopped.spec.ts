import { appendFile } from "node:fs/promises";
import { test } from "@playwright/test";
import { mint } from "../src/playwright.js";

for (const scenario of ["timeout", "interruption"]) {
	test(`a hanging exercise preserves the runner ${scenario}`, () => {
		test.setTimeout(scenario === "timeout" ? 500 : 30_000);
		const record = (message: string) =>
			appendFile(process.env.TESTMINTS_LIFECYCLE_FILE ?? "", `${message}\n`);
		return mint({
			setup: async ({ scope }) => {
				await scope.using(
					"temporary resource",
					async () => {
						await record("acquired");
						return "resource";
					},
					() => record("released"),
				);
			},
			exercise: async () => {
				await record("exercise");
				console.log("TESTMINTS_HANGING_EXERCISE");
				await new Promise<void>(() => {});
			},
			verify: () => record("verify"),
			teardown: () => record("teardown"),
		});
	});
}
