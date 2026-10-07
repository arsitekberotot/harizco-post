// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: MailBackend port.
//
// The compatibility API (server/app.ts) talks to mail only through this port.
// The production implementation is the JMAP adapter (server/mail/backend-jmap.ts);
// tests inject an in-memory fake. Keeping the seam explicit is what lets the
// fail-closed auth tests prove "no identity => the backend is never called".
//
// Identity rules (see server/mail/mapping.ts): JMAP email id, thread id, mailbox
// id, and blob id are distinct identifiers. The RFC Message-ID is separate again.

import type { EmailDto, MailboxDto } from "./mapping";

/** A configured, selectable mailbox as the UI sees it. */
export type MailboxView = MailboxDto;

/** A message as the UI sees it (same DTO the JMAP path maps into). */
export type EmailView = EmailDto;

export interface EmailListResult {
	emails: EmailView[];
	/** Total matching messages, independent of the page size. */
	total: number;
}

export interface SearchResult {
	emailIds: string[];
	total: number;
}

export interface FlagInput {
	/** true = read, false = unread. */
	read?: boolean;
	/** true = starred, false = unstarred. */
	starred?: boolean;
}

export interface DraftInput {
	mailboxId: string;
	to?: string[];
	cc?: string[];
	bcc?: string[];
	subject?: string;
	body: string;
	/** Id of the draft being replaced, if this is an edit. */
	replacesDraftId?: string | null;
}

export interface FolderMutationInput {
	name: string;
	parentId?: string | null;
}

/**
 * A mail backend. Every method is account-scoped by construction: the adapter
 * instance is already bound to one configured mailbox/account, so no method
 * takes a caller-supplied account id.
 */
export interface MailBackend {
	listMailboxes(): Promise<MailboxView[]>;
	getMailbox(id: string): Promise<MailboxView | null>;
	listEmails(mailboxId: string, opts?: { limit?: number; offset?: number }): Promise<EmailListResult>;
	getEmail(id: string): Promise<EmailView | null>;
	search(mailboxId: string, filter: Record<string, unknown>): Promise<SearchResult>;
	setFlags(ids: string[], flags: FlagInput): Promise<{ updated: string[] }>;
	/** Mark all messages of a thread read/unread. */
	setThreadRead(mailboxId: string, emailIds: string[], read: boolean): Promise<{ updated: string[] }>;
	move(ids: string[], fromMailboxId: string, toMailboxId: string): Promise<{ updated: string[] }>;
	createDraft(input: DraftInput): Promise<{ draftId: string }>;
	createFolder(input: FolderMutationInput): Promise<{ id: string }>;
	renameFolder(id: string, name: string): Promise<{ updated: string }>;
	deleteFolder(id: string, moveToMailboxId: string): Promise<{ updated: string }>;
	health(): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * The configured address map the operator provisioned. The browser may only
 * select from these; it can never invent a sender domain or a Stalwart account.
 */
export interface ConfiguredAddresses {
	domains: string[];
	emailAddresses: string[];
}
