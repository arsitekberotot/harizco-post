// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in LICENSE.
// Guarded journal primitives. A lease is not proof of provider/JMAP success.
import { randomUUID } from "node:crypto";
import type { Journal, ImportJobState, SubmissionIntentState } from "./index";

export type JobTable = "import_jobs" | "submission_intents";
type JobState = ImportJobState | SubmissionIntentState;
export interface JobLease {
	readonly table: JobTable;
	readonly id: number;
	readonly owner: string;
	readonly token: string;
	readonly state: JobState;
}
export interface JobPatch {
	last_error?: string | null;
	stalwart_email_id?: string | null;
	stalwart_blob_id?: string | null;
	provider_id?: string | null;
}
export class JournalStateError extends Error {
	constructor(message: string) { super(message); this.name = "JournalStateError"; }
}
const TRANSITIONS: Record<JobTable, Record<string, readonly JobState[]>> = {
	import_jobs: {
		pending: ["spooled", "failed", "quarantined"],
		spooled: ["uploaded", "failed", "quarantined"],
		uploaded: ["imported", "unknown", "failed"],
		imported: ["verified", "unknown", "failed"],
		failed: ["spooled", "verified", "quarantined"],
		unknown: [], verified: [], quarantined: [],
	},
	submission_intents: {
		intent: ["submitted", "failed"],
		submitted: ["accepted", "failed", "unknown"],
		failed: ["submitted"], unknown: [], accepted: [],
	},
};
const CLAIMABLE: Record<JobTable, readonly JobState[]> = {
	import_jobs: ["pending", "spooled", "uploaded", "imported", "failed"],
	submission_intents: ["intent", "failed"],
};
function validRecordedId(value: unknown): boolean {
	return typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}
function validate(table: JobTable, id: number, owner: string, now: number): void {
	if (table !== "import_jobs" && table !== "submission_intents") throw new JournalStateError("Invalid journal table.");
	if (!Number.isSafeInteger(id) || id < 1 || typeof owner !== "string" || !owner.trim() || owner.length > 128 || /[\x00-\x1f\x7f]/.test(owner)) {
		throw new JournalStateError("Invalid lease identity.");
	}
	if (!Number.isSafeInteger(now) || now < 0 || now > 8_000_000_000_000_000) throw new JournalStateError("Invalid lease clock.");
}
function validateLease(lease: JobLease, now: number): void {
	validate(lease.table, lease.id, lease.owner, now);
	if (typeof lease.token !== "string" || !lease.token || lease.token.length > 128) throw new JournalStateError("Invalid lease token.");
}

/** One atomic claim across connections; random tokens also prevent same-owner ABA. */
export function claimJob(db: Journal, table: JobTable, id: number, owner: string, ttlMs: number, now = Date.now()): JobLease | null {
	validate(table, id, owner, now);
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new JournalStateError("Lease TTL must be between 1 and 300000 milliseconds.");
	const at = new Date(now).toISOString(), expiry = new Date(now + ttlMs).toISOString();
	return db.transaction(() => {
		// A crash after a durable submit marker may have sent mail. Hold it, never
		// reclaim it for retry. Actual reconciliation is a separate operation.
		if (table === "submission_intents") {
			db.prepare(`UPDATE submission_intents SET state='unknown', updated_at=?, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
				WHERE id=? AND state='submitted' AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(at, id, at);
		}
		const row = db.prepare(`SELECT state FROM ${table} WHERE id=?`).get(id) as { state: JobState } | undefined;
		if (!row || !CLAIMABLE[table].includes(row.state)) return null;
		const token = randomUUID();
		const result = db.prepare(`UPDATE ${table} SET lease_owner=?, lease_token=?, lease_expires_at=?, updated_at=?
			WHERE id=? AND state=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(owner, token, expiry, at, id, row.state, at);
		return result.changes === 1 ? { table, id, owner, token, state: row.state } : null;
	}).immediate();
}

/** Compare state AND live owner/token before applying an explicitly allowed edge. */
export function transitionJob(db: Journal, lease: JobLease, next: JobState, extra: JobPatch = {}, now = Date.now()): JobLease {
	validateLease(lease, now);
	if (!TRANSITIONS[lease.table][lease.state]?.includes(next)) throw new JournalStateError("Invalid journal state transition.");
	const allowed = lease.table === "import_jobs" ? ["last_error", "stalwart_email_id", "stalwart_blob_id"] : ["last_error", "provider_id"];
	for (const [key, value] of Object.entries(extra)) {
		if (!allowed.includes(key) || (value !== null && (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)))) {
			throw new JournalStateError("Invalid journal transition metadata.");
		}
	}
	const at = new Date(now).toISOString();
	return db.transaction(() => {
		const row = db.prepare(`SELECT * FROM ${lease.table} WHERE id=? AND state=? AND lease_owner=? AND lease_token=? AND lease_expires_at>?`)
			.get(lease.id, lease.state, lease.owner, lease.token, at) as Record<string, unknown> | undefined;
		if (!row) throw new JournalStateError("Lease or expected state is no longer valid.");
		const metadata = { ...row, ...extra };
		if (next === "verified" && (!validRecordedId(metadata.stalwart_email_id) || !validRecordedId(metadata.stalwart_blob_id))) {
			throw new JournalStateError("Verified import requires canonical readback identifiers.");
		}
		if (next === "accepted" && !validRecordedId(metadata.provider_id)) throw new JournalStateError("Accepted submission requires a provider identifier.");
		const entries = Object.entries(extra);
		const sets = ["state=?", "updated_at=?", ...entries.map(([key]) => `${key}=?`)];
		const result = db.prepare(`UPDATE ${lease.table} SET ${sets.join(",")} WHERE id=? AND state=? AND lease_owner=? AND lease_token=? AND lease_expires_at>?`)
			.run(next, at, ...entries.map(([, value]) => value), lease.id, lease.state, lease.owner, lease.token, at);
		if (result.changes !== 1) throw new JournalStateError("Lease or expected state is no longer valid.");
		return { ...lease, state: next };
	}).immediate();
}

/** Old/expired claims cannot release a successor's lease. */
export function releaseJob(db: Journal, lease: JobLease, now = Date.now()): boolean {
	validateLease(lease, now);
	const at = new Date(now).toISOString();
	return db.prepare(`UPDATE ${lease.table} SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=?
		WHERE id=? AND state=? AND lease_owner=? AND lease_token=? AND lease_expires_at>?`)
		.run(at, lease.id, lease.state, lease.owner, lease.token, at).changes === 1;
}
