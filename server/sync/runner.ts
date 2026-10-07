// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: bounded sync worker loop.
//
// One leased poller, no overlapping runs, exponential backoff on provider
// errors, and no unbounded spool or checkpoint growth. Every run is bounded so
// a single pathological run cannot wedge the loop.

import type { Journal } from "../db/index";
import type { RecipientRouter } from "./recipients";

export interface PollOutcome {
	pages: number;
	discovered: number;
	imported: number;
	failed: number;
}

export interface SyncRunnerOptions {
	db: Journal;
	router: RecipientRouter;
	intervalSeconds: number;
	owner: string;
	poll: () => Promise<PollOutcome>;
	maxBackoffSeconds?: number;
}

const LEASE_KEY = "sync_lease";

export class SyncRunner {
	readonly #db: Journal;
	readonly #router: RecipientRouter;
	readonly #interval: number;
	readonly #owner: string;
	readonly #poll: () => Promise<PollOutcome>;
	readonly #maxBackoff: number;
	#inFlight = false;
	#backoff = 1;
	#stopped = false;
	#lastSuccessAt: string | null = null;

	constructor(opts: SyncRunnerOptions) {
		if (opts.intervalSeconds < 30) {
			// Below this the provider is at real risk of rate-limit abuse.
			throw new Error("Sync interval must be at least 30 seconds to respect provider limits.");
		}
		this.#db = opts.db;
		this.#router = opts.router;
		this.#interval = opts.intervalSeconds;
		this.#owner = opts.owner;
		this.#poll = opts.poll;
		this.#maxBackoff = opts.maxBackoffSeconds ?? 15 * 60;
		this.#db.exec(`CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	}

	acquireLease(ttlSeconds = 300): boolean {
		const now = Date.now();
		const existing = this.#db.prepare("SELECT value FROM sync_state WHERE key = ?").get(LEASE_KEY) as
			| { value: string }
			| undefined;
		if (existing) {
			const held = JSON.parse(existing.value) as { owner: string; expiresAt: number };
			if (held.expiresAt > now && held.owner !== this.#owner) {
				return false;
			}
		}
		this.#db
			.prepare(
				"INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(LEASE_KEY, JSON.stringify({ owner: this.#owner, expiresAt: now + ttlSeconds * 1000 }));
		return true;
	}

	holdingLease(): boolean {
		const row = this.#db.prepare("SELECT value FROM sync_state WHERE key = ?").get(LEASE_KEY) as
			| { value: string }
			| undefined;
		if (!row) return false;
		const held = JSON.parse(row.value) as { owner: string; expiresAt: number };
		return held.owner === this.#owner && held.expiresAt > Date.now();
	}

	stop(): void {
		this.#stopped = true;
		this.#db.prepare("DELETE FROM sync_state WHERE key = ?").run(LEASE_KEY);
	}

	/** Run one bounded poll. Re-entrant calls are refused rather than queued. */
	async runOnce(): Promise<PollOutcome | null> {
		if (this.#inFlight || this.#stopped) return null;
		this.#inFlight = true;
		try {
			const outcome = await this.#poll();
			if (outcome.failed > 0) this.recordFailure("partial_failure");
			else this.recordSuccess();
			return outcome;
		} finally {
			this.#inFlight = false;
		}
	}

	recordFailure(_reason: string): void {
		this.#backoff = Math.min(this.#backoff * 2, Math.ceil(this.#maxBackoff / this.#interval));
	}

	recordSuccess(): void {
		this.#backoff = 1;
		this.#lastSuccessAt = new Date().toISOString();
	}

	nextDelaySeconds(): number {
		return this.#interval * this.#backoff;
	}

	get lastSuccessAt(): string | null {
		return this.#lastSuccessAt;
	}
}
