// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// SYNTHETIC browser security probes, never provider or persistence evidence.

import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { FIXTURE_LABEL, FIXTURE_MAILBOX_ID } from "../fixtures/mail/data";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const tracker = "https://tracker.example.invalid";
const iframe = 'iframe[title="Email content"]';
let harness: string;

// Exercise the actual component, including effect/prop changes, without adding
// a production route. Only this synthetic harness is fulfilled by Playwright.
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React from "react";
import { createRoot } from "react-dom/client";
import EmailIframe from "./app/components/EmailIframe";
const root = createRoot(document.getElementById("root"));
window.renderEmail = ({cidData, ...props}) => root.render(React.createElement(EmailIframe, {
  ...props, resolveCidImage: cid => Object.prototype.hasOwnProperty.call(cidData || {}, cid) ? cidData[cid] : null
}));`,
			resolveDir: process.cwd(),
			loader: "tsx",
		},
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		jsx: "automatic",
	});
	harness = result.outputFiles[0].text;
});

interface ProbeProps {
	body: string;
	autoSize?: boolean;
	blockRemoteImages?: boolean;
	contentType?: "text/html" | "text/plain";
	cidData?: Record<string, string>;
}

async function observeNetwork(page: Page) {
	const requests: string[] = [];
	const origin = new URL(test.info().project.use.baseURL as string).origin;
	await page.route("**/*", async route => {
		const request = route.request();
		const url = new URL(request.url());
		// Intercept ALL iframe network requests and ALL off-origin requests, so
		// even a failing RED cannot send anything to an external service.
		if (request.frame().parentFrame() || url.origin !== origin) {
			requests.push(request.url());
			await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG.split(",")[1], "base64") });
		} else {
			await route.continue();
		}
	});
	return requests;
}

async function mount(page: Page, props: ProbeProps) {
	await page.route("**/__task17_security", route => route.fulfill({
		contentType: "text/html",
		body: '<!doctype html><title>SYNTHETIC Task17 security harness</title><div id="root"></div>',
	}));
	await page.goto("/__task17_security");
	await page.addScriptTag({ content: harness });
	await render(page, props);
}

async function render(page: Page, props: ProbeProps) {
	await page.evaluate(props => {
		(window as unknown as { renderEmail: (props: ProbeProps) => void }).renderEmail(props);
	}, props);
	await expect(page.locator(iframe)).toHaveCount(1);
	await expect.poll(() => page.locator(iframe).getAttribute("srcdoc")).toContain("<body>");
}

async function settled(page: Page) {
	await expect.poll(async () => {
		const frame = await page.locator(iframe).contentFrame().locator("body").count();
		return frame;
	}).toBe(1);
	// Includes image loads and the component's last height-report timer.
	await page.waitForTimeout(500);
}

async function evidence(page: Page, requests: string[]) {
	await test.info().attach("network-attempts.json", { body: JSON.stringify(requests, null, 2), contentType: "application/json" });
	await test.info().attach("srcdoc.html", { body: await page.locator(iframe).getAttribute("srcdoc") ?? "", contentType: "text/html" });
	await test.info().attach("reader.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

test("built mailbox reader blocks tracker and unresolved attachment requests by default", async ({ page }) => {
	const requests = await observeNetwork(page);
	await page.goto(`/mailbox/${FIXTURE_MAILBOX_ID}/emails/inbox`);
	await page.getByText("Synthetic image and attachment message", { exact: true }).click();
	await expect(page.frameLocator(iframe).getByText(FIXTURE_LABEL, { exact: true })).toBeVisible();
	await settled(page);
	await evidence(page, requests);
	expect(requests).toEqual([]);
	await expect(page.frameLocator(iframe).locator('img[alt="pixel"]')).not.toHaveAttribute("src", /./);
	await expect(page.frameLocator(iframe).locator('img[alt="logo"]')).not.toHaveAttribute("src", /./);
});

test("unquoted, entity, srcset, CSS and font trackers never load", async ({ page }) => {
	const requests = await observeNetwork(page);
	await mount(page, { body: `<p>synthetic network probe</p>
<img src="${tracker}/quoted"><img src=${tracker}/unquoted>
<img src="https&#58;//tracker.example.invalid/entity">
<img src="//tracker.example.invalid/protocol-relative"><img src="/api/v1/private">
<img srcset="${tracker}/srcset 1x, ${tracker}/srcset2 2x">
<p style="background-image:url('${tracker}/css')">styled text</p>
<table background="${tracker}/legacy"><tr><td>legacy</td></tr></table>
<style>@import '${tracker}/import'; @font-face {font-family:evil;src:url('${tracker}/font')} p {font-family:evil;background:url('${tracker}/style')}</style>
<link rel="stylesheet" href="${tracker}/link"><video poster="${tracker}/poster"><source src="${tracker}/media"></video>` });
	await settled(page);
	await evidence(page, requests);
	expect(requests).toEqual([]);
	const frame = page.frameLocator(iframe);
	await expect(frame.locator("[style], [background], [srcset], style:not(head style), link, video, source")).toHaveCount(0);
	await expect(frame.locator("img[src]")).toHaveCount(0);
});

test("active HTML and SVG attachments cannot execute or navigate", async ({ page }) => {
	const requests = await observeNetwork(page);
	await mount(page, { body: `<p>safe message</p><script>window.__hostileExecuted = true; fetch('${tracker}/script')</script>
