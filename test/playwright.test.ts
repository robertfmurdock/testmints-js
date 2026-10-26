import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

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
			const runs = await readdir(artifactRoot);
			expect(runs).toHaveLength(1);
			const runDirectory = resolve(artifactRoot, runs[0] ?? "");
			const manifest = JSON.parse(
				await readFile(resolve(runDirectory, "manifest.json"), "utf8"),
			) as { status: string; producerFiles: string[] };
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
			const retryAttempts = new Set(
				events
					.filter((event) => event.title?.includes("fresh Testmints attempt"))
					.map((event) => event.attemptId),
			);
			expect(retryAttempts.size).toBe(2);
			const sequencesByProducer = new Map<string, number[]>();
			for (const event of events) {
				if (event.producerId === undefined || event.seq === undefined) continue;
				const sequences = sequencesByProducer.get(event.producerId) ?? [];
				sequences.push(event.seq);
				sequencesByProducer.set(event.producerId, sequences);
			}
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
