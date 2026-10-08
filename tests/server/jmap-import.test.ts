import { describe, expect, test, vi } from "vitest";
import { JmapImportAdapter } from "../../server/sync/jmap-import";

const baseUrl = "http://127.0.0.1:8080";
const accountId = "acct-hanif";

function fakeJmapFetch() {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const fetcher = vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/.well-known/jmap")) {
			return Response.json({
				capabilities: { "urn:ietf:params:jmap:core": {} },
				accounts: { [accountId]: { name: "Hanif" } },
				primaryAccounts: { "urn:ietf:params:jmap:mail": accountId },
				apiUrl: `${baseUrl}/api`,
				uploadUrl: `${baseUrl}/upload/{accountId}`,
				downloadUrl: `${baseUrl}/download/{accountId}/{blobId}`,
			});
		}
		const request = JSON.parse(String(init?.body)) as {
			methodCalls: Array<[string, Record<string, unknown>, string]>;
		};
		const [name, args, tag] = request.methodCalls[0]!;
		calls.push({ name, args });
		if (name === "Mailbox/get") {
			return Response.json({ methodResponses: [["Mailbox/get", {
				list: [{ id: "inbox-hanif", name: "Inbox", role: "inbox", totalEmails: 0, unreadEmails: 0 }],
			}, tag]] });
		}
		if (name === "Email/import") {
			return Response.json({ methodResponses: [["Email/import", {
				created: { imported: { id: "email-1" } },
			}, tag]] });
		}
		throw new Error(`Unexpected JMAP call: ${name}`);
	});
	return { fetcher, calls };
}

describe("JMAP inbound import account isolation", () => {
	test("imports to the account's Inbox folder, not the account ID", async () => {
		const { fetcher, calls } = fakeJmapFetch();
		const adapter = new JmapImportAdapter({
			baseUrl,
			auth: { username: "mail-admin", secret: "synthetic-secret" },
			accountId,
			fetch: fetcher,
		});

		await adapter.importEmail({ mailboxId: accountId, blobId: "blob-1", bytes: new Uint8Array() });

		expect(calls.map((call) => call.name)).toEqual(["Mailbox/get", "Email/import"]);
		expect(calls[0]?.args.accountId).toBe(accountId);
		expect(calls[1]?.args.accountId).toBe(accountId);
		const emailImport = calls[1]?.args.emails as Record<string, { mailboxIds: Record<string, boolean> }>;
		expect(emailImport.imported?.mailboxIds).toEqual({ "inbox-hanif": true });
	});

	test("rejects an import routed to a different mailbox account before JMAP writes", async () => {
		const { fetcher } = fakeJmapFetch();
		const adapter = new JmapImportAdapter({
			baseUrl,
			auth: { username: "mail-admin", secret: "synthetic-secret" },
			accountId,
			fetch: fetcher,
		});

		await expect(adapter.importEmail({ mailboxId: "acct-natla", blobId: "blob-1", bytes: new Uint8Array() }))
			.rejects.toThrow(/does not match/i);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
