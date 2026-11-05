import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [tarball] = process.argv.slice(2);
const version = process.env.RELEASE_VERSION;

if (tarball === undefined)
	throw new Error("A release tarball path is required.");
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
	throw new Error("RELEASE_VERSION must be a stable semantic version.");
}

const directory = await mkdtemp(resolve(tmpdir(), "testmints-consumer-"));
try {
	await exec("npm", [
		"install",
		"--ignore-scripts",
		"--no-package-lock",
		"--prefix",
		directory,
		resolve(tarball),
	]);
	await writeFile(
		resolve(directory, "verify.mjs"),
		[
			'import assert from "node:assert/strict";',
			'import { executeDefinition, validateDefinition } from "@continuous-excellence/testmints-js";',
			'import { mint as vitestMint } from "@continuous-excellence/testmints-js/vitest";',
			'import { mint } from "@continuous-excellence/testmints-js/playwright";',
			'import TestmintsPlaywrightReporter from "@continuous-excellence/testmints-js/playwright/reporter";',
			'if (typeof executeDefinition !== "function" || typeof vitestMint !== "function" || typeof mint !== "function" || typeof TestmintsPlaywrightReporter !== "function") {',
			'  throw new Error("Published exports are unavailable.");',
			"}",
			"const calls = [];",
			"await executeDefinition(validateDefinition({",
			"  setup: async ({ scope }) => {",
			"    await scope.using('consumer resource', () => 21, () => calls.push('release'));",
			"    calls.push('setup');",
			"    return 21;",
			"  },",
			"  exercise: async (input) => { calls.push('exercise'); return input * 2; },",
			"  verify: (output) => { assert.equal(output, 42); calls.push('verify'); },",
			"  teardown: () => { calls.push('teardown'); },",
			"}));",
			"assert.deepEqual(calls, ['setup', 'exercise', 'verify', 'teardown', 'release']);",
		].join("\n"),
	);
	await exec(process.execPath, [resolve(directory, "verify.mjs")], {
		cwd: directory,
	});
	try {
		await exec(resolve(directory, "node_modules", ".bin", "testmints"), []);
		throw new Error(
			"The Testmints CLI unexpectedly succeeded without arguments.",
		);
	} catch (error) {
		const detail = error;
		if (typeof detail !== "object" || detail === null || !("code" in detail))
			throw error;
		if (detail.code !== 2) throw error;
	}
	console.log(`Verified @continuous-excellence/testmints-js@${version}.`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
