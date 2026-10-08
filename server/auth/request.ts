import type { AppConfig } from "../config";
import { timingSafeEqual } from "node:crypto";
import { createAccessVerifier, type AccessTestOptions } from "./access";
import { assertTestOnly, validateWebSecurityConfig } from "./configuration";

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Length is compared first (unavoidable, and not secret for a fixed-format
 * shared token); the byte comparison is constant-time. Returns false when
 * either side is empty so a missing header never matches an unset secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function applyPrivateHeaders(headers: Headers): void {
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
}

export function privateError(status: number, error: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  applyPrivateHeaders(headers);
  return new Response(JSON.stringify({ error }), { status, headers });
}

export function isLoopbackHealth(request: Request): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  return url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD") &&
    url.hostname === "127.0.0.1" && host === url.host;
}

/** Authenticate before body consumption, backend access, or static/SPA reads. */
export function createRequestGate(config: AppConfig, mode: "access" | "fixture", testOnly?: AccessTestOptions) {
  validateWebSecurityConfig(config);
  if (mode === "fixture") assertTestOnly(config);
  const verify = createAccessVerifier(config, testOnly);
  const authority = config.publicOrigin ? new URL(config.publicOrigin).host : undefined;
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return isLoopbackHealth(request) ? null : privateError(403, "Forbidden");
    if (mode === "fixture") return null;
    if (!authority || request.headers.get("host") !== authority) return privateError(403, "Forbidden");
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if ((origin !== null && origin !== config.publicOrigin) || site === "cross-site" ||
        (mutation && (origin !== config.publicOrigin || request.headers.get("x-harizco-csrf") !== "1" ||
          (site !== null && site !== "same-origin")))) return privateError(403, "Forbidden");
    if (!await verify(request.headers.get("cf-access-jwt-assertion"))) return privateError(403, "Forbidden");
    return null;
  };
}
