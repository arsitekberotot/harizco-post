// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: reply/forward composition.
//
// The browser sends only the original email id and the edited body; the server
// derives every recipient and threading header from the *stored* message. That
// is deliberate: a client-supplied recipient list would let the browser widen
// a reply-all or re-thread a forward. The policy lives in server/mail/threading
// (unit-tested); this module only applies it to a fetched message.

import type { EmailView, SendInput } from "../mail/backend";
import { computeReplyAll, forwardSubject, buildReferencesChain, buildThreadingHeaders, replySubject } from "../mail/threading";

export interface ReplyRequest {
	/** The owned mailbox address the reply is sent from. */
	from: string;
	body: string;
	/** Reply-all widens to the original To/Cc, minus our own address. */
	replyAll?: boolean;
}

export interface ForwardRequest {
	from: string;
	body: string;
	/** Explicit forward recipients; a forward never inherits the original's. */
	to: string[];
	/**
	 * Blob ids the user explicitly selected to carry. A forward never drags
	 * every original attachment along; unselected blobs are not included, and
	 * ids the original does not have are ignored (never invented).
	 */
	attachmentBlobIds?: string[];
}

function addressEmail(addr: EmailView["from"][number]): string {
	return typeof addr === "string" ? addr : addr.email;
}

/**
 * Build the submission payload for a reply.
 *
 * `inReplyTo`/`references` are derived from the stored message so the reply
 * threads; the subject is `Re:`-prefixed; reply-all resolves the original
 * sender plus To/Cc with our own address removed (never re-added, never a Bcc).
 */
export function buildReplySendInput(original: EmailView, request: ReplyRequest): SendInput {
	const chain = buildReferencesChain({
		id: original.id,
		messageId: original.messageId ?? null,
		threadId: original.threadId ?? null,
		references: original.references ?? [],
	});
	// `buildThreadingHeaders` is the single place angle brackets are applied;
	// the raw chain values are bare ids and must not be sent as-is.
	const headers = buildThreadingHeaders(chain.originalMessageId, chain.references);

	let to: string[];
	let cc: string[] = [];
	if (request.replyAll) {
		const all = computeReplyAll({
			mailboxAddress: request.from,
			originalFrom: original.from,
			originalReplyTo: (original as { replyTo?: EmailView["from"] }).replyTo ?? null,
			originalTo: original.to,
			originalCc: original.cc ?? [],
		});
		to = all.to;
		cc = all.cc;
	} else {
		// A single reply goes to Reply-To when present, else the From.
		const replyTo = ((original as { replyTo?: EmailView["from"] }).replyTo ?? []).map(addressEmail);
		to = replyTo.length ? replyTo : original.from.map(addressEmail);
	}
	// Whatever path is taken, our own address must never be a recipient.
	const owner = request.from.trim().toLowerCase();
	to = to.filter((a) => a.toLowerCase() !== owner);
	cc = cc.filter((a) => a.toLowerCase() !== owner);

	return {
		mailboxId: original.mailboxIds?.[0] ?? "",
		from: request.from,
		to,
		cc,
		subject: replySubject(original.subject ?? ""),
		body: request.body,
		...(headers["In-Reply-To"] ? { inReplyTo: headers["In-Reply-To"] } : {}),
		...(headers.References ? { references: headers.References.split(" ") } : {}),
	};
}

/**
 * Build the submission payload for a forward.
 *
 * A forward starts its own conversation: the subject is `Fwd:`-prefixed and NO
 * threading headers are carried (the reply chain must not absorb it).
 */
export function buildForwardSendInput(original: EmailView, request: ForwardRequest): SendInput {
	const selected = new Set(request.attachmentBlobIds ?? []);
	// Only blobs the original actually carries may be forwarded, and each keeps
	// its owned-mailbox identity so the guard can re-check it downstream.
	const mailboxId = original.mailboxIds?.[0] ?? "";
	const attachments = (original.attachments ?? [])
		.filter((a) => selected.has(a.blobId))
		.map((a) => ({ blobId: a.blobId, mailboxId, size: a.size }));
	return {
		mailboxId,
		from: request.from,
		to: request.to,
		subject: forwardSubject(original.subject ?? ""),
		body: request.body,
		attachments,
	};
}
