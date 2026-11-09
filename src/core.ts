export type Awaitable<T> = T | PromiseLike<T>;

export type PhaseName = "setup" | "exercise" | "verify" | "teardown";
export type PhaseStatus = "passed" | "failed" | "skipped";

export interface EventContext {
	runId: string;
	producerId: string;
	attemptId: string;
	testId: string;
	title: string;
}

export interface EventError {
	name: string;
	message: string;
	stack?: string;
}

interface EventBase extends EventContext {
	v: 1;
	seq: number;
	timestamp: string;
}

export interface AttemptStartedEvent extends EventBase {
	kind: "attempt.start";
}

export interface AttemptEndedEvent extends EventBase {
	kind: "attempt.end";
	status: Exclude<PhaseStatus, "skipped">;
	error?: EventError;
}

export interface PhaseStartedEvent extends EventBase {
	kind: "phase.start";
	phase: PhaseName;
}

export interface PhaseEndedEvent extends EventBase {
	kind: "phase.end";
	phase: PhaseName;
	status: PhaseStatus;
	durationMs: number;
	reason?: string;
	error?: EventError;
}

export type TestmintEvent =
	| AttemptStartedEvent
	| AttemptEndedEvent
	| PhaseStartedEvent
	| PhaseEndedEvent;

type EventPayload =
	| Omit<AttemptStartedEvent, keyof EventBase>
	| Omit<AttemptEndedEvent, keyof EventBase>
	| Omit<PhaseStartedEvent, keyof EventBase>
	| Omit<PhaseEndedEvent, keyof EventBase>;

