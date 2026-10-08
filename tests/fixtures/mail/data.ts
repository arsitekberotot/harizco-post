// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: in-memory synthetic fixture data for tests/preview only.
// SYNTHETIC TEST FIXTURE — not provider evidence. Uses .invalid addresses.

import type { Email, Folder, Mailbox } from "../../../app/types";

/** Visible marker that this data is synthetic, not live mail. */
export const FIXTURE_LABEL =
	"SYNTHETIC TEST FIXTURE — not provider evidence" as const;

export const FIXTURE_MAILBOX_ID = "fixture-mailbox-owner";

export const fixtureConfig = {
	domains: ["harizco-post.invalid"],
	emailAddresses: ["owner@harizco-post.invalid"],
	fixtureLabel: FIXTURE_LABEL,
} as const;

export const fixtureMailbox: Mailbox = {
	id: FIXTURE_MAILBOX_ID,
	email: "owner@harizco-post.invalid",
	name: "Fixture Owner",
	settings: {
		fromName: "Fixture Owner",
	},
};

export const fixtureFolders: Folder[] = [
	{ id: "inbox", name: "Inbox", unreadCount: 1 },
	{ id: "sent", name: "Sent", unreadCount: 0 },
	{ id: "draft", name: "Drafts", unreadCount: 0 },
	{ id: "archive", name: "Archive", unreadCount: 0 },
	{ id: "trash", name: "Trash", unreadCount: 0 },
];

export const fixtureEmails: Email[] = [
	{
		id: "fixture-email-1",
		thread_id: "fixture-thread-1",
		folder_id: "inbox",
		subject: "Synthetic welcome thread",
		sender: "correspondent@example.invalid",
		recipient: "owner@harizco-post.invalid",
		date: "2026-10-07T10:00:00.000Z",
		read: false,
		starred: false,
		body: `<p>${FIXTURE_LABEL}</p><p>Hello from a synthetic correspondent.</p>`,
		snippet: "Hello from a synthetic correspondent.",
		thread_count: 1,
		thread_unread_count: 1,
		participants: "correspondent@example.invalid, owner@harizco-post.invalid",
		attachments: [],
	},
	{
		id: "fixture-email-2",
		thread_id: "fixture-thread-2",
		folder_id: "inbox",
		subject: "Synthetic follow-up",
		sender: "notes@example.invalid",
		recipient: "owner@harizco-post.invalid",
		date: "2026-10-07T11:30:00.000Z",
		read: true,
		starred: false,
		body: `<p>${FIXTURE_LABEL}</p><p>Second synthetic message for list rendering.</p>`,
		snippet: "Second synthetic message for list rendering.",
		thread_count: 1,
		thread_unread_count: 0,
		participants: "notes@example.invalid, owner@harizco-post.invalid",
		attachments: [],
	},
	{
		id: "fixture-email-3",
		thread_id: "fixture-thread-3",
		folder_id: "inbox",
		subject: "Synthetic image and attachment message",
		sender: "designer@example.invalid",
		recipient: "owner@harizco-post.invalid",
		date: "2026-10-07T12:45:00.000Z",
		read: true,
		starred: false,
		// Synthetic metadata only: no fixture attachment byte/download endpoint.
		// Tracker must be blocked; the intentionally non-raster CID must stay
		// unresolved (only authorized, bounded raster data may render inline).
		body: `<p>${FIXTURE_LABEL}</p><p>Inline logo: <img src="cid:fixture-logo" alt="logo"></p><p>Remote pixel: <img src="https://tracker.example.invalid/pixel.gif" alt="pixel"></p>`,
		snippet: "Synthetic message with an inline image and a remote tracker.",
		thread_count: 1,
		thread_unread_count: 0,
		participants: "designer@example.invalid, owner@harizco-post.invalid",
		attachments: [
			{
				id: "fixture-attachment-1",
				filename: "layout-preview.txt",
				mimetype: "text/plain",
				size: 42,
				content_id: "fixture-logo",
				disposition: "inline",
			},
			{
				id: "fixture-attachment-2",
				filename: "spec.txt",
				mimetype: "text/plain",
				size: 128,
				disposition: "attachment",
			},
		],
	},
];

export function listFixtureMailboxes(): Mailbox[] {
	return [fixtureMailbox];
}

export function getFixtureMailbox(mailboxId: string): Mailbox | undefined {
	return listFixtureMailboxes().find((m) => m.id === mailboxId);
}

export function listFixtureEmails(folderId = "inbox"): Email[] {
	return fixtureEmails.filter((email) => email.folder_id === folderId);
}

export function getFixtureEmail(emailId: string): Email | undefined {
	return fixtureEmails.find((email) => email.id === emailId);
}
