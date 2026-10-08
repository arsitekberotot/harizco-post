// Task 16 caller wiring: reply/forward must run the real threading policy
// (In-Reply-To/References, Reply-To, reply-all minus self, fresh forward
// thread) and reach the submission guard. Before this, the browser's
// `replyToEmail`/`forwardEmail` POSTs 404'd.
//
// Synthetic transport only: no real relay, provider, or account operation.

import { describe, expect, test } from "vitest";
import api from "../../app/services/api";
import { vi } from "vitest";
import type { MailBackend } from "../../server/mail/backend";
import { createTestApp, productionAccessEnv } from "../helpers/app";

const OWNER = "hanif@atelieriza.com";
const original = {
	id: "e-1",
	mailboxIds: ["mb1"],
	messageId: "<orig@friend.test>",
	threadId: "t-1",
	from: [{ email: "sender@friend.test" }],
	to: [{ email: OWNER }, { email: "peer@friend.test" }],
	cc: [{ email: "cc@friend.test" }],
	subject: "Project",
	receivedAt: "2026-10-07T00:00:00Z",
	preview: "",
	hasAttachment: false,
	unread: false,
	starred: false,
	draft: false,
	inReplyTo: [],
	references: [],
};

interface Capture extends MailBackend {
	calls: string[];
	last: Parameters<MailBackend["sendEmail"]>[0] | null;
}

function backendWithCapture(): Capture {
	const backend: Capture = {
		calls: [],
		last: null,
		async listMailboxes() { return []; },
		async getMailbox() { return null; },
		async listEmails() { return { emails: [], total: 0 }; },
		async getEmail(id: string) {
			backend.calls.push(`getEmail:${id}`);
			return id === "e-1" ? { ...original } : null;
		},
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
			backend.calls.push(`sendEmail:${input.from}`);
			backend.last = input;
			return { requestId: "req-rf", state: "queued" as const };
		},
	};
	return backend;
}

const fixtureEnv = () => ({ ...productionAccessEnv(), NODE_ENV: "test" });

function post(app: ReturnType<typeof createTestApp>["app"], path: string, body: unknown) {
	return app.fetch(new Request(`http://127.0.0.1:3000${path}`, {
		method: "POST",
		headers: { host: "example.invalid", origin: "https://example.invalid", "content-type": "application/json", "x-harizco-csrf": "1" },
		body: JSON.stringify(body),
	}));
}

describe("POST /emails/:id/reply", () => {
	test("threads the reply, applies Re:, and strips our own address from reply-all", async () => {
		const backend = backendWithCapture();
		const { app } = createTestApp({ authMode: "fixture", env: fixtureEnv(), backend });
		const res = await post(app, "/api/v1/mailboxes/mb1/emails/e-1/reply", {
			replyAll: true,
			body: "Thanks!",
			from: OWNER,
		});
		expect(res.status).toBe(200);
		const sent = backend.last as { from: string; to: string[]; cc: string[]; subject: string; inReplyTo?: string };
		expect(sent.inReplyTo).toBe("<orig@friend.test>");
		expect(sent.subject).toBe("Re: Project");
		// Sender first; our own address never appears in to/cc.
		expect(sent.to).toEqual(["sender@friend.test", "peer@friend.test"]);
		expect(sent.cc).toEqual(["cc@friend.test"]);
		expect([...sent.to, ...sent.cc]).not.toContain(OWNER);
	});

	test("a plain reply targets only the original sender", async () => {
		const backend = backendWithCapture();
		const { app } = createTestApp({ authMode: "fixture", env: fixtureEnv(), backend });
		const res = await post(app, "/api/v1/mailboxes/mb1/emails/e-1/reply", { replyAll: false, body: "ok", from: OWNER });
		expect(res.status).toBe(200);
		const sent = backend.last as { to: string[]; cc: string[] };
		expect(sent.to).toEqual(["sender@friend.test"]);
		expect(sent.cc).toEqual([]);
	});

	test("an unknown original returns 404 without any provider call", async () => {
		const backend = backendWithCapture();
		const { app } = createTestApp({ authMode: "fixture", env: fixtureEnv(), backend });
		const res = await post(app, "/api/v1/mailboxes/mb1/emails/missing/reply", { body: "ok", from: OWNER });
		expect(res.status).toBe(404);
		expect(backend.calls.some((c) => c.startsWith("sendEmail"))).toBe(false);
	});
});

describe("POST /emails/:id/forward", () => {
	test("forwards with Fwd: and no threading headers (fresh conversation)", async () => {
		const backend = backendWithCapture();
		const { app } = createTestApp({ authMode: "fixture", env: fixtureEnv(), backend });
		const res = await post(app, "/api/v1/mailboxes/mb1/emails/e-1/forward", {
			to: ["new@elsewhere.test"],
			body: "fyi",
			from: OWNER,
		});
		expect(res.status).toBe(200);
		const sent = backend.last as { to: string[]; subject: string; inReplyTo?: string; references?: string[] };
		expect(sent.to).toEqual(["new@elsewhere.test"]);
		expect(sent.subject).toBe("Fwd: Project");
		expect(sent.inReplyTo).toBeUndefined();
		expect(sent.references ?? []).toHaveLength(0);
	});
});

describe("browser client routes", () => {
	test("replyToEmail/forwardEmail target the reply/forward routes", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => Response.json({ requestId: "r", state: "queued" }));
		vi.stubGlobal("fetch", fetcher);
		await api.replyToEmail("mb1", "e-1", { body: "x" });
		await api.forwardEmail("mb1", "e-1", { body: "x" });
		vi.unstubAllGlobals();
		expect(String(fetcher.mock.calls[0][0])).toContain("/api/v1/mailboxes/mb1/emails/e-1/reply");
		expect(String(fetcher.mock.calls[1][0])).toContain("/api/v1/mailboxes/mb1/emails/e-1/forward");
	});
});