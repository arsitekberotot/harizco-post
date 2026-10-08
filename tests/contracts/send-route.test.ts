// Task 14/15 caller wiring: the UI `sendEmail` POST must actually reach the
// submission guard. Before this route existed, `POST /api/v1/mailboxes/:id/emails`
// fell through to a 404 while the client called it for every send.
//
// Synthetic transport only: no real relay, provider, or account operation.

import { describe, expect, test, vi } from "vitest";
import api from "../../app/services/api";
import type { MailBackend } from "../../server/mail/backend";
import { validateSubmission } from "../../server/mail/validation";
import { createTestApp, productionAccessEnv } from "../helpers/app";

/** The operator policy the real adapter enforces before any relay write. */
const policy = {
	mailboxId: "mb1",
	address: "hanif@atelieriza.com",
	domain: "atelieriza.com",
	maxRecipients: 20,
	maxBytes: 5_000_000,
};

function fakeBackend(send: MailBackend["sendEmail"]): MailBackend & { sends: number } {
	const backend = {
		sends: 0,
		async listMailboxes() { return []; },
		async getMailbox() { return null; },
		async listEmails() { return { emails: [], total: 0 }; },
		async getEmail() { return null; },
		async search() { return { emailIds: [], total: 0 }; },
		async setFlags() { return { updated: [] }; },
		async setThreadRead() { return { updated: [] }; },
		async move() { return { updated: [] }; },
		async createDraft() { return { draftId: "d1" }; },
		async createFolder() { return { id: "f1" }; },
		async renameFolder() { return { updated: "f1" }; },
		async deleteFolder() { return { updated: "f1" }; },
		async health() { return { ok: true }; },
		async sendEmail(input: Parameters<MailBackend["sendEmail"]>[0]) {
			// The fake runs the REAL guard so the route's "zero provider
			// mutation on rejection" contract is exercised, not bypassed.
			validateSubmission(
				{ mailboxId: input.mailboxId, from: input.from, to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [], subject: input.subject ?? "", body: input.body, attachments: [] },
				policy,
			);
			backend.sends += 1;
			return send(input);
		},
	} as MailBackend & { sends: number };
	return backend;
}

const payload = {
	from: "hanif@atelieriza.com",
	to: ["friend@example.test"],
	subject: "Hi",
	body: "Hello",
};

/**
 * Fixture auth needs a parseable Access config and public origin, but must stay
 * in `NODE_ENV=test` (production composition forbids the fixture transport).
 */
const fixtureEnv = (overrides: Record<string, string> = {}) => ({
	...productionAccessEnv(),
	NODE_ENV: "test",
	...overrides,
});

describe("POST /api/v1/mailboxes/:id/emails (send)", () => {
	test("routes a valid send to the backend and returns its submission state", async () => {
		const backend = fakeBackend(async () => ({ requestId: "req-1", state: "queued" as const }));
		const { app } = createTestApp({ authMode: "fixture", env: fixtureEnv(), backend });
		const res = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/mailboxes/mb1/emails", {
			method: "POST",
			headers: { host: "example.invalid", origin: "https://example.invalid", "content-type": "application/json", "x-harizco-csrf": "1" },
			body: JSON.stringify(payload),
		}));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ requestId: "req-1", state: "queued" });
		expect(backend.sends).toBe(1);
	});

	test("a rejected send returns 4xx and never reaches the backend (zero provider mutation)", async () => {
		const backend = fakeBackend(async () => ({ requestId: "never", state: "queued" as const }));
		const { app } = createTestApp({ authMode: "fixture", env: fixtureEnv(), backend });
		const res = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/mailboxes/mb1/emails", {
			method: "POST",
			headers: { host: "example.invalid", origin: "https://example.invalid", "content-type": "application/json", "x-harizco-csrf": "1" },
			body: JSON.stringify({ ...payload, from: "spoofed@evil.test" }),
		}));
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		expect(backend.sends).toBe(0);
	});

	test("the browser client sends to that exact route", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => Response.json({ requestId: "req-2", state: "queued" }));
		vi.stubGlobal("fetch", fetcher);
		await api.sendEmail("mb1", payload);
		vi.unstubAllGlobals();
		expect(String(fetcher.mock.calls[0][0])).toContain("/api/v1/mailboxes/mb1/emails");
		expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
	});
});
