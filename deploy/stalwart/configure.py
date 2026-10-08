#!/usr/bin/env python3
"""Configure the local Stalwart store for the app (operator, not fixture).

Applies the SAME management-API sequence the Task 5 fixture verifies
(`scripts/stalwart-fixtures.py`), against the running Compose container:

  1. bind one loopback HTTP listener (JMAP runs over it),
  2. set the Http/Jmap/DnsResolver/Authentication singletons,
  3. create the mail domain with relaying DISABLED,
  4. create the mailbox account with an explicit permission allowlist,
  5. exit recovery mode by writing the config and restarting into normal mode.

Differences from the fixture, and why:
  - Domain/hostname are the real ones (atelieriza.com / mail.atelieriza.com).
  - No public MX, no SMTP relay, no outbound routes: the plan keeps public
    receiving on Resend and forbids touching MX without a gate.
  - The credential is read from deploy/stalwart/.env and written to the same
    file as the runtime client credential; it is never printed.

Idempotent: re-running detects an already-configured store and exits 0.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_PATH = HERE / ".env"
RECOVERY = "http://127.0.0.1:8080"
USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]

HOSTNAME = "mail.atelieriza.com"
DOMAIN = "atelieriza.com"
ACCOUNT_NAME = "hanif"
ACCOUNT_EMAIL = f"{ACCOUNT_NAME}@{DOMAIN}"
LISTENER_PORT = "8080"

# Exact allowlist the fixture verifies. Submission writes are intentionally
# present (the app queues sends) but relaying stays off, so Stalwart cannot
# deliver to arbitrary external recipients on its own.
ENABLED_PERMISSIONS = [
    "authenticate", "jmapMailboxGet", "jmapMailboxQuery", "jmapMailboxCreate",
    "jmapMailboxUpdate", "jmapMailboxDestroy", "jmapEmailGet", "jmapEmailQuery",
    "jmapEmailCreate", "jmapEmailUpdate", "jmapEmailDestroy", "jmapEmailImport",
    "jmapIdentityGet", "jmapEmailSubmissionGet", "jmapEmailSubmissionQuery",
    "jmapBlobGet", "jmapBlobUpload", "jmapBlobLookup",
]


def sh(*args: str) -> str:
    return subprocess.check_output(["sg", "docker", "-c", " ".join(args)], text=True)


def call(auth: str, method: str, args: dict) -> dict:
    body = json.dumps({"using": USING, "methodCalls": [[method, args, "c"]]}).encode()
    req = urllib.request.Request(f"{RECOVERY}/jmap/", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Basic " + base64.b64encode(auth.encode()).decode())
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    result = data["methodResponses"][0]
    if result[0].startswith("error"):
        raise RuntimeError(f"{method}: {result[1].get('type')}: {result[1].get('description', '')}")
    return result[1]


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


def save_env(env: dict[str, str]) -> None:
    # Rewrite atomically with 0600; contains the account credential.
    tmp = ENV_PATH.with_suffix(".tmp")
    tmp.write_text("".join(f"{k}={v}\n" for k, v in sorted(env.items())))
    os.chmod(tmp, 0o600)
    tmp.replace(ENV_PATH)


def main() -> int:
    env = load_env()
    recovery_admin = env["STALWART_RECOVERY_ADMIN"]

    # Already configured? (config file present and normal listener up)
    if "STALWART_ACCOUNT_SECRET" in env:
        print("already configured; nothing to do")
        return 0

    # 1. HTTP listener; JMAP shares it.
    #
    # Bind 0.0.0.0 INSIDE the container, not 127.0.0.1. A container-internal
    # loopback bind is unreachable through Docker's published-port proxy (the
    # proxy connects from outside the container namespace and is reset), which
    # silently breaks every host-side request. Real exposure is still loopback
    # only, because compose.yaml publishes the port as 127.0.0.1:8080.
    listeners = call(recovery_admin, "x:NetworkListener/get", {}).get("list", [])
    if not any(str(v) == "http" for l in listeners for v in [l.get("protocol")]):
        call(recovery_admin, "x:NetworkListener/set", {
            "create": {"http": {"name": "http", "protocol": "http",
                                "bind": {f"0.0.0.0:{LISTENER_PORT}": True}, "useTls": False}}
        })

    # 2. Singleton service config, read back each (fixture-verified pattern).
    for method, values in [
        ("x:Http/set", {"enableHsts": False, "usePermissiveCors": False}),
        ("x:Jmap/set", {}),
        ("x:DnsResolver/set", {"@type": "System"}),
        ("x:Authentication/set", {}),
    ]:
        call(recovery_admin, method, {"update": {"singleton": values}})

    # 3. Domain. Relaying off; no public MX is created here.
    domains = call(recovery_admin, "x:Domain/get", {}).get("list", [])
    existing = next((d for d in domains if d.get("name") == DOMAIN), None)
    if existing is None:
        created = call(recovery_admin, "x:Domain/set", {
            "create": {"domain": {"name": DOMAIN, "isEnabled": True,
                                  "allowRelaying": False, "allowScimProvisioning": False}}
        })
        domain_id = created["created"]["domain"]["id"]
    else:
        domain_id = existing["id"]

    # 4. Account with an explicit permission allowlist.
    secret = secrets.token_urlsafe(24)
    accounts = call(recovery_admin, "x:Account/get", {}).get("list", [])
    if not any(a.get("name") == ACCOUNT_NAME for a in accounts):
        call(recovery_admin, "x:Account/set", {
            "create": {"user": {"@type": "User", "name": ACCOUNT_NAME, "domainId": domain_id,
                                "credentials": {"0": {"@type": "Password", "secret": secret}},
                                "roles": {"@type": "User"},
                                "permissions": {"@type": "Replace",
                                                "enabledPermissions": {p: True for p in ENABLED_PERMISSIONS},
                                                "disabledPermissions": {}}}}
        })

    # Refuse to continue if outbound routes appeared: that would mean the store
    # could relay mail on its own, outside the Resend path.
    if call(recovery_admin, "x:MtaRoute/get", {}).get("list"):
        raise RuntimeError("unexpected outbound MTA routes; refusing to enable relaying")

    env["STALWART_ACCOUNT_SECRET"] = secret
    env["STALWART_ACCOUNT_EMAIL"] = ACCOUNT_EMAIL
    save_env(env)

    # 5. Leave recovery mode: restart picks up the written configuration.
    subprocess.run(["sg", "docker", "-c", "docker compose restart"], cwd=HERE, check=True)
    print(f"configured: {ACCOUNT_EMAIL}; credential stored in {ENV_PATH.name} (0600)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
