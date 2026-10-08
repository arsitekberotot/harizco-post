// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 16: preserve threading, reply-all, and forward semantics.
//
// These assertions name the local policy helpers directly. Until the reply-all
// and forward builders exist they are RED by design (the imports resolve to
// undefined), which is the honest way to show the gap before implementing it.

import { describe, expect, test } from "vitest";
import {
	SenderValidationError,
	buildForward,
	buildReferencesChain,
	buildThreadingHeaders,
	computeReplyAll,
	forwardSubject,
	normalizeAddressList,
	replySubject,
	validateSender,
} from "../../server/mail/threading";

const OWNER = "hanif@atelieriza.com";

describe("sender ownership (no open relay)", () => {
	test("rejects a From address we do not own", () => {
		expect(() => validateSender("friend@example.test", "spoof@evil.test", OWNER)).toThrow(SenderValidationError);
	});

	test("accepts a From address that exactly matches the mailbox", () => {
		const result = validateSender("friend@example.test", "Hanif <hanif@atelieriza.com>", OWNER);
		expect(result.fromEmail).toBe(OWNER);
		expect(result.to).toEqual(["friend@example.test"]);
		expect(result.fromDomain).toBe("atelieriza.com");
	});

	test("never silently rewrites a spoofed sender to the mailbox address", () => {
		try {
			validateSender("a@b.test", "ceo@atelieriza.com", OWNER);
			throw new Error("expected SenderValidationError");
		} catch (err) {
			expect(err).toBeInstanceOf(SenderValidationError);
			expect((err as Error).message).not.toMatch(/rewrit/i);
		}
	});
});

describe("reply threading", () => {
	test("a missing RFC Message-ID never fabricates a header from a local record ID", () => {
		const chain = buildReferencesChain({ id: "opaque-local-record", threadId: "opaque-thread" });
		expect(chain.originalMessageId).toBe("");
		expect(chain.references).toEqual([]);
		expect(buildThreadingHeaders(chain.originalMessageId, chain.references)).toEqual({});
	});

	test("malformed RFC IDs and header injection are rejected instead of emitted", () => {
		for (const value of ["opaque-local-record", "<m@example.test>\r\nBcc: hidden@example.test", "<m@example.test> <other@example.test>", "<m @example.test>"]) {
			expect(() => buildReferencesChain({ id: "local", messageId: value })).toThrow(/message.id/i);
			expect(() => buildThreadingHeaders(value, [])).toThrow(/message.id/i);
			expect(() => buildThreadingHeaders("m@example.test", [value])).toThrow(/message.id/i);
		}
	});

	test("header assembly normalizes brackets and de-duplicates canonical RFC IDs", () => {
		expect(buildThreadingHeaders("<m-2@example.test>", ["<m-1@example.test>", "m-1@example.test", "<m-2@example.test>"])).toEqual({
			"In-Reply-To": "<m-2@example.test>",
			References: "<m-1@example.test> <m-2@example.test>",
		});
	});
	test("a reply carries In-Reply-To and the full References chain", () => {
		const original = {
			id: "e-2",
			messageId: "<m-2@example.test>",
			threadId: "t-1",
			references: ["<m-1@example.test>"],
		};
		const chain = buildReferencesChain(original);
		expect(chain.threadId).toBe("t-1");
		// chain stores bare ids; brackets belong on the wire (see headers below)
		expect(chain.originalMessageId).toBe("m-2@example.test");
		expect(chain.references).toEqual(["m-1@example.test", "m-2@example.test"]);

		const headers = buildThreadingHeaders(chain.originalMessageId, chain.references);
		expect(headers["In-Reply-To"]).toBe("<m-2@example.test>");
		expect(headers.References).toBe("<m-1@example.test> <m-2@example.test>");
	});

	test("reply subject is never doubled", () => {
		expect(replySubject("Re: Hello")).toBe("Re: Hello");
		expect(replySubject("Hello")).toBe("Re: Hello");
	});
});

describe("reply-all recipients", () => {
	test("Reply-To replaces From before owned-address exclusion and de-duplication", () => {
		const recipients = computeReplyAll({
			mailboxAddress: OWNER,
			originalFrom: "sender@example.test",
			originalReplyTo: ["help@example.test", OWNER],
			originalTo: [OWNER, "teammate@example.test"],
			originalCc: ["help@example.test", "cc@example.test"],
		});
		expect(recipients.to).toEqual(["help@example.test", "teammate@example.test"]);
		expect(recipients.cc).toEqual(["cc@example.test"]);
	});
	test("includes the original To and Cc minus the mailbox address", () => {
		const recipients = computeReplyAll({
			mailboxAddress: OWNER,
			originalFrom: [{ email: "sender@example.test" }],
			originalTo: [{ email: "hanif@atelieriza.com" }, { email: "teammate@example.test" }],
			originalCc: [{ email: "cc@example.test" }],
		});
		expect(recipients.to).toEqual(["sender@example.test", "teammate@example.test"]);
		expect(recipients.cc).toEqual(["cc@example.test"]);
	});

	test("drops our own address from Cc too and de-duplicates", () => {
		const recipients = computeReplyAll({
			mailboxAddress: OWNER,
			originalFrom: [{ email: "sender@example.test" }],
			originalTo: [{ email: "sender@example.test" }, { email: "hanif@atelieriza.com" }],
			originalCc: [{ email: "hanif@atelieriza.com" }],
		});
		expect(recipients.to).toEqual(["sender@example.test"]);
		expect(recipients.cc).toEqual([]);
	});
});

describe("forward starts a fresh thread", () => {
	test("has no In-Reply-To/References and a non-doubled Fwd subject", () => {
		const forward = buildForward({
			fromEmail: OWNER,
			to: "friend@example.test",
			subject: "Hello",
			original: { id: "e-2", messageId: "<m-2@example.test>", threadId: "t-1", references: ["<m-1@example.test>"] },
		});
		expect(forward.subject).toBe("Fwd: Hello");
		expect(forward.headers["In-Reply-To"]).toBeUndefined();
		expect(forward.headers.References).toBeUndefined();
		expect(forward.threadId).not.toBe("t-1");
		expect(forward.to).toEqual(["friend@example.test"]);
	});

	test("forward subject is never doubled", () => {
		expect(forwardSubject("Fwd: Hello")).toBe("Fwd: Hello");
		expect(forwardSubject("FW: Hello")).toBe("FW: Hello");
	});
});

describe("address normalization", () => {
	test("lower-cases, trims, and drops blanks", () => {
		expect(normalizeAddressList([" A@X.test ", "", { email: "B@Y.test" }])).toEqual(["a@x.test", "b@y.test"]);
	});
});
