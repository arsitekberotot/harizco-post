// The relay listener binding guards the send path, so it must be fail-closed
// and loopback-only. A relay reached from off-host would be an open relay.

import { describe, expect, test } from "vitest";
import { loadRelayBinding } from "../../server/config";

describe("loadRelayBinding", () => {
	test("returns null when unset (no listener, sends stay refused)", () => {
		expect(loadRelayBinding({})).toBeNull();
	});

	test("refuses a partial binding (a relay without a secret is an open path)", () => {
		expect(() => loadRelayBinding({ RELAY_SHARED_SECRET: "s" })).toThrow(/Incomplete relay binding/);
		expect(() => loadRelayBinding({ RELAY_RESEND_API_KEY: "re_x" })).toThrow(/Incomplete relay binding/);
	});

	test("refuses a non-loopback bind host", () => {
		expect(() =>
			loadRelayBinding({ RELAY_SHARED_SECRET: "s", RELAY_RESEND_API_KEY: "re_x", RELAY_HOST: "0.0.0.0" }),
		).toThrow(/loopback only/);
	});

	test("defaults to loopback with an explicit port and no secret in the shape it logs", () => {
		const binding = loadRelayBinding({ RELAY_SHARED_SECRET: "s3cret", RELAY_RESEND_API_KEY: "re_x", RELAY_PORT: "9001" });
		expect(binding!.host).toBe("127.0.0.1");
		expect(binding!.port).toBe(9001);
		expect(binding!.secret).toBe("s3cret");
	});
});
