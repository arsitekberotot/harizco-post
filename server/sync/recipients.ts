// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: recipient routing.
//
// Routing uses the provider's verified recipient metadata (the envelope
// recipients), not the visible To/Cc headers. This is required for Bcc to work
// and for multi-recipient mail to reach every owned mailbox.
//
// An unknown address is never turned into a mailbox: doing so would let an
// external sender create a sendable identity simply by sending mail.

import type { Journal } from "../db/index";
import type { MailboxRegistry } from "../mailboxes/registry";
import { normalizeAddress } from "../mailboxes/registry";

export interface DeliveryTarget {
	mailboxId: string;
	address: string;
}

export interface RecipientRouterOptions {
	db: Journal;
	registry: MailboxRegistry;
	/** Hard cap on distinct unmatched addresses recorded per message. */
	maxUnmatched?: number;
}

export class RecipientRouter {
	readonly #db: Journal;
	readonly #registry: MailboxRegistry;
	readonly #maxUnmatched: number;
	lastUnmatched: string[] = [];

	constructor(opts: RecipientRouterOptions) {
		this.#db = opts.db;
		this.#registry = opts.registry;
		this.#maxUnmatched = opts.maxUnmatched ?? 50;
	}

	/**
	 * Map provider-reported recipients to enabled local mailboxes.
	 * Deduplicated per mailbox; unknown addresses are reported separately.
	 */
	resolve(recipients: readonly string[]): DeliveryTarget[] {
		const targets = new Map<string, DeliveryTarget>();
		const unmatched: string[] = [];

		for (const raw of recipients) {
			const address = normalizeAddress(String(raw ?? ""));
			if (!address) continue;
			const mailbox = this.#registry.getByAddress(address);
			// Disabled mailboxes are not delivery targets: unlink must actually
			// stop delivery rather than keep writing into a dormant account.
			if (!mailbox || mailbox.enabled !== 1) {
				if (!unmatched.includes(address)) unmatched.push(address);
				continue;
			}
			if (!targets.has(mailbox.id)) {
				targets.set(mailbox.id, { mailboxId: mailbox.id, address });
			}
		}

		this.lastUnmatched = unmatched.slice(0, this.#maxUnmatched);
		return [...targets.values()];
	}

	/**
	 * Persist one job per (provider, receipt, target) before any import attempt.
	 * Idempotent: a replay returns the existing job ids.
	 */
	ensureJobs(provider: string, receiptId: string, mailboxIds: readonly string[]): number[] {
		if (!provider || !receiptId) throw new Error("ensureJobs requires a provider and a receipt id.");
		const ids: number[] = [];
		const now = new Date().toISOString();

		const insert = this.#db.prepare(
			`INSERT INTO import_jobs
			 (provider, provider_receipt_id, target_mailbox_id, state, created_at, updated_at)
			 VALUES (?, ?, ?, 'pending', ?, ?)`,
		);
		const find = this.#db.prepare(
			`SELECT id FROM import_jobs
			 WHERE provider = ? AND provider_receipt_id = ? AND target_mailbox_id = ?`,
		);

		const tx = this.#db.transaction((targets: readonly string[]) => {
			for (const mailboxId of targets) {
				const existing = find.get(provider, receiptId, mailboxId) as { id: number } | undefined;
				if (existing) {
					ids.push(existing.id);
					continue;
				}
				const info = insert.run(provider, receiptId, mailboxId, now, now);
				ids.push(Number(info.lastInsertRowid));
			}
		});
		tx(mailboxIds);
		return ids;
	}
}
