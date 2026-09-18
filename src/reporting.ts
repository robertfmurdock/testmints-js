import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { threadId } from "node:worker_threads";

import type { EventSink, TestmintEvent } from "./core.js";

export interface ReportingContext {
	readonly outputDir: string;
	readonly runId: string;
}

export interface RunManifest {
	v: 1;
	runId: string;
	status: "running" | "complete" | "incomplete";
	producerFiles: string[];
	failureFiles: string[];
}

export interface RunnerResultEvent {
	v: 1;
	kind: "runner.result";
	runId: string;
	testId: string;
	title: string;
	status: "passed" | "failed" | "skipped";
	timestamp: string;
	error?: { name: string; message: string };
}

function producerFile(context: ReportingContext): string {
	return resolve(
		context.outputDir,
		context.runId,
		"events",
		`producer-${process.pid}-${threadId}.ndjson`,
	);
}

function producerFailureFile(context: ReportingContext): string {
	return resolve(
		context.outputDir,
		context.runId,
		"events",
		`producer-${process.pid}-${threadId}.failure.json`,
	);
}

/** A Node-only, append-only sink; each Vitest worker owns its output file. */
export class NdjsonEventSink implements EventSink {
	readonly #file: string;
	#ready: Promise<void> | undefined;
	#reportedFailure = false;

	constructor(private readonly context: ReportingContext) {
		this.#file = producerFile(context);
	}

	async emit(event: TestmintEvent): Promise<void> {
		try {
			this.#ready ??= mkdir(resolve(this.#file, ".."), {
				recursive: true,
			}).then(() => undefined);
			await this.#ready;
			await appendFile(this.#file, `${JSON.stringify(event)}\n`, "utf8");
		} catch (error) {
			await this.recordFailure(error);
			throw error;
		}
	}

	private async recordFailure(error: unknown): Promise<void> {
		if (this.#reportedFailure) return;
		this.#reportedFailure = true;
		const detail = runnerError(error);
		try {
			await writeFile(
				producerFailureFile(this.context),
				JSON.stringify(detail),
				"utf8",
			);
		} catch {
			// The original I/O failure is reported below even when its marker cannot persist.
		}
		console.error("Testmints reporting could not write a phase event.", error);
	}
}

export async function startManifest(context: ReportingContext): Promise<void> {
	const directory = resolve(context.outputDir, context.runId);
	await mkdir(directory, { recursive: true });
	await writeFile(
		resolve(directory, "manifest.json"),
		JSON.stringify({
			v: 1,
			runId: context.runId,
			status: "running",
			producerFiles: [],
			failureFiles: [],
		} satisfies RunManifest),
		"utf8",
	);
}

export async function completeManifest(
	context: ReportingContext,
	status: "complete" | "incomplete",
): Promise<void> {
	const directory = resolve(context.outputDir, context.runId);
	const events = resolve(directory, "events");
	let producerFiles: string[] = [];
	let failureFiles: string[] = [];
	try {
		const { readdir } = await import("node:fs/promises");
		const files = await readdir(events);
		producerFiles = files.filter(
			(file) => file.startsWith("producer-") && file.endsWith(".ndjson"),
		);
		failureFiles = files.filter(
			(file) => file.startsWith("producer-") && file.endsWith(".failure.json"),
		);
		if (failureFiles.length > 0) status = "incomplete";
	} catch {
		status = "incomplete";
	}
	await writeFile(
		resolve(directory, "manifest.json"),
		JSON.stringify({
			v: 1,
			runId: context.runId,
			status,
			producerFiles,
			failureFiles,
		} satisfies RunManifest),
		"utf8",
	);
}

export async function readManifest(directory: string): Promise<RunManifest> {
	return JSON.parse(
		await readFile(resolve(directory, "manifest.json"), "utf8"),
	) as RunManifest;
}

function runnerError(error: unknown): { name: string; message: string } {
	if (error instanceof Error)
		return { name: error.name, message: error.message };
	if (error !== null && typeof error === "object") {
		const candidate = error as { name?: unknown; message?: unknown };
		return {
			name: typeof candidate.name === "string" ? candidate.name : "Error",
			message:
				typeof candidate.message === "string"
					? candidate.message
					: String(error),
		};
	}
	return { name: "Error", message: String(error) };
}

export async function appendRunnerResult(
	context: ReportingContext,
	result: Omit<
		RunnerResultEvent,
		"v" | "kind" | "runId" | "timestamp" | "error"
	> & { error?: unknown },
): Promise<void> {
	const file = resolve(
		context.outputDir,
		context.runId,
		"events",
		"runner.ndjson",
	);
	await mkdir(resolve(file, ".."), { recursive: true });
	await appendFile(
		file,
		`${JSON.stringify({
			v: 1,
			kind: "runner.result",
			runId: context.runId,
			testId: result.testId,
			title: result.title,
			status: result.status,
			timestamp: new Date().toISOString(),
			...(result.error === undefined
				? {}
				: { error: runnerError(result.error) }),
		} satisfies RunnerResultEvent)}\n`,
		"utf8",
	);
}
