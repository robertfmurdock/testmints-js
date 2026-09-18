import "vite";

import type { InlineConfig } from "vitest/config";

declare module "vite" {
	interface UserConfig {
		test?: InlineConfig;
	}
}