/** Observational only: a sink can never alter test execution. */
export interface EventSink {
	emit(event: TestmintEvent): void | PromiseLike<void>;
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

export interface TemplateDefinition<Context, Input, Output>
	extends Omit<TestmintDefinition<Input, Output>, "setup"> {
	setup: (context: Context, tools: SetupTools) => Awaitable<Input>;
}

export interface MintTemplateOptions<Shared, Args extends unknown[] = []> {
	shared: (...args: Args) => Awaitable<Shared>;
	attempt?: never;
}

export interface HookedMintTemplateOptions<
	Shared,
	Context,
	Args extends unknown[] = [],
	Parent extends unknown[] = [],
> {
	shared: (...args: Args) => Awaitable<Shared>;
	attempt: AttemptHooks<Shared, Context, Parent>;
}

interface AttemptHooks<Input, Context, Parent extends unknown[] = []> {
	before: (
		input: Input,
		tools: SetupTools,
		...parent: Parent
	) => Awaitable<Context>;
	after?: (context: Context, tools: CleanupTools) => Awaitable<unknown>;
}

export interface SharedTools {
	readonly scope: ResourceScope;
}

export type RegisterDisposal = (dispose: () => Promise<void>) => void;

export type ExtensionArgs<
	Shared,
	Managed extends boolean,
> = Managed extends true
	? [parent: Shared, tools: SharedTools]
	: [parent: Shared];

export interface ConfiguredMint<
	Shared,
	Context,
	Managed extends boolean,
	Result,
> {
	<Input, Output>(
		definition: TemplateDefinition<Context, Input, Output>,
	): Result;
	dispose(): Promise<void>;
	extend<ChildContext>(options: {
		shared?: never;
		attempt: AttemptHooks<Context, ChildContext>;
	}): ConfiguredMint<Shared, ChildContext, Managed, Result>;
	extend<Child, ChildContext>(
		options: HookedMintTemplateOptions<
			Child,
			ChildContext,
			ExtensionArgs<Shared, Managed>,
			[parent: Context]
		>,
	): ConfiguredMint<Child, ChildContext, Managed, Result>;
	extend<Child>(
		options: MintTemplateOptions<Child, ExtensionArgs<Shared, Managed>>,
	): ConfiguredMint<Child, Child, Managed, Result>;
}

type TemplateBinder<Context> = <Input, Output>(
	candidate: TemplateDefinition<Context, Input, Output>,
) => ValidatedDefinition<Input, Output>;

export interface TemplateBinding {
	bind: TemplateBinder<unknown>;
	dispose: () => Promise<void>;
	extend: (options: unknown) => TemplateBinding;
}

export type ValidatedDefinition<Input, Output> = Readonly<
	TestmintDefinition<Input, Output>
>;

export interface ExecuteOptions {
	signal?: AbortSignal;
	sink?: EventSink;
	eventContext?: EventContext;
	/** Supplies a producer-wide event sequence when reporting spans attempts. */
	nextEventSequence?: () => number;
	/** Lets a runner present an awaited Testmints phase in its native UI. */
	executePhase?: <T>(
		phase: PhaseName,
		callback: () => Awaitable<T>,
	) => Awaitable<T>;
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
	return validatePhases(candidate, (setup, tools) => setup(tools));
}

function validatePhases(
	candidate: unknown,
	runSetup: (setup: UntypedCallback, tools: SetupTools) => unknown,
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
		setup: (tools: SetupTools) => runSetup(setup, tools),
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

export function createTemplate<Shared, Context>(
	options: HookedMintTemplateOptions<Shared, Context>,
): TemplateBinder<Context>;
export function createTemplate<Shared>(
	options: MintTemplateOptions<Shared>,
): TemplateBinder<Shared>;
export function createTemplate(options: unknown) {
	return bindTemplate(options).bind;
}

export function bindTemplate(
	options: unknown,
	registerDisposal?: RegisterDisposal,
): TemplateBinding {
	if (
		registerDisposal !== undefined &&
		typeof registerDisposal !== "function"
	) {
		throw new TypeError("A Testmint disposal registrar must be callable.");
	}
	const template = new TemplateLifetime(
		options,
		registerDisposal !== undefined,
	);
	const binding = template.binding();
	registerDisposal?.(binding.dispose);
	return binding;
}

function validateInitializer(options: unknown, canInherit: boolean) {
	const { shared, attempt } = isDefinitionCandidate(options) ? options : {};
	const hooks = validateAttemptHooks(attempt);
	if (shared === undefined && canInherit && hooks !== undefined) {
		return { prepare: undefined, hooks };
	}
	if (typeof shared !== "function") {
		throw new TypeError(
			"A Testmint template requires a callable shared initializer.",
		);
	}
	return {
		prepare: (...args: unknown[]): unknown => shared(...args),
		hooks,
	};
}

class TemplateLifetime {
	readonly #initializer: ReturnType<typeof validateInitializer>;
	readonly #scope = new CleanupScope();
	readonly #active = new Set<Promise<void>>();
	readonly #children = new Set<TemplateLifetime>();
	#preparation: Promise<unknown> | undefined;
	#disposal: Promise<void> | undefined;

	constructor(
		options: unknown,
		private readonly managed: boolean,
		private readonly parent?: TemplateLifetime,
	) {
		this.#initializer = validateInitializer(options, parent !== undefined);
	}

	binding(): TemplateBinding {
		const template = this;
		function bind<Input, Output>(
			candidate: TemplateDefinition<unknown, Input, Output>,
		): ValidatedDefinition<Input, Output>;
		function bind(candidate: unknown): ValidatedDefinition<unknown, unknown> {
			return validatePhases(candidate, async (setup, tools) => {
				tools.signal.throwIfAborted();
				template.#begin(tools.scope);
				return setup(await template.#enter(tools), tools);
			});
		}
		return {
			bind,
			dispose: () => this.#dispose(),
			extend: (options) => {
				this.#assertOpen();
				const child = new TemplateLifetime(options, this.managed, this);
				this.#children.add(child);
				return child.binding();
			},
		};
	}

	#assertOpen(): void {
		if (this.#disposal !== undefined) {
			throw new Error("Cannot use a disposed Testmint template.");
		}
		if (this.parent !== undefined) this.parent.#assertOpen();
	}

	#begin(scope: ResourceScope): void {
		this.#assertOpen();
		let finish: () => void = () => undefined;
		const active = new Promise<void>((resolve) => {
			finish = resolve;
		});
		scope.defer("template attempt", () => {
			this.#active.delete(active);
			finish();
		});
		this.#active.add(active);
	}

	#prepare(): Promise<unknown> {
		this.#preparation ??= Promise.resolve().then(() => this.#initialize());
		return this.#preparation;
	}

