#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const input = process.argv[2] ?? "check-results/vitest-results.json";
const output = process.argv[3] ?? "check-results/test-summary.json";
const runId = positiveInteger(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
const runAttempt = positiveInteger(
	process.env.GITHUB_RUN_ATTEMPT ?? "1",
	"GITHUB_RUN_ATTEMPT",
);

const report = JSON.parse(await readFile(input, "utf8"));
const files = Array.isArray(report.testResults) ? report.testResults : [];
const counts = files.reduce(
	(total, file) => {
		for (const assertion of file.assertionResults ?? []) {
			if (assertion.status === "passed") total.passed += 1;
			else if (assertion.status === "failed") total.failed += 1;
			else if (assertion.status === "skipped" || assertion.status === "pending")
				total.skipped += 1;
		}
		return total;
	},
	{ passed: 0, failed: 0, skipped: 0 },
);

const summary = {
	schemaVersion: 1,
	runId,
	runAttempt,
	headSha: process.env.GITHUB_SHA ?? "local",
	total: counts.passed + counts.failed + counts.skipped,
	...counts,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(summary)}\n`, "utf8");

function positiveInteger(value, name) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return number;
}
