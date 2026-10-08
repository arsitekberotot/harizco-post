// Task 15 composition: the outbound binding is fail-closed.
//
// A half-set sender identity must refuse to start (never send From the wrong
// address) and an unset binding must disable sending honestly rather than
// silently degrading. The web process must NOT need a provider secret here.

import { describe, expect, test } from "vitest";
import { loadOutboundBinding } from "../../server/config";
import { configuredAddressesFrom } from "../../server/index";

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

// GET /api/v1/config feeds the UI's mailbox-domain picker. If this derivation
// regresses the picker goes empty and Create stays disabled ("@ no domain"),
// even though the sender identity is perfectly valid.
describe("configuredAddressesFrom", () => {
	test("reports the owned domain and address from the binding", () => {
		const binding = loadOutboundBinding({ OUTBOUND_FROM: "hanif@atelieriza.com", OUTBOUND_RELAY_URL: "http://127.0.0.1:8788/submit" });
		expect(configuredAddressesFrom(binding)).toEqual({
			domains: ["atelieriza.com"],
			emailAddresses: ["hanif@atelieriza.com"],
		});
	});

	test("returns undefined when there is no binding, so the route stays honest", () => {
		expect(configuredAddressesFrom(null)).toBeUndefined();
	});

	test("refuses to invent a domain from a blank binding", () => {
		expect(configuredAddressesFrom({ address: "", domain: "" } as never)).toBeUndefined();
	});
});
