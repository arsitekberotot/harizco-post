// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Task 17: in-memory attachment METADATA helper contracts only. These are
// not HTTP upload/download, draft, submission, byte storage or persistence
// evidence. Browser sanitization/CID tests live in ui/email-security.spec.ts.

import { beforeEach, describe, expect, test } from "vitest";
import { safeInlineImageData as rasterData } from "../../shared/sanitize-html";
import {
	AttachmentError,
	createAttachmentStore,
	sanitizeFilename,
	safeContentDisposition,
	type AttachmentStore,
} from "../../server/routes/attachments";

let store: AttachmentStore;

beforeEach(() => {
	store = createAttachmentStore({ maxBytes: 1024 * 1024, tempTtlMs: 60_000 });
});

describe("sanitizeFilename", () => {
	test("strips path components and keeps a usable name", () => {
		expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
		expect(sanitizeFilename("/abs/path/report.pdf")).toBe("report.pdf");
		expect(sanitizeFilename("C:\\Users\\x\\doc.txt")).toBe("doc.txt");
	});

	test("rejects or neutralizes header/CRLF and control characters", () => {
		expect(sanitizeFilename("a\r\nX-Evil: 1.txt")).not.toMatch(/[\r\n]/);
		const clean = sanitizeFilename("weird\u0000name.txt");
		expect(clean).not.toMatch(/[\u0000-\u001f\u007f]/);
	});

	test("falls back to a safe name when nothing usable remains", () => {
		expect(sanitizeFilename("...")).toBe("attachment");
		expect(sanitizeFilename("")).toBe("attachment");
	});

	test("never returns a leading dot (no hidden/relative names)", () => {
		expect(sanitizeFilename(".bashrc")).not.toMatch(/^\./);
	});

	test("long extensions cannot enlarge the filename beyond its hard limit", () => {
		for (const name of ["a." + "x".repeat(250), "report." + "x".repeat(1000), "b".repeat(250) + ".pdf"]) {
			const safe = sanitizeFilename(name);
			expect(safe.length).toBeLessThanOrEqual(200);
			expect(name.startsWith(safe) || safe.endsWith(".pdf")).toBe(true);
		}
		expect(sanitizeFilename("b".repeat(250) + ".pdf")).toHaveLength(200);
		expect(sanitizeFilename("b".repeat(250) + ".pdf")).toMatch(/\.pdf$/);
	});
});

describe("safeContentDisposition", () => {
	test("is always attachments (never inline) and includes a sanitized filename", () => {
		const cd = safeContentDisposition("report.pdf");
		expect(cd).toMatch(/^attachment;/);
		expect(cd).toContain('filename="report.pdf"');
		expect(cd).not.toMatch(/[\r\n]/);
	});

	test("adds an RFC 5987 filename* for non-ASCII names", () => {
		const cd = safeContentDisposition("résumé.pdf");
		expect(cd).toContain("filename*=UTF-8''");
	});

	test("extended filenames percent-encode apostrophes and parentheses", () => {
		const cd = safeContentDisposition("résumé(1)'.pdf");
		expect(cd).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%281%29%27.pdf");
	});

	test("malformed Unicode and truncated surrogate pairs yield usable dispositions", () => {
		for (const name of ["\ud800.pdf", "\udc00.pdf", "a".repeat(199) + "😀", "😀.pdf"]) {
			const cd = safeContentDisposition(name);
			expect(cd).toMatch(/^attachment;/);
			expect(cd).not.toMatch(/[\r\n]/);
			const extended = cd.split("filename*=UTF-8''")[1];
			expect(extended).toBeDefined();
			expect(() => decodeURIComponent(extended)).not.toThrow();
		}
		expect(safeContentDisposition("😀.pdf")).toContain("%F0%9F%98%80.pdf");
	});
});

describe("ownership and size", () => {
	test("an upload is bound to exactly one mailbox", () => {
		const att = store.put({ mailboxId: "mb1", filename: "a.txt", contentType: "text/plain", bytes: 10 });
		expect(store.get("mb1", att.id)?.id).toBe(att.id);
		// a different mailbox cannot see it
		expect(store.get("mb2", att.id)).toBeNull();
	});

	test("a readback from the wrong mailbox is refused, not 404-guessed", () => {
		const att = store.put({ mailboxId: "mb1", filename: "a.txt", contentType: "text/plain", bytes: 10 });
		expect(() => store.assertOwned("mb2", att.id)).toThrow(AttachmentError);
	});

	test("rejects an upload over the size cap", () => {
		expect(() => store.put({ mailboxId: "mb1", filename: "big.bin", contentType: "application/octet-stream", bytes: 2 * 1024 * 1024 })).toThrow(
			/too large/i,
		);
	});

	test("rejects a blob ref for a mailbox that does not own it", () => {
		const att = store.put({ mailboxId: "mb1", filename: "a.txt", contentType: "text/plain", bytes: 10 });
		expect(() => store.assertOwned("mb2", att.id)).toThrow(AttachmentError);
	});
});

describe("temporary upload cleanup", () => {
	test("abandoned temp uploads are reaped after the TTL", () => {
		let now = 1_000_000;
		const s = createAttachmentStore({ maxBytes: 1024, tempTtlMs: 1000, clock: () => now });
		s.put({ mailboxId: "mb1", filename: "tmp.txt", contentType: "text/plain", bytes: 4, temporary: true });
		now += 5000;
		const reaped = s.reapTemporary();
		expect(reaped).toBe(1);
	});

	test("referenced (non-temporary) blobs are never reaped", () => {
		let now = 1_000_000;
		const s = createAttachmentStore({ maxBytes: 1024, tempTtlMs: 1000, clock: () => now });
		const kept = s.put({ mailboxId: "mb1", filename: "keep.txt", contentType: "text/plain", bytes: 4 });
		now += 5000;
		s.reapTemporary();
		expect(s.get("mb1", kept.id)?.id).toBe(kept.id);
	});
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

describe("inline raster data policy", () => {
	test("accepts valid PNG data below the decoded-byte cap", () => {
		expect(rasterData(PNG, 1024)).toBe(PNG);
	});

	test.each([
		"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
		"data:text/html;base64,PHNjcmlwdD4=",
		"javascript:alert(1)",
		"https://tracker.example.invalid/pixel",
		"blob:https://example.invalid/image",
		"data:image/png;base64,PHN2Zz48L3N2Zz4=",
		"data:image/png;base64,not base64!",
		"data:image/png,unencoded",
	])("rejects active, remote, forged or malformed image data: %s", input => {
		expect(rasterData(input)).toBeNull();
	});

	test("enforces the hard maximum without recursive-regex crashes", () => {
		const bytes = Buffer.alloc(1024 * 1024);
		Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
		// Signature fixture only, not a valid complete PNG or provider bytes.
		const atCap = `data:image/png;base64,${bytes.toString("base64")}`;
		expect(rasterData(atCap)).toBe(atCap);
		expect(rasterData(`${atCap}AAAA`)).toBeNull();
		expect(rasterData(PNG, 2 * 1024 * 1024)).toBeNull();
	});

	test("enforces decoded size and refuses invalid limits", () => {
		expect(rasterData(PNG, 1)).toBeNull();
		expect(rasterData(PNG, Infinity)).toBeNull();
		expect(rasterData(PNG, -1)).toBeNull();
		expect(rasterData(null)).toBeNull();
	});
});
