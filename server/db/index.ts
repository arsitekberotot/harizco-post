// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: SQLite integration journal.
//
// This database is NOT a second mailbox. It records only integration state:
// configured mailbox mappings, provider receipt IDs, import jobs, submission
// intents, and reconciliation metadata. Stalwart owns message content, folders,
// flags, and blobs.
//
// The journal and Stalwart cannot share a transaction, so every state
// transition here is explicit and recoverable. A job is never marked complete
// before Stalwart readback confirms the imported message.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type ImportJobState =
	| "pending"
	| "spooled"
	| "uploaded"
	| "imported"
	| "verified"
	| "failed"
	| "quarantined";

export type SubmissionIntentState =
	| "intent"
	| "submitted"
	| "accepted"
	| "failed"
	| "unknown";

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
	lease_expires_at: string | null;
	last_error: string | null;
	/** Stable identity proven at Stalwart readback; used for reconciliation. */
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
	created_at: string;
	updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mailboxes (
  id              TEXT PRIMARY KEY,
  address         TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL DEFAULT '',
  jmap_account_id TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider            TEXT NOT NULL,
  provider_receipt_id TEXT NOT NULL,
  target_mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id),
  state               TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_expires_at    TEXT,
  last_error          TEXT,
  stalwart_email_id   TEXT,
  stalwart_blob_id    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (provider, provider_receipt_id, target_mailbox_id)
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_state ON import_jobs(state);

CREATE TABLE IF NOT EXISTS submission_intents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT NOT NULL UNIQUE,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id),
  payload_hash TEXT NOT NULL,
  state        TEXT NOT NULL,
  provider_id  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submission_intents_state ON submission_intents(state);
`;

export type Journal = Database.Database;

/**
 * Open (and migrate) the journal.
 *
 * Uses better-sqlite3 with prebuilt binaries, so no compiler or native
 * toolchain is required to run or test the integration layer.
 */
export function openJournal(path: string): Journal {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	db.exec(SCHEMA);
	return db;
}

export { SCHEMA };
