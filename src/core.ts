export type Awaitable<T> = T | PromiseLike<T>;

export type PhaseName = "setup" | "exercise" | "verify" | "teardown";
export type PhaseStatus = "passed" | "failed";

export interface PhaseEvent {
	phase: PhaseName;
	status: PhaseStatus | "started";
	error?: unknown;
}

/** Observational only: a sink can never alter test execution. */
export interface EventSink {
	emit(event: PhaseEvent): void | PromiseLike<void>;
}

export interface PhaseTools {
	readonly signal: AbortSignal;
}

export interface CleanupTools extends PhaseTools {}

export interface ResourceScope {
	using<T>(
		name: string,
		acquire: () => Awaitable<T>,
		release: (resource: T, tools: CleanupTools) => Awaitable<unknown>,
	): Promise<T>;
	defer(
		name: string,
		release: (tools: CleanupTools) => Awaitable<unknown>,
	): void;
}

export interface SetupTools extends PhaseTools {
	readonly scope: ResourceScope;
}

export interface ExerciseTools extends PhaseTools {
	readonly scope: ResourceScope;
}

export interface TestmintDefinition<Input, Output> {
	setup: (tools: SetupTools) => Awaitable<Input>;
	exercise: (input: Input, tools: ExerciseTools) => Awaitable<Output>;
	verify: (
		output: Output,
		input: Input,
		tools: PhaseTools,
	) => Awaitable<unknown>;
	teardown?: (input: Input, tools: CleanupTools) => Awaitable<unknown>;
}

export type ValidatedDefinition<Input, Output> = Readonly<
	TestmintDefinition<Input, Output>
>;

export interface ExecuteOptions {
	signal?: AbortSignal;
	sink?: EventSink;
}

const phaseKeys = new Set(["setup", "exercise", "verify", "teardown"]);
type UntypedCallback = (...arguments_: unknown[]) => unknown;

function isDefinitionCandidate(
	value: unknown,
): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredCallback(
	definition: Record<string, unknown>,
	phase: "setup" | "exercise" | "verify",
): UntypedCallback {
	const callback = definition[phase];
	if (typeof callback !== "function") {
		throw new TypeError(
			`Testmint definition requires a callable ${phase} phase.`,
		);
	}
	return (...arguments_) => callback(...arguments_);
}

function optionalCallback(
	definition: Record<string, unknown>,
): UntypedCallback | undefined {
	const callback = definition.teardown;
	if (callback === undefined) return undefined;
	if (typeof callback !== "function") {
		throw new TypeError("Testmint teardown must be a function when provided.");
	}
	return (...arguments_) => callback(...arguments_);
}

export function validateDefinition<Input, Output>(
	candidate: TestmintDefinition<Input, Output>,
): ValidatedDefinition<Input, Output>;
export function validateDefinition(
	candidate: unknown,
): ValidatedDefinition<unknown, unknown> {
	if (!isDefinitionCandidate(candidate)) {
		throw new TypeError("A Testmint definition must be an object.");
	}

	const definition = candidate;
	for (const key of Object.keys(definition)) {
		if (!phaseKeys.has(key)) {
			throw new TypeError(`Unknown Testmint definition key: ${key}`);
		}
	}
	const setup = requiredCallback(definition, "setup");
	const exercise = requiredCallback(definition, "exercise");
	const verify = requiredCallback(definition, "verify");
	const teardown = optionalCallback(definition);
	const validated = {
		setup: (tools: SetupTools) => setup(tools),
		exercise: (input: unknown, tools: ExerciseTools) => exercise(input, tools),
		verify: (output: unknown, input: unknown, tools: PhaseTools) =>
			verify(output, input, tools),
	};

	return Object.freeze(
		teardown === undefined
			? validated
			: {
					...validated,
					teardown: (input: unknown, tools: CleanupTools) =>
						teardown(input, tools),
				},
	);
}

