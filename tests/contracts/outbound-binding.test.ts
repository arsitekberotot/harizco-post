// Task 15 composition: the outbound binding is fail-closed.
//
// A half-set sender identity must refuse to start (never send From the wrong
// address) and an unset binding must disable sending honestly rather than
// silently degrading. The web process must NOT need a provider secret here.

import { describe, expect, test } from "vitest";
import { loadOutboundBinding } from "../../server/config";

describe("loadOutboundBinding", () => {
	test("returns null when nothing is configured (send stays disabled)", () => {
		expect(loadOutboundBinding({})).toBeNull();
	});

	test("refuses a partially configured binding", () => {
		expect(() => loadOutboundBinding({ OUTBOUND_FROM: "hanif@atelieriza.com" })).toThrow(/Incomplete outbound binding/);
		expect(() => loadOutboundBinding({ OUTBOUND_RELAY_URL: "http://127.0.0.1:8788/submit" })).toThrow(/Incomplete outbound binding/);
	});

	test("derives the owned domain from the address and lower-cases it", () => {
		const binding = loadOutboundBinding({
			OUTBOUND_FROM: "Hanif@Atelieriza.com",
			OUTBOUND_RELAY_URL: "http://127.0.0.1:8788/submit/",
		});
		expect(binding).not.toBeNull();
		expect(binding!.address).toBe("hanif@atelieriza.com");
		expect(binding!.domain).toBe("atelieriza.com");
		expect(binding!.relayUrl).toBe("http://127.0.0.1:8788/submit");
		expect(binding!.maxRecipients).toBe(20);
	});

	test("rejects a non-URL relay and a malformed address", () => {
		expect(() => loadOutboundBinding({ OUTBOUND_FROM: "not-an-email", OUTBOUND_RELAY_URL: "http://x.test" })).toThrow(/Invalid OUTBOUND_FROM/);
		expect(() => loadOutboundBinding({ OUTBOUND_FROM: "a@b.test", OUTBOUND_RELAY_URL: "ftp://x.test" })).toThrow(/Invalid OUTBOUND_RELAY_URL/);
	});

	test("carries no provider secret: only a relay URL and sender identity", () => {
		const binding = loadOutboundBinding({ OUTBOUND_FROM: "a@b.test", OUTBOUND_RELAY_URL: "http://x.test", RESEND_API_KEY: "leaky" });
		expect(JSON.stringify(binding)).not.toContain("leaky");
	});
});
