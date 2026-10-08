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
			const after = new URL(url).searchParams.get("after");
			if (after === null) {
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
		expect(new URL(calls[0]).searchParams.has("page")).toBe(false);
		expect(new URL(calls[1]).searchParams.get("after")).toBe("r2");
	});

	test("caps page size at the provider maximum of 100", async () => {
		let url = "";
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", pageSize: 200,
			fetch: async (input) => { url = String(input); return jsonResponse({ data: [], has_more: false }); } });
		await client.listPage(0);
		expect(new URL(url).searchParams.get("limit")).toBe("100");
	});

	test("malformed provider listings are not successful empty scans", async () => {
		for (const body of [{}, { data: [], has_more: "false" }, { data: [{}], has_more: false }, { data: [], has_more: true }]) {
			const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => jsonResponse(body) });
			await expect(client.listPage(0)).rejects.toMatchObject({ code: "invalid_response" });
		}
	});

	test("a repeated cursor is refused rather than looping forever", async () => {
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => jsonResponse({ data: [{ id: "r1" }], has_more: true }) });
		await expect((async () => { for await (const _ of client.paginate({ maxPages: 5 })) { /* consume */ } })()).rejects.toMatchObject({ code: "invalid_response" });
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

describe("raw download credential and redirect safety", () => {
	test("never sends the API credential to a signed download URL", async () => {
		let headers: Headers | undefined;
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", allowedDownloadHosts: ["dl.test"],
			fetch: async (_url, init) => { headers = new Headers(init?.headers); return new Response("mime"); } });
		await client.fetchRaw({ downloadUrl: "https://dl.test/raw?Signature=private" });
		expect(headers?.has("authorization")).toBe(false);
	});

	test("redirect targets are checked before any second network call", async () => {
		const calls: string[] = [];
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", allowedDownloadHosts: ["dl.test"],
			fetch: async (url, init) => { calls.push(String(url)); expect(init?.redirect).toBe("manual");
				return new Response(null, { status: 302, headers: { location: "https://evil.test/leak" } }); } });
		await expect(client.fetchRaw({ downloadUrl: "https://dl.test/raw" })).rejects.toMatchObject({ code: "untrusted_url" });
		expect(calls).toHaveLength(1);
	});

	test("URL credentials and alternate ports are refused before a fetch", async () => {
		let calls = 0;
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => { calls++; return new Response("mime"); } });
		for (const url of ["https://user:password@api.resend.com/raw", "https://api.resend.com:8443/raw"]) {
			await expect(client.fetchRaw({ downloadUrl: url })).rejects.toMatchObject({ code: "invalid_url" });
		}
		expect(calls).toBe(0);
	});

	test("mismatched length and midstream overflow are never returned as complete MIME", async () => {
		const incomplete = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => new Response("abc", { headers: { "content-length": "4" } }) });
		await expect(incomplete.fetchRaw({ downloadUrl: "https://api.resend.com/raw" })).rejects.toMatchObject({ code: "raw_incomplete" });
		const oversized = new ResendReceivingClient({ apiKey: "fixture-only-api-key", maxRawBytes: 2, fetch: async () => new Response("abc") });
		await expect(oversized.fetchRaw({ downloadUrl: "https://api.resend.com/raw" })).rejects.toMatchObject({ code: "raw_too_large" });
	});
});

