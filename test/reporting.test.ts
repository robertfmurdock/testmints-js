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
	"the Vitest plugin writes one complete inspectable event stream",
	mint({
		setup: ({ scope }) => {
			scope.defer("fixture artifacts", () =>
				rm(artifactRoot, { recursive: true, force: true }),
			);
			return undefined;
		},
		exercise: async () => {
			await rm(artifactRoot, { recursive: true, force: true });
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
			const inspection = await captureInspector(runDirectory);
			expect(inspection.exitCode).toBe(0);
			expect(inspection.lines).toContain(
				"test/fixtures/reporting.case.ts > writes an inspectable phase timeline — passed",
			);
			expect(
				inspection.lines.filter((line) => line.includes("passed")),
			).toHaveLength(5);
		},
	}),
);

test(
	"a producer write failure makes the run manifest incomplete",
	mint({
		setup: ({ scope }) => {
			const outputDir = resolve(".testmints-health-fixture");
			scope.defer("health fixture artifacts", () =>
				rm(outputDir, { recursive: true, force: true }),
			);
			return { outputDir, runId: "run-health" };
		},
		exercise: async (context) => {
			await startManifest(context);
			const events = resolve(context.outputDir, context.runId, "events");
			await mkdir(events, { recursive: true });
			const blockedFile = resolve(
				events,
				`producer-${process.pid}-${threadId}.ndjson`,
			);
			await mkdir(blockedFile);
			const sink = new NdjsonEventSink(context);
			await expect(
				sink.emit({
					v: 1,
					kind: "attempt.start",
					runId: context.runId,
					producerId: "test-producer",
					attemptId: "test-attempt",
					testId: "test-id",
					title: "test title",
					seq: 0,
					timestamp: new Date().toISOString(),
				}),
			).rejects.toBeDefined();
			await completeManifest(context, "complete");
			return readManifest(resolve(context.outputDir, context.runId));
		},
		verify: (manifest) => {
			expect(manifest.status).toBe("incomplete");
			expect(manifest.failureFiles).toEqual([
				`producer-${process.pid}-${threadId}.failure.json`,
			]);
		},
	}),
);

test(
	"the inspector shows failed verification and successful teardown",
	mint({
		setup: ({ scope }) => {
			scope.defer("failure fixture artifacts", () =>
				rm(artifactRoot, { recursive: true, force: true }),
			);
			return undefined;
		},
		exercise: async () => {
			await rm(artifactRoot, { recursive: true, force: true });
			return captureRun([
				"node_modules/vitest/vitest.mjs",
				"run",
				"test/fixtures/reporting.failed.case.ts",
				"--config",
				"test/fixtures/reporting.config.ts",
			]);
		},
		verify: async (outcome) => {
			expect(outcome.passed).toBe(false);
			const runs = await readdir(artifactRoot);
			expect(runs).toHaveLength(1);
			const inspection = await captureInspector(
				resolve(artifactRoot, runs[0] ?? ""),
			);
			expect(inspection.exitCode).toBe(1);
			expect(inspection.lines).toContain(
				"test/fixtures/reporting.failed.case.ts > shows verification failure after an exported report is created — FAILED",
			);
			expect(
				inspection.lines.some(
					(line) =>
						line.includes("verify") && line.includes("failed — expected"),
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
