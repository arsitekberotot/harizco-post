// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post test harness for the future Node/Hono runtime (Task 3).
//
// Minimal production API these tests assume:
// - `server/config.ts` exports `loadConfig(env)`
// - `server/app.ts` exports `createApp(options)` with an explicit auth /
//   mail-store injection seam for tests
//
// Until Task 3 lands those modules, importing this helper fails RED by design.

import type { Hono } from "hono";
import type { MailStore } from "../../server/app";
import type { MailBackend, ConfiguredAddresses } from "../../server/mail/backend";
import type { AppConfig } from "../../server/config";
import type { StatusReport } from "../../server/routes/status";

// Collect the individual contracts even before the planned modules exist.
// Missing runtime code is a test assertion failure, not an empty failed suite.
const runtime = await Promise.allSettled([
	import("../../server/app"),
	import("../../server/config"),
]);

function requireRuntime<T>(result: PromiseSettledResult<T>): T {
	if (result.status === "rejected") {
		throw new Error("Planned runtime module is not implemented", {
			cause: result.reason,
		});
	}
	return result.value;
}

const createApp: typeof import("../../server/app").createApp = (options) =>
	requireRuntime(runtime[0]).createApp(options);
const loadConfig: typeof import("../../server/config").loadConfig = (env) =>
	requireRuntime(runtime[1]).loadConfig(env);

export type TestAuthMode = "access" | "fixture";

export type MailStoreCall = {
	method: string;
	path: string;
};

/**
 * Probe used by contract tests to prove private routes never touch mail
 * storage when Access is missing.
 */
export type MailStoreProbe = MailStore & {
	calls: MailStoreCall[];
	record(method: string, path: string): void;
};

export type CreateTestAppOptions = {
	/** Default `access` — production-style JWT validation path. */
	authMode?: TestAuthMode;
	/** Process-like env map passed to `loadConfig`. */
	env?: Record<string, string | undefined>;
	/** Real mail backend (Phase 2+). Absent => honest 503 on private reads. */
	backend?: MailBackend;
	/** Operator-provisioned addresses returned by GET /api/v1/config. */
	addresses?: ConfiguredAddresses;
	/** Sync/import status source for GET /api/v1/status. */
	statusProvider?: () => StatusReport | Promise<StatusReport>;
};

export type TestAppHandle = {
	app: Hono;
	config: AppConfig;
	mailStore: MailStoreProbe;
};

const PRODUCTION_ACCESS_ENV = {
	NODE_ENV: "production",
	TEAM_DOMAIN: "example.cloudflareaccess.com",
	POLICY_AUD: "test-policy-aud",
	OWNER_EMAIL: "owner@example.invalid",
} as const;

export function productionAccessEnv(
	overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	return { ...PRODUCTION_ACCESS_ENV, ...overrides };
}

export function createMailStoreProbe(): MailStoreProbe {
	const calls: MailStoreCall[] = [];
	return {
		calls,
		record(method, path) {
			calls.push({ method, path });
		},
		async listMailboxes() {
			// Phase 1 has no mailbox backend; the probe only records calls.
			return { mailboxes: [] };
		},
	};
}

/**
 * Build the future production app with an explicit test seam.
 *
 * - `authMode: "access"` — fail closed without a valid Access assertion.
 * - `authMode: "fixture"` — explicit test-only injection; never a silent
 *   production bypass via env vars alone.
 */
export function createTestApp(
	options: CreateTestAppOptions = {},
): TestAppHandle {
	const authMode = options.authMode ?? "access";
	const env =
		authMode === "access"
			? productionAccessEnv(options.env)
			: {
					NODE_ENV: "test",
					...options.env,
				};

	const config = loadConfig(env);
	const mailStore = createMailStoreProbe();
	const app = createApp({
		config,
		authMode,
		mailStore,
		...(options.backend ? { backend: options.backend } : {}),
		...(options.addresses ? { addresses: options.addresses } : {}),
		...(options.statusProvider ? { statusProvider: options.statusProvider } : {}),
	});

	return { app, config, mailStore };
}

export { loadConfig, createApp };
