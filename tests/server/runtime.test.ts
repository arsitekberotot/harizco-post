// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: failing-first contracts for the future local Node runtime.
// Expected RED until Task 3 adds server/config.ts and server/app.ts.

import { describe, expect, test } from "vitest";
import {
	createTestApp,
	loadConfig,
	productionAccessEnv,
} from "../helpers/app";

describe("loadConfig", () => {
	test("binds only 127.0.0.1 with default port 3000", () => {
		const config = loadConfig(productionAccessEnv());
		expect(config.host).toBe("127.0.0.1");
		expect(config.port).toBe(3000);
	});

	test("rejects a non-loopback host override", () => {
		expect(() =>
			loadConfig(productionAccessEnv({ HOST: "0.0.0.0" })),
		).toThrow(/127\.0\.0\.1|loopback|host/i);
	});

	test("validates a configured port", () => {
		expect(() =>
			loadConfig(productionAccessEnv({ PORT: "not-a-port" })),
		).toThrow(/port/i);
		expect(() =>
			loadConfig(productionAccessEnv({ PORT: "70000" })),
		).toThrow(/port/i);

		const config = loadConfig(productionAccessEnv({ PORT: "3001" }));
		expect(config.port).toBe(3001);
	});

	test("production fails closed without TEAM_DOMAIN, POLICY_AUD, and OWNER_EMAIL", () => {
		expect(() =>
			loadConfig({
				NODE_ENV: "production",
			}),
		).toThrow(/TEAM_DOMAIN|POLICY_AUD|OWNER_EMAIL|Access/i);

		expect(() =>
			loadConfig({
				NODE_ENV: "production",
				TEAM_DOMAIN: "example.cloudflareaccess.com",
			}),
		).toThrow(/POLICY_AUD|OWNER_EMAIL|Access/i);
	});

	test("fixture/dev bypass env must not silently enable a production bypass", () => {
		expect(() =>
			loadConfig({
				NODE_ENV: "production",
				FIXTURE_AUTH_BYPASS: "1",
				ALLOW_FIXTURE_AUTH: "true",
				DEV_AUTH_BYPASS: "true",
			}),
		).toThrow(/TEAM_DOMAIN|POLICY_AUD|OWNER_EMAIL|Access|bypass/i);
	});
});

describe("createApp runtime contracts", () => {
	test("a missing production Access assertion cannot read mailbox data", async () => {
		const { app, mailStore } = createTestApp({ authMode: "access" });
		const response = await app.request("/api/v1/mailboxes");
		expect(response.status).toBe(403);
		expect(mailStore.calls).toEqual([]);
		expect(response.headers.get("cache-control") ?? "").toMatch(/no-store/i);
	});

	test("header-presence-only identity is not enough for private API access", async () => {
		const { app, mailStore } = createTestApp({ authMode: "access" });
		const response = await app.request("/api/v1/mailboxes", {
			headers: {
				"cf-access-authenticated-user-email": "owner@example.invalid",
			},
		});
		expect(response.status).toBe(403);
		expect(mailStore.calls).toEqual([]);
	});

	test("unknown /api paths return JSON 404, not HTML 200", async () => {
		const { app } = createTestApp({ authMode: "access" });
		const response = await app.request("/api/no-such-route");
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type") ?? "").toMatch(/json/i);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("error");
		const text = JSON.stringify(body);
		expect(text).not.toMatch(/<!DOCTYPE html>/i);
	});

	test("health is non-sensitive and reachable without Access", async () => {
		const { app } = createTestApp({ authMode: "access" });
		const response = await app.request("http://127.0.0.1:3000/health", {
			headers: { host: "127.0.0.1:3000" },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body).not.toHaveProperty("ownerEmail");
		expect(body).not.toHaveProperty("TEAM_DOMAIN");
		expect(body).not.toHaveProperty("POLICY_AUD");
		expect(JSON.stringify(body)).not.toMatch(/cloudflareaccess|secret|token/i);
	});

	test("authenticated mail API returns honest 503 before a mailbox backend exists", async () => {
		const { app, mailStore } = createTestApp({
			authMode: "fixture",
			env: {
				NODE_ENV: "test",
			},
		});
		const response = await app.request("/api/v1/mailboxes");
		expect(response.status).toBe(503);
		expect(mailStore.calls.length).toBeGreaterThan(0);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("error");
		expect(JSON.stringify(body)).not.toMatch(/@harizco-post\.invalid/i);
	});

	test("private API responses use no-store caching", async () => {
		const { app } = createTestApp({ authMode: "access" });
		const response = await app.request("/api/v1/mailboxes");
		expect(response.headers.get("cache-control") ?? "").toMatch(/no-store/i);
	});
});
