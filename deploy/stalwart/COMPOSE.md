# Stalwart mailbox store — Compose deployment

Runs the local Stalwart store the app talks to over JMAP. This is the
**operator** deployment; it is distinct from the Task 5 *fixture* harness
(`scripts/stalwart-fixtures.py`), which stays synthetic and short-lived.

## Pin and provenance

| Item | Value |
|---|---|
| Image | `stalwartlabs/stalwart:v0.16.25` (same release the fixtures pin) |
| Config volume | `harizco-stalwart-config` → `/etc/stalwart` |
| Data volume | `harizco-stalwart-data` → `/var/lib/stalwart` |
| Host bind | **`127.0.0.1:8080`** (management + JMAP) |
| Mailbox | `hanif@atelieriza.com` on domain `atelieriza.com` |

## Exposure rule (do not weaken)

Every published port binds `127.0.0.1`. `mail.atelieriza.com` must reach the
**app UI + its API only** — never Stalwart's WebUI, JMAP, database, or SMTP.
Publishing `0.0.0.0` in `compose.yaml` would let anyone reaching the host touch
the mailbox store directly, bypassing Cloudflare Access.

The listener **inside** the container binds `0.0.0.0:8080`. That is required,
not a mistake: a container-internal loopback bind is unreachable through
Docker's published-port proxy, so host-side requests are reset. The host-side
`127.0.0.1:8080` mapping in `compose.yaml` is the actual boundary.

## First-time setup

```bash
# 1. Generate the bootstrap admin credential (gitignored, 0600).
umask 077
printf 'STALWART_RECOVERY_ADMIN=admin:%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)" > .env

# 2. Boot in recovery mode so the management API accepts the bootstrap admin.
STALWART_RECOVERY_MODE=true sg docker -c 'docker compose up -d'

# 3. Bind the HTTP/JMAP listener and create the domain + mailbox; the script
#    writes STALWART_ACCOUNT_* into .env and restarts into normal mode.
python3 configure.py
```

## Daily operation

```bash
sg docker -c 'docker compose up -d'          # start (normal mode)
sg docker -c 'docker compose ps'             # status
sg docker -c 'docker logs --tail 50 harizco-stalwart'
sg docker -c 'docker compose restart'
sg docker -c 'docker compose down'           # stop (keeps volumes)

# DESTRUCTIVE — deletes all mail state. Only with explicit approval.
#   sg docker -c 'docker compose down -v'
```

`sg docker -c '...'` is required on hosts where the `docker` group was added to
the user *after* the shell session started; it applies the group for one command
without a re-login.

## Verified working state

- JMAP session authenticates as `hanif@atelieriza.com` (HTTP 200), with `mail`
  and `submission` capabilities.
- Standard mailboxes present: Inbox, Sent Items, Drafts, Deleted Items,
  Junk Mail.
- Store survives `docker compose restart` / `--force-recreate` (named volumes).

## Pitfalls found the hard way

- **`STALWART_RECOVERY_MODE=true` is sticky.** Leaving it set keeps the server
  on the recovery listener even after configuration, so the normal HTTP
  listener never starts. It is opt-in in `compose.yaml`; unset it after setup.
- **The image ships `curl`, not `wget`.** A `wget` healthcheck silently fails
  with exit 127.
- **Data lives in `/var/lib/stalwart`, not `/opt/stalwart`.** The image declares
  both `/etc/stalwart` and `/var/lib/stalwart` as volumes; mounting elsewhere
  leaves real state on an anonymous volume that a recreate discards.
- **`allowRelaying` stays false and no MTA routes are created.** Public
  receiving is Resend's job; this store must not relay mail on its own.

## Secrets

`.env` holds the bootstrap admin credential and the mailbox account credential.
It is **gitignored** with mode `0600`. Never commit it, print it, or paste it
into a chat.
