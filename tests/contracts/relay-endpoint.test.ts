// Task 15: the worker-side relay endpoint.
//
// The web process holds no provider secret; it forwards `{requestId, payload}`
// to this endpoint, which owns the Resend key. Properties that matter:
//   1. The endpoint authenticates its caller with a shared secret and refuses
//      an unauthenticated or wrong-secret request BEFORE any provider call.
//   2. It relays through the real ResendRelay (stable idempotency key), so a
//      retry cannot double-send, and reports the provider id on success.
//   3. Ambiguity is surfaced as 202 (held for reconciliation), never as
//      success; a definite rejection is 4xx; the response never leaks the key.
//
// Synthetic only: the provider fetch is stubbed; no live relay is contacted.

import { describe, expect, test, vi } from "vitest";
import { createRelayHandler } from "../../server/routes/relay";

const SECRET = "shared-web-to-worker-secret-0001";

function handler(fetchImpl: typeof fetch) {
	return createRelayHandler({
		secret: SECRET,
		relay: { apiKey: "re_test_key", baseUrl: "https://api.resend.test", fetch: fetchImpl },
	});
}

function post(body: unknown, headers: Record<string, string> = {}) {
	return new Request("http://127.0.0.1:8788/submit", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

const payload = {
	requestId: "sub_abc",
	payload: { mailboxId: "mb1", from: "hanif@atelieriza.com", to: ["friend@example.test"], subject: "Hi", body: "Hello" },
};

describe("relay endpoint auth", () => {
	test("refuses a missing shared secret without calling the provider", async () => {
		const impl = vi.fn();
		const res = await handler(impl as unknown as typeof fetch)(post(payload));
		expect(res.status).toBe(401);
		expect(impl).not.toHaveBeenCalled();
	});

	test("refuses a wrong shared secret without calling the provider", async () => {
		const impl = vi.fn();
		const res = await handler(impl as unknown as typeof fetch)(post(payload, { authorization: "Bearer wrong-secret" }));
		expect(res.status).toBe(401);
		expect(impl).not.toHaveBeenCalled();
	});
});

describe("relay endpoint relay", () => {
	test("an accepted send returns the provider id", async () => {
		const impl = vi.fn(async () => Response.json({ id: "prov-9" })) as unknown as typeof fetch;
		const res = await handler(impl)(post(payload, { authorization: `Bearer ${SECRET}` }));
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ providerId: "prov-9" });
	});

	test("an ambiguous provider result is 202, never a success", async () => {
		const impl = vi.fn(async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
		const res = await handler(impl)(post(payload, { authorization: `Bearer ${SECRET}` }));
		expect(res.status).toBe(202);
	});

	test("a definite rejection is a 4xx and never contains the provider key", async () => {
		const impl = vi.fn(async () => new Response("bad", { status: 422 })) as unknown as typeof fetch;
		const res = await handler(impl)(post(payload, { authorization: `Bearer ${SECRET}` }));
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		expect(await res.text()).not.toContain("re_test_key");
	});

	test("a malformed body is refused without a provider call", async () => {
		const impl = vi.fn();
		const res = await handler(impl as unknown as typeof fetch)(
			post({ nope: true }, { authorization: `Bearer ${SECRET}` }),
		);
		expect(res.status).toBe(400);
		expect(impl).not.toHaveBeenCalled();
	});
});
