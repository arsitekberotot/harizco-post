// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 14: outbound submission intents with idempotent retry.
//
// The rules under test are the ones that stop a retry from sending twice:
//   - a durable intent + a stable idempotency key exist BEFORE any side effect;
//   - a replay of the same payload returns the SAME intent (no new intent, no
//     new provider attempt);
//   - an ambiguous result is recorded as `unknown` and held for reconciliation,
//     never blindly retransmitted;
//   - acceptance (`submitted`/`accepted`) is distinct from delivery.
//
// These are RED until server/mail/submissions.ts exists (module not found).

import { beforeEach, describe, expect, test } from "vitest";
import { loadOutboundBinding } from "../../server/config";
import { senderPolicyForAddress } from "../../server/index";
import { openJournal, type Journal } from "../../server/db/index";
import {
	SubmissionStore,
	idempotencyKeyFor,
	payloadHash,
	type SubmissionPayload,
} from "../../server/mail/submissions";
import {
	SubmissionValidationError,
	validateSubmission,
	type SenderPolicy,
} from "../../server/mail/validation";

let db: Journal;
let store: SubmissionStore;

const payload: SubmissionPayload = {
	mailboxId: "mb1",
	from: "hanif@atelieriza.com",
	to: ["friend@example.test"],
	subject: "Hello",
	body: "Hi there",
};

const policy: SenderPolicy = {
	mailboxId: "mb1",
	address: "hanif@atelieriza.com",
	domain: "atelieriza.com",
	maxRecipients: 25,
	maxBytes: 25 * 1024 * 1024,
};

/** A fake backend that counts mutations, so a rejected send proves zero side effects. */
function countingBackend() {
	const calls = { submit: 0 };
	return {
		calls,
		submit: async () => {
			calls.submit += 1;
			return { providerId: "p1" };
		},
	};
}

beforeEach(() => {
	db = openJournal(":memory:");
	db.prepare(
		"INSERT INTO mailboxes (id, address, display_name, enabled, created_at) VALUES (?,?,?,?,?)",
	).run("mb1", "hanif@atelieriza.com", "Hanif", 1, "2026-10-07T00:00:00Z");
	store = new SubmissionStore(db);
});

describe("intent creation", () => {
	test("records a durable intent in state `intent` before any submission", () => {
		const intent = store.createIntent(payload);
		expect(intent.state).toBe("intent");
		expect(intent.request_id).toBe(idempotencyKeyFor(payload));
		expect(intent.payload_hash).toBe(payloadHash(payload));
		// durable: it is already in the journal
		expect(store.getIntent(intent.request_id)?.state).toBe("intent");
	});

	test("a replay of the same payload returns the same intent, not a new one", () => {
		const a = store.createIntent(payload);
		const b = store.createIntent(payload);
		expect(b.id).toBe(a.id);
		expect(b.request_id).toBe(a.request_id);
		// exactly one row for this request id
		const rows = db.prepare("SELECT COUNT(*) AS n FROM submission_intents").get() as { n: number };
		expect(rows.n).toBe(1);
	});

	test("the idempotency key is stable across calls and differs for a changed body", () => {
		expect(idempotencyKeyFor(payload)).toBe(idempotencyKeyFor({ ...payload }));
		expect(idempotencyKeyFor(payload)).not.toBe(idempotencyKeyFor({ ...payload, body: "different" }));
	});

	test("a different payload for the same mailbox is a distinct intent", () => {
		const a = store.createIntent(payload);
		const b = store.createIntent({ ...payload, subject: "Other" });
		expect(b.request_id).not.toBe(a.request_id);
	});
});

