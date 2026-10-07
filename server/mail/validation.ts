// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: server-side submission validation.
//
// Everything here runs BEFORE a submission intent is handed to the relay, so a
// rejected message can never reach the outbound queue. The plan requires this:
// "validate owner, configured mailbox, sender identity/domain, recipient
// syntax/count, and size before queue/provider side effects."
//
// Rejections are explicit and typed so callers can map them to 4xx without
// guessing, and so tests can assert "no backend mutation happened" by timing.

import { extractEmail } from "./threading";
import type { SubmissionPayload } from "./submissions";

/** Raised for any submission that must not be sent. Never carries a secret. */
export class SubmissionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubmissionValidationError";
	}
}

export interface SenderPolicy {
	/** The mailbox the browser selected. */
	mailboxId: string;
	/** The owned address for that mailbox (lower-cased compare). */
	address: string;
	/** The owned domain; every From must be on it. */
	domain: string;
	/** Maximum total recipients across To+Cc+Bcc. */
	maxRecipients: number;
	/** Maximum message size in bytes (headers + body + declared attachment sizes). */
	maxBytes: number;
}

export interface AttachmentRef {
	blobId: string;
	/** The mailbox that owns this attachment; cross-mailbox reuse is refused. */
	mailboxId: string;
	size: number;
}

export interface ValidationResult {
	ok: true;
	/** Normalized recipients actually used downstream. */
	to: string[];
	cc: string[];
	bcc: string[];
	/** Total size in bytes that was validated. */
	bytes: number;
}

// Deliberately conservative: RFC 5322 allows far more, but mail we SEND must be
// plain and predictable. No comments, no quoted local parts, no IP literals.
const ADDRESS_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const HEADER_INJECTION_RE = /[\r\n]/;
/** Control characters that must never appear in an address or subject. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function assertNoInjection(value: string, field: string): void {
	if (HEADER_INJECTION_RE.test(value) || CONTROL_RE.test(value)) {
		throw new SubmissionValidationError(`Illegal control/newline characters in ${field}`);
	}
}

function normalizeRecipients(list: string[] | undefined, field: string): string[] {
	if (list === undefined || list === null) return [];
	if (!Array.isArray(list)) throw new SubmissionValidationError(`${field} must be a list of addresses`);
	return list.map((entry) => {
		if (typeof entry !== "string") throw new SubmissionValidationError(`${field} must be a list of addresses`);
		assertNoInjection(entry, field);
		const bare = extractEmail(entry);
		if (!ADDRESS_RE.test(bare)) throw new SubmissionValidationError(`Invalid recipient address in ${field}: ${bare}`);
		return bare;
	});
}

/**
 * Validate a submission against the sender policy. Throws
 * SubmissionValidationError on any problem; returns the normalized recipients
 * and validated size on success.
 */
export function validateSubmission(
	payload: SubmissionPayload & { attachments?: AttachmentRef[]; autoSend?: boolean },
	policy: SenderPolicy,
): ValidationResult {
	if (payload.autoSend === true) {
		throw new SubmissionValidationError("Unsupported auto-send setting");
	}

	// 1. Sender identity: the From must be on an owned domain AND exactly this
	//    mailbox. Domain is checked first so a foreign-domain attempt gets the
	//    specific rejection rather than a generic mismatch.
	const fromBare = extractEmail(payload.from);
	assertNoInjection(payload.from, "From");
	const fromDomain = fromBare.split("@")[1] ?? "";
	if (fromDomain !== policy.domain.trim().toLowerCase()) {
		throw new SubmissionValidationError(`From address is not on an owned domain: ${fromDomain}`);
	}
	if (fromBare !== policy.address.trim().toLowerCase()) {
		throw new SubmissionValidationError("From address must match the selected mailbox");
	}

	// 2. Subject must not smuggle headers.
	assertNoInjection(payload.subject, "subject");

	// 3. Recipients: valid syntax, bounded count.
	const to = normalizeRecipients(payload.to, "To");
	const cc = normalizeRecipients(payload.cc, "Cc");
	const bcc = normalizeRecipients(payload.bcc, "Bcc");
	if (to.length === 0) throw new SubmissionValidationError("At least one recipient is required");
	const total = to.length + cc.length + bcc.length;
	if (total > policy.maxRecipients) {
		throw new SubmissionValidationError(`Too many recipients: ${total} exceeds ${policy.maxRecipients}`);
	}

	// 4. Attachments: each must belong to the SAME mailbox. Cross-mailbox reuse
	//    would let one account exfiltrate another's blobs.
	let attachmentBytes = 0;
	for (const att of payload.attachments ?? []) {
		if (att.mailboxId !== policy.mailboxId) {
			throw new SubmissionValidationError(`Attachment ${att.blobId} is not owned by mailbox ${policy.mailboxId}`);
		}
		if (!Number.isFinite(att.size) || att.size < 0) {
			throw new SubmissionValidationError(`Attachment ${att.blobId} has an invalid size`);
		}
		attachmentBytes += att.size;
	}

	// 5. Size: body (utf-8 bytes) + declared attachment sizes.
	const bodyBytes = Buffer.byteLength(payload.body ?? "", "utf8");
	const bytes = bodyBytes + attachmentBytes;
	if (bytes > policy.maxBytes) {
		throw new SubmissionValidationError(`Message too large: ${bytes} exceeds ${policy.maxBytes} bytes`);
	}

	return { ok: true, to, cc, bcc, bytes };
}
