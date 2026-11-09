import { threadId } from "node:worker_threads";
import type { Plugin } from "vite";
import type { TestContext, TestFunction } from "vitest";
import { inject } from "vitest";
import type { Reporter } from "vitest/node";

import {
	bindTemplate,
	executeDefinition,
	type HookedMintTemplateOptions,
	type MintTemplateOptions,
	type TemplateDefinition,
	type TestmintDefinition,
	validateDefinition,
} from "./core.js";
import {
	appendRunnerResult,
	completeManifest,
	NdjsonEventSink,
	type ReportingContext,
	startManifest,
} from "./reporting.js";

export interface TestmintsVitestOptions {
	/** Root directory for run artifacts. Defaults to `.testmints`. */
	outputDir?: string;
}

function reportingContext(): ReportingContext | undefined {
	return inject("testmints");
}

function id(): string {
	return crypto.randomUUID();
}

const producerId = `${process.pid}-${threadId}`;
let producerSequence = 0;

async function runValidatedMint<Input, Output>(
	definition: TestmintDefinition<Input, Output>,
	context: TestContext,
): Promise<void> {
	const reporting = reportingContext();
	const task = context.task;
	await executeDefinition(definition, {
		signal: context.signal,
		...(reporting === undefined
			? {}
			: {
					sink: new NdjsonEventSink(reporting),
					eventContext: {
						runId: reporting.runId,
						producerId,
						attemptId: id(),
						testId: task.id,
						title: task.fullName,
					},
					nextEventSequence: () => producerSequence++,
				}),
	});
}

/** Execute a complete Testmint definition from a Vitest test callback. */
export async function runMint<Input, Output>(
	definition: TestmintDefinition<Input, Output>,
	context: TestContext,
): Promise<void> {
	await runValidatedMint(validateDefinition(definition), context);
}

/** Create a Vitest callback from a complete Testmint definition. */
export function mint<Input, Output>(
	definition: TestmintDefinition<Input, Output>,
): TestFunction {
	const validated = validateDefinition(definition);
	return async (context) => runValidatedMint(validated, context);
}

type ConfiguredMint<Context> = <Input, Output>(
	definition: TemplateDefinition<Context, Input, Output>,
) => TestFunction;

/** Configure a mint with lazy shared preparation and optional per-attempt hooks. */
export function createMint<Shared, Context>(
	options: HookedMintTemplateOptions<Shared, Context>,
): ConfiguredMint<Context>;
export function createMint<Shared>(
	options: MintTemplateOptions<Shared>,
): ConfiguredMint<Shared>;
export function createMint(options: unknown): ConfiguredMint<unknown> {
	const bind = bindTemplate(options);
	return function mint<Input, Output>(
		definition: TemplateDefinition<unknown, Input, Output>,
	): TestFunction {
		const validated = bind(definition);
		return async (context) => runValidatedMint(validated, context);
	};
}

class TestmintsReporter implements Reporter {
	#incomplete = false;

	constructor(private readonly context: ReportingContext) {}

	async onTestRunStart(): Promise<void> {
		try {
			await startManifest(this.context);
		} catch (error) {
			this.#incomplete = true;
			console.error(
				"Testmints reporting could not create its artifact directory.",
				error,
			);
		}
	}

	async onTestRunEnd(): Promise<void> {
		try {
			await completeManifest(
				this.context,
				this.#incomplete ? "incomplete" : "complete",
			);
		} catch (error) {
			console.error(
				"Testmints reporting could not finalize its artifacts.",
				error,
			);
		}
	}

	async onTestCaseResult(
		testCase: Parameters<NonNullable<Reporter["onTestCaseResult"]>>[0],
	): Promise<void> {
		const result = testCase.result();
		if (result.state === "pending") return;
		try {
			await appendRunnerResult(this.context, {
				testId: testCase.id,
				title: testCase.fullName,
				status: result.state,
				...(result.errors?.[0] === undefined
					? {}
					: { error: result.errors[0] }),
			});
		} catch (error) {
			this.#incomplete = true;
			console.error(
				"Testmints reporting could not record a Vitest outcome.",
				error,
			);
		}
	}
}

/** Enable local Testmints NDJSON artifacts for a Node Vitest project. */
export function testmintsVitest(options: TestmintsVitestOptions = {}): Plugin {
	const outputDir = options.outputDir ?? ".testmints";
	const context: ReportingContext = {
		outputDir,
		runId: `run-${new Date().toISOString().replaceAll(":", "-")}-${id()}`,
	};
	const plugin: Plugin = {
		name: "testmints-vitest",
		config: (config) => {
			const configured = config.test?.reporters;
			const reporters =
				configured === undefined
					? []
					: Array.isArray(configured)
						? configured
						: [configured];
			return {
				test: {
					provide: { testmints: context },
					reporters: [
						...(reporters.length === 0 ? ["default"] : reporters),
						new TestmintsReporter(context),
					],
				},
			};
		},
	};
	return plugin;
}
