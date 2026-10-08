// Copyright (c) 2026 Cloudflare, Inc.
// Apache-2.0. Harizco Post: web production backend binding contracts.
//
// Proves the composition seam that turns a validated mailbox binding into a
// private read backend, plus the config validation around it. Synthetic
// transport only: no real Stalwart, network, or account operation.

import { describe, expect, test, vi } from "vitest";
import { loadConfig, loadMailboxBinding } from "../../server/config";
import { createProductionBackend } from "../../server/index";
import { securityEnv } from "../security/fixtures";

const boundEnv = { ...securityEnv, STALWART_URL: "http://127.0.0.1:8080", STALWART_USERNAME: "read", STALWART_SECRET: "synthetic-secret" };

describe("loadMailboxBinding", () => {
	test("returns null when no mailbox variable is set (honest 503 path)", () => {
		expect(loadMailboxBinding(securityEnv)).toBeNull();
	});

	test("normalises the endpoint and keeps the declared account when present", () => {
		const binding = loadMailboxBinding({ ...boundEnv, STALWART_ACCOUNT_ID: "acct-1" });
		expect(binding).toEqual({ url: "http://127.0.0.1:8080", username: "read", secret: "synthetic-secret", accountId: "acct-1" });
	});

	test("omits the account when undeclared so the session discovers it", () => {
		expect(loadMailboxBinding(boundEnv)).toEqual({ url: "http://127.0.0.1:8080", username: "read", secret: "synthetic-secret" });
	});

	test.each(["STALWART_URL", "STALWART_USERNAME", "STALWART_SECRET"])(
		"refuses a partial binding missing %s rather than degrading to 503",
		missing => {
			const env: Record<string, string> = { ...boundEnv };
			delete env[missing];
			expect(() => loadMailboxBinding(env)).toThrow(new RegExp(missing));
		},
	);

	test("rejects a non-URL endpoint", () => {
		expect(() => loadMailboxBinding({ ...boundEnv, STALWART_URL: "not a url" })).toThrow(/STALWART_URL/);
	});
});

describe("loadConfig + binding", () => {
	test("exposes the binding on the web config when fully set, and null otherwise", () => {
		expect(loadConfig(securityEnv).mailbox).toBeNull();
		expect(loadConfig(boundEnv).mailbox).toEqual({ url: "http://127.0.0.1:8080", username: "read", secret: "synthetic-secret" });
	});
});

describe("createProductionBackend", () => {
	test("returns null without a binding so authenticated reads keep their honest 503", () => {
		expect(createProductionBackend(loadConfig(securityEnv))).toBeNull();
	});

	test("constructs a JmapMailBackend bound to the configured endpoint with synthetic transport", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ capabilities: { "urn:ietf:params:jmap:core": {} }, accounts: { "acct-1": { name: "primary" } }, primaryAccounts: {}, apiUrl: "http://127.0.0.1:8080/api", sessionState: "s" }),
		);
		const backend = createProductionBackend(loadConfig(boundEnv), { fetch: fetcher });
		expect(backend).not.toBeNull();
		// The client discovers its account lazily; a mailbox listing proves the
		// injected transport is used. The secret is sent only as a JMAP
		// Authorization header on the outbound provider request, never on a
		// browser-facing response.
		await backend!.listMailboxes().catch(() => undefined);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toContain("127.0.0.1:8080");
		expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic |^Bearer /);
	});
});
