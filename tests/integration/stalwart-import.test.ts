import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Opt-in REAL integration suite. No mock provider and no production adapter.
// scripts/stalwart-fixtures.py provisions and tears down the isolated service.
const configPath = process.env.STALWART_FIXTURE_CONFIG;
const evidencePath = process.env.STALWART_FIXTURE_EVIDENCE;
const core = "urn:ietf:params:jmap:core";
const mail = "urn:ietf:params:jmap:mail";
const submission = "urn:ietf:params:jmap:submission";
const blob = "urn:ietf:params:jmap:blob";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixture = (name: string) => readFileSync(resolve("tests/fixtures/mail", name));
let config: { baseUrl: string; username: string; secret: string; namespace: string; version: string };
let session: any;
let accountId: string;
let folders: any[];
let plain: any;
let multi: any;
let inline: any;
let uploadBlob: string;
let duplicateId: string;
let draftId: string;
const emailsToDestroy = new Set<string>();

function record(step: string, value: unknown) {
	if (evidencePath) appendFileSync(evidencePath, JSON.stringify({ step, value }) + "\n", { mode: 0o600 });
}
function localUrl(url: string) {
	const parsed = new URL(url);
	expect(parsed.origin, "session must not redirect credentials off loopback").toBe(config.baseUrl);
	return parsed.toString();
}
async function http(url: string, init: RequestInit = {}) {
	return fetch(localUrl(url), {
		...init,
		redirect: "error",
		headers: { ...init.headers, Authorization: `Basic ${Buffer.from(`${config.username}:${config.secret}`).toString("base64")}` },
		signal: AbortSignal.timeout(15000),
	});
}
async function call(method: string, args: any, using = [core, mail, submission, blob]) {
	// This probe has NO send operation, even against the isolated service.
	if (method === "EmailSubmission/set") throw new Error("Submission writes forbidden in this fixture probe");
	const response = await http(session.apiUrl, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ using, methodCalls: [[method, { accountId, ...args }, "probe"]] }),
	});
	expect(response.status).toBe(200);
	const data: any = await response.json();
	record(method, data);
	expect(data.methodResponses).toHaveLength(1);
	return data.methodResponses[0];
}
async function success(method: string, args: any, using?: string[]) {
	const result = await call(method, args, using);
	expect(result[0], JSON.stringify(result)).toBe(method);
	return result[1];
}
async function upload(bytes: Buffer) {
	const url = session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId));
	const res = await http(url, { method: "POST", headers: { "Content-Type": "message/rfc822" }, body: bytes as any });
	expect(res.status).toBe(200);
	const data: any = await res.json();
	record("upload", data);
	expect(data.accountId).toBe(accountId);
	expect(data.size).toBe(bytes.length);
	return data.blobId as string;
}
async function download(blobId: string, name = "original.eml", type = "message/rfc822") {
	const url = session.downloadUrl.replace("{accountId}", encodeURIComponent(accountId))
		.replace("{blobId}", encodeURIComponent(blobId)).replace("{name}", encodeURIComponent(name))
		.replace("{type}", encodeURIComponent(type));
	const res = await http(url);
	expect(res.status).toBe(200);
	return Buffer.from(await res.arrayBuffer());
}
async function getEmail(id: string) {
	const result = await success("Email/get", {
		ids: [id], properties: ["id", "blobId", "size", "subject", "messageId", "mailboxIds", "keywords", "attachments", "bodyStructure", "textBody", "htmlBody", "bodyValues"],
		bodyProperties: ["partId", "blobId", "size", "name", "type", "disposition", "cid", "subParts"], fetchAllBodyValues: true,
	});
	expect(result.notFound).toEqual([]);
	expect(result.list).toHaveLength(1);
	return result.list[0];
}
async function importBlob(blobId: string, mailboxId: string, keywords = {}) {
	const result = await success("Email/import", {
		emails: { fixture: { blobId, mailboxIds: { [mailboxId]: true }, keywords, receivedAt: "2026-10-07T05:00:00Z" } },
	});
	expect(result.notCreated ?? null, JSON.stringify(result)).toBeNull();
	expect(result.created.fixture.id).toBeTruthy();
	emailsToDestroy.add(result.created.fixture.id);
	return getEmail(result.created.fixture.id);
}
function role(name: string) { return folders.find((f) => f.role === name).id as string; }

