// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: raw-MIME import pipeline.
//
// The SQLite journal and Stalwart cannot be committed atomically. This pipeline
// therefore makes every intermediate state durable and named, so that a crash
// lands in a state that is either safely retryable or reconcilable:
//
//   pending -> spooled -> uploaded -> imported -> verified
//                    \-> failed (retryable, with a recorded reason)
//
// A job is only marked `verified` after an authoritative readback proves the
// exact imported message and blob. Nothing here claims exactly-once delivery;
// it provides at-least-once with a proven reconciliation path.

import { createHash } from "node:crypto";
import type { Journal } from "../db/index";
import type { RecipientRouter } from "./recipients";

export type ImportFaultPoint = "before_upload" | "after_upload" | "after_import" | "before_commit";

export interface SpoolPort {
	write(bytes: Uint8Array): Promise<string>;
	read(key: string): Promise<Uint8Array>;
	release(key: string): Promise<void>;
}

export interface JmapImportPort {
	upload(bytes: Uint8Array): Promise<string>;
	importEmail(input: { mailboxId: string; blobId: string; bytes: Uint8Array }): Promise<{ emailId: string }>;
	readback(emailId: string): Promise<{ emailId: string; blobId: string; size: number } | null>;
	findByContentHash(hash: string): Promise<{ emailId: string; blobId: string } | null>;
}

export interface ImportJobResult {
	jobId: number;
	mailboxId: string;
	state: "verified" | "failed" | "already_imported";
	stalwartEmailId?: string;
	error?: string;
}

export interface ImportResult {
	status: "imported" | "already_imported" | "partial" | "failed";
	jobs: ImportJobResult[];
}

export interface ImportPipelineOptions {
	db: Journal;
	router: RecipientRouter;
	spool: SpoolPort;
	/** Shared account adapter for single-mailbox deployments. */
	jmap?: JmapImportPort;
	/** Selects an isolated JMAP adapter for each local mailbox identity. */
	jmapForMailbox?: (mailboxId: string) => JmapImportPort;
	/** Resolves the JMAP account for a given local mailbox row. */
	mailboxIdResolver: (mailboxId: string) => string;
	/** Test-only hook to force failures at named boundaries. */
	faultInjector?: (point: ImportFaultPoint) => void;
	/** Test-only hook to fail a specific target without failing the others. */
	shouldFailTarget?: (mailboxId: string) => boolean;
}

