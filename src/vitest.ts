import { threadId } from "node:worker_threads";
import type { Plugin } from "vite";
import { inject, test } from "vitest";
import type { Reporter } from "vitest/node";

import {
	executeDefinition,
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

/** Register a complete Testmint definition with Vitest. */
export function mintTest<Input, Output>(
	name: string,
	definition: TestmintDefinition<Input, Output>,
): void {
	const validated = validateDefinition(definition);
	test(name, async (context) => {
		const reporting = reportingContext();
		const task = context.task;
		await executeDefinition(validated, {
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
	});
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
