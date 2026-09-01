# Deployment

This guide covers deploying your own instance of the backend and distributing the
extension. Everything here uses placeholders. Substitute your own values.

| Placeholder | Meaning |
|---|---|
| `api.example.com` | The public hostname of your backend |
| `your-portal.bitrix24.com` | Your Bitrix24 portal domain |
| `<extension-id>` | Your Chrome extension ID |

## Deployment topology

The backend is a stateless Node.js process. Any host that can run Node 20 and reach
both MySQL and the public internet works. Three tested shapes:

| Shape | When to use | Notes |
|---|---|---|
| Node behind a reverse proxy (nginx, Caddy, Traefik) | Default choice | Simplest. Terminate TLS at the proxy |
| Container (Docker) | You already run containers | `backend/Dockerfile` builds a production image |
| Shared hosting with a PHP front door | No root, cPanel style host | See [deploy/php-proxy/](deploy/php-proxy/) |

## 1. Register a Bitrix24 OAuth application

Full walkthrough in [docs/SETUP.md](docs/SETUP.md). In short: create a local
application on your portal, grant it the `crm` scope, set the redirect (handler) URI
to `https://api.example.com/auth/callback`, and note the client ID and secret.

## 2. Prepare the database

```bash
mysql -u <user> -p <database> < backend/migrations/003_create_audit_log.sql
mysql -u <user> -p <database> < backend/migrations/004_audit_log_immutability.sql
mysql -u <user> -p <database> < backend/migrations/005_audit_log_retention.sql
mysql -u <user> -p <database> < backend/migrations/006_add_portal_domain.sql
mysql -u <user> -p <database> < backend/migrations/007_create_bitrix_tokens.sql
```

Apply them in numeric order. See [DATA_MODEL.md](DATA_MODEL.md) for the schema.

## 3. Configure and start the backend

```bash
cp backend/.env.example backend/.env
# edit backend/.env, then:
npm install
cd backend && npm run build && npm start
```

Verify:

```bash
curl https://api.example.com/health      # {"status":"ok"}
curl https://api.example.com/readiness   # config + database checks
```

### Running under a process manager

Any supervisor works. With PM2:

```bash
cd backend
pm2 start dist/server.js --name b24-backend
pm2 save
pm2 startup      # follow the printed instruction to survive reboots
```

On hosts without systemd (typical shared hosting), `scripts/start-b24-backend.sh`
is a watchdog you can schedule on a cron every few minutes. Set `APP_DIR` to your
checkout path before using it.

## 4. Build and distribute the extension

```bash
cd extension && npm run build
# output: extension/dist/
```

The build produces an extension with **no backend baked in**. Users configure the
backend URL on the options page after installing. To ship a build that is
pre-configured for your own deployment, set the backend URL at build time:

```bash
echo 'VITE_BACKEND_URL=https://api.example.com' > .env
cd extension && npm run build
```

That value only seeds the default on first run. Users can still change it.

`scripts/build-extension.sh` runs typecheck, build, validation, and produces a
zip in `build/` ready for the Chrome Web Store.

### Chrome Web Store

See [docs/deployment/chrome-web-store.md](docs/deployment/chrome-web-store.md).

After publishing you receive a permanent extension ID. Add it to the backend CORS
allowlist and restart:

```
CORS_ORIGINS=chrome-extension://<extension-id>
```

For local development with an unpacked extension, the ID changes on every reload
unless you pin it with a `key` in the manifest, so during development it is normal
to leave `CORS_ORIGINS` unset (it defaults to `*` and the backend warns).

## 5. Environment variables

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | Yes | | Signing secret. Use at least 32 random bytes |
| `BITRIX24_CLIENT_ID` | Yes | | OAuth application client ID |
| `BITRIX24_CLIENT_SECRET` | Yes | | OAuth application client secret |
| `BITRIX24_ALLOWED_PORTALS` | Yes* | | Comma separated portals this backend serves. Supports `*.suffix` wildcards and `*` for any portal |
| `BITRIX24_PORTAL_DOMAIN` | Yes* | | Single portal shorthand. Sets the allowlist when `BITRIX24_ALLOWED_PORTALS` is unset |
| `DATABASE_URL` | Production | | `mysql://user:pass@host:3306/db` |
| `TOKEN_ENCRYPTION_KEY` | Production | | 64 hex characters (32 bytes) used to encrypt stored Bitrix24 refresh tokens |
| `BACKEND_URL` | Yes in production | `http://localhost:3000` | Public origin, used to build the OAuth redirect URI |
| `PORT` | No | `3000` | Listening port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `JWT_EXPIRY_SECONDS` | No | `3600` | JWT lifetime |
| `CORS_ORIGINS` | No | `*` | Comma separated allowed origins |
| `MAX_COMMENT_LENGTH` | No | `5000` | Maximum comment length |
| `DUPLICATE_WINDOW_SECONDS` | No | `300` | Duplicate detection window |
| `TRUST_PROXY` | Behind a proxy | `0` | How many reverse proxies sit in front. See below |

### `TRUST_PROXY`, and why the number matters

Almost every deployment puts the backend behind something: nginx, Caddy, a load
balancer, Cloudflare. Express then sees the proxy's address on every request
rather than the client's, and the per IP rate limiters key on that one address.
Left at `0`, every visitor shares a single bucket, so the limiter stops
protecting anyone individually and starts locking out everyone collectively.

It is a hop count, not a boolean, because a client can prepend entries to
`X-Forwarded-For` but cannot affect the ones your own proxies append on the
right. Trusting exactly the number of proxies that really exist is what makes
the header safe to read.

| Your setup | Value |
|---|---|
| Backend exposed directly, no proxy | `0` |
| One reverse proxy (nginx, Caddy, Traefik) | `1` |
| Cloudflare in front of one reverse proxy | `2` |

Set it too low and everyone shares a bucket. Set it too high and a client can
forge its own address and evade the limit entirely. If you change what sits in
front of the backend, change this in the same deploy.

\* Set at least one of `BITRIX24_ALLOWED_PORTALS` or `BITRIX24_PORTAL_DOMAIN`.

### Extension (repo root `.env`, build time only, optional)

| Variable | Description |
|---|---|
| `VITE_BACKEND_URL` | Seeds the default backend URL on first run |
| `VITE_SUPPORT_URL` | Origin the Get help form and the hosting waitlist post to. Build time only, and deliberately not a user setting: a support message is addressed to whoever published the build. Empty hides both forms and offers the issue tracker instead |

## 6. Bitrix24 application settings

| Field | Value |
|---|---|
| Handler / redirect URI | `https://api.example.com/auth/callback` |
| Scope | `crm` |
| Type | Server application (local application on your portal) |

The redirect URI registered with Bitrix24 must match `BACKEND_URL` exactly,
including scheme and any port.

## 7. Upgrading

```bash
git pull
npm install
cd backend && npm run build
# apply any new migrations, then restart the process
```

Migrations are additive and safe to re-run in order on a fresh database. Check
[CHANGELOG.md](CHANGELOG.md) for migration requirements per release.
