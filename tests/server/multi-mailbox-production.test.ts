import { describe, expect, test, vi } from "vitest";
import { openJournal } from "../../server/db/index";
import { MailboxRegistry } from "../../server/mailboxes/registry";
import { loadConfig, loadOutboundBinding } from "../../server/config";
import { createProductionMailboxBackends } from "../../server/index";

const env = {
	NODE_ENV: "test",
	STALWART_URL: "http://127.0.0.1:8080",
	STALWART_USERNAME: "service-user",
	STALWART_SECRET: "synthetic-secret",
	OUTBOUND_FROM: "hanif@atelieriza.com",
	OUTBOUND_ADDRESSES: "hanif@atelieriza.com,natla@atelieriza.com",
	OUTBOUND_RELAY_URL: "http://127.0.0.1:8788/relay",
};
const baseUrl = env.STALWART_URL;

function buildRegistry(accountIds: [string, string] = ["acct-hanif", "acct-natla"]) {
	const db = openJournal(":memory:");
	const registry = new MailboxRegistry(db);
	for (const [id, address, accountId] of [
		["mb-hanif", "hanif@atelieriza.com", accountIds[0]],
		["mb-natla", "natla@atelieriza.com", accountIds[1]],
		["mb-ignored", "other@atelieriza.com", "acct-other"],
	] as const) {
		registry.provision({ id, address });
		registry.bindAccount(id, accountId);
		registry.setEnabled(id, true);
	}
	return { db, registry };
}

function fakeFetch() {
	const discovered: string[] = [];
	const fetcher = vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/.well-known/jmap")) {
			return Response.json({
				capabilities: { "urn:ietf:params:jmap:core": {} },
				accounts: { "acct-hanif": {}, "acct-natla": {}, "acct-other": {} },
				primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-hanif" },
				apiUrl: `${baseUrl}/api`,
				uploadUrl: `${baseUrl}/upload/{accountId}`,
				downloadUrl: `${baseUrl}/download/{accountId}/{blobId}`,
			});
		}
		const request = JSON.parse(String(init?.body)) as {
			methodCalls: Array<[string, Record<string, unknown>, string]>;
		};
		const [name, args, tag] = request.methodCalls[0]!;
		discovered.push(String(args.accountId));
		return Response.json({ methodResponses: [[name, { list: [] }, tag]] });
	});
	return { fetcher, discovered };
}

describe("production multi-mailbox JMAP routing", () => {
	test("builds one account-bound backend per configured provisioned mailbox", async () => {
		const { db, registry } = buildRegistry();
		registry.setEnabled("mb-natla", false);
		const { fetcher, discovered } = fakeFetch();
		const backends = createProductionMailboxBackends(
			loadConfig(env),
			registry.listAll(),
			loadOutboundBinding(env),
			{ db, fetch: fetcher },
		);

		expect([...backends.keys()].sort()).toEqual(["hanif@atelieriza.com", "natla@atelieriza.com"]);
		await Promise.all([...backends.values()].map((backend) => backend.listMailboxes()));
		expect(discovered.sort()).toEqual(["acct-hanif", "acct-natla"]);
		db.close();
	});

	test("fails closed when one configured address has no JMAP account binding", () => {
		const db = openJournal(":memory:");
		const registry = new MailboxRegistry(db);
		registry.provision({ id: "mb-hanif", address: "hanif@atelieriza.com" });
		registry.bindAccount("mb-hanif", "acct-hanif");
		registry.setEnabled("mb-hanif", true);
		expect(() => createProductionMailboxBackends(
			loadConfig(env),
			registry.listAll(),
			loadOutboundBinding(env),
			{ db, fetch: fetch as typeof globalThis.fetch },
		)).toThrow(/natla@atelieriza.com.*no JMAP account binding/i);
		db.close();
	});

	test("refuses two configured addresses bound to the same JMAP account", () => {
		const { db, registry } = buildRegistry(["acct-shared", "acct-shared"]);
		expect(() => createProductionMailboxBackends(
			loadConfig(env),
			registry.listEnabled(),
			loadOutboundBinding(env),
			{ db, fetch: fetch as typeof globalThis.fetch },
		)).toThrow(/account.*bound/i);
		db.close();
	});
});