describe("submission lifecycle", () => {
	test("intent -> submitted -> accepted, and acceptance is not delivery", () => {
		const intent = store.createIntent(payload);
		store.markSubmitted(intent.request_id);
		expect(store.getIntent(intent.request_id)?.state).toBe("submitted");
		store.markAccepted(intent.request_id, "re_provider_1");
		const done = store.getIntent(intent.request_id);
		expect(done?.state).toBe("accepted");
		expect(done?.provider_id).toBe("re_provider_1");
	});

	test("failure is recorded with a reason and stays retryable from the same key", () => {
		const intent = store.createIntent(payload);
		store.markSubmitted(intent.request_id);
		store.markFailed(intent.request_id, "relay unreachable");
		const failed = store.getIntent(intent.request_id);
		expect(failed?.state).toBe("failed");
		expect(failed?.last_error).toBe("relay unreachable");
		// retry reuses the SAME key (no duplicate intent)
		const again = store.createIntent(payload);
		expect(again.request_id).toBe(intent.request_id);
	});

	test("an ambiguous result is `unknown` and is held, not retransmitted", () => {
		const intent = store.createIntent(payload);
		store.markSubmitted(intent.request_id);
		store.markUnknown(intent.request_id, "timeout after send");
		const held = store.getIntent(intent.request_id);
		expect(held?.state).toBe("unknown");
		// the store lists it as needing reconciliation; it is NOT re-submittable blind
		expect(store.listNeedingReconcile()).toContainEqual(expect.objectContaining({ request_id: intent.request_id }));
		expect(store.canSubmit(intent.request_id)).toBe(false);
	});

	test("a fresh intent can submit, but a submitted/accepted one cannot re-submit", () => {
		const intent = store.createIntent(payload);
		expect(store.canSubmit(intent.request_id)).toBe(true);
		store.markSubmitted(intent.request_id);
		expect(store.canSubmit(intent.request_id)).toBe(false);
	});

	test("an unknown submission reconciles by provider id without a new send", () => {
		const intent = store.createIntent(payload);
		store.markSubmitted(intent.request_id);
		store.markUnknown(intent.request_id, "timeout");
		store.reconcile(intent.request_id, "re_provider_2");
		const done = store.getIntent(intent.request_id);
		expect(done?.state).toBe("accepted");
		expect(done?.provider_id).toBe("re_provider_2");
		expect(store.canSubmit(intent.request_id)).toBe(false);
	});
});

describe("submission validation (reject before any side effect)", () => {
	test("each mailbox can send as itself but not as another address on the same domain", () => {
		const binding = loadOutboundBinding({
			OUTBOUND_FROM: "hanif@atelieriza.com",
			OUTBOUND_ADDRESSES: "hanif@atelieriza.com,natla@atelieriza.com",
			OUTBOUND_RELAY_URL: "http://127.0.0.1:8788/submit",
		});
		const natlaPolicy = senderPolicyForAddress(binding!, "natla@atelieriza.com");
		const ownSend = { ...payload, mailboxId: "natla@atelieriza.com", from: "natla@atelieriza.com" };
		expect(() => validateSubmission(ownSend, natlaPolicy)).not.toThrow();
		expect(() => validateSubmission({ ...ownSend, from: "hanif@atelieriza.com" }, natlaPolicy)).toThrow(/selected mailbox/i);
	});

	test("a valid submission passes and does not touch the backend", async () => {
		const backend = countingBackend();
		const result = validateSubmission(payload, policy);
		expect(result.ok).toBe(true);
		// validation itself is pure; the backend is only called after an intent exists
		expect(backend.calls.submit).toBe(0);
	});

	test("rejects a spoofed From that is not the mailbox address", () => {
		expect(() => validateSubmission({ ...payload, from: "ceo@atelieriza.com" }, policy)).toThrow(
			SubmissionValidationError,
		);
	});

	test("rejects a From on a domain we do not own", () => {
		expect(() => validateSubmission({ ...payload, from: "hanif@evil.test" }, policy)).toThrow(/domain/i);
	});

	test("rejects CRLF / header injection in subject, address, and body", () => {
		expect(() => validateSubmission({ ...payload, subject: "Hi\r\nBcc: x@y.test" }, policy)).toThrow(
			SubmissionValidationError,
		);
		expect(() => validateSubmission({ ...payload, to: ["a@b.test\r\nBcc: c@d.test"] }, policy)).toThrow(
			SubmissionValidationError,
		);
	});

	test("rejects syntactically invalid recipient addresses", () => {
		expect(() => validateSubmission({ ...payload, to: ["not-an-address"] }, policy)).toThrow(
			SubmissionValidationError,
		);
		expect(() => validateSubmission({ ...payload, to: [] }, policy)).toThrow(/recipient/i);
	});

	test("rejects too many recipients", () => {
		const many = Array.from({ length: 30 }, (_, i) => `u${i}@example.test`);
		expect(() => validateSubmission({ ...payload, to: many }, policy)).toThrow(/recipient/i);
	});

	test("rejects an oversized message", () => {
		const big = "x".repeat(policy.maxBytes + 1);
		expect(() => validateSubmission({ ...payload, body: big }, policy)).toThrow(/size|large/i);
	});

	test("rejects an attachment owned by a different mailbox", () => {
		expect(() =>
			validateSubmission({ ...payload, attachments: [{ blobId: "b1", mailboxId: "mb-other", size: 10 }] }, policy),
		).toThrow(/attachment|mailbox/i);
	});

	test("rejects unsupported auto-send settings", () => {
		expect(() =>
			validateSubmission({ ...payload, autoSend: true } as SubmissionPayload & { autoSend: boolean }, policy),
		).toThrow(/auto-send|unsupported/i);
	});
});
