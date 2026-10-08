// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: Resend outbound relay transport.
//
// The production RelayTransport for `submitWithIdempotency`. It is the ONLY
// place an outbound message is handed to a provider, and it lives with the
// worker (never the web process), so a web compromise cannot read the relay
// secret.
//
// Two properties are non-negotiable and tested:
//   1. Every attempt carries the STABLE idempotency key from the intent, so a
//      retry after a timeout cannot double-send.
//   2. An ambiguous result (network error, 5xx, 429) is reported `ambiguous`
//      and held for reconciliation — never `accepted`, never blindly resent.
// A definite 4xx is a `rejected` outcome (a known refusal is not retried).

import { redactSecrets } from "./resend-receiving";
import type { RelayOutcome, RelayRequest, RelayTransport } from "../mail/submissions";

/** Resend's API-style idempotency header. */
const IDEMPOTENCY_HEADER = "Idempotency-Key";

export interface ResendRelayOptions {
	apiKey: string;
	baseUrl?: string;
	/** Injection seam for tests; defaults to the ambient fetch. */
	fetch?: typeof fetch;
	/** Per-attempt timeout in milliseconds. */
	timeoutMs?: number;
}

interface ResendSendResponse {
	id?: string;
}

export class ResendRelay implements RelayTransport {
	readonly #apiKey: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(opts: ResendRelayOptions) {
		if (!opts.apiKey) throw new Error("A Resend API key is required for the outbound relay.");
		this.#apiKey = opts.apiKey;
		this.#baseUrl = (opts.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
		this.#fetch = opts.fetch ?? fetch;
		this.#timeoutMs = opts.timeoutMs ?? 15_000;
	}

	/**
	 * Post one submission attempt.
	 *
	 * Never throws for a *known* rejection; ambiguity is a value, not an
	 * exception, because the caller must record and reconcile it.
	 */
	async send(request: RelayRequest): Promise<RelayOutcome> {
		// The intent's header wins; the provider header name is fixed so a
		// mis-wired upstream cannot silently drop the key.
		const idempotencyValue = request.idempotencyHeader.value || request.requestId;
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}/emails`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					"Content-Type": "application/json",
					[IDEMPOTENCY_HEADER]: idempotencyValue,
				},
				body: JSON.stringify(toResendPayload(request)),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (err) {
			// A thrown fetch is genuinely ambiguous: the request may have been
			// received. Never claim success and never auto-retry here.
			return { status: "ambiguous", reason: redactSecrets(`relay transport error: ${(err as Error).message}`) };
		}

		if (response.ok) {
			try {
				const body = (await response.json()) as ResendSendResponse;
				if (body?.id) return { status: "accepted", providerId: body.id };
				// A 2xx with no id is not proof of delivery.
				return { status: "ambiguous", reason: "relay accepted without a provider id" };
			} catch {
				return { status: "ambiguous", reason: "relay response could not be decoded" };
			}
		}

		// 4xx (bar 429) is a definite refusal; 429/5xx are ambiguous because the
		// provider may have accepted before failing to answer.
		if (response.status === 429 || response.status >= 500) {
			return { status: "ambiguous", reason: `relay returned ${response.status}` };
		}
		return { status: "rejected", reason: `relay rejected with ${response.status}` };
	}
}

/**
 * Map our submission payload to Resend's send shape.
 *
 * Only owned addresses reach here (validation ran upstream); the relay does not
 * re-derive recipients. Bcc is included only when the validated payload set it.
 */
function toResendPayload(request: RelayRequest): Record<string, unknown> {
	const p = request.payload;
	return {
		from: p.from,
		to: p.to,
		...(p.cc?.length ? { cc: p.cc } : {}),
		...(p.bcc?.length ? { bcc: p.bcc } : {}),
		subject: p.subject,
		text: p.body,
		...(p.inReplyTo ? { headers: { "In-Reply-To": p.inReplyTo, ...(p.references?.length ? { References: p.references.join(" ") } : {}) } } : {}),
	};
}
