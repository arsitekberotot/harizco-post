// Task 14/15 gap: the submit path must not hand one intent to the relay twice.
//
// submitWithIdempotency() reads canSubmit() and then awaits the transport, so
// two concurrent callers for the same payload can both observe `intent` and
// A node-only synchronous window (no await between the state read and the
// transition) means two racing callers cannot both observe `intent`. The test
// asserts the state transition claims the intent before the transport is
// awaited, so at most one attempt is emitted for one request id.

import { beforeEach, describe, expect, test } from "vitest";
import { openJournal, type Journal } from "../../server/db/index";
import {
	SubmissionStore,
	submitWithIdempotency,
	type RelayTransport,
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

beforeEach(() => {
	db = openJournal(":memory:");
	db.prepare(
		"INSERT INTO mailboxes (id, address, display_name, enabled, created_at) VALUES (?,?,?,?,?)",
	).run("mb1", "hanif@atelieriza.com", "Hanif", 1, "2026-10-07T00:00:00Z");
	store = new SubmissionStore(db);
});

describe("concurrent submission of one intent", () => {
	test("the state transition claims the intent before the transport is awaited", async () => {
		let stateAtSend: string | undefined;
		const transport: RelayTransport = {
			async send(request) {
				stateAtSend = store.getIntent(request.requestId)?.state;
				return { status: "accepted", providerId: "p1" };
			},
		};
		await submitWithIdempotency(store, transport, payload);
		// `submitted` must already be persisted when send() runs, so a concurrent
		// or restarted caller sees canSubmit() === false and never re-sends.
		expect(stateAtSend).toBe("submitted");
	});

	test("a racing duplicate never reaches the transport a second time", async () => {
		let sends = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transport: RelayTransport = {
			async send() {
				sends += 1;
				// Hold the first attempt inside the transport so a second caller
				// can race the same request id.
				await gate;
				return { status: "accepted", providerId: "p1" };
			},
		};

		const first = submitWithIdempotency(store, transport, payload);
		const second = submitWithIdempotency(store, transport, { ...payload });
		release();
		await Promise.allSettled([first, second]);
		expect(sends).toBe(1);
	});
});
