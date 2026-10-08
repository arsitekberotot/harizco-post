// Task 16 item 4: "preserve explicitly selected forward attachments".
//
// A forward may carry a subset of the ORIGINAL message's attachments, chosen by
// the user. Two properties matter:
//   1. Only attachments the user explicitly selected are carried — a forward
//      does not silently drag every original attachment along.
//   2. A selected attachment keeps its identity (blobId) and is re-checked
//      against the sending mailbox by the submission guard, so a cross-mailbox
//      blob can never ride out on a forward.
//
// Synthetic only: no provider or relay contact.

import { describe, expect, test } from "vitest";
import { buildForwardSendInput } from "../../server/routes/reply-forward";
import { validateSubmission, SubmissionValidationError } from "../../server/mail/validation";

const OWNER = "hanif@atelieriza.com";
const original = {
	id: "e-1",
	threadId: "t-1",
	mailboxIds: ["mb1"],
	unread: false,
	starred: false,
	draft: false,
	subject: "Report",
	from: [{ email: "sender@friend.test" }],
	to: [{ email: OWNER }],
	cc: [],
	receivedAt: "2026-10-07T00:00:00Z",
	preview: "",
	hasAttachment: true,
	messageId: "<orig@friend.test>",
	inReplyTo: [],
	references: [],
	attachments: [
		{ blobId: "blob-a", size: 100, name: "a.pdf" },
		{ blobId: "blob-b", size: 200, name: "b.pdf" },
	],
};

const policy = { mailboxId: "mb1", address: OWNER, domain: "atelieriza.com", maxRecipients: 20, maxBytes: 5_000_000 };

describe("forward attachment selection", () => {
	test("carries only the explicitly selected attachments", () => {
		const input = buildForwardSendInput(original as never, {
			from: OWNER,
			body: "see attached",
			to: ["friend@example.test"],
			attachmentBlobIds: ["blob-b"],
		});
		expect(input.attachments?.map((a) => a.blobId)).toEqual(["blob-b"]);
	});

	test("carries nothing when the user selects nothing", () => {
		const input = buildForwardSendInput(original as never, {
			from: OWNER,
			body: "see attached",
			to: ["friend@example.test"],
		});
		expect(input.attachments ?? []).toEqual([]);
	});

	test("a selected attachment beyond the mailbox is refused by the guard", () => {
		const input = buildForwardSendInput(original as never, {
			from: OWNER,
			body: "x",
			to: ["friend@example.test"],
			attachmentBlobIds: ["blob-a"],
		});
		// The carried ref claims mailbox mb1; a guard for a DIFFERENT mailbox
		// must reject it rather than let the blob cross mailboxes.
		expect(() =>
			validateSubmission(
				{
					mailboxId: "mb1",
					from: OWNER,
					to: ["friend@example.test"],
					subject: input.subject ?? "",
					body: "x",
					attachments: (input.attachments ?? []).map((a) => ({ ...a, mailboxId: "mb-other" })),
				},
				policy,
			),
		).toThrow(SubmissionValidationError);
	});
});
