// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Harizco Post: retained mail UI contracts at desktop and mobile sizes.
// GREEN depends on Task 3 (build + fixture preview) and Task 4 (branding,
// hide AI/MCP). Baseline screenshots are not claimed generated in Task 2.

import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_LABEL, FIXTURE_MAILBOX_ID } from "../fixtures/mail/data";

const mailboxRoot = `/mailbox/${FIXTURE_MAILBOX_ID}`;
const inboxPath = `${mailboxRoot}/emails/inbox`;
const settingsPath = `${mailboxRoot}/settings`;
const sentPath = `${mailboxRoot}/emails/sent`;
const inboxName = /^Inbox\s*1$/i;

async function inboxReady(page: Page) {
	await expect(page.getByText("Synthetic follow-up", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: inboxName })).toHaveCount(1);
}

async function openNavigation(page: Page) {
	if ((page.viewportSize()?.width ?? 1280) < 768) {
		await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
	}
	await expect(page.getByRole("link", { name: inboxName })).toBeInViewport();
	await expect(page.getByRole("button", { name: /^Compose$/i })).toBeInViewport();
}

async function settingsReady(page: Page) {
	await expect(page.getByRole("heading", { name: /^Settings$/i })).toBeVisible();
	await expect(page.getByLabel(/Display Name/i)).toHaveValue("Fixture Owner");
	await expect(page.getByLabel(/^Email$/i)).toHaveValue("owner@harizco-post.invalid");
}

test.describe("mail layout", () => {
	test("home and direct mailbox loads render route-specific content", async ({ page }) => {
		await page.goto("/");
		// The product name is the document title; the visible home heading is
		// the mailbox list heading.
		await expect(page).toHaveTitle(/Harizco Post/i);
		await expect(page.getByRole("heading", { name: /^Mailboxes$/i })).toBeVisible();
		await page.goto(inboxPath);
		await inboxReady(page);
		await page.goto(sentPath);
		await expect(page.getByText("No sent emails", { exact: true })).toBeVisible();
		await page.goto(settingsPath);
		await settingsReady(page);
	});

	test("Sent and Settings controls navigate within the document", async ({ page }) => {
		await page.goto(inboxPath);
		await inboxReady(page);
		const document = await page.evaluateHandle(() => window.document);
		await openNavigation(page);
		await page.getByRole("link", { name: /^Sent$/i }).click();
		await expect(page).toHaveURL(new RegExp(`${sentPath}$`));
		await expect(page.getByText("No sent emails", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${settingsPath}$`));
		await settingsReady(page);
		expect(await document.evaluate(original => original === window.document)).toBe(true);
		await document.dispose();
	});

	test("inbox and reader shell show synthetic mail", async ({ page }, testInfo) => {
		await page.goto(inboxPath);
		await inboxReady(page);
		// The already-read message opens without a mark-read mutation.
		await page.getByText("Synthetic follow-up", { exact: true }).click();
		await expect(page.frameLocator('iframe[title="Email content"]').getByText(FIXTURE_LABEL, { exact: true })).toBeVisible();
		if (process.env.HARIZCO_CAPTURE_BASELINE === "1") {
			await page.screenshot({
				path: `test-results/mail-layout-${testInfo.project.name}.png`,
				fullPage: true,
			});
		}
	});

	test("compose opens from exposed mailbox navigation", async ({ page }) => {
		await page.goto(inboxPath);
		await inboxReady(page);
		await openNavigation(page);
		await page.getByRole("button", { name: /^Compose$/i }).click();
		// The composer renders a "To" field; Kumo labels it with visible text
		// beside a textbox that carries the recipient placeholder.
		await expect(page.getByRole("heading", { name: /New Message/i })).toBeVisible();
		await expect(page.getByText("To", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: /recipient@example\.com/i }),
		).toBeVisible();
	});

	test("display-name settings remain available", async ({ page }) => {
		await page.goto(settingsPath);
		await settingsReady(page);
	});

	test("loaded inbox and settings do not present AI or MCP controls", async ({ page }) => {
		await page.goto(inboxPath);
		await inboxReady(page);
		await openNavigation(page);
		await expect(page.getByRole("button", { name: /Toggle agent panel/i })).toHaveCount(0);
		await expect(page.getByText(/Show agent panel/i)).toHaveCount(0);
		await expect(page.getByText(/MCP/i)).toHaveCount(0);
		await page.goto(settingsPath);
		await settingsReady(page);
		await expect(page.getByText(/AI Agent Prompt/i)).toHaveCount(0);
		await expect(page.getByText(/Customize how the AI agent/i)).toHaveCount(0);
		await expect(page.getByText(/MCP/i)).toHaveCount(0);
	});
});
