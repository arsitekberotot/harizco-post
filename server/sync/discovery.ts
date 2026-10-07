// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: inbound discovery and checkpointing.
//
// The checkpoint is what makes catch-up reliable, and it is the easiest place
// to lose mail. Rules enforced here:
//   - jobs for a page are persisted before the checkpoint advances;
//   - a page with has_more=true never advances the checkpoint, so undiscovered
//     pages are not skipped past;
//   - an overlap boundary is retained so recent receipts are re-seen and
//     reconciled rather than assumed complete.

import type { Journal } from "../db/index";
import type { RecipientRouter } from "./recipients";

export interface DiscoveryCheckpoint {
	provider: string;
	lastPage: number;
	overlapFrom: string | null;
	updatedAt: string;
}

export interface PageOutcome {
	page: number;
	hasMore: boolean;
	jobCount: number;
	lastReceiptId: string | null;
}

const CHECKPOINT_SCHEMA = `
CREATE TABLE IF NOT EXISTS discovery_checkpoints (
  provider     TEXT PRIMARY KEY,
  last_page    INTEGER NOT NULL DEFAULT -1,
  overlap_from TEXT,
  updated_at   TEXT NOT NULL
);
`;

export class DiscoveryCheckpointStore {
	#db: Journal;

	constructor(db: Journal) {
		this.#db = db;
		this.#db.exec(CHECKPOINT_SCHEMA);
	}

	read(provider: string): DiscoveryCheckpoint | null {
		const row = this.#db.prepare("SELECT * FROM discovery_checkpoints WHERE provider = ?").get(provider) as
			| { provider: string; last_page: number; overlap_from: string | null; updated_at: string }
			| undefined;
		if (!row) return { provider, lastPage: -1, overlapFrom: null, updatedAt: "" };
		return {
			provider: row.provider,
			lastPage: row.last_page,
			overlapFrom: row.overlap_from,
			updatedAt: row.updated_at,
		};
	}

	advance(provider: string, next: { lastPage: number; overlapFrom: string | null }): void {
		this.#db
			.prepare(
				`INSERT INTO discovery_checkpoints (provider, last_page, overlap_from, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(provider) DO UPDATE SET
				   last_page = excluded.last_page,
				   overlap_from = excluded.overlap_from,
				   updated_at = excluded.updated_at`,
			)
			.run(provider, next.lastPage, next.overlapFrom, new Date().toISOString());
	}
}

export interface DiscoveryServiceOptions {
	db: Journal;
	router: RecipientRouter;
	checkpoints: DiscoveryCheckpointStore;
}

export class DiscoveryService {
	readonly #router: RecipientRouter;
	readonly #checkpoints: DiscoveryCheckpointStore;
	#caughtUp = new Map<string, boolean>();

	constructor(opts: DiscoveryServiceOptions) {
		this.#router = opts.router;
		this.#checkpoints = opts.checkpoints;
	}

	/**
	 * Record the outcome of one listing page.
	 *
	 * The checkpoint advances only when the page is genuinely the last one.
	 * When has_more is true the page is neither complete nor safe to skip past.
	 */
	recordPage(provider: string, outcome: PageOutcome): { advanced: boolean } {
		if (outcome.hasMore) {
			// Incomplete page: keep the previous checkpoint, and mark not caught up.
			this.#caughtUp.set(provider, false);
			return { advanced: false };
		}
		this.#checkpoints.advance(provider, {
			lastPage: outcome.page,
			// Retain the newest receipt seen as an overlap boundary so the next
			// scan re-sees recent mail and can reconcile rather than assume.
			overlapFrom: outcome.lastReceiptId,
		});
		this.#caughtUp.set(provider, true);
		return { advanced: true };
	}

	isCaughtUp(provider: string): boolean {
		return this.#caughtUp.get(provider) === true;
	}
}
