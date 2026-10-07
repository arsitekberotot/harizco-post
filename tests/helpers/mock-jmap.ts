// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// A programmable mock JMAP server for contract tests.
//
// Real Stalwart is not required to test the adapter contract. This mock speaks
// enough of the JMAP session + API shape to exercise discovery, mapping, and
// error handling. It deliberately preserves upstream quirks that the adapter
// must correct for (e.g. system folder roles must come from `role`, not names).

export interface MockEmail {
	id: string;
	threadId: string;
	mailboxIds: Record<string, true>;
	keywords: Record<string, true>;
	subject: string;
	from: { name?: string; email: string }[];
	to: { name?: string; email: string }[];
	receivedAt: string;
	preview: string;
	bodyValues?: Record<string, { value: string }>;
	textBody?: unknown[];
	htmlBody?: unknown[];
	hasAttachment: boolean;
	messageId?: string[];
	inReplyTo?: string[];
	references?: string[];
}

export interface MockMailbox {
	id: string;
	name: string;
	role: string | null;
	totalEmails: number;
	unreadEmails: number;
}

export interface MockJmapState {
	mailboxes: MockMailbox[];
	emails: MockEmail[];
	accountId: string;
	/** Set to force the next method call to fail with the given type. */
	failNextWith: { type: string; status?: number } | null;
	/** Recorded (methodName) calls, for asserting scoping/round-trips. */
	calls: string[];
}

export function createMockJmap(overrides: Partial<MockJmapState> = {}): MockJmapState {
	return {
		accountId: "b-account-1",
		mailboxes: [
			{ id: "mb-inbox", name: "Inbox", role: "inbox", totalEmails: 2, unreadEmails: 1 },
			{ id: "mb-drafts", name: "Drafts", role: "drafts", totalEmails: 1, unreadEmails: 0 },
			{ id: "mb-sent", name: "Sent", role: "sent", totalEmails: 1, unreadEmails: 0 },
			{ id: "mb-trash", name: "Trash", role: "trash", totalEmails: 0, unreadEmails: 0 },
			{ id: "mb-projects", name: "Projects", role: null, totalEmails: 0, unreadEmails: 0 },
		],
		emails: [
			{
				id: "e-1",
				threadId: "t-1",
				mailboxIds: { "mb-inbox": true },
				keywords: { $seen: true },
				subject: "Welcome to Harizco Post",
				from: [{ name: "Sender", email: "sender@example.com" }],
				to: [{ email: "hanif@atelieriza.com" }],
				receivedAt: "2026-10-01T10:00:00Z",
				preview: "Welcome...",
				hasAttachment: false,
				messageId: ["<m-1@example.com>"],
			},
			{
				id: "e-2",
				threadId: "t-2",
				mailboxIds: { "mb-inbox": true },
				keywords: {},
				subject: "Invoice with attachment",
				from: [{ email: "billing@example.com" }],
				to: [{ email: "hanif@atelieriza.com" }],
				receivedAt: "2026-10-02T11:00:00Z",
				preview: "Please find...",
				hasAttachment: true,
				messageId: ["<m-2@example.com>"],
			},
			{
				id: "e-draft",
				threadId: "t-draft",
				mailboxIds: { "mb-drafts": true },
				keywords: { $draft: true },
				subject: "Unfinished reply",
				from: [{ email: "hanif@atelieriza.com" }],
				to: [],
				receivedAt: "2026-10-03T09:00:00Z",
				preview: "Draft body",
				hasAttachment: false,
			},
		],
		failNextWith: null,
		calls: [],
		...overrides,
	};
}

/**
 * Minimal fake fetch that answers JMAP session discovery and API calls.
 * Returns { fetch, state } so tests can mutate state between requests.
 */
export function mockJmapFetch(state: MockJmapState, opts: { origin?: string } = {}) {
	const origin = opts.origin ?? "http://127.0.0.1:8080";
	const authed: boolean[] = [];

	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const auth = new Headers(init?.headers ?? {}).get("authorization") ?? "";
		const isAuthed = auth.startsWith("Bearer ") && auth.length > "Bearer ".length;
		authed.push(isAuthed);

		if (url.endsWith("/.well-known/jmap")) {
			if (!isAuthed) return new Response("unauthorized", { status: 401 });
			return Response.json({
				capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} },
				accounts: {
					[state.accountId]: {
						name: "hanif@atelieriza.com",
						isPersonal: true,
						accountCapabilities: { "urn:ietf:params:jmap:mail": {} },
					},
				},
				primaryAccounts: { "urn:ietf:params:jmap:mail": state.accountId },
				apiUrl: `${origin}/jmap`,
				downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
				uploadUrl: `${origin}/jmap/upload/{accountId}/`,
				eventSourceUrl: `${origin}/jmap/event`,
				state: "session-state-1",
			});
		}

		if (url.endsWith("/jmap")) {
			if (!isAuthed) return new Response("unauthorized", { status: 401 });
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				methodCalls: [string, Record<string, unknown>, string][];
			};

			if (state.failNextWith) {
				const failure = state.failNextWith;
				state.failNextWith = null;
				return Response.json({
					methodResponses: [
						[
							"error",
							{ type: failure.type, description: `forced ${failure.type}` },
							body.methodCalls[0]?.[2] ?? "c0",
						],
					],
				}, { status: failure.status ?? 200 });
			}

			const responses = body.methodCalls.map(([name, args, tag]) => {
				state.calls.push(name);
				switch (name) {
					case "Mailbox/get":
						return [name, { accountId: state.accountId, state: "s1", list: state.mailboxes, notFound: [] }, tag];
					case "Email/query": {
						const mailboxFilter = (args.filter as { inMailbox?: string } | undefined)?.inMailbox;
						const matching = mailboxFilter
							? state.emails.filter((e) => e.mailboxIds[mailboxFilter])
							: state.emails;
						const allIds = matching.map((e) => e.id);
						const limit = typeof args.limit === "number" ? args.limit : allIds.length;
						const position = typeof args.position === "number" ? args.position : 0;
						const ids = allIds.slice(position, position + limit);
						return [
							name,
							{ accountId: state.accountId, queryState: "q1", canCalculateChanges: false, position, ids, total: allIds.length },
							tag,
						];
					}
					case "Email/get": {
						const wanted = (args.ids as string[] | null) ?? state.emails.map((e) => e.id);
						const list = state.emails.filter((e) => wanted.includes(e.id));
						return [name, { accountId: state.accountId, state: "s1", list, notFound: [] }, tag];
					}
					case "Thread/get":
						return [name, { accountId: state.accountId, state: "s1", list: [], notFound: [] }, tag];
					default:
						return [name, { accountId: state.accountId }, tag];
				}
			});
			return Response.json({ methodResponses: responses, sessionState: "session-state-1" });
		}

		return new Response("not found", { status: 404 });
	};

	return { fetch: fetchImpl, authedCalls: authed };
}
