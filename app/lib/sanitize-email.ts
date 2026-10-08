// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { safeInlineImageData } from "../../shared/sanitize-html";

export interface EmailContentOptions {
	contentType?: "text/html" | "text/plain";
	blockRemoteImages?: boolean;
	/** Already-authorized, bounded bytes encoded as data, NEVER an API URL.
	 * The message parent must fetch/authorize these before rendering. */
	resolveCidImage?: (cid: string) => string | null;
}

/** Browser-only DOM parsing: regex is not an HTML/network security boundary. */
export function sanitizeEmailContent(body: string, options: EmailContentOptions = {}): string {
	const template = document.createElement("template");
	if (options.contentType === "text/plain") {
		const pre = document.createElement("pre");
		pre.textContent = body;
		template.content.append(pre);
		return template.innerHTML;
	}

	// A deliberately small email-formatting profile. No sender CSS (including
	// style attributes), srcset, media, SVG, forms, meta, links or active embeds.
	// Template content remains inert while resource attributes are filtered.
	template.innerHTML = DOMPurify.sanitize(body, {
		ALLOWED_TAGS: ["a", "abbr", "b", "blockquote", "br", "caption", "code", "dd", "del", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tfoot", "tr", "u", "ul"],
		ALLOWED_ATTR: ["alt", "colspan", "height", "href", "rowspan", "scope", "src", "title", "width"],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		FORCE_BODY: true,
	});

	for (const image of template.content.querySelectorAll("img")) {
		const src = (image.getAttribute("src") ?? "").trim();
		let data: string | null = null;
		if (/^cid:/i.test(src)) {
			// Fail closed for unknown CIDs/resolver errors. No iframe fetch with
			// cookies or an opaque Origin:null is used to resolve them.
			try { data = safeInlineImageData(options.resolveCidImage?.(src.slice(4)) ?? null); } catch { /* blocked */ }
		} else {
			data = safeInlineImageData(src);
		}
		if (data) {
			image.setAttribute("src", data);
		} else if (options.blockRemoteImages === false && /^https:\/\//i.test(src)) {
			image.setAttribute("src", src);
		} else {
			image.removeAttribute("src");
		}
	}

	for (const link of template.content.querySelectorAll("a")) {
		const href = (link.getAttribute("href") ?? "").trim();
		if (/^(https?:\/\/|mailto:)/i.test(href)) {
			link.setAttribute("target", "_blank");
			link.setAttribute("rel", "noopener noreferrer");
		} else {
			link.removeAttribute("href");
		}
	}
	return template.innerHTML;
}
