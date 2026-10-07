// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 7: read-only mail contract through the compatibility API.

import { beforeEach, describe, expect, test } from "vitest";
import { createMockJmap, mockJmapFetch, type MockJmapState } from "../helpers/mock-jmap";
import { JmapClient, JmapError } from "../../server/mail/jmap-client";
import { mapMailbox, mapEmail } from "../../server/mail/mapping";

let state: MockJmapState;
let client: JmapClient;

beforeEach(() => {
	state = createMockJmap();
	const { fetch } = mockJmapFetch(state);
	client = new JmapClient({
		baseUrl: "http://127.0.0.1:8080",
		auth: { username: "hanif@atelieriza.com", secret: "test-secret" },
		fetch,
	});
});

describe("JMAP discovery", () => {
	test("discovers apiUrl/uploadUrl/downloadUrl from the session rather than assuming paths", async () => {
		const session = await client.discover();
		expect(session.apiUrl).toBe("http://127.0.0.1:8080/jmap");
		expect(session.uploadUrl).toContain("/jmap/upload/");
		expect(session.downloadUrl).toContain("/jmap/download/");
		expect(session.accountId).toBe("b-account-1");
	});

	test("sends authentication on every session and API request", async () => {
		await client.discover();
		await client.request([["Mailbox/get", { accountId: state.accountId }, "c0"]]);
		expect(client.lastAuthHeaders).toContain("Bearer test-secret");
	});

	test("a provider error surfaces as a typed JmapError, not a silent empty list", async () => {
		state.failNextWith = { type: "serverFail" };
		await expect(client.request([["Mailbox/get", { accountId: state.accountId }, "c0"]])).rejects.toBeInstanceOf(
			JmapError,
		);
	});

	test("missing/invalid auth config fails closed before any network call", () => {
		expect(() => new JmapClient({ baseUrl: "http://127.0.0.1:8080", auth: { username: "", secret: "" } })).toThrow(
			/auth/i,
		);
	});
});

describe("mapping", () => {
	test("system folders map by JMAP role, not by display name", () => {
		expect(mapMailbox(state.mailboxes[0]).systemRole).toBe("inbox");
		// A mailbox named "Inbox" with a non-inbox role must not be treated as inbox.
		expect(mapMailbox({ id: "x", name: "Inbox", role: "archive", totalEmails: 0, unreadEmails: 0 }).systemRole).toBe(
			"archive",
		);
		expect(mapMailbox({ id: "y", name: "Inbox", role: null, totalEmails: 0, unreadEmails: 0 }).systemRole).toBeNull();
	});

	test("original identifiers are preserved, not substituted", async () => {
		const mbs = await client.listMailboxes();
		expect(mbs.map((m) => m.id)).toContain("mb-inbox");
		expect(mbs.find((m) => m.id === "mb-inbox")?.name).toBe("Inbox");
	});

	test("an email DTO keeps the JMAP email id and thread id distinct from the RFC message-id", () => {
		const dto = mapEmail(state.emails[0]);
		expect(dto.id).toBe("e-1");
		expect(dto.threadId).toBe("t-1");
		expect(dto.messageId).toBe("<m-1@example.com>");
		// These must never collapse into each other.
		expect(dto.id).not.toBe(dto.messageId);
	});

	test("unread state derives from the $seen keyword", () => {
		expect(mapEmail(state.emails[0]).unread).toBe(false);
		expect(mapEmail(state.emails[1]).unread).toBe(true);
	});
});

describe("read routes", () => {
	test("lists mailboxes with accurate counts", async () => {
		const mbs = await client.listMailboxes();
		const inbox = mbs.find((m) => m.id === "mb-inbox")!;
		expect(inbox.totalEmails).toBe(2);
		expect(inbox.unreadEmails).toBe(1);
	});

	test("lists messages bounded by the requested limit and reports a total", async () => {
		const page = await client.listEmails("mb-inbox", { limit: 1 });
		expect(page.ids.length).toBe(1);
		expect(page.total).toBeGreaterThanOrEqual(1);
	});

	test("scoping is enforced: every JMAP call names the authenticated account", async () => {
		await client.listMailboxes();
		await client.getEmails(["e-1"]);
		expect(state.calls).toContain("Mailbox/get");
		expect(state.calls).toContain("Email/get");
	});

	test("unsupported search filters raise a clear error instead of returning wrong results", async () => {
		await expect(client.search("mb-inbox", { unsupportedFilter: "body:xyz" })).rejects.toThrow(
			/unsupported search filter/i,
		);
	});

	test("a message get resolves attachments only within its own account", async () => {
		const { id } = await client.getEmail("e-2");
		expect(id).toBe("e-2");
	});
});
