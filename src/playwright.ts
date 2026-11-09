import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test as playwrightTest } from "@playwright/test";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import {
	type AttemptOnlyMintTemplateOptions,
	bindTemplate,
	type ConfiguredMint,
	type EventSink,
	executeDefinition,
	type HookedMintTemplateOptions,
	type MintTemplateOptions,
	type RegisterDisposal,
	type SharedTools,
	type TemplateBinding,
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

/** Configure a mint with lazy shared preparation, per-attempt hooks, or both. */
export function createMint<Shared, Context>(
	options: HookedMintTemplateOptions<Shared, Context, [SharedTools]>,
	registerDisposal: RegisterDisposal,
): ConfiguredMint<Shared, Context, true, Promise<void>>;
export function createMint<Shared>(
	options: MintTemplateOptions<Shared, [SharedTools]>,
	registerDisposal: RegisterDisposal,
): ConfiguredMint<Shared, Shared, true, Promise<void>>;
export function createMint<Shared, Context>(
	options: HookedMintTemplateOptions<Shared, Context>,
): ConfiguredMint<Shared, Context, false, Promise<void>>;
export function createMint<Shared>(
	options: MintTemplateOptions<Shared>,
): ConfiguredMint<Shared, Shared, false, Promise<void>>;
export function createMint<Context>(
	options: AttemptOnlyMintTemplateOptions<Context>,
	registerDisposal: RegisterDisposal,
): ConfiguredMint<undefined, Context, true, Promise<void>>;
export function createMint<Context>(
	options: AttemptOnlyMintTemplateOptions<Context>,
): ConfiguredMint<undefined, Context, false, Promise<void>>;
export function createMint(
	options: unknown,
	registerDisposal?: RegisterDisposal,
) {
	return configuredMint(bindTemplate(options, registerDisposal));
}

function configuredMint(
	binding: TemplateBinding,
): ConfiguredMint<unknown, unknown, boolean, Promise<void>> {
	async function mint<Input, Output>(
		definition: TemplateDefinition<unknown, Input, Output>,
	): Promise<void> {
		return executePlaywrightMint(binding.bind(definition));
	}

	return Object.assign(mint, {
		dispose: binding.dispose,
		extend: (options: unknown) => configuredMint(binding.extend(options)),
	});
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
