// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 15: submission recovery under acceptance ambiguity and restart.
//
// The relay is injected, so no live recipient or Resend call is involved. These
// tests prove the rules that keep a retry from double-sending:
//   - the SAME idempotency key is carried on every attempt;
//   - an ambiguous outcome is recorded `unknown` and NOT retried automatically;
//   - a restart (a fresh store over the same DB) does not re-send a submitted
//     intent, and can reconcile a held one without a new send;
//   - a known rejection consumes no automatic retry.

import { beforeEach, describe, expect, test } from "vitest";
import { openJournal, type Journal } from "../../server/db/index";
import {
	SubmissionStore,
	type RelayOutcome,
	type RelayRequest,
	submitWithIdempotency,
	type SubmissionPayload,
} from "../../server/mail/submissions";

let db: Journal;
let store: SubmissionStore;

const payload: SubmissionPayload = {
	mailboxId: "mb1",
	from: "hanif@atelieriza.com",
	to: ["friend@example.test"],
	subject: "Hello",
	body: "Hi there",
};

interface Recorder {
	calls: RelayRequest[];
	keys: string[];
}

/** A transport that records every attempt (idempotency keys + payloads). */
function recordingTransport(outcome: () => RelayOutcome): { transport: { send(r: RelayRequest): Promise<RelayOutcome> }; rec: Recorder } {
	const rec: Recorder = { calls: [], keys: [] };
	const transport = {
		async send(request: RelayRequest): Promise<RelayOutcome> {
			rec.calls.push(request);
			rec.keys.push(request.idempotencyHeader.value);
			return outcome();
		},
	};
	return { transport, rec };
}

beforeEach(() => {
	db = openJournal(":memory:");
	db.prepare(
		"INSERT INTO mailboxes (id, address, display_name, enabled, created_at) VALUES (?,?,?,?,?)",
	).run("mb1", "hanif@atelieriza.com", "Hanif", 1, "2026-10-07T00:00:00Z");
	store = new SubmissionStore(db);
});

describe("idempotency key stability", () => {
	test("the same key is used on the single attempt for a given payload", async () => {
		const { transport, rec } = recordingTransport(() => ({ status: "accepted", providerId: "re_1" }));
		const result = await submitWithIdempotency(store, transport, payload);
		expect(result.state).toBe("accepted");
		expect(rec.keys).toEqual([result.requestId]);
		expect(rec.calls[0].idempotencyHeader.name).toBe("Idempotency-Key");
	});

	test("a second submit of an already-accepted intent does NOT call the relay", async () => {
		const { transport, rec } = recordingTransport(() => ({ status: "accepted", providerId: "re_1" }));
		await submitWithIdempotency(store, transport, payload);
		await submitWithIdempotency(store, transport, payload);
		expect(rec.calls).toHaveLength(1);
	});
});

describe("acceptance ambiguity", () => {
	test("an ambiguous result is recorded unknown and not retried automatically", async () => {
		const { transport, rec } = recordingTransport(() => ({ status: "ambiguous", reason: "socket timeout after write" }));
		const result = await submitWithIdempotency(store, transport, payload);
		expect(result.state).toBe("unknown");
		expect(rec.calls).toHaveLength(1);
		// a second call does not resend: the held intent is not submittable
		await submitWithIdempotency(store, transport, payload);
		expect(rec.calls).toHaveLength(1);
	});

	test("a held intent reconciles by provider id without a new send", async () => {
		const { transport, rec } = recordingTransport(() => ({ status: "ambiguous", reason: "timeout" }));
		const { requestId } = await submitWithIdempotency(store, transport, payload);
		store.reconcile(requestId, "re_reconciled");
		const held = store.getIntent(requestId);
		expect(held?.state).toBe("accepted");
		expect(held?.provider_id).toBe("re_reconciled");
		expect(rec.calls).toHaveLength(1);
	});

	test("a known rejection is failed and consumes no automatic retry", async () => {
		const { transport, rec } = recordingTransport(() => ({ status: "rejected", reason: "550 mailbox unavailable" }));
		const result = await submitWithIdempotency(store, transport, payload);
		expect(result.state).toBe("failed");
		expect(store.getIntent(result.requestId)?.last_error).toMatch(/550/);
		expect(rec.calls).toHaveLength(1);
	});
});

describe("restart handling", () => {
	test("a fresh store over the same DB does not resend a submitted intent", async () => {
		const { transport, rec } = recordingTransport(() => ({ status: "accepted", providerId: "re_1" }));
		const first = await submitWithIdempotency(store, transport, payload);

		// Simulate a process restart: new store, same journal.
		const store2 = new SubmissionStore(db);
		const { transport: t2, rec: rec2 } = recordingTransport(() => ({ status: "accepted", providerId: "re_2" }));
		const second = await submitWithIdempotency(store2, t2, payload);

		expect(second.requestId).toBe(first.requestId);
		expect(second.state).toBe("accepted");
		expect(rec2.calls).toHaveLength(0);
		expect(rec.calls).toHaveLength(1);
	});

	test("a restart can reconcile an intent held as unknown without resending", async () => {
		const { transport } = recordingTransport(() => ({ status: "ambiguous", reason: "crash mid-send" }));
		const { requestId } = await submitWithIdempotency(store, transport, payload);

		const store2 = new SubmissionStore(db);
		const { transport: t2, rec: rec2 } = recordingTransport(() => ({ status: "accepted", providerId: "re_late" }));
		expect(store2.listNeedingReconcile().map((i) => i.request_id)).toContain(requestId);
		store2.reconcile(requestId, "re_late");
		expect(rec2.calls).toHaveLength(0);
		expect(store2.getIntent(requestId)?.state).toBe("accepted");
	});
});
