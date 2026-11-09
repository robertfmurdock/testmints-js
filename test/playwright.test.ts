import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { inspect } from "../src/cli.js";

import { mint } from "../src/vitest.js";

const run = promisify(execFile);
const artifactRoot = resolve(".testmints-playwright-fixture");

test(
	"the Playwright primary suite records native phases in an inspectable artifact stream",
	mint({
		setup: ({ scope }) => {
			scope.defer("Playwright artifacts", () =>
				rm(artifactRoot, { recursive: true, force: true }),
			);
			return undefined;
		},
		exercise: async () => {
			await rm(artifactRoot, { recursive: true, force: true });
			return run("npx", [
				"playwright",
				"test",
				"-c",
				"test/playwright.config.ts",
			]);
		},
		verify: async () => {
			const runs = (await readdir(artifactRoot)).filter((entry) =>
				entry.startsWith("run-"),
			);
			expect(runs).toHaveLength(1);
			const runDirectory = resolve(artifactRoot, runs[0] ?? "");
			const manifest = JSON.parse(
				await readFile(resolve(runDirectory, "manifest.json"), "utf8"),
			) as { status: string; producerFiles: string[] };
			interface NativeSuite {
				suites?: NativeSuite[];
				specs?: {
					title: string;
					tests: { results: { steps?: { title: string }[] }[] }[];
				}[];
			}
			const native = JSON.parse(
				await readFile(resolve(artifactRoot, "native.json"), "utf8"),
			) as NativeSuite;
			function specs(suite: NativeSuite): NonNullable<NativeSuite["specs"]> {
				return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)];
			}
			const nativeScenario = specs(native).find(
				(spec) =>
					spec.title ===
					"the Playwright adapter awaits setup, exercise, verify, and teardown in order",
			);
			expect(nativeScenario).toBeDefined();
			expect(
				nativeScenario?.tests[0]?.results[0]?.steps?.map((step) => step.title),
			).toEqual(["setup", "exercise", "verify", "teardown"]);
			expect(manifest.status).toBe("complete");
			const events = (
				await readFile(
					resolve(runDirectory, "events", manifest.producerFiles[0] ?? ""),
					"utf8",
				)
			)
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							attemptId?: string;
							kind: string;
							phase?: string;
							producerId?: string;
							seq?: number;
							title?: string;
						},
				);
			const phases = events.map((event) => event.phase).filter(Boolean);
			expect(
				events.filter((event) => event.kind === "phase.start"),
			).not.toHaveLength(0);
			expect(phases).toContain("setup");
			expect(phases).toContain("exercise");
			expect(phases).toContain("verify");
			expect(phases).toContain("teardown");
			const retryEvents = events.filter((event) =>
				event.title?.includes("fresh Testmints attempt"),
			);
			const retryAttempts = new Set(
				retryEvents.map((event) => event.attemptId),
			);
			expect(retryAttempts.size).toBe(2);
			expect(new Set(retryEvents.map((event) => event.producerId)).size).toBe(
				2,
			);
			const retry = retryEvents.find((event) =>
				event.attemptId?.endsWith("-1"),
			);
			const fixtureAttempt = events.find((event) =>
				event.title?.includes("a Playwright page and custom fixture"),
			);
			expect(retry?.producerId).toBeDefined();
			expect(fixtureAttempt?.producerId).toBe(retry?.producerId);
			const sequencesByProducer = new Map<string, number[]>();
			for (const event of events) {
				if (event.producerId === undefined || event.seq === undefined) continue;
				const sequences = sequencesByProducer.get(event.producerId) ?? [];
				sequences.push(event.seq);
				sequencesByProducer.set(event.producerId, sequences);
			}
			expect(sequencesByProducer.size).toBeGreaterThan(0);
			for (const sequences of sequencesByProducer.values()) {
				expect(sequences).toEqual(sequences.map((_sequence, index) => index));
			}
		},
	}),
);

test(
	"the Playwright reporter preserves a failed verification and successful teardown",
	mint({
		setup: ({ scope }) => {
			const failedArtifactRoot = resolve(
				".testmints-playwright-failed-fixture",
			);
			scope.defer("failed Playwright artifacts", () =>
				rm(failedArtifactRoot, { recursive: true, force: true }),
			);
			return failedArtifactRoot;
		},
		exercise: async (failedArtifactRoot) => {
			await rm(failedArtifactRoot, { recursive: true, force: true });
			try {
				await run("npx", [
					"playwright",
					"test",
					"-c",
					"test/playwright.failed.config.ts",
					"--grep",
					"records failed verification",
				]);
				return true;
			} catch {
				return false;
			}
		},
		verify: async (passed, failedArtifactRoot) => {
			expect(passed).toBe(false);
			const [runId] = await readdir(failedArtifactRoot);
			const runDirectory = resolve(failedArtifactRoot, runId ?? "");
			const manifest = JSON.parse(
				await readFile(resolve(runDirectory, "manifest.json"), "utf8"),
			) as { producerFiles: string[]; status: string };
			expect(manifest.status).toBe("complete");
			const events = (
				await readFile(
					resolve(runDirectory, "events", manifest.producerFiles[0] ?? ""),
					"utf8",
				)
			)
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							kind: string;
							phase?: string;
							status?: string;
						},
				);
			expect(
				events.some(
					(event) =>
						event.kind === "phase.end" &&
						event.phase === "verify" &&
						event.status === "failed",
				),
			).toBe(true);
			expect(
				events.some(
					(event) =>
						event.kind === "phase.end" &&
						event.phase === "teardown" &&
						event.status === "passed",
				),
			).toBe(true);
		},
	}),
);