export function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export class ImportPipeline {
	readonly #db: Journal;
	readonly #router: RecipientRouter;
	readonly #spool: SpoolPort;
	readonly #jmapForMailbox: (mailboxId: string) => JmapImportPort;
	readonly #resolveAccount: (mailboxId: string) => string;
	readonly #fault: (point: ImportFaultPoint) => void;
	readonly #shouldFailTarget: (mailboxId: string) => boolean;

	constructor(opts: ImportPipelineOptions) {
		this.#db = opts.db;
		this.#router = opts.router;
		this.#spool = opts.spool;
		const sharedJmap = opts.jmap;
		const jmapForMailbox = opts.jmapForMailbox ?? (sharedJmap ? () => sharedJmap : undefined);
		if (!jmapForMailbox) throw new Error("ImportPipeline requires a JMAP port or mailbox-scoped JMAP ports.");
		this.#jmapForMailbox = jmapForMailbox;
		this.#resolveAccount = opts.mailboxIdResolver;
		this.#fault = opts.faultInjector ?? (() => {});
		this.#shouldFailTarget = opts.shouldFailTarget ?? (() => false);
	}

	#updateJob(
		jobId: number,
		patch: { state: string; attempts?: number; lastError?: string | null; emailId?: string | null; blobId?: string | null },
	): void {
		const sets: string[] = ["state = ?", "updated_at = ?"];
		const values: unknown[] = [patch.state, new Date().toISOString()];
		if (patch.attempts !== undefined) {
			sets.push("attempts = ?");
			values.push(patch.attempts);
		}
		if (patch.lastError !== undefined) {
			sets.push("last_error = ?");
			values.push(patch.lastError);
		}
		if (patch.emailId !== undefined) {
			sets.push("stalwart_email_id = ?");
			values.push(patch.emailId);
		}
		if (patch.blobId !== undefined) {
			sets.push("stalwart_blob_id = ?");
			values.push(patch.blobId);
		}
		values.push(jobId);
		this.#db.prepare(`UPDATE import_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
	}

	#readJob(jobId: number): { id: number; state: string; attempts: number; stalwart_email_id: string | null } {
		return this.#db
			.prepare("SELECT id, state, attempts, stalwart_email_id FROM import_jobs WHERE id = ?")
			.get(jobId) as { id: number; state: string; attempts: number; stalwart_email_id: string | null };
	}

	async importReceipt(input: {
		provider: string;
		receiptId: string;
		recipients: readonly string[];
		bytes: Uint8Array;
		/** Declared byte count from the provider, if known; detects truncation. */
		expectedBytes?: number;
	}): Promise<ImportResult> {
		// 1. Verify completeness before touching anything.
		if (input.expectedBytes !== undefined && input.bytes.byteLength !== input.expectedBytes) {
			throw new Error(
				`Refusing to import an incomplete raw message: got ${input.bytes.byteLength} bytes, expected ${input.expectedBytes}.`,
			);
		}
		if (input.bytes.byteLength === 0) {
			throw new Error("Refusing to import an empty raw message.");
		}

		// 2. Resolve targets from provider metadata, and persist jobs first.
		const targets = this.#router.resolve(input.recipients);
		const jobIds = this.#router.ensureJobs(
			input.provider,
			input.receiptId,
			targets.map((t) => t.mailboxId),
		);

		const jobs: ImportJobResult[] = [];

		for (const jobId of jobIds) {
			const job = this.#readJob(jobId);
			const mailboxId = (
				this.#db.prepare("SELECT target_mailbox_id FROM import_jobs WHERE id = ?").get(jobId) as {
					target_mailbox_id: string;
				}
			).target_mailbox_id;

			// Already-confirmed jobs are never re-imported; this is what makes a
			// replay of the same receipt produce one visible copy.
			if (job.state === "verified") {
				jobs.push({ jobId, mailboxId, state: "already_imported", stalwartEmailId: job.stalwart_email_id ?? undefined });
				continue;
			}

			try {
				if (this.#shouldFailTarget(mailboxId)) {
					throw new Error(`injected target failure for ${mailboxId}`);
				}
				const result = await this.#importOne(jobId, mailboxId, input.bytes);
				jobs.push({ jobId, mailboxId, ...result });
			} catch (err) {
				const message = (err as Error).message;
				this.#updateJob(jobId, { state: "failed", attempts: job.attempts + 1, lastError: message });
				jobs.push({ jobId, mailboxId, state: "failed", error: message });
			}
		}

		const verifiedCount = jobs.filter((j) => j.state === "verified").length;
		const alreadyCount = jobs.filter((j) => j.state === "already_imported").length;
		const status: ImportResult["status"] =
			verifiedCount + alreadyCount === jobs.length && jobs.length > 0
				? verifiedCount === 0 && alreadyCount > 0
					? "already_imported"
					: "imported"
				: verifiedCount + alreadyCount > 0
					? "partial"
					: "failed";

		return { status, jobs };
	}

	async #importOne(
		jobId: number,
		mailboxId: string,
		bytes: Uint8Array,
	): Promise<{ state: "verified"; stalwartEmailId: string }> {
		const job = this.#readJob(jobId);
		const jmap = this.#jmapForMailbox(mailboxId);
		const accountId = this.#resolveAccount(mailboxId);
		if (!accountId) throw new Error(`No JMAP account bound for mailbox ${mailboxId}.`);

		// Reconciliation first: if a previous attempt already delivered this
		// content, adopt it rather than creating a second copy.
		if (job.state === "uploaded" || job.state === "imported" || job.state === "failed") {
			const existing = await jmap.findByContentHash(hashBytes(bytes));
			if (existing) {
				const rb = await jmap.readback(existing.emailId);
				if (rb && rb.blobId === existing.blobId) {
					this.#updateJob(jobId, {
						state: "verified",
						emailId: existing.emailId,
						blobId: existing.blobId,
						lastError: null,
					});
					return { state: "verified", stalwartEmailId: existing.emailId };
				}
			}
		}

		// Spool the bytes privately before uploading.
		const spoolKey = await this.#spool.write(bytes);
		this.#updateJob(jobId, { state: "spooled", attempts: job.attempts + 1 });

		this.#fault("before_upload");

		const blobId = await jmap.upload(bytes);
		this.#updateJob(jobId, { state: "uploaded", blobId });

		this.#fault("after_upload");

		const { emailId } = await jmap.importEmail({ mailboxId: accountId, blobId, bytes });
		this.#updateJob(jobId, { state: "imported", emailId, blobId });

		// The email id is committed to the journal BEFORE the post-import fault
		// boundary. This ordering is the whole reconciliation story: if we crash
		// here, the journal already names the message that exists in Stalwart, so
		// a later reconcile can positively adopt it instead of guessing.
		this.#fault("after_import");

		// Authoritative readback: the message must exist with the exact blob.
		const rb = await jmap.readback(emailId);
		if (!rb || rb.blobId !== blobId || rb.size !== bytes.byteLength) {
			throw new Error(
				`Readback mismatch for job ${jobId}: expected blob ${blobId} (${bytes.byteLength} bytes), got ${rb ? `${rb.blobId} (${rb.size} bytes)` : "nothing"}.`,
			);
		}

		this.#fault("before_commit");

		this.#updateJob(jobId, { state: "verified", emailId, blobId, lastError: null });
		// Temporary bytes are released only once the canonical copy is proven.
		await this.#spool.release(spoolKey);

		return { state: "verified", stalwartEmailId: emailId };
	}
}
