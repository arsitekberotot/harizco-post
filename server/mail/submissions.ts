// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: outbound submission intents.
//
// Sending is the one operation where a retry can duplicate a real message to a
// real person, so the discipline is stricter than for reads:
//
//   1. A durable intent AND a stable idempotency key are written BEFORE any
//      provider side effect. If the process dies mid-send, the intent survives.
//   2. A replay of the same payload resolves to the SAME intent. There is one
//      row per (request_id); retries reuse the key rather than minting a new one.
//   3. An ambiguous result (timeout after we may have sent) becomes `unknown`
//      and is HELD for reconciliation. It is never blindly retransmitted.
//   4. `accepted` means the relay/provider accepted the message for delivery; it
//      is NOT proof the recipient received it. The UI must say "accepted".
//
// The provider idempotency header is the `request_id` itself, so the same key is
// carried across every relay retry.

import { createHash } from "node:crypto";
import type { Journal, SubmissionIntent, SubmissionIntentState } from "../db/index";

export interface SubmissionPayload {
	/** The owned mailbox the message is sent from. */
	mailboxId: string;
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
	/** Optional explicit threading headers; part of the identity. */
	inReplyTo?: string;
	references?: string[];
}

/** Raised when a request id is reused with a different payload. */
export class SubmissionReuseError extends Error {
	constructor(requestId: string) {
		super(`Request id ${requestId} was already used with different content`);
		this.name = "SubmissionReuseError";
	}
}

