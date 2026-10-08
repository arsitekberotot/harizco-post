// Task 15: the production RelayTransport carries a STABLE idempotency header
// through retries and reports ambiguity honestly.
//
// The plan requires (Task 15 item 5) that submission retries reuse one Resend
// idempotency key so a network retry cannot double-send, and that an ambiguous
// result is surfaced as `ambiguous` (held for reconciliation) rather than being
// reported as accepted or blindly resent.
//
// Synthetic transport only: fetch is stubbed; no live relay is contacted.

import { describe, expect, test, vi } from "vitest";
import { ResendRelay } from "../../server/integrations/resend-relay";
import type { RelayRequest } from "../../server/mail/submissions";

const request: RelayRequest = {
	requestId: "sub_abc123",
	idempotencyHeader: { name: "Idempotency-Key", value: "sub_abc123" },
	payload: {
		mailboxId: "mb1",
		from: "hanif@atelieriza.com",
		to: ["friend@example.test"],
		cc: [],
		bcc: [],
		subject: "Hi",
		body: "Hello",
	},
};

function relay(fetchImpl: typeof fetch) {
	return new ResendRelay({ apiKey: "test-key", baseUrl: "https://api.resend.test", fetch: fetchImpl });
}

describe("ResendRelay", () => {
	test("carries the idempotency key on the provider request", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init: init! });
			return Response.json({ id: "prov-1" });
		}) as unknown as typeof fetch;

		const outcome = await relay(impl).send(request);
		expect(outcome).toEqual({ status: "accepted", providerId: "prov-1" });
		const headers = calls[0].init.headers as Record<string, string>;
		// The stable key must reach the provider (Resend's idempotency header).
		expect(headers["Idempotency-Key"]).toBe("sub_abc123");
		expect(String(calls[0].url)).toContain("/emails");
	});

	test("a 5xx or network failure is ambiguous, never 'accepted'", async () => {
		const impl = vi.fn(async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
		const outcome = await relay(impl).send(request);
		expect(outcome.status).toBe("ambiguous");
	});

	test("a thrown network error is ambiguous (the relay may have accepted)", async () => {
		const impl = vi.fn(async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const outcome = await relay(impl).send(request);
		expect(outcome.status).toBe("ambiguous");
	});

	test("a 4xx rejection is a definite failure, not ambiguous", async () => {
		const impl = vi.fn(async () => new Response("bad from", { status: 422 })) as unknown as typeof fetch;
		const outcome = await relay(impl).send(request);
		expect(outcome.status).toBe("rejected");
	});

	test("never leaks the API key inside the returned reason", async () => {
		const impl = vi.fn(async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
		const outcome = await relay(impl).send(request);
		expect(outcome.status).toBe("rejected");
		if (outcome.status === "rejected") expect(outcome.reason).not.toContain("test-key");
	});
});
