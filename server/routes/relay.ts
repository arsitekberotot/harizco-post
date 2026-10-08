// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: worker-side submission relay endpoint.
//
// This is the counterpart to the web process's `HttpRelayTransport`: the web
// side records the durable intent and forwards `{requestId, payload}` here, and
// THIS process (which owns the Resend credential) performs the send. The web
// process therefore never holds a provider secret.
//
// Trust boundary:
//   - The caller is authenticated with a shared secret, compared in constant
//     time. An unauthenticated or wrong-secret request is refused BEFORE any
//     provider call, so the endpoint is not an open relay.
//   - The payload is validated as a well-formed submission before relaying.
//   - Responses carry a provider id or a category — never the provider secret,
//     never the message body, never recipients.
//
// Status mapping matches the ambiguity contract used everywhere else:
//   200 accepted · 202 ambiguous (held for reconciliation) · 4xx rejected.

import { constantTimeEqual } from "../auth/request";
import { redactSecrets } from "../integrations/resend-receiving";
import { ResendRelay, type ResendRelayOptions } from "../integrations/resend-relay";
import type { RelayTransport, SubmissionPayload } from "../mail/submissions";

export interface RelayHandlerOptions {
	/** Shared secret the web process presents; never logged. */
	secret: string;
	/** The outbound transport that owns the provider credential. */
	relay: ResendRelay | ResendRelayOptions;
}

const MAX_BODY_BYTES = 6_000_000;

/**
 * Build the relay endpoint handler.
 *
 * The returned function has the same `(Request) => Promise<Response>` shape as
 * every other entrypoint here, so it can be mounted by the worker's listener
 * without this module knowing about the server framework.
 */
export function createRelayHandler(options: RelayHandlerOptions): (request: Request) => Promise<Response> {
	const secret = options.secret;
	if (!secret) throw new Error("A shared relay secret is required.");
	const transport: RelayTransport =
		options.relay instanceof ResendRelay ? options.relay : new ResendRelay(options.relay);

	return async function relayHandler(request: Request): Promise<Response> {
		if (request.method !== "POST") return jsonError(405, "Method not allowed");

		// Authenticate first: an unauthenticated body must never reach a provider.
		const presented = bearer(request.headers.get("authorization"));
		if (!presented || !constantTimeEqual(presented, secret)) {
			return jsonError(401, "Unauthorized");
		}

		const declared = Number(request.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return jsonError(413, "Payload too large");

		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return jsonError(400, "Invalid JSON body");
		}
		const parsed = parseRelayRequest(raw);
		if (!parsed) return jsonError(400, "Malformed submission");

		const outcome = await transport.send(parsed);
		switch (outcome.status) {
			case "accepted":
				return jsonOk({ providerId: outcome.providerId }, 200);
			case "ambiguous":
				// Held for reconciliation by the caller; never reported as sent.
				return jsonOk({ state: "unknown", reason: redactSecrets(outcome.reason) }, 202);
			case "rejected":
				// A known refusal; the reason is redacted before it leaves.
				return jsonError(422, redactSecrets(outcome.reason));
		}
	};
}

function bearer(header: string | null): string | null {
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1] : null;
}

/**
 * Validate the forwarded submission.
 *
 * Only the fields the transport needs are read, and every required one must be
 * present with the right type: a half-formed body is refused rather than sent
 * with an invented recipient or subject.
 */
function parseRelayRequest(raw: unknown): { requestId: string; idempotencyHeader: { name: string; value: string }; payload: SubmissionPayload } | null {
	if (!raw || typeof raw !== "object") return null;
	const { requestId, payload } = raw as { requestId?: unknown; payload?: unknown };
	if (typeof requestId !== "string" || !requestId) return null;
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	const from = str(p.from);
	const mailboxId = str(p.mailboxId);
	const subject = typeof p.subject === "string" ? p.subject : "";
	const body = typeof p.body === "string" ? p.body : null;
	const to = strArray(p.to);
	if (!from || !mailboxId || body === null || !to || to.length === 0) return null;
	const cc = strArray(p.cc) ?? [];
	const bcc = strArray(p.bcc) ?? [];
	const references = strArray(p.references);
	return {
		requestId,
		idempotencyHeader: { name: "Idempotency-Key", value: requestId },
		payload: {
			mailboxId,
			from,
			to,
			cc,
			bcc,
			subject,
			body,
			...(typeof p.inReplyTo === "string" ? { inReplyTo: p.inReplyTo } : {}),
			...(references ? { references } : {}),
		},
	};
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v : null;
}

function strArray(v: unknown): string[] | null {
	if (v === undefined) return null;
	if (!Array.isArray(v)) return null;
	return v.filter((x): x is string => typeof x === "string");
}

function jsonOk(value: unknown, status: number): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function jsonError(status: number, error: string): Response {
	return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