	async #initialize(): Promise<unknown> {
		const { prepare } = this.#initializer;
		const args: unknown[] = [];
		if (this.parent !== undefined) args.push(await this.parent.#prepare());
		if (prepare === undefined) return args[0];
		if (this.managed) args.push({ scope: this.#scope });
		try {
			return await prepare(...args);
		} catch (error) {
			const cleanupErrors = await this.#scope.close(cleanupTools());
			if (cleanupErrors.length === 0) throw error;
			throw new AggregateError(
				[error, ...cleanupErrors],
				"Testmint shared preparation and cleanup failed.",
			);
		}
	}

	async #enter(tools: SetupTools): Promise<unknown> {
		const parent =
			this.parent === undefined ? [] : [await this.parent.#enter(tools)];
		tools.signal.throwIfAborted();
		const shared = await this.#prepare();
		tools.signal.throwIfAborted();
		const { hooks } = this.#initializer;
		if (hooks === undefined) return shared;

		const context = await (this.#initializer.prepare === undefined
			? hooks.before(parent[0], tools)
			: hooks.before(shared, tools, ...parent));
		const { after } = hooks;
		if (after !== undefined) {
			tools.scope.defer("template after", (cleanup) => after(context, cleanup));
		}
		tools.signal.throwIfAborted();
		return context;
	}

	#dispose(): Promise<void> {
		this.#disposal ??= Promise.resolve().then(() => this.#close());
		return this.#disposal;
	}

	async #close(): Promise<void> {
		const errors: unknown[] = [];
		for (const child of [...this.#children].reverse()) {
			try {
				await child.#dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		await Promise.all(this.#active);
		errors.push(...(await this.#scope.close(cleanupTools())));
		if (this.parent !== undefined) this.parent.#children.delete(this);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1)
			throw new AggregateError(errors, "Testmint template disposal failed.");
	}
}

function validateAttemptHooks(candidate: unknown) {
	if (candidate === undefined) return undefined;
	const { before, after } = isDefinitionCandidate(candidate) ? candidate : {};
	if (
		typeof before !== "function" ||
		(after !== undefined && typeof after !== "function")
	) {
		throw new TypeError(
			"Testmint template attempt hooks require a callable before hook and an optional callable after hook.",
		);
	}
	return {
		before: (
			context: unknown,
			tools: SetupTools,
			...parent: unknown[]
		): unknown => before(context, tools, ...parent),
		after:
			typeof after === "function"
				? (context: unknown, tools: CleanupTools): unknown =>
						after(context, tools)
				: undefined,
	};
}

function cleanupTools(): CleanupTools {
	return { signal: new AbortController().signal };
}

class CleanupScope implements ResourceScope {
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

function eventError(error: unknown): EventError {
	try {
		if (error instanceof Error) {
			return {
				name: error.name,
				message: error.message,
				...(error.stack === undefined ? {} : { stack: error.stack }),
			};
		}
		return { name: "Error", message: String(error) };
	} catch {
		return { name: "Error", message: "Unprintable error" };
	}
}

class EventEmitter {
	#sequence = 0;

	constructor(
		private readonly sink: EventSink | undefined,
		private readonly context: EventContext | undefined,
		private readonly nextSequence: (() => number) | undefined,
	) {}

	async emit(event: EventPayload): Promise<void> {
		if (!this.sink) return;
		try {
			const complete: TestmintEvent = {
				...(this.context ?? {
					runId: "local",
					producerId: "local",
					attemptId: "local",
					testId: "local",
					title: "local",
				}),
				...event,
				v: 1,
				seq: this.nextSequence?.() ?? this.#sequence++,
				timestamp: new Date().toISOString(),
			} as TestmintEvent;
			await this.sink.emit(complete);
		} catch {
			// Instrumentation is not allowed to affect test behavior in this slice.
		}
	}
}

async function runPhase<T>(
	phase: PhaseName,
	emitter: EventEmitter,
	callback: () => Awaitable<T>,
	executePhase: ExecuteOptions["executePhase"],
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	const startedAt = performance.now();
	await emitter.emit({ kind: "phase.start", phase });
	try {
		const value = await (executePhase === undefined
			? callback()
			: executePhase(phase, callback));
		await emitter.emit({
			kind: "phase.end",
			phase,
			status: "passed",
			durationMs: performance.now() - startedAt,
		});
		return { ok: true, value };
	} catch (error) {
		await emitter.emit({
			kind: "phase.end",
			phase,
			status: "failed",
			durationMs: performance.now() - startedAt,
			error: eventError(error),
		});
		return { ok: false, error };
	}
}

async function skipPhase(
	emitter: EventEmitter,
	phase: PhaseName,
	reason: string,
): Promise<void> {
	await emitter.emit({
		kind: "phase.end",
		phase,
		status: "skipped",
		durationMs: 0,
		reason,
	});
}

export async function executeDefinition<Input, Output>(
	definition: ValidatedDefinition<Input, Output>,
	options: ExecuteOptions = {},
): Promise<void> {
	const scope = new CleanupScope();
	const emitter = new EventEmitter(
		options.sink,
		options.eventContext,
		options.nextEventSequence,
	);
	const signal = options.signal ?? new AbortController().signal;
	const setupTools: SetupTools = { signal, scope };
	const exerciseTools: ExerciseTools = { signal, scope };
	const phaseTools: PhaseTools = { signal };
	const cleanup = cleanupTools();
	let completedSetup: { input: Input } | undefined;
	let failure: { error: unknown } | undefined;
	const cleanupErrors: unknown[] = [];

	await emitter.emit({ kind: "attempt.start" });

	const setup = await runPhase(
		"setup",
		emitter,
		() => definition.setup(setupTools),
		options.executePhase,
	);
	if (setup.ok) {
		const input = setup.value;
		completedSetup = { input };
		const exercise = await runPhase(
			"exercise",
			emitter,
			() => definition.exercise(input, exerciseTools),
			options.executePhase,
		);
		if (exercise.ok) {
			const verify = await runPhase(
				"verify",
				emitter,
				() => definition.verify(exercise.value, input, phaseTools),
				options.executePhase,
			);
			if (!verify.ok) failure = verify;
		} else {
			failure = exercise;
			await skipPhase(emitter, "verify", "exercise failed");
		}
	} else {
		failure = setup;
		await skipPhase(emitter, "exercise", "setup failed");
		await skipPhase(emitter, "verify", "setup failed");
	}

	async function cleanupAttempt() {
		if (completedSetup && definition.teardown) {
			try {
				await definition.teardown(completedSetup.input, cleanup);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		cleanupErrors.push(...(await scope.close(cleanup)));
	}

	let cleaning: Promise<void> | undefined;
	const teardown = await runPhase(
		"teardown",
		emitter,
		async () => {
			cleaning ??= cleanupAttempt();
			await cleaning;
			if (cleanupErrors.length === 1) throw cleanupErrors[0];
			if (cleanupErrors.length > 1)
				throw new AggregateError(cleanupErrors, "Testmint cleanup failed.");
		},
		options.executePhase,
	);
	if (cleaning === undefined) {
		if (!teardown.ok) cleanupErrors.push(teardown.error);
		await cleanupAttempt();
	} else if (!teardown.ok) {
		await cleaning;
		if (cleanupErrors.length === 0) cleanupErrors.push(teardown.error);
	}

	const errors =
		failure === undefined ? cleanupErrors : [failure.error, ...cleanupErrors];
	const failed = errors.length > 0;
	const finalError =
		errors.length > 1
			? new AggregateError(errors, "Testmint execution and cleanup failed.")
			: errors[0];
	await emitter.emit({
		kind: "attempt.end",
		status: failed ? "failed" : "passed",
		...(failed ? { error: eventError(finalError) } : {}),
	});
	if (failed) throw finalError;
}
