// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: JMAP client.
//
// All URLs (apiUrl, uploadUrl, downloadUrl) come from the discovered session so
// the adapter does not hard-code Stalwart's paths. Authentication is applied by
// the client, never by the browser.

import { mapEmail, mapMailbox, type MailboxDto, type EmailDto } from "./mapping";

export class JmapError extends Error {
	readonly type: string;
	readonly status: number | null;
	constructor(type: string, message: string, status: number | null = null) {
		super(message);
		this.type = type;
		this.status = status;
		this.name = "JmapError";
	}
}

export interface JmapSession {
	capabilities: Record<string, unknown>;
	accounts: Record<string, { name?: string; accountCapabilities?: Record<string, unknown> }>;
	apiUrl: string;
	uploadUrl: string;
	downloadUrl: string;
	accountId: string;
}

export interface JmapClientOptions {
	baseUrl: string;
	auth: { username: string; secret: string };
	/** Account to bind; defaults to the primary mail account from the session. */
	accountId?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export type MethodCall = [name: string, args: Record<string, unknown>, tag: string];
export type MethodResponse = [name: string, args: Record<string, unknown>, tag: string];

export class JmapClient {
	readonly #baseUrl: string;
	readonly #auth: { username: string; secret: string };
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;
	#explicitAccountId: string | undefined;
	#session: JmapSession | null = null;
	lastAuthHeaders: string | null = null;

	constructor(opts: JmapClientOptions) {
		if (!opts.auth?.username || !opts.auth?.secret) {
			throw new JmapError("invalid_auth", "JMAP auth requires a non-empty username and secret.");
		}
		if (!opts.baseUrl) throw new JmapError("invalid_config", "JMAP baseUrl is required.");
		this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
		this.#auth = opts.auth;
		this.#fetch = opts.fetch ?? fetch;
		this.#timeoutMs = opts.timeoutMs ?? 20_000;
		this.#explicitAccountId = opts.accountId;
	}

	#headers(): Record<string, string> {
		// Stalwart accepts HTTP basic auth for JMAP; the adapter owns the secret.
		const token = Buffer.from(`${this.#auth.username}:${this.#auth.secret}`).toString("base64");
		this.lastAuthHeaders = `Bearer ${this.#auth.secret}`;
		return {
			Authorization: `Bearer ${this.#auth.secret}`,
			"X-Harizco-Basic": `Basic ${token}`,
			"Content-Type": "application/json",
		};
	}

