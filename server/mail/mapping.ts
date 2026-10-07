// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: JMAP -> UI DTO mapping.
//
// The forked UI's contract lives in app/types/index.ts. This module is the only
// place JMAP shapes are translated, so the adapter can correct upstream quirks
// without every hook needing to know.
//
// Identity rules enforced here:
//   - JMAP email id, thread id, mailbox id, and blob id are distinct.
//   - The RFC Message-ID is separate again and must not be substituted for any
//     of the above.

export interface MailboxDto {
	id: string;
	name: string;
	systemRole: string | null;
	totalEmails: number;
	unreadEmails: number;
}

export interface EmailDto {
	id: string;
	threadId: string;
	mailboxIds: string[];
	unread: boolean;
	starred: boolean;
	draft: boolean;
	subject: string;
	from: { name?: string; email: string }[];
	to: { name?: string; email: string }[];
	receivedAt: string;
	preview: string;
	hasAttachment: boolean;
	/** RFC Message-ID, e.g. "<abc@example.com>". Not an internal identifier. */
	messageId: string | null;
	inReplyTo: string[];
	references: string[];
}

export interface JmapMailboxShape {
	id: string;
	name: string;
	role: string | null;
	totalEmails: number;
	unreadEmails: number;
}

export interface JmapEmailShape {
	id: string;
	threadId: string;
	mailboxIds?: Record<string, true>;
	keywords?: Record<string, true>;
	subject?: string;
	from?: { name?: string; email: string }[];
	to?: { name?: string; email: string }[];
	receivedAt?: string;
	preview?: string;
	hasAttachment?: boolean;
	messageId?: string[];
	inReplyTo?: string[];
	references?: string[];
}

/**
 * System folder identity comes from the JMAP `role`, never the display name.
 * A mailbox literally named "Inbox" with role `archive` is an archive.
 */
export function mapMailbox(m: JmapMailboxShape): MailboxDto {
	return {
		id: m.id,
		name: m.name,
		systemRole: m.role ?? null,
		totalEmails: m.totalEmails ?? 0,
		unreadEmails: m.unreadEmails ?? 0,
	};
}

export function mapEmail(e: JmapEmailShape): EmailDto {
	const keywords = e.keywords ?? {};
	return {
		id: e.id,
		threadId: e.threadId,
		mailboxIds: Object.keys(e.mailboxIds ?? {}),
		unread: !keywords.$seen,
		starred: Boolean(keywords.$flagged),
		draft: Boolean(keywords.$draft),
		subject: e.subject ?? "",
		from: e.from ?? [],
		to: e.to ?? [],
		receivedAt: e.receivedAt ?? "",
		preview: e.preview ?? "",
		hasAttachment: Boolean(e.hasAttachment),
		messageId: e.messageId?.[0] ?? null,
		inReplyTo: e.inReplyTo ?? [],
		references: e.references ?? [],
	};
}
