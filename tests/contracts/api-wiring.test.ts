// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Phase 2 wiring contract: the compatibility API must be reachable through a
// MailBackend seam. Until the wiring lands, these tests are RED because
// server/app.ts only serves /health and denies every private route.

import { beforeEach, describe, expect, test } from "vitest";
import { createTestApp } from "../helpers/app";
import type {
	MailBackend,
	MailboxView,
	EmailView,
	EmailListResult,
	SearchResult,
	FlagInput,
	DraftInput,
	FolderMutationInput,
} from "../../server/mail/backend";

/** In-memory backend used to prove routes forward faithfully to a backend. */
function fakeBackend(): MailBackend & { calls: string[] } {
	const calls: string[] = [];
	const mailboxes: MailboxView[] = [
		{ id: "mb-inbox", name: "Inbox", systemRole: "inbox", totalEmails: 3, unreadEmails: 1 },
		{ id: "mb-sent", name: "Sent", systemRole: "sent", totalEmails: 1, unreadEmails: 0 },
	];
	const emails: EmailView[] = [
		{
			id: "e-1",
			threadId: "t-1",
			mailboxIds: ["mb-inbox"],
			unread: true,
			starred: false,
			draft: false,
			subject: "Hello",
			from: [{ email: "sender@example.test" }],
			to: [{ email: "owner@example.invalid" }],
			receivedAt: "2026-10-07T05:00:00Z",
			preview: "hi",
			hasAttachment: false,
			messageId: "<m1@example.test>",
			inReplyTo: [],
			references: [],
		},
	];

	const backend: MailBackend & { calls: string[] } = {
		calls,
		async listMailboxes(): Promise<MailboxView[]> {
			calls.push("listMailboxes");
			return mailboxes;
		},
		async getMailbox(id: string): Promise<MailboxView | null> {
			calls.push(`getMailbox:${id}`);
			return mailboxes.find((m) => m.id === id) ?? null;
		},
		async listEmails(mailboxId: string): Promise<EmailListResult> {
			calls.push(`listEmails:${mailboxId}`);
			return { emails: emails.filter((e) => e.mailboxIds.includes(mailboxId)), total: 1 };
		},
		async getEmail(id: string): Promise<EmailView | null> {
			calls.push(`getEmail:${id}`);
			return emails.find((e) => e.id === id) ?? null;
		},
		async search(mailboxId: string, filter: Record<string, unknown>): Promise<SearchResult> {
			calls.push(`search:${mailboxId}:${JSON.stringify(filter)}`);
			return { emailIds: ["e-1"], total: 1 };
		},
		async setFlags(ids: string[], _flags: FlagInput): Promise<{ updated: string[] }> {
			calls.push(`setFlags:${ids.join(",")}:${JSON.stringify(_flags)}`);
			return { updated: ids };
		},
		async setThreadRead(mailboxId: string, ids: string[], read: boolean): Promise<{ updated: string[] }> {
			calls.push(`setThreadRead:${mailboxId}:${ids.join(",")}:${read}`);
			return { updated: ids };
		},
		async move(ids: string[], from: string, to: string): Promise<{ updated: string[] }> {
			calls.push(`move:${ids.join(",")}:${from}->${to}`);
			return { updated: ids };
		},
		async createDraft(input: DraftInput): Promise<{ draftId: string }> {
			calls.push(`createDraft:${input.subject}`);
			return { draftId: "d-new" };
		},
		async createFolder(input: FolderMutationInput): Promise<{ id: string }> {
			calls.push(`createFolder:${input.name}`);
			return { id: "f-new" };
		},
		async renameFolder(id: string, name: string): Promise<{ updated: string }> {
			calls.push(`renameFolder:${id}:${name}`);
			return { updated: id };
		},
		async deleteFolder(id: string, moveTo: string): Promise<{ updated: string }> {
			calls.push(`deleteFolder:${id}->${moveTo}`);
			return { updated: id };
		},
		async health(): Promise<{ ok: boolean }> {
			calls.push("health");
			return { ok: true };
		},
	};
	return backend;
}

describe("Phase 2: compatibility API forwards to the MailBackend", () => {
	let backend: ReturnType<typeof fakeBackend>;

	beforeEach(() => {
		backend = fakeBackend();
	});

	test("GET /api/v1/config returns the caller's configured addresses", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/config");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { domains: string[]; emailAddresses: string[] };
		expect(Array.isArray(body.domains)).toBe(true);
		expect(Array.isArray(body.emailAddresses)).toBe(true);
	});

	test("GET /api/v1/mailboxes lists mapped mailboxes", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/mailboxes");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string }[];
		expect(body.map((m) => m.id)).toEqual(["mb-inbox", "mb-sent"]);
		expect(backend.calls).toContain("listMailboxes");
	});

	test("GET /api/v1/mailboxes/:id/emails lists scoped messages", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/mailboxes/mb-inbox/emails");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { emails: { id: string }[]; total: number };
		expect(body.emails.map((e) => e.id)).toEqual(["e-1"]);
		expect(backend.calls).toContain("listEmails:mb-inbox");
	});

	test("GET /api/v1/mailboxes/:id/emails/:emailId returns one message", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/mailboxes/mb-inbox/emails/e-1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string };
		expect(body.id).toBe("e-1");
	});

	test("unknown email id yields a JSON 404, not a fabricated message", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/mailboxes/mb-inbox/emails/nope");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type") ?? "").toMatch(/json/i);
	});

	test("PATCH flags forwards a tri-state flag patch", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/mailboxes/mb-inbox/emails/e-1", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ unread: false, starred: true }),
		});
		expect(res.status).toBe(200);
		expect(backend.calls.some((c) => c.startsWith("setFlags:e-1"))).toBe(true);
	});

	test("POST move requires a destination mailbox", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const ok = await app.request("/api/v1/mailboxes/mb-inbox/emails/e-1/move", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mailboxId: "mb-sent" }),
		});
		expect(ok.status).toBe(200);
		expect(backend.calls).toContain("move:e-1:mb-inbox->mb-sent");

		const bad = await app.request("/api/v1/mailboxes/mb-inbox/emails/e-1/move", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(bad.status).toBe(400);
	});

	test("POST drafts returns the client draft_id contract", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/mailboxes/mb-inbox/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subject: "Draft one", body: "hello" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { draft_id: string };
		expect(body.draft_id).toBe("d-new");
	});

	test("a backend failure surfaces as 502, never a silent 200", async () => {
		const failing = fakeBackend();
		failing.listMailboxes = async () => {
			throw new Error("jmap down at internal-host:8080");
		};
		const { app } = createTestApp({ authMode: "fixture", backend: failing });
		const res = await app.request("/api/v1/mailboxes");
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBeTruthy();
		expect(JSON.stringify(body)).not.toMatch(/internal-host/);
	});

	test("private API responses are never cached", async () => {
		const { app } = createTestApp({ authMode: "fixture", backend });
		const res = await app.request("/api/v1/mailboxes");
		expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/i);
	});
});
