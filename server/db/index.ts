// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: SQLite integration journal, NOT a second mailbox.
// Stalwart owns message content, folders, flags, and blobs. Journal transactions
// cannot make a provider/JMAP call atomic; uncertain outcomes require readback.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { JOURNAL_VERSION, MIGRATIONS } from "./schema";

export type ImportJobState = "pending" | "spooled" | "uploaded" | "imported" | "verified" | "failed" | "quarantined" | "unknown";
export type SubmissionIntentState = "intent" | "submitted" | "accepted" | "failed" | "unknown";

export interface MailboxRecord {
	id: string;
	address: string;
	display_name: string;
	jmap_account_id: string | null;
	enabled: number;
	created_at: string;
}
export interface ImportJob {
	id: number;
	provider: string;
	provider_receipt_id: string;
	target_mailbox_id: string;
	state: ImportJobState;
	attempts: number;
	lease_owner: string | null;
	lease_token: string | null;
	lease_expires_at: string | null;
	last_error: string | null;
	/** Stable identity proven by canonical readback, not inferred from an upload. */
	stalwart_email_id: string | null;
	stalwart_blob_id: string | null;
	created_at: string;
	updated_at: string;
}
export interface SubmissionIntent {
	id: number;
	request_id: string;
	mailbox_id: string;
	payload_hash: string;
	state: SubmissionIntentState;
	provider_id: string | null;
	last_error: string | null;
	lease_owner: string | null;
	lease_token: string | null;
	lease_expires_at: string | null;
	created_at: string;
	updated_at: string;
}
export type Journal = Database.Database;

/** Versioned, additive migrations. Call only on an operator-approved data path. */
export function openJournal(path: string): Journal {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	try {
		// Reject a future schema before changing journal mode or creating tables.
		const version = db.pragma("user_version", { simple: true }) as number;
		if (version > JOURNAL_VERSION) throw new Error("Unsupported newer integration journal schema.");
		db.pragma("busy_timeout = 5000");
		db.pragma("foreign_keys = ON");
		db.transaction(() => {
			// Read inside the lock: another opener may have finished migration.
			const current = db.pragma("user_version", { simple: true }) as number;
			if (current > JOURNAL_VERSION) throw new Error("Unsupported newer integration journal schema.");
			for (const migration of MIGRATIONS) {
				if (migration.version <= current) continue;
				db.exec(migration.sql);
				db.pragma(`user_version = ${migration.version}`);
			}
		}).immediate();
		db.pragma("journal_mode = WAL");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export { SCHEMA, JOURNAL_VERSION } from "./schema";
export { claimJob, transitionJob, releaseJob, JournalStateError } from "./jobs";
export type { JobLease, JobTable, JobPatch } from "./jobs";