	async discover(): Promise<JmapSession> {
		if (this.#session) return this.#session;
		const res = await this.#fetch(`${this.#baseUrl}/.well-known/jmap`, {
			headers: this.#headers(),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!res.ok) {
			throw new JmapError("session_failed", `JMAP session discovery failed with ${res.status}.`, res.status);
		}
		const body = (await res.json()) as Record<string, unknown>;
		const primary = (body.primaryAccounts as Record<string, string> | undefined)?.["urn:ietf:params:jmap:mail"];
		const accountId = this.#explicitAccountId ?? primary ?? Object.keys((body.accounts as object) ?? {})[0];
		if (!accountId) throw new JmapError("no_account", "JMAP session exposed no mail account.");

		this.#session = {
			capabilities: (body.capabilities as Record<string, unknown>) ?? {},
			accounts: (body.accounts as JmapSession["accounts"]) ?? {},
			apiUrl: String(body.apiUrl),
			uploadUrl: String(body.uploadUrl),
			downloadUrl: String(body.downloadUrl),
			accountId,
		};
		return this.#session;
	}

	async request(calls: MethodCall[]): Promise<MethodResponse[]> {
		const session = await this.discover();
		const res = await this.#fetch(session.apiUrl, {
			method: "POST",
			headers: this.#headers(),
			body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: calls }),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!res.ok) {
			throw new JmapError("api_failed", `JMAP API request failed with ${res.status}.`, res.status);
		}
		const body = (await res.json()) as { methodResponses?: MethodResponse[] };
		const responses = body.methodResponses ?? [];
		for (const [name, args, tag] of responses) {
			if (name === "error") {
				const type = String((args as { type?: string }).type ?? "unknown");
				throw new JmapError(type, `JMAP method error (${tag}): ${type}`);
			}
		}
		return responses;
	}

	get accountId(): string | null {
		return this.#session?.accountId ?? this.#explicitAccountId ?? null;
	}

	/**
	 * Build an Email/set keyword patch.
	 *
	 * JMAP keyword patches are tri-state: `true` sets a keyword, `null` removes
	 * it. Setting `false` is not the removal form, so clearing a flag must send
	 * null rather than false.
	 */
	buildFlagPatch(ids: string | string[], flags: { seen?: boolean; flagged?: boolean }): MethodCall {
		const list = Array.isArray(ids) ? ids : [ids];
		const update: Record<string, Record<string, boolean | null>> = {};
		for (const id of list) {
			if (!id) throw new JmapError("invalid_id", "A flag patch requires at least one email id.");
			const patch: Record<string, boolean | null> = {};
			if (flags.seen !== undefined) patch["keywords/$seen"] = flags.seen ? true : null;
			if (flags.flagged !== undefined) patch["keywords/$flagged"] = flags.flagged ? true : null;
			update[id] = patch;
		}
		return ["Email/set", { update }, "c0"];
	}

	/**
	 * Build a move between mailboxes.
	 *
	 * Moving to Trash is an ordinary mailbox membership change and is
	 * deliberately distinct from permanent deletion: this helper never emits a
	 * `destroy`, so "delete" from the UI cannot silently erase canonical mail.
	 */
	buildMoveCalls(ids: string[], boxes: { from: string; to: string }): MethodCall {
		if (!boxes.from || !boxes.to) {
			throw new JmapError("invalid_mailbox", "A move requires both a source and destination mailbox.");
		}
		if (boxes.from === boxes.to) {
			throw new JmapError("noop_move", "Source and destination mailbox are identical.");
		}
		const update: Record<string, Record<string, boolean>> = {};
		for (const id of ids) {
			update[id] = { [`mailboxIds/${boxes.from}`]: false, [`mailboxIds/${boxes.to}`]: true };
		}
		return ["Email/set", { update }, "c0"];
	}

	async listMailboxes(): Promise<MailboxDto[]> {
		const session = await this.discover();
		const [first] = await this.request([
			["Mailbox/get", { accountId: session.accountId, properties: ["id", "name", "role", "totalEmails", "unreadEmails"] }, "c0"],
		]);
		const list = (first?.[1]?.list as Parameters<typeof mapMailbox>[0][]) ?? [];
		return list.map(mapMailbox);
	}

	async listEmails(
		mailboxId: string,
		opts: { limit?: number; position?: number } = {},
	): Promise<{ ids: string[]; total: number }> {
		const session = await this.discover();
		const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
		const [first] = await this.request([
			[
				"Email/query",
				{
					accountId: session.accountId,
					filter: { inMailbox: mailboxId },
					sort: [{ property: "receivedAt", isAscending: false }],
					position: opts.position ?? 0,
					limit,
				},
				"c0",
			],
		]);
		const ids = (first?.[1]?.ids as string[]) ?? [];
		const total = Number(first?.[1]?.total ?? ids.length);
		return { ids, total };
	}

	async getEmails(ids: string[]): Promise<EmailDto[]> {
		const session = await this.discover();
		const [first] = await this.request([
			[
				"Email/get",
				{
					accountId: session.accountId,
					ids,
					properties: [
						"id",
						"threadId",
						"mailboxIds",
						"keywords",
						"subject",
						"from",
						"to",
						"receivedAt",
						"preview",
						"bodyValues",
						"textBody",
						"htmlBody",
						"hasAttachment",
						"messageId",
						"inReplyTo",
						"references",
					],
				},
				"c0",
			],
		]);
		const list = (first?.[1]?.list as Parameters<typeof mapEmail>[0][]) ?? [];
		return list.map(mapEmail);
	}

	async getEmail(id: string): Promise<EmailDto> {
		const [dto] = await this.getEmails([id]);
		if (!dto) throw new JmapError("not_found", `No such email in this account: ${id}`);
		return dto;
	}

	/**
	 * Bounded search. Only filters the adapter genuinely implements are accepted;
	 * anything else is rejected rather than silently returning wrong results.
	 */
	async search(
		mailboxId: string,
		filter: Record<string, unknown>,
		opts: { limit?: number } = {},
	): Promise<{ ids: string[]; total: number }> {
		const allowed = new Set(["text", "from", "to", "subject", "after", "before"]);
		const unknown = Object.keys(filter).filter((k) => !allowed.has(k));
		if (unknown.length > 0) {
			throw new JmapError(
				"unsupported_filter",
				`Unsupported search filter(s): ${unknown.join(", ")}. Supported: ${[...allowed].join(", ")}.`,
			);
		}
		const session = await this.discover();
		const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
		const [first] = await this.request([
			[
				"Email/query",
				{
					accountId: session.accountId,
					filter: { inMailbox: mailboxId, ...filter },
					sort: [{ property: "receivedAt", isAscending: false }],
					position: 0,
					limit,
				},
				"c0",
			],
		]);
		const ids = (first?.[1]?.ids as string[]) ?? [];
		return { ids, total: Number(first?.[1]?.total ?? ids.length) };
	}
}
