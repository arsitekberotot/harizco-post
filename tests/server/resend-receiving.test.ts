// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 9: Resend receiving API client.
//
// Ingress is pull-based: there is no public webhook in the MVP. This client is
// deliberately defensive because provider retention is finite and a raw MIME
// body may be missing or its signed URL may have expired.

import { describe, expect, test } from "vitest";
import {
	ResendReceivingClient,
	ResendError,
	isRawExpired,
	redactSecrets,
} from "../../server/integrations/resend-receiving";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("paginated listing", () => {
	test("honours has_more and an explicit bounded page size", async () => {
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			calls.push(url);
			const page = new URL(url).searchParams.get("page");
			if (page === "0") {
				return jsonResponse({ data: [{ id: "r1" }, { id: "r2" }], has_more: true });
			}
			return jsonResponse({ data: [{ id: "r3" }], has_more: false });
		};
		const client = new ResendReceivingClient({ apiKey: "k", fetch: fetchImpl, pageSize: 2 });
		const all: { id: string }[] = [];
		for await (const batch of client.paginate({ limit: 10 })) {
			all.push(...batch.data);
			if (!batch.hasMore) break;
		}
		expect(all.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
		expect(calls.length).toBe(2);
		// Page size must be explicit, never left to the provider default.
		expect(calls[0]).toContain("limit=2");
	});

	test("never checkpoints past an undiscovered page when has_more is true", async () => {
		const fetchImpl: typeof fetch = async () =>
			jsonResponse({ data: [{ id: "r1" }], has_more: true });
		const client = new ResendReceivingClient({ apiKey: "k", fetch: fetchImpl, pageSize: 1 });
		const first = await client.listPage(0);
		expect(first.hasMore).toBe(true);
		// The caller must not treat a has_more page as complete.
		expect(first.complete).toBe(false);
	});
});

describe("raw content handling", () => {
	test("a null raw body is reported as unavailable, not as an empty email", async () => {
		const fetchImpl: typeof fetch = async () => jsonResponse({ id: "r1", raw: null });
		const client = new ResendReceivingClient({ apiKey: "k", fetch: fetchImpl });
		const msg = await client.retrieve("r1");
		expect(msg.raw).toBeNull();
		expect(msg.rawAvailable).toBe(false);
	});

	test("recognises an expired signed download URL", () => {
		const past = new Date(Date.now() - 1000).toISOString();
		expect(isRawExpired({ download_url: "https://x", expires_at: past })).toBe(true);
		const future = new Date(Date.now() + 60_000).toISOString();
		expect(isRawExpired({ download_url: "https://x", expires_at: future })).toBe(false);
	});

	test("expired URLs are refreshed by re-retrieving, never persisted as an archive", async () => {
		let retrievals = 0;
		const future = new Date(Date.now() + 60_000).toISOString();
		const fetchImpl: typeof fetch = async () => {
			retrievals += 1;
			return jsonResponse({
				id: "r1",
				raw: { download_url: `https://dl.test/r1?t=${retrievals}`, expires_at: future },
			});
		};
		const client = new ResendReceivingClient({ apiKey: "k", fetch: fetchImpl });
		const a = await client.retrieve("r1");
		const b = await client.retrieve("r1");
		expect(a.raw!.download_url).not.toBe(b.raw!.download_url);
		expect(retrievals).toBe(2);
	});

	test("only provider-supplied URLs are fetched; an arbitrary URL is refused", async () => {
		const client = new ResendReceivingClient({ apiKey: "k", fetch: async () => jsonResponse({}) });
		await expect(client.fetchRaw({ downloadUrl: "https://evil.example/steal" })).rejects.toThrow(/not a provider/i);
	});

	test("streaming download enforces a byte ceiling", async () => {
		const bytes = new Uint8Array(5000);
		const fetchImpl: typeof fetch = async () =>
			new Response(bytes, { headers: { "content-length": String(bytes.length) } });
		const client = new ResendReceivingClient({
			apiKey: "k",
			fetch: fetchImpl,
			allowedDownloadHosts: ["dl.test"],
			maxRawBytes: 1000,
		});
		await expect(
			client.fetchRaw({ downloadUrl: "https://dl.test/r1", allowAnyHostForTest: false }),
		).rejects.toThrow(/exceeds/i);
	});
});

describe("error handling and redaction", () => {
	test("rate limits are surfaced as retryable with a backoff hint", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("rate limited", { status: 429, headers: { "retry-after": "2" } });
		const client = new ResendReceivingClient({ apiKey: "k", fetch: fetchImpl });
		await expect(client.listPage(0)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
	});

	test("provider 5xx is retryable, 4xx auth failure is not", async () => {
		const fiveX = new ResendReceivingClient({
			apiKey: "k",
			fetch: async () => new Response("boom", { status: 503 }),
		});
		await expect(fiveX.listPage(0)).rejects.toMatchObject({ retryable: true });

		const fourX = new ResendReceivingClient({
			apiKey: "bad",
			fetch: async () => new Response("nope", { status: 401 }),
		});
		await expect(fourX.listPage(0)).rejects.toMatchObject({ retryable: false });
	});

	test("errors and logs never contain the API key or a signed URL", async () => {
		const secret = "re_super_secret_key";
		const client = new ResendReceivingClient({
			apiKey: secret,
			fetch: async () => new Response("denied", { status: 401 }),
		});
		try {
			await client.listPage(0);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ResendError);
			expect(String((err as Error).message)).not.toContain(secret);
		}
		expect(redactSecrets(`key=${secret}&url=https://dl.test/a?token=xyz`)).not.toContain(secret);
		expect(redactSecrets("https://dl.test/a?token=xyz")).not.toContain("xyz");
	});

	test("a timeout aborts rather than hanging the sync loop", async () => {
		const fetchImpl: typeof fetch = async (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		};
		const client = new ResendReceivingClient({ apiKey: "k", fetch: fetchImpl, timeoutMs: 20 });
		await expect(client.listPage(0)).rejects.toThrow(/abort|timeout/i);
	});
});