test(
	"a Playwright worker shares one profile directory across tests and closes it at shutdown",
	mint({
		setup: () => resolve("test/playwright.worker.config.ts"),
		exercise: (config) =>
			run(process.execPath, [
				"node_modules/@playwright/test/cli.js",
				"test",
				"-c",
				config,
				"--reporter=list",
			]),
		verify: ({ stdout }) => {
			const events = Array.from(
				stdout.matchAll(/profile directory: (open|read|close)/g),
				([, event]) => event,
			);
			expect(events).toEqual(["open", "read", "read", "close"]);
		},
	}),
);

test(
	"a Playwright worker fixture surfaces shared disposal failure at shutdown",
	mint({
		setup: () => "worker could not close the profile service",
		exercise: async () => {
			try {
				const result = await run(process.execPath, [
					"node_modules/@playwright/test/cli.js",
					"test",
					"-c",
					"test/playwright.failed.config.ts",
					"--grep",
					"reports a shared resource failure",
					"--reporter=line",
				]);
				return { passed: true, output: result.stdout };
			} catch (error) {
				return {
					passed: false,
					output:
						String(error) +
						(error && typeof error === "object" && "stdout" in error
							? String(error.stdout)
							: ""),
				};
			}
		},
		verify: ({ passed, output }, message) => {
			expect(passed).toBe(false);
			expect(output).toContain(message);
		},
	}),
);

for (const scenario of ["timeout", "interruption"]) {
	test(
		`a Playwright ${scenario} keeps the runner failure and exposes incomplete artifacts`,
		mint({
			setup: async ({ scope }) =>
				scope.using(
					"stopped run artifacts",
					() => mkdtemp(resolve(tmpdir(), "testmints-stopped-")),
					(directory) => rm(directory, { recursive: true, force: true }),
				),
			exercise: async (directory) => {
				const lifecycle = resolve(directory, "lifecycle.txt");
				const outcome = await new Promise<{
					code: number | string | null;
					stdout: string;
				}>((done) => {
					const child = execFile(
						process.execPath,
						[
							"node_modules/@playwright/test/cli.js",
							"test",
							"-c",
							"test/playwright.stopped.config.ts",
							"--grep",
							`runner ${scenario}`,
						],
						{
							env: {
								...process.env,
								TESTMINTS_LIFECYCLE_FILE: lifecycle,
								TESTMINTS_STOPPED_OUTPUT: resolve(directory, "runs"),
							},
							timeout: 45_000,
						},
						(error, stdout) => done({ code: error?.code ?? 0, stdout }),
					);
					let output = "";
					child.stdout?.on("data", (chunk: string) => {
						output += chunk;
						if (
							scenario === "interruption" &&
							output.includes("TESTMINTS_HANGING_EXERCISE")
						) {
							output = "";
							child.kill("SIGINT");
						}
					});
				});
				const [runId] = await readdir(resolve(directory, "runs"));
				const runDirectory = resolve(directory, "runs", runId ?? "");
				const log = vi
					.spyOn(console, "log")
					.mockImplementation(() => undefined);
				const warning = vi
					.spyOn(console, "error")
					.mockImplementation(() => undefined);
				try {
					const exitCode = await inspect(runDirectory);
					return {
						outcome,
						lifecycle: await readFile(lifecycle, "utf8"),
						manifest: JSON.parse(
							await readFile(resolve(runDirectory, "manifest.json"), "utf8"),
						),
						runner: await readFile(
							resolve(runDirectory, "events/runner.ndjson"),
							"utf8",
						),
						exitCode,
						lines: log.mock.calls.flat().join("\n"),
						warnings: warning.mock.calls.flat().join("\n"),
					};
				} finally {
					log.mockRestore();
					warning.mockRestore();
				}
			},
			verify: (result) => {
				expect(result.outcome.code).toBe(scenario === "timeout" ? 1 : 130);
				expect(result.lifecycle).toBe("acquired\nexercise\n");
				expect(result.manifest.status).toBe("incomplete");
				expect(result.runner).toContain('"status":"failed"');
				if (scenario === "timeout")
					expect(result.runner).toContain("Test timeout of 500ms exceeded");
				expect(result.exitCode).toBe(1);
				expect(result.lines).toContain(`runner ${scenario} — FAILED`);
				expect(result.warnings).toContain("artifacts are incomplete");
			},
		}),
		60_000,
	);
}
