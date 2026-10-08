// REAL side-effect/crash helper. Receives only private config/fixture paths.
// It deliberately never writes the receipt journal or returns the imported ID.
import assert from "node:assert/strict";
import { readFileSync, readlinkSync, statSync } from "node:fs";

const [configPath, fixturePath, mailboxId] = process.argv.slice(2);
assert(configPath && fixturePath && mailboxId, "private fixture arguments required");
assert.equal(statSync(configPath).mode & 0o077, 0);
const config = JSON.parse(readFileSync(configPath, "utf8"));
assert.equal(config.baseUrl, "http://127.0.0.1:18081");
assert.equal(config.version, "0.16.25");
assert.equal(readlinkSync("/proc/self/ns/net"), config.namespace);
const auth = `Basic ${Buffer.from(`${config.username}:${config.secret}`).toString("base64")}`;
/** @param {string} url @param {RequestInit} [init] */
async function request(url, init = {}) {
	assert.equal(new URL(url).origin, config.baseUrl);
	const result = await fetch(url, { ...init, redirect: "error", headers: { ...init.headers, Authorization: auth }, signal: AbortSignal.timeout(15000) });
	assert.equal(result.status, 200);
	return result.json();
}
const session = await request(`${config.baseUrl}/jmap/session`);
const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
const bytes = readFileSync(fixturePath);
const uploaded = await request(session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId)), { method: "POST", headers: { "Content-Type": "message/rfc822" }, body: bytes });
assert.equal(uploaded.size, bytes.length);
const imported = await request(session.apiUrl, {
	method: "POST", headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/import", { accountId, emails: { crash: { blobId: uploaded.blobId, mailboxIds: { [mailboxId]: true }, keywords: {}, receivedAt: "2026-10-07T05:00:00Z" } } }, "crash"]] }),
});
assert.equal(imported.methodResponses[0][0], "Email/import");
assert.equal(imported.methodResponses[0][1].notCreated ?? null, null);
assert(imported.methodResponses[0][1].created.crash.id);
// The server committed import; the client dies BEFORE storing either blob/Email
// identity in the existing durable receipt journal. Parent must rediscover it.
process.exit(86);
