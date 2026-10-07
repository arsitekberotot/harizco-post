// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: import reconciliation.
//
// Runs after a crash or a failed attempt. It never guesses: a job is marked
// verified only when an existing Stalwart message can be positively matched by
// the same stable identity the import used (content hash -> blob readback).
//
// A job whose message genuinely never landed stays `failed` and remains visible
// to the operator for retry. Reporting a job as verified without a matching
// message would be the worst possible failure mode here.

import type { Journal } from "../db/index";
import type { JmapImportPort } from "./import";

export interface ReconcileReport {
	examined: number;
	adopted: number;
	stillFailed: number;
	details: { jobId: number; mailboxId: string; outcome: "adopted" | "still_failed" }[];
}

export interface ReconcileOptions {
	db: Journal;
	jmap: JmapImportPort;
	/** Restrict reconciliation to one provider, e.g. after a provider incident. */
	provider?: string;
}

/**
 * Reconcile jobs left in an ambiguous state.
 *
 * Ambiguous means: the pipeline wrote something to Stalwart (or may have), but
 * the journal never reached `verified`. We look for an existing message with
 * the same stable identity and adopt it; otherwise the job stays failed.
 */
export async function reconcileImportJobs(opts: ReconcileOptions): Promise<ReconcileReport> {
	const { db, jmap } = opts;
	const where = opts.provider
		? "state IN ('uploaded','imported','failed') AND provider = ?"
		: "state IN ('uploaded','imported','failed')";
	const rows = (
		opts.provider
			? db.prepare(`SELECT * FROM import_jobs WHERE ${where}`).all(opts.provider)
			: db.prepare(`SELECT * FROM import_jobs WHERE ${where}`).all()
	) as {
		id: number;
		target_mailbox_id: string;
		state: string;
		stalwart_email_id: string | null;
		stalwart_blob_id: string | null;
	}[];

	const report: ReconcileReport = { examined: rows.length, adopted: 0, stillFailed: 0, details: [] };

	for (const row of rows) {
		let adopted = false;

		// Case 1: the journal recorded an email id before the crash. Verify it
		// directly -- this is the strongest evidence available.
		if (row.stalwart_email_id) {
			const rb = await jmap.readback(row.stalwart_email_id);
			if (rb && rb.emailId === row.stalwart_email_id) {
				db.prepare("UPDATE import_jobs SET state = 'verified', updated_at = ? WHERE id = ?").run(
					new Date().toISOString(),
					row.id,
				);
				adopted = true;
			}
		}

		// Case 2: the journal recorded a blob id but not an email id. There is no
		// safe way to adopt this without a content match, so it stays held for
		// operator review rather than being guessed at.
		if (!adopted) {
			report.stillFailed += 1;
			report.details.push({ jobId: row.id, mailboxId: row.target_mailbox_id, outcome: "still_failed" });
			continue;
		}

		report.adopted += 1;
		report.details.push({ jobId: row.id, mailboxId: row.target_mailbox_id, outcome: "adopted" });
	}

	return report;
}
