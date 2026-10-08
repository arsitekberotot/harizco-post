import { expect, test } from "@playwright/test";

test("configured mailbox addresses require explicit per-address activation", async ({ page }) => {
	let mailboxes = [
		{ id: "hanif@atelieriza.com", email: "hanif@atelieriza.com", name: "Hanif" },
	];
	const activationRequests: Array<{ email: string; name: string }> = [];

	await page.route("**/api/v1/config", (route) => route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({
			domains: ["atelieriza.com"],
			emailAddresses: ["hanif@atelieriza.com", "natla@atelieriza.com"],
		}),
	}));
	await page.route("**/api/v1/mailboxes", async (route) => {
		if (route.request().method() === "GET") {
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mailboxes) });
		}
		if (route.request().method() === "POST") {
			const body = route.request().postDataJSON() as { email: string; name: string };
			activationRequests.push(body);
			mailboxes = [...mailboxes, { id: body.email, email: body.email, name: body.name }];
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mailboxes.at(-1)) });
		}
		return route.fulfill({ status: 405, body: "Method not allowed" });
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Mailboxes" })).toBeVisible();
	await expect(page.getByText("hanif@atelieriza.com", { exact: true })).toBeVisible();
	await expect(page.getByText("natla@atelieriza.com", { exact: true })).toHaveCount(0);
	await expect.poll(() => activationRequests).toHaveLength(0);

	await page.getByRole("button", { name: "Add mailbox" }).click();
	await expect(page.getByRole("heading", { name: "Add Mailbox" })).toBeVisible();
	await page.getByRole("combobox", { name: "Pre-provisioned address" }).click();
	await page.getByRole("option", { name: "natla@atelieriza.com" }).click();
	await page.getByRole("button", { name: "Add", exact: true }).click();

	await expect.poll(() => activationRequests).toEqual([{ email: "natla@atelieriza.com", name: "natla" }]);
	await expect(page.getByRole("link", { name: /natla@atelieriza\.com/ })).toBeVisible();
});
