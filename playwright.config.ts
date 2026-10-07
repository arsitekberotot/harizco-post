// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post additions: Playwright harness for retained-mail UI contracts.
// Browser runs depend on Task 3 build + `preview:fixtures`; do not claim
// baseline screenshots until that runtime exists.

import { defineConfig, devices } from "@playwright/test";

import { fixturePreviewPort } from "./tests/helpers/fixture-preview";

const PREVIEW_ORIGIN = `http://127.0.0.1:${fixturePreviewPort()}`;

export default defineConfig({
	testDir: "./tests/ui",
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: [["list"], ["html", { open: "never" }]],
	timeout: 60_000,
	use: {
		baseURL: PREVIEW_ORIGIN,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "desktop",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1280, height: 720 },
			},
		},
		{
			name: "mobile",
			use: {
				...devices["Pixel 5"],
			},
		},
	],
	webServer: {
		command: "npm run preview:fixtures",
		url: `${PREVIEW_ORIGIN}/health`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
