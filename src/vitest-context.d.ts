import "vitest";

import type { ReportingContext } from "./reporting.js";

declare module "vitest" {
	interface ProvidedContext {
		testmints?: ReportingContext;
	}
}
