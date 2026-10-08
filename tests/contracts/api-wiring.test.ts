// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Phase 2 wiring contract: the compatibility API must be reachable through a
// MailBackend seam. Until the wiring lands, these tests are RED because
// server/app.ts only serves /health and denies every private route.

import { beforeEach, describe, expect, test } from "vitest";
import { openJournal } from "../../server/db/index";
import { MailboxRegistry } from "../../server/mailboxes/registry";
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
	SendInput,
	SendResult,
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
			cc: [],
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
		async sendEmail(input: SendInput): Promise<SendResult> {
			calls.push(`sendEmail:${input.subject ?? ""}`);
			return { requestId: "req-wiring", state: "queued" };
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

	test("multi-account mode lists only configured identities, not JMAP folders", async () => {
		const hanif = fakeBackend();
		const natla = fakeBackend();
		const { app } = createTestApp({
			authMode: "fixture",
				addresses: { domains: ["atelieriza.com"], emailAddresses: ["hanif@atelieriza.com", "natla@atelieriza.com"] },
				mailboxBackends: new Map([["hanif@atelieriza.com", hanif], ["natla@atelieriza.com", natla]]),
		});
		const res = await app.request("/api/v1/mailboxes");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([
			{ id: "hanif@atelieriza.com", email: "hanif@atelieriza.com", name: "hanif" },
			{ id: "natla@atelieriza.com", email: "natla@atelieriza.com", name: "natla" },
		]);
		expect(hanif.calls).toEqual([]);
		expect(natla.calls).toEqual([]);
	});

	test("POST /api/v1/mailboxes activates only a pre-provisioned configured address", async () => {
		const db = openJournal(":memory:");
		const registry = new MailboxRegistry(db);
		registry.provision({ id: "mb-hanif", address: "hanif@atelieriza.com" });
		registry.bindAccount("mb-hanif", "acct-hanif");
		registry.setEnabled("mb-hanif", true);
		registry.provision({ id: "mb-natla", address: "natla@atelieriza.com" });
		registry.bindAccount("mb-natla", "acct-natla");
		const { app } = createTestApp({
			authMode: "fixture",
			addresses: { domains: ["atelieriza.com"], emailAddresses: ["hanif@atelieriza.com", "natla@atelieriza.com"] },
			mailboxBackends: new Map([["hanif@atelieriza.com", fakeBackend()], ["natla@atelieriza.com", fakeBackend()]]),
			mailboxRegistry: registry,
		});

		const before = await app.request("/api/v1/mailboxes");
		expect((await before.json()).map((mailbox: { email: string }) => mailbox.email)).toEqual(["hanif@atelieriza.com"]);
		const disabledAccess = await app.request("/api/v1/mailboxes/natla%40atelieriza.com");
		expect(disabledAccess.status).toBe(404);

		const res = await app.request("/api/v1/mailboxes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "natla@atelieriza.com", name: "Natla" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: "natla@atelieriza.com", email: "natla@atelieriza.com", name: "Natla" });
		expect(registry.getByAddress("natla@atelieriza.com")?.enabled).toBe(1);
		expect(registry.listAll()).toHaveLength(2);
		const after = await app.request("/api/v1/mailboxes");
		expect((await after.json()).map((mailbox: { email: string }) => mailbox.email).sort()).toEqual([
			"hanif@atelieriza.com",
			"natla@atelieriza.com",
		]);
		db.close();
	});

	test("DELETE /api/v1/mailboxes disables the registry binding without deleting it", async () => {
		const db = openJournal(":memory:");
		const registry = new MailboxRegistry(db);
		registry.provision({ id: "mb-hanif", address: "hanif@atelieriza.com" });
		registry.bindAccount("mb-hanif", "acct-hanif");
		registry.setEnabled("mb-hanif", true);
		const { app } = createTestApp({
			authMode: "fixture",
				addresses: { domains: ["atelieriza.com"], emailAddresses: ["hanif@atelieriza.com"] },
				mailboxBackends: new Map([["hanif@atelieriza.com", fakeBackend()]]),
				mailboxRegistry: registry,
		});

		const res = await app.request("/api/v1/mailboxes/hanif%40atelieriza.com", { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(registry.getByAddress("hanif@atelieriza.com")?.enabled).toBe(0);
		expect(registry.getById("mb-hanif")).toBeDefined();
		const list = await app.request("/api/v1/mailboxes");
		expect(await list.json()).toEqual([]);
		const inaccessible = await app.request("/api/v1/mailboxes/hanif%40atelieriza.com");
		expect(inaccessible.status).toBe(404);
		db.close();
	});

	test("POST refuses a configured identity without a pre-provisioned JMAP binding", async () => {
		const db = openJournal(":memory:");
		const registry = new MailboxRegistry(db);
		const { app } = createTestApp({
			authMode: "fixture",
			addresses: { domains: ["atelieriza.com"], emailAddresses: ["natla@atelieriza.com"] },
			mailboxBackends: new Map([["natla@atelieriza.com", fakeBackend()]]),
			mailboxRegistry: registry,
		});

		const res = await app.request("/api/v1/mailboxes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "natla@atelieriza.com", name: "Natla" }),
		});
		expect(res.status).toBe(404);
		expect(registry.listAll()).toEqual([]);
		db.close();
	});

	test("POST refuses an address not in the operator-configured address list", async () => {
		const db = openJournal(":memory:");
		const registry = new MailboxRegistry(db);
		registry.provision({ id: "mb-outsider", address: "outsider@atelieriza.com" });
		registry.bindAccount("mb-outsider", "acct-outsider");
		const { app } = createTestApp({
			authMode: "fixture",
			addresses: { domains: ["atelieriza.com"], emailAddresses: ["hanif@atelieriza.com"] },
			mailboxBackends: new Map([
				["hanif@atelieriza.com", fakeBackend()],
				["outsider@atelieriza.com", fakeBackend()],
			]),
			mailboxRegistry: registry,
		});

		const res = await app.request("/api/v1/mailboxes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "outsider@atelieriza.com", name: "Outsider" }),
		});
		expect(res.status).toBe(404);
		expect(registry.getByAddress("outsider@atelieriza.com")?.enabled).toBe(0);
		db.close();
	});

	test("multi-account requests use only the selected account backend and folder query", async () => {
		const hanif = fakeBackend();
		const natla = fakeBackend();
		const { app } = createTestApp({
			authMode: "fixture",
				addresses: { domains: ["atelieriza.com"], emailAddresses: ["hanif@atelieriza.com", "natla@atelieriza.com"] },
				mailboxBackends: new Map([["hanif@atelieriza.com", hanif], ["natla@atelieriza.com", natla]]),
		});
		const folderRes = await app.request("/api/v1/mailboxes/natla%40atelieriza.com/folders");
		expect(folderRes.status).toBe(200);
		expect(natla.calls).toContain("listMailboxes");
		expect(hanif.calls).not.toContain("listMailboxes");

		const emailsRes = await app.request("/api/v1/mailboxes/natla%40atelieriza.com/emails?folder=mb-inbox");
		expect(emailsRes.status).toBe(200);
		expect(natla.calls).toContain("listEmails:mb-inbox");
		expect(hanif.calls.some((call) => call.startsWith("listEmails:"))).toBe(false);
	});

	test("multi-account mode fails closed for an unconfigured address", async () => {
		const hanif = fakeBackend();
		const { app } = createTestApp({
			authMode: "fixture",
				addresses: { domains: ["atelieriza.com"], emailAddresses: ["hanif@atelieriza.com"] },
				mailboxBackends: new Map([["hanif@atelieriza.com", hanif]]),
		});
		const res = await app.request("/api/v1/mailboxes/outsider%40atelieriza.com/folders");
		expect(res.status).toBe(404);
		expect(hanif.calls).toEqual([]);
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

	test("GET /api/v1/status is served without a mail backend", async () => {
		const { app } = createTestApp({ authMode: "fixture" });
		const res = await app.request("/api/v1/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { pending: number; verified: number };
		expect(body.pending).toBe(0);
		expect(body.verified).toBe(0);
	});

	test("GET /api/v1/status reports injected sync state", async () => {
		const { app } = createTestApp({
			authMode: "fixture",
			statusProvider: () => ({
				lastSuccessAt: "2026-10-07T05:00:00Z",
				pending: 2,
				failed: 1,
				quarantined: 0,
				verified: 40,
				oldestPendingAt: "2026-10-07T04:59:00Z",
			}),
		});
		const res = await app.request("/api/v1/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { pending: number; verified: number; lastSuccessAt: string };
		expect(body.pending).toBe(2);
		expect(body.verified).toBe(40);
		expect(body.lastSuccessAt).toBe("2026-10-07T05:00:00Z");
	});
});
