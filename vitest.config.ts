// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post additions: Vitest harness for Node runtime contract tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		exclude: ["tests/ui/**", "node_modules/**"],
		// Homelab-friendly: avoid parallel forks during Phase 1.
		fileParallelism: false,
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
			},
		},
		watch: false,
	},
});
