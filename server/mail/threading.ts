// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: outbound submission helpers.
//
// These rules are the ones that keep a mailbox from being used as an open relay
// and keep replies attached to their conversation:
//   - the From address must match an owned mailbox exactly (no spoofing);
//   - a reply carries In-Reply-To/References so it threads with the original;
//   - a forward starts a fresh thread rather than masquerading as a reply.
//
// They are pure functions so the policy is unit-testable without a provider.

/** Raised when an outbound message would send as an address we do not own. */
export class SenderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderValidationError";
	}
}

export type AddressInput = string | { email: string; name?: string };

/** Strip surrounding angle brackets from an RFC 5322 message id. */
function bareMessageId(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * Extract the bare email address from `"Name <user@host>"`, `"user@host"`, or
 * `{ email, name }`. Returns the lower-cased address so ownership comparison is
 * case-insensitive without rewriting the displayed sender.
 */
export function extractEmail(value: AddressInput): string {
	const raw = typeof value === "string" ? value : value.email;
	const trimmed = raw.trim();
	const angled = trimmed.match(/<([^>]+)>/);
	return (angled ? angled[1] : trimmed).trim().toLowerCase();
}

/** Lower-case, trim, and drop blanks from a possibly-array address field. */
export function normalizeAddressList(value: AddressInput | AddressInput[] | undefined | null): string[] {
	if (value === undefined || value === null) return [];
	const list = Array.isArray(value) ? value : [value];
	return list
		.map((entry) => extractEmail(entry))
		.filter((entry) => entry !== "");
}

export interface SenderValidation {
	to: string[];
	toHeader: string;
	fromEmail: string;
	fromDisplay: string;
	fromDomain: string;
}

/**
 * Normalize recipients and assert the sender owns the mailbox.
 *
 * @throws SenderValidationError when `from` does not equal the mailbox address,
 * or the address has no domain. Never falls back to the mailbox address: that
 * would silently rewrite an attempt to spoof a different sender.
 */
export function validateSender(
	to: AddressInput | AddressInput[],
	from: AddressInput,
	mailboxAddress: string,
): SenderValidation {
	const toList = normalizeAddressList(to);
	// Accept both "user@host" and "Name <user@host>" forms; never treat a
	// display-name wrapper as part of the address (that would false-reject a
	// legitimate send and weaken the ownership check).
	const fromEmail = extractEmail(from);
	const fromDisplay = typeof from === "string" ? from : (from.name ?? from.email);

	if (fromEmail === "") {
		throw new SenderValidationError("A From address is required");
	}
	if (fromEmail !== mailboxAddress.trim().toLowerCase()) {
		throw new SenderValidationError("From address must match the mailbox email address");
	}

	const at = fromEmail.lastIndexOf("@");
	const fromDomain = at >= 0 ? fromEmail.slice(at + 1) : "";
	if (!fromDomain) {
		throw new SenderValidationError("Invalid sender email address");
	}

	return {
		to: toList,
		toHeader: toList.join(", "),
		fromEmail,
		fromDisplay,
		fromDomain,
	};
}

export interface GeneratedMessageId {
	/** Internal, opaque id (also the stored message id). */
	id: string;
	/** RFC 2822 Message-ID value (without angle brackets). */
	outgoingMessageId: string;
}

/** Generate a unique internal id and a domain-qualified Message-ID. */
export function generateMessageId(fromDomain: string, makeId: () => string = defaultId): GeneratedMessageId {
	const id = makeId();
	return { id, outgoingMessageId: `${id}@${fromDomain}` };
}

function defaultId(): string {
	return globalThis.crypto.randomUUID();
}

/** The subset of a stored message needed to thread a reply. */
export interface ThreadableMessage {
	id: string;
	messageId?: string | null;
	threadId?: string | null;
	references?: string[] | null;
}

export interface ReferenceChain {
	originalMessageId: string;
	references: string[];
	threadId: string;
}

/**
 * Build the References chain for a reply: existing references plus the id of
 * the message being replied to, with the thread pinned to the original thread.
 */
export function buildReferencesChain(original: ThreadableMessage): ReferenceChain {
	const originalMessageId = bareMessageId(original.messageId ?? original.id);
	const existing = (original.references ?? [])
		.filter((r): r is string => typeof r === "string" && r !== "")
		.map(bareMessageId);
	const references = dedupe([...existing, originalMessageId].filter((r) => r !== ""));
	const threadId = (original.threadId ?? original.id).trim();
	return { originalMessageId, references, threadId };
}

/** Headers that make a reply thread with its original. */
export function buildThreadingHeaders(
	originalMessageId: string,
	references: readonly string[],
): Record<string, string> {
	const headers: Record<string, string> = {};
	if (originalMessageId) headers["In-Reply-To"] = `<${originalMessageId}>`;
	const refs = dedupe(references.filter((r) => r !== ""));
	if (refs.length > 0) headers.References = refs.map((r) => `<${r}>`).join(" ");
	return headers;
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

/** A reply quoting an original subject ("Re: …", never "Re: Re: …"). */
export function replySubject(subject: string): string {
	const trimmed = subject.trim();
	if (/^re:/i.test(trimmed)) return trimmed;
	return trimmed === "" ? "Re:" : `Re: ${trimmed}`;
}

/** A forward subject ("Fwd: …", never doubled). */
export function forwardSubject(subject: string): string {
	const trimmed = subject.trim();
	if (/^fwd?:/i.test(trimmed)) return trimmed;
	return trimmed === "" ? "Fwd:" : `Fwd: ${trimmed}`;
}

export interface ReplyAllInput {
	/** The owned mailbox address; always removed from every recipient list. */
	mailboxAddress: string;
	originalFrom?: AddressInput | AddressInput[] | null;
	originalTo?: AddressInput | AddressInput[] | null;
	originalCc?: AddressInput | AddressInput[] | null;
}

export interface ReplyAllRecipients {
	to: string[];
	cc: string[];
	toHeader: string;
	ccHeader: string;
}

/**
 * Reply-all recipient set: the original sender plus everyone who was on To or
 * Cc, minus our own address, de-duplicated and case-normalized.
 *
 * The original sender moves to `to`; the remaining To/Cc addresses become `cc`.
 * Our own address is stripped from both lists so a reply-all never loops back to
 * the mailbox that sent it.
 */
export function computeReplyAll(input: ReplyAllInput): ReplyAllRecipients {
	const owner = input.mailboxAddress.trim().toLowerCase();
	const from = normalizeAddressList(input.originalFrom).filter((a) => a !== owner);
	const to = normalizeAddressList(input.originalTo).filter((a) => a !== owner);
	const cc = normalizeAddressList(input.originalCc).filter((a) => a !== owner);

	// Sender first, then the other To recipients; drop anyone already in `to`
	// from `cc` so the same address is never addressed twice.
	const primary = dedupe([...from, ...to]);
	const primarySet = new Set(primary);
	const secondary = dedupe(cc.filter((a) => !primarySet.has(a)));

	return {
		to: primary,
		cc: secondary,
		toHeader: primary.join(", "),
		ccHeader: secondary.join(", "),
	};
}

export interface ForwardInput {
	fromEmail: string;
	to: AddressInput | AddressInput[];
	subject: string;
	original: ThreadableMessage;
}

export interface ForwardPlan {
	to: string[];
	toHeader: string;
	subject: string;
	/** A forward starts a fresh thread: no In-Reply-To/References. */
	headers: Record<string, string>;
	/** A brand-new thread id, distinct from the original message's thread. */
	threadId: string;
}

/**
 * Build a forward plan. A forward must NOT thread with the original: it starts
 * its own conversation, so there are no threading headers and the thread id is
 * fresh (never the original's thread id).
 */
export function buildForward(input: ForwardInput, makeThreadId: () => string = defaultId): ForwardPlan {
	const to = normalizeAddressList(input.to);
	const originalThreadId = (input.original.threadId ?? input.original.id).trim();
	let threadId = makeThreadId();
	if (threadId === originalThreadId) threadId = `${threadId}-fwd`;

	return {
		to,
		toHeader: to.join(", "),
		subject: forwardSubject(input.subject),
		headers: {},
		threadId,
	};
}