describe("body failure redaction and raw retry hints", () => {
	test("JSON parsing failures never expose response text or credentials", async () => {
		const leaked = "fixture-private-key-from-response";
		const response = jsonResponse({});
		response.json = async () => { throw new SyntaxError(leaked); };
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => response });
		try { await client.listPage(0); throw new Error("expected rejection"); }
		catch (err) { expect(err).toBeInstanceOf(ResendError); expect(err).toMatchObject({ retryable: true }); expect(String(err)).not.toContain(leaked); }
	});

	test("raw stream failures are sanitized retryable errors", async () => {
		const leaked = "fixture-private-signed-url-token";
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(leaked)); } })) });
		try { await client.fetchRaw({ downloadUrl: "https://api.resend.com/raw" }); throw new Error("expected rejection"); }
		catch (err) { expect(err).toBeInstanceOf(ResendError); expect(err).toMatchObject({ retryable: true }); expect(String(err)).not.toContain(leaked); }
	});

	test("raw download rate limits preserve only valid retry hints", async () => {
		for (const [header, wanted] of [["9", 9], ["-1", null], ["nonsense", null]] as const) {
			const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => new Response(null, { status: 429, headers: { "retry-after": header } }) });
			await expect(client.fetchRaw({ downloadUrl: "https://api.resend.com/raw" })).rejects.toMatchObject({ retryable: true, retryAfterSeconds: wanted });
		}
	});
});

describe("retrieval metadata and redirect cleanup", () => {
	test("retrieved metadata must match the requested id and define valid raw information", async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		for (const body of [null, {}, { id: "different", raw: null }, { id: "r1", raw: { expires_at: future } }, { id: "r1", raw: { download_url: "https://api.resend.com/raw", expires_at: "not-a-date" } }]) {
			const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => jsonResponse(body) });
			await expect(client.retrieve("r1")).rejects.toMatchObject({ code: "invalid_response", retryable: true });
		}
	});

	test("errored redirect cleanup cannot leak a signed secret or make a second fetch", async () => {
		let calls = 0;
		const leaked = "fixture-private-redirect-token";
		const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => { calls++;
			return new Response(new ReadableStream({ start(controller) { controller.error(new Error(leaked)); } }), { status: 302, headers: { location: "https://api.resend.com/next" } }); } });
		try { await client.fetchRaw({ downloadUrl: "https://api.resend.com/raw" }); throw new Error("expected rejection"); }
		catch (err) { expect(err).toBeInstanceOf(ResendError); expect(err).toMatchObject({ retryable: true }); expect(String(err)).not.toContain(leaked); }
		expect(calls).toBe(1);
	});

	test("known HTTP failures and oversize declarations cancel unused bodies safely", async () => {
		let cancellations = 0;
		const body = () => new ReadableStream({ cancel() { cancellations++; throw new Error("fixture-private-cleanup-token"); } });
		const limited = new ResendReceivingClient({ apiKey: "fixture-only-api-key", fetch: async () => new Response(body(), { status: 429, headers: { "retry-after": "9" } }) });
		await expect(limited.fetchRaw({ downloadUrl: "https://api.resend.com/raw" })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 9 });
		const oversized = new ResendReceivingClient({ apiKey: "fixture-only-api-key", maxRawBytes: 2, fetch: async () => new Response(body(), { headers: { "content-length": "3" } }) });
		await expect(oversized.fetchRaw({ downloadUrl: "https://api.resend.com/raw" })).rejects.toMatchObject({ code: "raw_too_large" });
		expect(cancellations).toBe(2);
	});
});

describe("overflow cancellation preserves known size rejection", () => {
	test("throwing and hanging cancellation cannot hide or delay an oversized-message rejection", async () => {
		for (const hanging of [false, true]) {
			let cancellations = 0;
			const client = new ResendReceivingClient({ apiKey: "fixture-only-api-key", timeoutMs: 20, maxRawBytes: 2,
				fetch: async () => new Response(new ReadableStream({
					start(controller) { controller.enqueue(new Uint8Array(3)); },
					cancel() { cancellations++; if (hanging) return new Promise<void>(() => {}); throw new Error("fixture-private-cancel-token"); }
				})) });
			const result = await Promise.race([
				client.fetchRaw({ downloadUrl: "https://api.resend.com/raw" }).catch(err => err),
				new Promise(resolve => setTimeout(() => resolve("still hanging"), 300)),
			]);
			expect(result).toBeInstanceOf(ResendError);
			expect(result).toMatchObject({ code: "raw_too_large", retryable: false });
			expect(String(result)).not.toContain("fixture-private-cancel-token");
			expect(cancellations).toBe(1);
		}
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
