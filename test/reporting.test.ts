import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { threadId } from "node:worker_threads";

import { expect, test, vi } from "vitest";

import { inspect } from "../src/cli.js";
import {
	completeManifest,
	NdjsonEventSink,
	readManifest,
	startManifest,
} from "../src/reporting.js";
import { mint } from "../src/vitest.js";

const run = promisify(execFile);
const artifactRoot = resolve(".testmints-fixture");

async function captureRun(args: string[]) {
	try {
		await run(process.execPath, args);
		return { passed: true };
	} catch {
		return { passed: false };
	}
}

async function captureInspector(directory: string) {
	const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
	try {
		return {
			exitCode: await inspect(directory),
			lines: output.mock.calls.map((call) => call.join(" ")),
		};
	} finally {
		output.mockRestore();
	}
}

test(
	"the Vitest plugin writes one complete phase and runner event stream",
	mint({
		setup: async ({ scope }) => {
			scope.defer("fixture artifacts", () =>
				rm(artifactRoot, { recursive: true, force: true }),
			);
			await rm(artifactRoot, { recursive: true, force: true });
		},
		exercise: async () => {
			return run(process.execPath, [
				"node_modules/vitest/vitest.mjs",
				"run",
				"test/fixtures/reporting.case.ts",
				"--config",
				"test/fixtures/reporting.config.ts",
			]);
		},
		verify: async () => {
			const runs = await readdir(artifactRoot);
			expect(runs).toHaveLength(1);
			const runDirectory = resolve(artifactRoot, runs[0] ?? "");
			const manifest = JSON.parse(
				await readFile(resolve(runDirectory, "manifest.json"), "utf8"),
			) as { status: string; producerFiles: string[] };
			expect(manifest.status).toBe("complete");
			expect(manifest.producerFiles).toHaveLength(1);
			const events = (
				await readFile(
					resolve(runDirectory, "events", manifest.producerFiles[0] ?? ""),
					"utf8",
				)
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; phase?: string });
			expect(events.map((event) => event.kind)).toEqual([
				"attempt.start",
				"phase.start",
				"phase.end",
				"phase.start",
				"phase.end",
				"phase.start",
				"phase.end",
				"phase.start",
				"phase.end",
				"attempt.end",
			]);
			expect(events.filter((event) => event.phase === "teardown")).toHaveLength(
				2,
			);
			const runnerEvents = (
				await readFile(resolve(runDirectory, "events", "runner.ndjson"), "utf8")
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; status: string });
			expect(
				runnerEvents.map((event) => `${event.kind}:${event.status}`),
			).toEqual(["runner.result:passed"]);
		},
	}),
);

test(
	"a producer write failure makes the run manifest incomplete",
	mint({
		setup: async ({ scope }) => {
			const outputDir = resolve(".testmints-health-fixture");
			scope.defer("health fixture artifacts", () =>
				rm(outputDir, { recursive: true, force: true }),
			);
			const context = { outputDir, runId: "run-health" };
			await startManifest(context);
			const events = resolve(context.outputDir, context.runId, "events");
			await mkdir(events, { recursive: true });
			const blockedFile = resolve(
				events,
				`producer-${process.pid}-${threadId}.ndjson`,
			);
			await mkdir(blockedFile);
			return { context, sink: new NdjsonEventSink(context) };
		},
		exercise: async ({ context, sink }) => {
			const emission = sink.emit({
				v: 1,
				kind: "attempt.start",
				runId: context.runId,
				producerId: "test-producer",
				attemptId: "test-attempt",
				testId: "test-id",
				title: "test title",
				seq: 0,
				timestamp: new Date().toISOString(),
			});
			const error = await emission.then(
				() => undefined,
				(error: unknown) => error,
			);
			await completeManifest(context, "complete");
			return {
				error,
				manifest: await readManifest(resolve(context.outputDir, context.runId)),
			};
		},
		verify: ({ error, manifest }) => {
			expect(error).toBeDefined();
			expect(manifest.status).toBe("incomplete");
			expect(manifest.failureFiles).toEqual([
				`producer-${process.pid}-${threadId}.failure.json`,
			]);
		},
	}),
);

for (const scenario of [
	{
		name: "the inspector shows passed verification and successful teardown",
		fixture: "test/fixtures/reporting.case.ts",
		passed: true,
		title: "writes an inspectable phase timeline",
		status: "passed",
		verification: "passed",
	},
	{
		name: "the inspector shows failed verification and successful teardown",
		fixture: "test/fixtures/reporting.failed.case.ts",
		passed: false,
		title: "shows verification failure after an exported report is created",
		status: "FAILED",
		verification: "failed — expected",
	},
]) {
	test(
		scenario.name,
		mint({
			setup: async ({ scope }) => {
				scope.defer("inspector fixture artifacts", () =>
					rm(artifactRoot, { recursive: true, force: true }),
				);
				await rm(artifactRoot, { recursive: true, force: true });
				const outcome = await captureRun([
					"node_modules/vitest/vitest.mjs",
					"run",
					scenario.fixture,
					"--config",
					"test/fixtures/reporting.config.ts",
				]);
				const runs = await readdir(artifactRoot);
				if (outcome.passed !== scenario.passed || runs.length !== 1)
					throw new Error(
						"Inspector fixture did not produce the expected runner outcome and run directory.",
					);
				return { directory: resolve(artifactRoot, runs[0] ?? ""), scenario };
			},
			exercise: ({ directory }) => captureInspector(directory),
			verify: (inspection, { scenario }) => {
				expect(inspection.lines).toHaveLength(5);
				for (const phase of ["setup", "exercise"]) {
					expect(
						inspection.lines.some(
							(line) =>
								line.trimStart().startsWith(phase) && line.includes("passed"),
						),
					).toBe(true);
				}
				expect(inspection.exitCode).toBe(Number(!scenario.passed));
				expect(inspection.lines).toContain(
					`${scenario.fixture} > ${scenario.title} — ${scenario.status}`,
				);
				expect(
					inspection.lines.some(
						(line) =>
							line.includes("verify") && line.includes(scenario.verification),
					),
				).toBe(true);
				expect(
					inspection.lines.some(
						(line) => line.includes("teardown") && line.includes("passed"),
					),
				).toBe(true);
			},
		}),
	);
}
