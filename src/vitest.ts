import { test } from "vitest";

import {
	executeDefinition,
	type TestmintDefinition,
	validateDefinition,
} from "./core.js";

/** Register a complete Testmint definition with Vitest. */
export function mintTest<Input, Output>(
	name: string,
	definition: TestmintDefinition<Input, Output>,
): void {
	const validated = validateDefinition(definition);
	test(name, async () => executeDefinition(validated));
}
