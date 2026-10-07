import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFixturePreviewServer } from "../helpers/fixture-preview";

let scratch: string;
let server: Server;
let port: number;

beforeEach(async () => {
	if (!process.env.TMPDIR) throw new Error("TMPDIR is required for isolated fixtures");
	scratch = await mkdtemp(join(process.env.TMPDIR, "fixture-preview-test-"));
	const client = join(scratch, "client");
	await mkdir(client);
	await mkdir(join(scratch, "client-secret"));
	await writeFile(join(client, "index.html"), "<html>synthetic shell</html>");
	await writeFile(join(client, "asset.js"), "/* synthetic asset */");
	await writeFile(join(scratch, "client-secret", "example.txt"), "outside sentinel");
	await symlink(join(scratch, "client-secret"), join(client, "escape"));
	server = createFixturePreviewServer(client);
	expect(server.listening).toBe(false);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	port = (server.address() as { port: number }).port;
});

afterEach(async () => {
	if (server?.listening) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

function get(path: string, host = "127.0.0.1") {
	return new Promise<{ status: number; body: string; identity: string | string[] | undefined }>((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port, path, headers: { host }, agent: false }, res => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", chunk => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode!, body, identity: res.headers["x-harizco-fixture"] }));
			res.on("error", reject);
		});
		req.setTimeout(500, () => req.destroy(new Error("preview did not respond")));
		req.on("error", reject);
		req.end();
	});
}

test("readiness identifies synthetic preview and static/deep links load", async () => {
	const health = await get("/health");
	expect(health.status).toBe(200);
	expect(health.identity).toBe("synthetic-test-fixture");
	expect(JSON.parse(health.body)).toMatchObject({ ok: true, mode: "fixture-preview" });
	expect((await get("/asset.js")).body).toBe("/* synthetic asset */");
	expect((await get("/mailbox/fixture-mailbox-owner/emails/inbox")).body).toContain("synthetic shell");
});

test.each([
	["/api/v1/mailboxes/%ZZ", "127.0.0.1"],
	["/%ZZ", "127.0.0.1"],
	["/health?bad=%ZZ", "127.0.0.1"],
	["/health", "[broken"],
	["http://[broken", "127.0.0.1"],
])("rejects malformed request %s / %s and stays alive", async (path, host) => {
	expect((await get(path, host)).status).toBe(400);
	expect((await get("/health")).status).toBe(200);
});

test.each(["/..%2fclient-secret/example.txt", "/escape/example.txt"])("blocks escape %s", async path => {
	const response = await get(path);
	expect(response.status).toBe(403);
	expect(response.body).not.toContain("outside sentinel");
	expect((await get("/health")).status).toBe(200);
});

test.each(["/missing.js", "/unknown", "/api/no-such-route"])("does not mask missing resource %s with SPA HTML", async path => {
	expect((await get(path)).status).toBe(404);
});
