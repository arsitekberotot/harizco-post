# Stalwart mailbox store — Compose deployment

Runs the local Stalwart store the app talks to over JMAP. This is the
**operator** deployment, distinct from the Task 5 *fixture* harness (see
`scripts/stalwart-fixtures.py`), which stays synthetic and short-lived.

## Pin and provenance

| Item | Value |
|---|---|
| Image | `stalwartlabs/stalwart:v0.16.25` (same release the fixtures pin) |
| Data volume | `harizco-stalwart-data` → `/opt/stalwart` |
| Host bind | **`127.0.0.1:8080`** (management + JMAP) |

## Exposure rule (do not weaken)

Every published port binds `127.0.0.1`. `mail.atelieriza.com` must reach the
**app UI + its API only** — never Stalwart's WebUI, JMAP, database, or SMTP.
Publishing `0.0.0.0` here would let anyone who finds the tunnel-adjacent host
reach the mailbox store directly, bypassing Cloudflare Access. If you need
remote access, route the *app* through the tunnel; do not expose this port.

## Bootstrap, then configure

The first boot runs in **bootstrap/recovery mode**: no config file exists, so
port 8080 opens for initial setup (it answers `302`). The admin credential is
`STALWART_RECOVERY_ADMIN` from `.env`. Real configuration is applied through
the management JMAP API afterwards — Stalwart 0.16.25 uses a JSON data-store
entrypoint, **not** the older TOML format. Do not apply old TOML examples.

## Operation

```bash
# .env must define STALWART_RECOVERY_ADMIN (gitignored; 0600):
#   STALWART_RECOVERY_ADMIN=admin:<32-char-random>

sg docker -c 'docker compose up -d'          # start
sg docker -c 'docker compose ps'             # status
sg docker -c 'docker logs --tail 50 harizco-stalwart'
sg docker -c 'docker compose down'           # stop (keeps the volume)

# DESTRUCTIVE — deletes all mail state. Only with explicit approval.
#   sg docker -c 'docker compose down -v'
```

`sg docker -c '...'` is required on hosts where the `docker` group was added to
the user *after* the shell session started; it applies the group for one
command without a re-login.

## Secrets

`.env` holds the bootstrap admin credential and is **gitignored** (`.gitignore`
line `.env`) with mode `0600`. Never commit it, print it, or paste it into a
chat. Generated locally with `head -c 32 /dev/urandom | base64`.
