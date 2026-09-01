# Deploy with Docker

The fastest way to get a backend of your own. One command brings up the API and
its MySQL database together, on anything that runs Docker: a laptop, a five
dollar VPS, or a managed container host.

If you would rather install Node and MySQL directly, see
[DEPLOYMENT.md](../../DEPLOYMENT.md). If you have not registered the Bitrix24
application yet, start at [SETUP.md](../SETUP.md): you need the client ID and
secret from it before anything here will work.

## 1. Get the code and the configuration

```bash
git clone https://github.com/PalWorks/bitrix24-comment-manager
cd bitrix24-comment-manager
cp .env.docker.example .env
```

## 2. Fill in `.env`

Generate the two secrets:

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

Then set, at minimum:

| Variable | What it is |
|---|---|
| `JWT_SECRET` | Signs the session tokens the extension holds |
| `TOKEN_ENCRYPTION_KEY` | Encrypts Bitrix24 refresh tokens at rest. Exactly 64 hex characters |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` | Any strong values. Nothing outside the compose network sees them |
| `BITRIX24_CLIENT_ID`, `BITRIX24_CLIENT_SECRET` | From your Bitrix24 local application |
| `BITRIX24_ALLOWED_PORTALS` | Which portals this backend will authenticate, comma separated |
| `BACKEND_URL` | The public https origin, matching the redirect URI you registered |
| `CORS_ORIGINS` | `chrome-extension://<your extension id>` |

Keep `TOKEN_ENCRYPTION_KEY` somewhere safe. Lose it and every stored Bitrix24
token becomes undecryptable, and all agents must reconnect.

## 3. Start it

```bash
docker compose up -d
docker compose logs -f backend
```

The database container applies `backend/migrations/` in numeric order on first
start, so the schema, the audit log immutability triggers and the retention job
are all in place before the backend accepts a request.

Check it:

```bash
curl http://127.0.0.1:3000/health      # {"status":"ok"}
curl http://127.0.0.1:3000/readiness   # config and database checks
```

`readiness` answering 503 with `"database": false` means the backend is up but
the database is not reachable yet. Give it a few seconds on a first start.

## 4. Put HTTPS in front

Port 3000 is published on loopback only, by design. The extension refuses any
backend origin that is not https unless it is localhost, so a public deployment
needs a reverse proxy terminating TLS.

Caddy is the shortest route, since it obtains and renews the certificate on its
own:

```
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx, Traefik or a cloud load balancer all work equally well. Whatever you
use, it must pass `X-Forwarded-Proto`, which the backend reads to decide
whether a request already arrived over TLS.

## 5. Point the extension at it

Open the extension's options page, choose **Deploy your own**, and paste the
origin, for example `https://api.example.com`, into **Backend URL**. Then open
the popup and connect your Bitrix24 account.

## Operating it

```bash
docker compose logs -f backend      # follow logs
docker compose pull && docker compose up -d --build   # update
docker compose down                 # stop, keeping data
docker compose down -v              # stop and delete the database volume
```

Back up the `db-data` volume. It holds the audit log, which is the record the
whole system exists to produce, and the encrypted Bitrix24 tokens.

```bash
docker compose exec db \
  mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" b24_comments > backup.sql
```

## Notes

- **Run one instance.** The JWT blacklist, OAuth state and rate limiter windows
  live in process. Two instances behind a load balancer will misbehave in the
  ways described in `backend/src/config.ts`.
- **The retention job needs the MySQL event scheduler**, which the compose file
  turns on with `--event-scheduler=ON`. If you run MySQL elsewhere, either
  enable it or call `purge_expired_audit_logs` from cron.
- **The support mailbox is optional.** `RESEND_API_KEY`, `SUPPORT_FROM_EMAIL`
  and `SUPPORT_TO_EMAIL` only matter for the deployment that answers the
  extension's Get help form. Leave them empty and the support endpoint stays
  off. Setting some but not all of them is rejected at startup.