function draftPayload(subject: string, body: string) {
	return { mailboxIds: { [role("drafts")]: true }, keywords: { "$draft": true }, from: [{ email: config.username }], to: [{ email: "nobody@example.test" }], subject, textBody: [{ partId: "body", type: "text/plain" }], bodyValues: { body: { value: body } } };
}

// Spike-only primitive; the preservation regression below exercises this path.
async function replaceDraft(oldId: string, draft: any, verify: (id: string) => Promise<void>) {
	// Email/set operations are independent, NOT an atomic replacement transaction.
	const replacement = await success("Email/set", { create: { edited: draft } });
	if (replacement.notCreated?.edited) return replacement; // Old remains readable.
	expect(replacement.notCreated ?? null).toBeNull();
	const newId = replacement.created.edited.id;
	expect(newId).toBeTruthy();
	emailsToDestroy.add(newId);
	await verify(newId); // Any readback failure leaves old intact; no destroy below.
	const destroyed = await success("Email/set", { destroy: [oldId] });
	expect(destroyed.notDestroyed ?? null).toBeNull();
	expect(destroyed.destroyed).toEqual([oldId]);
	emailsToDestroy.delete(oldId);
	record("draft-original-destroyed-after-verification", { oldId, newId, destroyed: destroyed.destroyed });
	return replacement;
}

// Deliberately scan canonical Email blobs, not temporary upload IDs or Message-ID.
// A real adapter must bound/cursor the scan and serialize per-account imports.
async function canonicalMatches(bytes: Buffer) {
	const wanted = hash(bytes);
	const found: any[] = [];
	let position = 0;
	for (;;) {
		const page = await success("Email/query", { position, limit: 2, calculateTotal: true });
		for (const id of page.ids) {
			const email = await getEmail(id);
			const raw = await download(email.blobId);
			if (raw.length === bytes.length && hash(raw) === wanted) found.push(email);
		}
		position += page.ids.length;
		if (position >= page.total) break;
		expect(page.ids.length, "query must progress").toBeGreaterThan(0);
	}
	return found;
}