class AttemptScope implements ResourceScope {
	readonly #releases: Array<{
		name: string;
		release: (tools: CleanupTools) => Awaitable<unknown>;
	}> = [];
	readonly #pending = new Set<Promise<unknown>>();
	#closing = false;

	using<T>(
		name: string,
		acquire: () => Awaitable<T>,
		release: (resource: T, tools: CleanupTools) => Awaitable<unknown>,
	): Promise<T> {
		this.assertOpen();
		const pending = Promise.resolve()
			.then(acquire)
			.then((resource) => {
				this.#releases.push({
					name,
					release: (tools) => release(resource, tools),
				});
				return resource;
			});
		this.#pending.add(pending);
		void pending
			.finally(() => this.#pending.delete(pending))
			.catch(() => undefined);
		return pending;
	}

	defer(
		name: string,
		release: (tools: CleanupTools) => Awaitable<unknown>,
	): void {
		this.assertOpen();
		this.#releases.push({ name, release });
	}

	async close(tools: CleanupTools): Promise<unknown[]> {
		if (this.#closing) return [];
		this.#closing = true;
		await Promise.allSettled([...this.#pending]);
		const errors: unknown[] = [];
		for (const registration of [...this.#releases].reverse()) {
			try {
				await registration.release(tools);
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}

	private assertOpen(): void {
		if (this.#closing)
			throw new Error(
				"Cannot acquire or defer a resource after cleanup has begun.",
			);
	}
}

async function emit(
	sink: EventSink | undefined,
	event: PhaseEvent,
): Promise<void> {
	try {
		await sink?.emit(event);
	} catch {
		// Instrumentation is not allowed to affect test behavior in this slice.
	}
}

async function runPhase<T>(
	phase: PhaseName,
	sink: EventSink | undefined,
	callback: () => Awaitable<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	await emit(sink, { phase, status: "started" });
	try {
		const value = await callback();
		await emit(sink, { phase, status: "passed" });
		return { ok: true, value };
	} catch (error) {
		await emit(sink, { phase, status: "failed", error });
		return { ok: false, error };
	}
}

function throwFailures(primaryError: unknown, cleanupErrors: unknown[]): void {
	const errors =
		primaryError === undefined
			? cleanupErrors
			: [primaryError, ...cleanupErrors];
	if (errors.length === 0) return;
	if (errors.length === 1) throw errors[0];
	throw new AggregateError(errors, "Testmint execution and cleanup failed.");
}

export async function executeDefinition<Input, Output>(
	definition: ValidatedDefinition<Input, Output>,
	options: ExecuteOptions = {},
): Promise<void> {
	const scope = new AttemptScope();
	const signal = options.signal ?? new AbortController().signal;
	const setupTools: SetupTools = { signal, scope };
	const exerciseTools: ExerciseTools = { signal, scope };
	const phaseTools: PhaseTools = { signal };
	const cleanupTools: CleanupTools = { signal: new AbortController().signal };
	let completedSetup: { input: Input } | undefined;
	let primaryError: unknown;
	const cleanupErrors: unknown[] = [];

	const setup = await runPhase("setup", options.sink, () =>
		definition.setup(setupTools),
	);
	if (setup.ok) {
		const input = setup.value;
		completedSetup = { input };
		const exercise = await runPhase("exercise", options.sink, () =>
			definition.exercise(input, exerciseTools),
		);
		if (exercise.ok) {
			const verify = await runPhase("verify", options.sink, () =>
				definition.verify(exercise.value, input, phaseTools),
			);
			if (!verify.ok) primaryError = verify.error;
		} else {
			primaryError = exercise.error;
		}
	} else {
		primaryError = setup.error;
	}

	if (completedSetup && definition.teardown) {
		const teardown = await runPhase("teardown", options.sink, () =>
			definition.teardown?.(completedSetup.input, cleanupTools),
		);
		if (!teardown.ok) {
			if (primaryError === undefined) primaryError = teardown.error;
			else cleanupErrors.push(teardown.error);
		}
	}

	cleanupErrors.push(...(await scope.close(cleanupTools)));
	throwFailures(primaryError, cleanupErrors);
}