<img alt="event" src="${tracker}/event" onerror="window.__hostileExecuted=true">
<a href="javascript:window.__hostileExecuted=true">javascript link</a>
<a href="data:text/html,<script>alert(1)</script>">HTML link</a>
<svg onload="window.__hostileExecuted=true"><image href="${tracker}/svg"></image></svg>
<object data="data:text/html,evil"></object><embed src="${tracker}/embed">
<iframe src="${tracker}/nested"></iframe><form action="${tracker}/form"><input autofocus onfocus="window.__hostileExecuted=true"></form>
<meta http-equiv="refresh" content="0;url=${tracker}/refresh">
<img alt="SVG attachment" src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=">
<img alt="HTML attachment" src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">` });
	await settled(page);
	await evidence(page, requests);
	const frame = page.frameLocator(iframe);
	await expect(frame.locator("script, svg, object, embed, iframe, form, input, meta[http-equiv=refresh], [onerror], [onload], [onfocus]")).toHaveCount(0);
	await expect(frame.locator('a[href^="javascript:"], a[href^="data:"], img[src]')).toHaveCount(0);
	expect(requests).toEqual([]);
	expect(await frame.locator("body").evaluate(() => (window as unknown as { __hostileExecuted?: boolean }).__hostileExecuted)).toBeUndefined();
});

test("only bounded raster image data and authorized CID data can render", async ({ page }) => {
	const requests = await observeNetwork(page);
	await mount(page, {
		body: `<p>synthetic CID probe</p><img alt="known" src=cid:logo><img alt="encoded" src="cid&#58;logo">
<img alt="missing" src="cid:missing"><img alt="unsafe" src="cid:unsafe"><img alt="remote" src="cid:remote">
<img alt="oversized" src="cid:oversized"><img alt="raster" src="${PNG}">
<img alt="fake raster" src="data:image/png;base64,PHN2Zz48L3N2Zz4=">`,
		cidData: {
			logo: PNG,
			unsafe: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
			remote: `${tracker}/not-authorized-by-data`,
			oversized: PNG + "A".repeat(2 * 1024 * 1024),
		},
	});
	await settled(page);
	await evidence(page, requests);
	const frame = page.frameLocator(iframe);
	for (const alt of ["known", "encoded", "raster"]) {
		await expect(frame.locator(`img[alt="${alt}"]`)).toHaveAttribute("src", PNG);
		expect(await frame.locator(`img[alt="${alt}"]`).evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
	}
	for (const alt of ["missing", "unsafe", "remote", "oversized", "fake raster"]) {
		await expect(frame.locator(`img[alt="${alt}"]`)).not.toHaveAttribute("src", /./);
	}
	expect(requests).toEqual([]);
});

test("text-only markup remains literal rather than becoming an active document", async ({ page }) => {
	const requests = await observeNetwork(page);
	const text = `<b>literal</b>\n<img src=${tracker}/plain onerror=alert(1)>& text`;
	await mount(page, { body: text, contentType: "text/plain" });
	await settled(page);
	await evidence(page, requests);
	await expect(page.frameLocator(iframe).locator("pre")).toHaveText(text);
	await expect(page.frameLocator(iframe).locator("b, img")).toHaveCount(0);
	expect(requests).toEqual([]);
});

test("opaque sandbox and nonce CSP retain safe auto-sizing without parent access", async ({ page }) => {
	const requests = await observeNetwork(page);
	await mount(page, { body: "<p>opaque sandbox</p>".repeat(20), autoSize: true });
	await settled(page);
	await evidence(page, requests);
	await expect(page.locator(iframe)).not.toHaveAttribute("sandbox", /allow-same-origin|allow-top-navigation/);
	await expect(page.locator(iframe)).toHaveAttribute("referrerpolicy", "no-referrer");
	const frame = page.frameLocator(iframe);
	const sandbox = await frame.locator("body").evaluate(() => {
		let parentReadable = false;
		try { parentReadable = !!parent.document.body; } catch { /* opaque origin */ }
		return { origin: globalThis.origin, parentReadable };
	});
	expect(sandbox).toEqual({ origin: "null", parentReadable: false });
	const csp = await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
	expect(csp).toContain("img-src data:");
	expect(csp).not.toContain("https:");
	expect(csp).toMatch(/script-src 'nonce-[^']+'/);
	expect(csp).toContain("form-action 'none'");
	expect(await page.locator(iframe).evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(100);
});

test("remote-image permission changes rewrite srcdoc and stay limited to HTTPS images", async ({ page }) => {
	const requests = await observeNetwork(page);
	const body = `<p>permission probe</p><img alt="remote" src="${tracker}/explicit"><img alt="http" src="http://tracker.example.invalid/insecure"><p style="background:url('${tracker}/still-blocked')">no CSS network</p>`;
	await mount(page, { body });
	await settled(page);
	expect(requests).toEqual([]);
	await render(page, { body, blockRemoteImages: false });
	await expect(page.frameLocator(iframe).locator('img[alt="remote"]')).toHaveAttribute("src", `${tracker}/explicit`);
	await settled(page);
	expect(requests).toEqual([`${tracker}/explicit`]);
	await render(page, { body });
	await expect(page.frameLocator(iframe).locator('img[alt="remote"]')).not.toHaveAttribute("src", /./);
	await settled(page);
	await evidence(page, requests);
	expect(requests).toEqual([`${tracker}/explicit`]);
});

test("empty body replaces previous message instead of retaining it", async ({ page }) => {
	await mount(page, { body: "<p>old private content</p>" });
	await expect(page.frameLocator(iframe).getByText("old private content")).toBeVisible();
	await render(page, { body: "" });
	await expect(page.frameLocator(iframe).getByText("old private content")).toHaveCount(0);
});
