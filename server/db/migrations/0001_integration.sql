-- Copyright (c) 2026 Cloudflare, Inc.
-- Licensed under the Apache 2.0 license found in the LICENSE file or at:
--     https://opensource.org/licenses/Apache-2.0
--
-- Harizco Post integration journal, migration 0001.
--
-- This schema records integration state only. It is not a mailbox store:
-- Stalwart remains canonical for message content, folders, flags, and blobs.
-- The UNIQUE constraint deduplicates journal jobs per receipt/target. It does
-- not make a cross-system JMAP import exactly-once; canonical readback is required.

CREATE TABLE IF NOT EXISTS mailboxes (
  id              TEXT PRIMARY KEY,
  address         TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL DEFAULT '',
  jmap_account_id TEXT,
  enabled         INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
