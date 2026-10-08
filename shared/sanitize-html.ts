// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Dependency-free filename and raster-data policy shared by Node/browser.
// HTML parsing/sanitization lives in app/lib/sanitize-email.ts with DOMPurify;
// regex-based image rewriting is NOT a safe HTML security boundary.

/** Characters that must never appear in a filename, Content-Disposition, or header. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Reduce an arbitrary client filename to a safe basename.
 * - strips any directory component (POSIX or Windows);
 * - removes control chars incl. CR/LF so a filename cannot inject a header;
 * - never returns a leading dot; falls back to `attachment`.
 */
export function sanitizeFilename(input: string): string {
	if (typeof input !== "string") return "attachment";
	let name = input.split(/[\\/]/).pop() ?? "";
	name = name.replace(CONTROL_CHARS, "").trim().replace(/^\.+/, "");
	if (name.length > 200) {
		const dot = name.lastIndexOf(".");
		const ext = dot > 0 ? name.slice(dot) : "";
		// An unbounded extension must not turn the prefix endpoint negative.
		name = ext.length < 200 ? name.slice(0, 200 - ext.length) + ext : name.slice(0, 200);
	}
	// Normalize lone surrogates, including a pair split by the length bound.
	name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, part => part.length === 2 ? part : "\uFFFD");
	return name === "" ? "attachment" : name;
}

export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

/** Only bounded base64 raster data with a matching file signature, never SVG,
 * HTML, blob URLs, CID URLs or remote locations. This is not a full decoder. */
export function safeInlineImageData(input: string | null, maxBytes = MAX_INLINE_IMAGE_BYTES): string | null {
	if (typeof input !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_INLINE_IMAGE_BYTES) return null;
	// Bound the work before parsing or decoding attacker-controlled content.
	if (input.length > Math.ceil(maxBytes / 3) * 4 + 32) return null;
	const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(input);
	if (!match) return null;
	const [, type, encoded] = match;
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
	const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
	if (bytes === 0 || bytes > maxBytes) return null;
	const header = atob(encoded.slice(0, 24));
	const valid = type.toLowerCase() === "png" ? header.startsWith("\x89PNG\r\n\x1a\n")
		: type.toLowerCase() === "jpeg" ? header.startsWith("\xff\xd8\xff")
		: type.toLowerCase() === "gif" ? /^GIF8[79]a/.test(header)
		: header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
	return valid ? input : null;
}
