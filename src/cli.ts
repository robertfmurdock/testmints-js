#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { PhaseEndedEvent, TestmintEvent } from "./core.js";
import {
	type RunManifest,
	type RunnerResultEvent,
	readManifest,
} from "./reporting.js";

function usage(): never {
	console.error("Usage: testmints inspect <artifact-dir>");
	process.exit(2);
}

function duration(durationMs: number): string {
	return `${Math.round(durationMs)} ms`;
}

async function readEvents(directory: string, files: readonly string[]) {
	const events: TestmintEvent[] = [];
	let incomplete = false;
	for (const file of files) {
		let text: string;
		try {
			text = await readFile(resolve(directory, "events", file), "utf8");
		} catch {
			incomplete = true;
			continue;
		}
		const lines = text.split("\n");
		for (const [index, line] of lines.entries()) {
			if (line === "") continue;
			try {
				events.push(JSON.parse(line) as TestmintEvent);
			} catch {
				if (index !== lines.length - 1) incomplete = true;
			}
		}
	}
	return { events, incomplete };
}

function phaseEvents(events: readonly TestmintEvent[]): PhaseEndedEvent[] {
	return events.filter(
		(event): event is PhaseEndedEvent => event.kind === "phase.end",
	);
}

async function readRunnerResults(
	directory: string,
): Promise<RunnerResultEvent[]> {
	try {
		return (
			await readFile(resolve(directory, "events", "runner.ndjson"), "utf8")
		)
			.trim()
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as RunnerResultEvent);
	} catch {
		return [];
	}
}

export async function inspect(directory: string): Promise<number> {
	let manifest: RunManifest;
	try {
		manifest = await readManifest(directory);
	} catch (error) {
		console.error(`Cannot read Testmints manifest: ${String(error)}`);
		return 1;
	}
	const { events, incomplete: malformed } = await readEvents(
		directory,
		manifest.producerFiles,
	);
	const runnerResults = new Map(
		(await readRunnerResults(directory)).map((result) => [
			result.testId,
			result,
		]),
	);
	const attempts = new Map<string, TestmintEvent[]>();
	for (const event of events) {
		const grouped = attempts.get(event.attemptId) ?? [];
		grouped.push(event);
		attempts.set(event.attemptId, grouped);
	}
	let failed = false;
	let interrupted = false;
	const displayedTests = new Set<string>();
	for (const attempt of attempts.values()) {
		attempt.sort((left, right) => left.seq - right.seq);
		const started = attempt.find((event) => event.kind === "attempt.start");
		const ended = attempt.find((event) => event.kind === "attempt.end");
		if (!started) continue;
		if (!ended) interrupted = true;
		displayedTests.add(started.testId);
		const runner = runnerResults.get(started.testId);
		const attemptFailed =
			(ended?.kind === "attempt.end" && ended.status === "failed") ||
			runner?.status === "failed";
		failed ||= attemptFailed;
		console.log(`${started.title} — ${attemptFailed ? "FAILED" : "passed"}`);
		for (const phase of phaseEvents(attempt)) {
			const detail =
				phase.status === "failed"
					? ` — ${phase.error?.message ?? "failed"}`
					: phase.status === "skipped"
						? ` — ${phase.reason ?? "skipped"}`
						: "";
			console.log(
				`  ${phase.phase.padEnd(10)} ${duration(phase.durationMs).padStart(7)}  ${phase.status}${detail}`,
			);
		}
		if (
			runner?.status === "failed" &&
			ended?.kind === "attempt.end" &&
			ended.status === "passed"
		) {
			console.log(
				`  runner              failed — ${runner.error?.message ?? "failed"}`,
			);
		}
	}
	for (const runner of runnerResults.values()) {
		if (displayedTests.has(runner.testId)) continue;
		const runnerFailed = runner.status === "failed";
		failed ||= runnerFailed;
		console.log(`${runner.title} — ${runnerFailed ? "FAILED" : runner.status}`);
		if (runnerFailed) {
			console.log(
				`  runner              failed — ${runner.error?.message ?? "failed"}`,
			);
		}
	}
	const incomplete =
		malformed ||
		interrupted ||
		manifest.status !== "complete" ||
		(manifest.failureFiles?.length ?? 0) > 0;
	if (incomplete) console.error("Testmints artifacts are incomplete.");
	return failed || incomplete ? 1 : 0;
}

const invokedPath = process.argv[1];
if (
	invokedPath !== undefined &&
	import.meta.url === pathToFileURL(await realpath(invokedPath)).href
) {
	if (process.argv[2] !== "inspect" || process.argv[3] === undefined) usage();
	process.exitCode = await inspect(resolve(process.argv[3]));
}