describe.skipIf(!configPath)("REAL pinned Stalwart fixture primitives (run scripts/stalwart-fixtures.py)", () => {
	beforeAll(async () => {
		expect(existsSync(configPath!), "isolated fixture service must be provisioned by the runner").toBe(true);
		expect(statSync(configPath!).mode & 0o077).toBe(0);
		config = JSON.parse(readFileSync(configPath!, "utf8"));
		expect(config.version).toBe("0.16.25");
		expect(config.baseUrl).toBe("http://127.0.0.1:18081");
		expect(readlinkSync("/proc/self/ns/net")).toBe(config.namespace);
		const res = await http(`${config.baseUrl}/jmap/session`);
		expect(res.status).toBe(200);
		session = await res.json();
		accountId = session.primaryAccounts[mail];
		record("session", session);
		expect(accountId).toBeTruthy();
		folders = (await success("Mailbox/get", {})).list;
	}, 30000);

	afterAll(async () => {
		if (!session) return;
		if (emailsToDestroy.size) {
			const destroyed = await success("Email/set", { destroy: [...emailsToDestroy] });
			expect(destroyed.notDestroyed ?? null).toBeNull();
			const readback = await success("Email/get", { ids: [...emailsToDestroy], properties: ["id"] });
			expect(readback.list).toEqual([]);
		}
	}, 30000);

	test("discovers folder roles and denies management access to the restricted account", async () => {
		for (const cap of [core, mail, submission, blob]) expect(session.capabilities).toHaveProperty(cap);
		expect(folders.map((f) => f.role).filter(Boolean).sort()).toEqual(["drafts", "inbox", "junk", "sent", "trash"]);
		const denied = await call("x:NetworkListener/get", {}, [core, "urn:stalwart:jmap"]);
		expect(denied[0]).toBe("error");
		expect(["forbidden", "unknownMethod"]).toContain(denied[1].type);
	});

	test("uploads and imports exact plain MIME, distinguishes upload and canonical blobs", async () => {
		const bytes = fixture("plain.eml");
		uploadBlob = await upload(bytes);
		expect(await download(uploadBlob)).toEqual(bytes);
		plain = await importBlob(uploadBlob, role("inbox"));
		expect(plain.subject).toBe("Harizco fixture plain");
		expect(plain.size).toBe(bytes.length);
		expect(plain.messageId).toEqual(["fixture-plain@harizco.test"]);
		expect(plain.blobId).not.toBe(uploadBlob);
		expect(await download(plain.blobId)).toEqual(bytes);
		record("canonical-identity", { emailId: plain.id, uploadBlobId: uploadBlob, canonicalBlobId: plain.blobId, size: bytes.length, sha256: hash(bytes) });
	});

	test("imports multipart MIME and downloads decoded attachment bytes", async () => {
		const bytes = fixture("multipart.eml");
		multi = await importBlob(await upload(bytes), role("inbox"));
		expect(await download(multi.blobId)).toEqual(bytes);
		expect(multi.attachments).toHaveLength(1);
		const part = multi.attachments[0];
		expect(part.name).toBe("fixture.bin");
		const attachment = await download(part.blobId, part.name, part.type);
		expect(attachment).toEqual(Buffer.from("harizco-attachment-bytes"));
		record("attachment-bytes", { size: attachment.length, sha256: hash(attachment) });
	});

	test("records malformed import rejection and probes canonical/upload blob lookup", async () => {
		const wrong = await success("Email/import", { emails: { [uploadBlob]: { mailboxIds: { [role("inbox")]: true } } } });
		expect(wrong.notCreated[uploadBlob].type).toBe("invalidProperties");
		const missing = await success("Email/import", { emails: { missing: { blobId: "missing-fixture-blob", mailboxIds: { [role("inbox")]: true } } } });
		expect(missing.notCreated.missing.type).toBe("invalidProperties");
		const absentBlobId = uploadBlob[0] + (uploadBlob[1] === "a" ? "b" : "a") + uploadBlob.slice(2);
		const absent = await success("Email/import", { emails: { absent: { blobId: absentBlobId, mailboxIds: { [role("inbox")]: true } } } });
		expect(absent.notCreated.absent.type).toBe("blobNotFound");
		const lookup = await success("Blob/lookup", { ids: [uploadBlob, plain.blobId], typeNames: ["Email"] });
		expect(lookup.notFound).toEqual([]);
		expect(lookup.list.find((entry: any) => entry.id === uploadBlob).matchedIds).toEqual({});
		expect(lookup.list.find((entry: any) => entry.id === plain.blobId).matchedIds).toEqual({ Email: [plain.id] });
		record("blob-lookup-identity", lookup);
		const byHash = await call("Email/query", { filter: { contentHash: hash(fixture("plain.eml")) }, calculateTotal: true });
		if (byHash[0] === "error") {
			expect(["unsupportedFilter", "invalidArguments"]).toContain(byHash[1].type);
		} else {
			// Unknown filters may be silently ignored: never call this hash lookup.
			expect(byHash[1].ids).toContain(multi.id);
			expect(byHash[1].ids).toContain(plain.id);
		}
		record("content-hash-filter-probe", byHash);
	});

	test("imports related HTML/CID MIME and downloads the inline image", async () => {
		const bytes = fixture("inline-image.eml");
		inline = await importBlob(await upload(bytes), role("inbox"));
		expect(await download(inline.blobId)).toEqual(bytes);
		function parts(part: any): any[] { return [part, ...(part.subParts ?? []).flatMap(parts)]; }
		const image = parts(inline.bodyStructure).find((p) => p.cid === "fixture-image");
		expect(image).toBeTruthy();
		expect(image.type).toBe("image/png");
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4WQAAAAASUVORK5CYII=", "base64");
		expect(await download(image.blobId, "pixel.png", image.type)).toEqual(png);
		expect(Object.values(inline.bodyValues).some((v: any) => v.value.includes("cid:fixture-image"))).toBe(true);
		record("inline-image-bytes", { size: png.length, sha256: hash(png) });
	});

	test("mutates flags and folder membership with confirmed readback", async () => {
		const folder = await success("Mailbox/set", { create: { probe: { name: "Fixture archive", parentId: null } } });
		expect(folder.notCreated ?? null).toBeNull();
		const folderId = folder.created.probe.id;
		try {
			const mutation = await success("Email/set", { update: { [plain.id]: { "keywords/$seen": true, "keywords/$flagged": true, mailboxIds: { [folderId]: true } } } });
			expect(mutation.updated).toHaveProperty(plain.id);
			const updated = await getEmail(plain.id);
			expect(updated.keywords).toEqual({ "$seen": true, "$flagged": true });
			expect(updated.mailboxIds).toEqual({ [folderId]: true });
			expect(await download(updated.blobId)).toEqual(fixture("plain.eml"));
			await success("Email/set", { update: { [plain.id]: { mailboxIds: { [role("inbox")]: true }, "keywords/$seen": null, "keywords/$flagged": null } } });
			expect((await getEmail(plain.id)).keywords).toEqual({});
		} finally {
			const destroyed = await success("Mailbox/set", { destroy: [folderId] });
			expect(destroyed.notDestroyed ?? null).toBeNull();
			expect((await success("Mailbox/get", { ids: [folderId] })).list).toEqual([]);
		}
	});

	test("preserves the readable original draft when replacement creation is really rejected", async () => {
		const draft = draftPayload("Draft preserved on rejection", "Original body must survive");
		const created = await success("Email/set", { create: { original: draft } });
		expect(created.notCreated ?? null).toBeNull();
		const oldId = created.created.original.id;
		emailsToDestroy.add(oldId);
		const original = await getEmail(oldId);
		const bytes = await download(original.blobId);
		let verificationCalled = false;
		// Empty mailboxIds is an invalid create property on the pinned server.
		const rejected = await replaceDraft(oldId, { ...draft, mailboxIds: {}, subject: "Must not replace" }, async () => { verificationCalled = true; });
		expect(rejected.notCreated.edited.type).toBe("invalidProperties");
		expect(rejected.notCreated.edited.properties).toContain("mailboxIds");
		expect(verificationCalled).toBe(false);
		const preserved = await getEmail(oldId);
		expect(preserved.subject).toBe(original.subject);
		expect(preserved.mailboxIds).toEqual(original.mailboxIds);
		expect(preserved.keywords).toEqual(original.keywords);
		expect(await download(preserved.blobId)).toEqual(bytes);
		record("draft-rejection-preservation", { oldId, rejection: rejected.notCreated.edited, originalReadable: true, size: bytes.length, sha256: hash(bytes) });
	});

	test("creates a draft; verifies replacement content before separately destroying the original", async () => {
		const draft = draftPayload("Draft v1", "Draft body v1");
		const created = await success("Email/set", { create: { draft } });
		expect(created.notCreated ?? null).toBeNull();
		draftId = created.created.draft.id;
		emailsToDestroy.add(draftId);
		expect((await getEmail(draftId)).subject).toBe("Draft v1");
		const direct = await success("Email/set", { update: { [draftId]: { subject: "Draft v2" } } });
		expect(direct.notUpdated[draftId].type).toBe("invalidProperties");
		const replacement = await replaceDraft(draftId, draftPayload("Draft v2", "Draft body v2"), async (newId) => {
			const edited = await getEmail(newId);
			expect(edited.subject).toBe("Draft v2");
			expect(edited.keywords).toEqual({ "$draft": true });
			expect(edited.mailboxIds).toEqual({ [role("drafts")]: true });
			expect(Object.values(edited.bodyValues).some((v: any) => v.value.includes("Draft body v2"))).toBe(true);
			expect((await getEmail(draftId)).subject).toBe("Draft v1");
			record("draft-replacement-verified-before-destroy", { oldId: draftId, newId, subject: edited.subject, oldStillReadable: true });
		});
		expect(replacement.notCreated ?? null).toBeNull();
		expect((await success("Email/get", { ids: [draftId], properties: ["id"] })).list).toEqual([]);
	});

	test("repeated import is NOT deduplicated by Stalwart, despite identical MIME", async () => {
		const repeat = await importBlob(uploadBlob, role("inbox"));
		duplicateId = repeat.id;
		expect(duplicateId).not.toBe(plain.id);
		expect(await download(repeat.blobId)).toEqual(fixture("plain.eml"));
		const matches = await canonicalMatches(fixture("plain.eml"));
		expect(matches.map((e) => e.id).sort()).toEqual([plain.id, duplicateId].sort());
		record("duplicate-import", { ids: matches.map((e) => e.id), canonicalBlobIds: matches.map((e) => e.blobId), serverDeduplicates: false });
	});

	test("post-import/pre-journal crash recovers by canonical MIME hash without importing again", async () => {
		// Remove the earlier multipart so recovery has one unambiguous candidate.
		await success("Email/set", { destroy: [multi.id] });
		expect((await success("Email/get", { ids: [multi.id], properties: ["id"] })).list).toEqual([]);
		emailsToDestroy.delete(multi.id);
		const journalPath = resolve(dirname(configPath!), "crash-receipt.json");
		writeFileSync(journalPath, JSON.stringify({ hash: hash(fixture("multipart.eml")), size: fixture("multipart.eml").length, state: "spooled", emailId: null, uploadBlobId: null }), { mode: 0o600 });
		const crashHelper = resolve("tests/helpers/stalwart-crash.mjs");
		expect(existsSync(crashHelper), "real post-import crash helper must exist").toBe(true);
		const child = spawnSync(process.execPath, [crashHelper, configPath!, resolve("tests/fixtures/mail/multipart.eml"), role("inbox")], { timeout: 20000, encoding: "utf8" });
		expect(child.status, child.stderr).toBe(86); // Deliberate process death AFTER real import.
		const intent = JSON.parse(readFileSync(journalPath, "utf8"));
		expect(intent.emailId).toBeNull();
		expect(intent.uploadBlobId).toBeNull();
		const before = await success("Email/query", { calculateTotal: true });
		const matches = await canonicalMatches(fixture("multipart.eml"));
		expect(matches).toHaveLength(1);
		intent.emailId = matches[0].id;
		expect(intent.emailId).not.toBe(multi.id);
		emailsToDestroy.add(intent.emailId);
		expect(hash(await download(matches[0].blobId))).toBe(intent.hash);
		const after = await success("Email/query", { calculateTotal: true });
		expect(after.total).toBe(before.total);
		const ambiguous = await canonicalMatches(fixture("plain.eml"));
		expect(ambiguous).toHaveLength(2); // Hold ambiguity; NEVER choose Message-ID's first match.
		writeFileSync(journalPath, JSON.stringify({ ...intent, state: "verified", canonicalBlobId: matches[0].blobId }), { mode: 0o600 });
		expect(JSON.parse(readFileSync(journalPath, "utf8")).state).toBe("verified");
		record("crash-reconciliation", { childExitCode: child.status, emailId: matches[0].id, canonicalBlobId: matches[0].blobId, sha256: intent.hash, totalBefore: before.total, totalAfter: after.total, ambiguousMatchesHeld: ambiguous.length });
	}, 30000);

	test("queries identities and submissions WITHOUT creating or externally sending mail", async () => {
		const identities = await success("Identity/get", {});
		expect(identities.list.some((i: any) => i.email === config.username)).toBe(true);
		const query = await success("EmailSubmission/query", { filter: { emailIds: [plain.id] }, calculateTotal: true });
		expect(query.ids).toEqual([]);
		const all = await success("EmailSubmission/query", { calculateTotal: true });
		expect(all.total).toBe(0);
		const get = await success("EmailSubmission/get", { ids: ["missing-fixture-submission"] });
		expect(get.list).toEqual([]);
		expect(get.notFound).toEqual(["missing-fixture-submission"]);
		record("submission-lookup-only", { queryByEmailSupported: true, total: all.total, noSubmissionCreate: true, externalSend: "NOT TESTED / FORBIDDEN" });
	});
});
