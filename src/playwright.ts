import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test as playwrightTest } from "@playwright/test";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import {
	bindTemplate,
	type EventSink,
	executeDefinition,
	type HookedMintTemplateOptions,
	type MintTemplateOptions,
	type TemplateDefinition,
	type TestmintDefinition,
	type ValidatedDefinition,
	validateDefinition,
} from "./core.js";
import {
	appendRunnerResult,
	completeManifest,
	NdjsonEventSink,
	type ReportingContext,
	startManifest,
} from "./reporting.js";

const attachmentName = "testmints-events.ndjson";
let producerSequence = 0;

class PlaywrightEventSink implements EventSink {
	#ready: Promise<void> | undefined;

	constructor(readonly file: string) {}

	async emit(event: Parameters<EventSink["emit"]>[0]): Promise<void> {
		this.#ready ??= mkdir(dirname(this.file), { recursive: true }).then(
			() => undefined,
		);
		await this.#ready;
		await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8");
	}
}

async function executePlaywrightMint<Input, Output>(
	definition: ValidatedDefinition<Input, Output>,
): Promise<void> {
	const testInfo = playwrightTest.info();
	const sink = new PlaywrightEventSink(testInfo.outputPath(attachmentName));
	try {
		await executeDefinition(definition, {
			sink,
			eventContext: {
				runId: "playwright",
				producerId: `playwright-${testInfo.workerIndex}`,
				attemptId: `${testInfo.testId}-${testInfo.retry}`,
				testId: testInfo.testId,
				title: testInfo.titlePath.join(" > "),
			},
			nextEventSequence: () => producerSequence++,
			executePhase: (phase, callback) =>
				playwrightTest.step(phase, async () => await callback()),
		});
	} finally {
		try {
			await testInfo.attach(attachmentName, {
				contentType: "application/x-ndjson",
				path: sink.file,
			});
		} catch (error) {
			console.error(
				"Testmints reporting could not attach Playwright phase events.",
				error,
			);
		}
	}
}

/** Execute a complete Testmint definition in the active Playwright test. */
export async function mint<Input, Output>(
	definition: TestmintDefinition<Input, Output>,
): Promise<void> {
	return executePlaywrightMint(validateDefinition(definition));
}

type ConfiguredMint<Context> = <Input, Output>(
	definition: TemplateDefinition<Context, Input, Output>,
) => Promise<void>;

/** Configure a mint with lazy shared preparation and optional per-attempt hooks. */
export function createMint<Shared, Context>(
	options: HookedMintTemplateOptions<Shared, Context>,
): ConfiguredMint<Context>;
export function createMint<Shared>(
	options: MintTemplateOptions<Shared>,
): ConfiguredMint<Shared>;
export function createMint(options: unknown): ConfiguredMint<unknown> {
	const bind = bindTemplate(options);
	return async function mint<Input, Output>(
		definition: TemplateDefinition<unknown, Input, Output>,
	): Promise<void> {
		return executePlaywrightMint(bind(definition));
	};
}

export interface TestmintsPlaywrightOptions {
	/** Root directory for run artifacts. Defaults to `.testmints`. */
	outputDir?: string;
}

function id(): string {
	return crypto.randomUUID();
}

function title(testCase: TestCase): string {
	return testCase.titlePath().join(" > ");
}

function attachment(result: TestResult) {
	return result.attachments.find(
		(candidate) => candidate.name === attachmentName,
	);
}

/** Aggregate attached phase streams into local Testmints artifacts. */
export class TestmintsPlaywrightReporter implements Reporter {
	#incomplete = false;
	readonly #context: ReportingContext;
	readonly #sink: NdjsonEventSink;

	constructor(options: TestmintsPlaywrightOptions = {}) {
		this.#context = {
			outputDir: options.outputDir ?? ".testmints",
			runId: `run-${new Date().toISOString().replaceAll(":", "-")}-${id()}`,
		};
		this.#sink = new NdjsonEventSink(this.#context);
	}

	async onBegin(): Promise<void> {
		try {
			await startManifest(this.#context);
		} catch (error) {
			this.#incomplete = true;
			console.error(
				"Testmints reporting could not create its artifact directory.",
				error,
			);
		}
	}

	async onTestEnd(testCase: TestCase, result: TestResult): Promise<void> {
		if (result.status === "timedOut" || result.status === "interrupted") {
			this.#incomplete = true;
		}
		try {
			const eventAttachment = attachment(result);
			if (eventAttachment?.path !== undefined) {
				const events = (await readFile(eventAttachment.path, "utf8"))
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>);
				for (const event of events) {
					await this.#sink.emit({
						...event,
						runId: this.#context.runId,
						producerId: `playwright-${result.workerIndex}`,
						attemptId: `${testCase.id}-${result.retry}`,
						testId: testCase.id,
						title: title(testCase),
					} as Parameters<EventSink["emit"]>[0]);
				}
			}
			await appendRunnerResult(this.#context, {
				testId: testCase.id,
				title: title(testCase),
				status:
					result.status === "passed"
						? "passed"
						: result.status === "skipped"
							? "skipped"
							: "failed",
				...(result.error === undefined ? {} : { error: result.error }),
			});
		} catch (error) {
			this.#incomplete = true;
			console.error(
				"Testmints reporting could not record a Playwright outcome.",
				error,
			);
		}
	}

	async onEnd(): Promise<void> {
		try {
			await completeManifest(
				this.#context,
				this.#incomplete ? "incomplete" : "complete",
			);
		} catch (error) {
			console.error(
				"Testmints reporting could not finalize its artifacts.",
				error,
			);
		}
	}
}

/** Create a Playwright reporter that writes local Testmints artifacts. */
export function testmintsPlaywright(
	options: TestmintsPlaywrightOptions = {},
): TestmintsPlaywrightReporter {
	return new TestmintsPlaywrightReporter(options);
}