/** Canonical, order-stable view of the payload so the same intent always hashes the same. */
function canonicalize(payload: SubmissionPayload): string {
	const norm = (list?: string[]): string[] => (list ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
	return JSON.stringify({
		mailboxId: payload.mailboxId,
		from: payload.from.trim().toLowerCase(),
		to: norm(payload.to),
		cc: norm(payload.cc),
		bcc: norm(payload.bcc),
		subject: payload.subject,
		body: payload.body,
		inReplyTo: payload.inReplyTo ?? null,
		references: payload.references ?? [],
	});
}

/** A stable content hash of the submission. Not secret; safe to log. */
export function payloadHash(payload: SubmissionPayload): string {
	return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

/**
 * The idempotency key for a submission. Deterministic from the payload so a
 * replay in a new process still lands on the same key, and stable across relay
 * retries so the provider can de-duplicate.
 */
export function idempotencyKeyFor(payload: SubmissionPayload): string {
	return "sub_" + payloadHash(payload).slice(0, 32);
}

function now(clock: () => Date): string {
	return clock().toISOString();
}

/**
 * Durable store for submission intents. Backed by the `submission_intents`
 * journal table; Stalwart remains canonical for the message itself.
 */
export class SubmissionStore {
	#db: Journal;
	#clock: () => Date;

	constructor(db: Journal, clock: () => Date = () => new Date()) {
		this.#db = db;
		this.#clock = clock;
	}

	/**
	 * Create (or find) the intent for a payload. Idempotent: calling twice with
	 * the same payload returns the same row and never creates a second intent.
	 */
	createIntent(payload: SubmissionPayload): SubmissionIntent {
		const requestId = idempotencyKeyFor(payload);
		const hash = payloadHash(payload);
		const existing = this.getIntent(requestId);
		if (existing) {
			// Same key must mean the same message. A differing payload under an
			// existing key is a client bug or an attack; refuse rather than send
			// the wrong content under a key the provider may have already seen.
			if (existing.payload_hash !== hash) {
				throw new SubmissionReuseError(requestId);
			}
			return existing;
		}

		const at = now(this.#clock);
		this.#db
			.prepare(
				`INSERT INTO submission_intents
				   (request_id, mailbox_id, payload_hash, state, provider_id, last_error, created_at, updated_at)
				 VALUES (?, ?, ?, 'intent', NULL, NULL, ?, ?)`,
			)
			.run(requestId, payload.mailboxId, hash, at, at);

		// Re-read so the caller always sees the persisted row (id, timestamps).
		return this.getIntent(requestId)!;
	}

	getIntent(requestId: string): SubmissionIntent | undefined {
		return this.#db.prepare("SELECT * FROM submission_intents WHERE request_id = ?").get(requestId) as
			| SubmissionIntent
			| undefined;
	}

	/** True when the intent exists and has not already been handed to the provider. */
	canSubmit(requestId: string): boolean {
		const intent = this.getIntent(requestId);
		if (!intent) return false;
		return intent.state === "intent" || intent.state === "failed";
	}

	/** Intents awaiting reconciliation: ambiguous results that must be resolved, not resent. */
	listNeedingReconcile(): SubmissionIntent[] {
		return this.#db
			.prepare("SELECT * FROM submission_intents WHERE state = 'unknown' ORDER BY created_at ASC")
			.all() as SubmissionIntent[];
	}

	markSubmitted(requestId: string): void {
		this.#setState(requestId, "submitted");
	}

	markAccepted(requestId: string, providerId: string): void {
		this.#setState(requestId, "accepted", { provider_id: providerId, last_error: null });
	}

	markFailed(requestId: string, reason: string): void {
		this.#setState(requestId, "failed", { last_error: reason });
	}

	/**
	 * Record an ambiguous outcome and hold it. Callers must NOT retransmit from
	 * here; the intent waits for reconcile() to learn the true outcome.
	 */
	markUnknown(requestId: string, reason: string): void {
		this.#setState(requestId, "unknown", { last_error: reason });
	}

	/**
	 * Resolve a held/ambiguous intent against a provider id WITHOUT sending
	 * again. This is the only path out of `unknown`.
	 */
	reconcile(requestId: string, providerId: string): void {
		const intent = this.getIntent(requestId);
		if (!intent) throw new Error(`No submission intent for ${requestId}`);
		if (intent.state !== "unknown" && intent.state !== "submitted") {
			throw new Error(`Intent ${requestId} is ${intent.state}; nothing to reconcile`);
		}
		this.markAccepted(requestId, providerId);
	}

	#setState(
		requestId: string,
		state: SubmissionIntentState,
		extra: { provider_id?: string | null; last_error?: string | null } = {},
	): void {
		const intent = this.getIntent(requestId);
		if (!intent) throw new Error(`No submission intent for ${requestId}`);
		const providerId = extra.provider_id !== undefined ? extra.provider_id : intent.provider_id;
		const lastError = extra.last_error !== undefined ? extra.last_error : intent.last_error;
		this.#db
			.prepare(
				`UPDATE submission_intents
				   SET state = ?, provider_id = ?, last_error = ?, updated_at = ?
				 WHERE request_id = ?`,
			)
			.run(state, providerId, lastError, now(this.#clock), requestId);
	}
}

// ---------------------------------------------------------------------------
// Task 15: relay submission with idempotency carried across retries.
//
// The transport is injected so tests can simulate acceptance ambiguity and
// restarts without a live relay. The production transport talks to Stalwart's
// authenticated submission path (see deploy/stalwart/README.md); it MUST carry
// the `request_id` as the provider idempotency header on every attempt.
// ---------------------------------------------------------------------------

export type RelayOutcome =
	| { status: "accepted"; providerId: string }
	| { status: "rejected"; reason: string }
	/** The relay may or may not have accepted; caller must hold and reconcile. */
	| { status: "ambiguous"; reason: string };

export interface RelayRequest {
	requestId: string;
	idempotencyHeader: { name: string; value: string };
	payload: SubmissionPayload;
}

export interface RelayTransport {
	/** Post one submission attempt. Must never throw for a *known* rejection. */
	send(request: RelayRequest): Promise<RelayOutcome>;
}

export interface SubmitResult {
	requestId: string;
	state: SubmissionIntent["state"];
	providerId: string | null;
}

/**
 * Drive one submission to a terminal-ish state with idempotent retry.
 *
 * - The intent is created (durable) BEFORE the transport is called.
 * - If the intent is already submitted/accepted, the transport is NOT called.
 * - An ambiguous outcome is recorded `unknown` and returned as such; it is not
 *   retried here — a later reconcile() resolves it.
 * - A known rejection never consumes a retry and is recorded `failed`.
 */
export async function submitWithIdempotency(
	store: SubmissionStore,
	transport: RelayTransport,
	payload: SubmissionPayload,
): Promise<SubmitResult> {
	const intent = store.createIntent(payload);
	if (!store.canSubmit(intent.request_id)) {
		// Already handed to the relay: do not send again.
		return { requestId: intent.request_id, state: intent.state, providerId: intent.provider_id };
	}

	store.markSubmitted(intent.request_id);
	const idempotencyHeader = { name: "Idempotency-Key", value: intent.request_id };
	const outcome = await transport.send({ requestId: intent.request_id, idempotencyHeader, payload });

	if (outcome.status === "accepted") {
		store.markAccepted(intent.request_id, outcome.providerId);
		return { requestId: intent.request_id, state: "accepted", providerId: outcome.providerId };
	}
	if (outcome.status === "rejected") {
		store.markFailed(intent.request_id, outcome.reason);
		return { requestId: intent.request_id, state: "failed", providerId: null };
	}
	store.markUnknown(intent.request_id, outcome.reason);
	return { requestId: intent.request_id, state: "unknown", providerId: null };
}
