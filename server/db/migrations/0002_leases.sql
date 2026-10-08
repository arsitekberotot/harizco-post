-- Copyright (c) 2026 Cloudflare, Inc.
-- Licensed under the Apache 2.0 license found in LICENSE.
-- Integration leases only; no canonical mail content or existing row deletion.
ALTER TABLE import_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE submission_intents ADD COLUMN lease_owner TEXT;
ALTER TABLE submission_intents ADD COLUMN lease_token TEXT;
ALTER TABLE submission_intents ADD COLUMN lease_expires_at TEXT;
CREATE INDEX idx_import_jobs_lease ON import_jobs(state, lease_expires_at);
CREATE INDEX idx_submission_intents_lease ON submission_intents(state, lease_expires_at);
