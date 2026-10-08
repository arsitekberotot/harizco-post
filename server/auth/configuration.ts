import { isIP } from "node:net";
import type { AppAccessConfig, AppConfig } from "../config";

const TEAM_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function parseAccessConfig(team: string, aud: string, email: string): AppAccessConfig {
  const slug = team.endsWith(".cloudflareaccess.com") ? team.slice(0, -".cloudflareaccess.com".length) : team;
  if (!TEAM_SLUG.test(slug) || (team !== slug && team !== `${slug}.cloudflareaccess.com`) ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(aud) || !isValidEmail(email)) {
    throw new Error("Invalid Access configuration");
  }
  return { teamDomain: `${slug}.cloudflareaccess.com`, policyAud: aud, ownerEmail: email };
}

export function isValidEmail(email: unknown): email is string {
  if (typeof email !== "string" || email.length > 254) return false;
  const parts = email.split("@");
  return parts.length === 2 && parts[0].length >= 1 && parts[0].length <= 64 &&
    /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/.test(parts[0]) &&
    parts[1].length <= 253 && DNS_NAME.test(parts[1]) && !isIP(parts[1]);
}

/** A literal canonical HTTPS browser origin, not the tunnel's HTTP transport. */
export function parsePublicOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.origin === raw && !url.username && !url.password &&
        url.hostname.length <= 253 && DNS_NAME.test(url.hostname) && !isIP(url.hostname)) return raw;
  } catch { /* Generic error below must never reflect the supplied value. */ }
  throw new Error("Invalid PUBLIC_ORIGIN configuration");
}

export function assertTestOnly(config: AppConfig): void {
  if (config.isProduction || config.nodeEnv !== "test" || process.env.NODE_ENV !== "test") {
    throw new Error("Test-only fixture/transport authentication is forbidden in production or non-test composition");
  }
}

/** Recheck manually composed configs too; a forged boolean is not a bypass. */
export function validateWebSecurityConfig(config: AppConfig): void {
  if (config.access) parseAccessConfig(config.access.teamDomain, config.access.policyAud, config.access.ownerEmail);
  if (config.publicOrigin) parsePublicOrigin(config.publicOrigin);
  if (config.isProduction || config.nodeEnv === "production" || process.env.NODE_ENV === "production") {
    if (!config.access) throw new Error("Production requires valid Access configuration");
    if (!config.publicOrigin) throw new Error("Production requires valid PUBLIC_ORIGIN configuration");
  }
}
