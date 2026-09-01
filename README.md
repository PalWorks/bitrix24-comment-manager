# Bitrix24 Comment Manager

A Chrome extension and companion backend that give Bitrix24 CRM teams a governed,
audited way to comment on leads.

Agents comment from a small popup on the lead page. Nothing goes to Bitrix24
directly: every operation is routed through a backend you run, which
authenticates the agent, checks authorization, enforces rate and size limits,
rejects duplicates, and writes an immutable audit record. Pair it with Bitrix24
role permissions that remove direct comment rights and you have a complete,
reviewable trail of who wrote what, when, and on which lead.

Works with any Bitrix24 portal: `bitrix24.com`, the regional domains, a custom
domain, or a self hosted installation.

**Status:** production use at one organization since 2026. Open sourced so other
Bitrix24 teams can run it too.

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuring the extension](#configuring-the-extension)
- [API reference](#api-reference)
- [Project layout](#project-layout)
- [Development](#development)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## How it works

```
+---------------------+         +-------------------+         +------------------+
|   Chrome Extension  |  JWT    |   Your Backend    |  REST   |   Bitrix24 CRM   |
|                     | ------> |   (Express)       | ------> |   REST API       |
|  - Popup UI         |         |                   |         +------------------+
|  - Service Worker   | <------ |  - OAuth2         |
|  - Content Script   |  JSON   |  - Comment CRUD   |         +------------------+
|  - Options Page     |         |  - Rate limiting  | ------> |   MySQL          |
+---------------------+         |  - Audit log      |         |   (audit + tokens)|
                                +-------------------+         +------------------+
```

1. The content script detects a lead page from its URL and reports the lead ID to
   the service worker.
2. The popup asks the service worker for auth state and lead context.
3. Comment operations go popup to service worker to backend.
4. The backend runs the authorization chain, calls the Bitrix24 REST API, and
   records the operation.

The extension never holds a Bitrix24 token. It holds a short lived JWT issued by
your backend; the Bitrix24 OAuth credentials stay server side.

### Why a backend at all

Because the point is governance. An extension that called Bitrix24 directly would
need Bitrix24 credentials on every agent's machine, could not enforce a policy the
agent cannot bypass, and could not produce an audit log the agent cannot edit.

## Features

- **Automatic lead detection** from the page URL, including SPA navigation with no
  page reload.
- **Comment create, edit, delete** on the CRM lead timeline.
- **OAuth2 with a server side callback**, so Bitrix24's redirect URI validation is
  satisfied without putting credentials in the browser.
- **Automatic JWT refresh** five minutes before expiry, with concurrent refresh
  coalescing.
- **Per agent rate limiting** on a sliding window.
- **Immutable audit log** in MySQL. Comment bodies are never stored, only a
  SHA-256 hash.
- **Duplicate prevention** within a configurable window.
- **Multi portal**: one backend can serve several Bitrix24 portals, gated by an
  allowlist.
- **Runtime configuration**: point the extension at your backend from the options
  page. No rebuild needed.
- **Two routes to a backend** offered in the options page: cloud hosted, which
  we run, or self hosted, which you run.
- **Options page in three sections**: Settings, Plans and billing, and Help,
  each deep linkable (`options.html#billing`).
- **Built in support form** with attachments, delivered through Resend. Optional,
  and off unless a deployment configures a mailbox.
- **Offline feedback** when the backend is unreachable.

## Requirements

- Node.js 20 or newer, npm 9 or newer
- MySQL 8 or newer (required in production; optional for local development)
- A Bitrix24 portal where you can create a local application
- Google Chrome

## Quick start

Full walkthrough, including the Bitrix24 application registration, is in
[docs/SETUP.md](docs/SETUP.md). The short version:

```bash
git clone https://github.com/<your-org>/bitrix24-comment-manager.git
cd bitrix24-comment-manager
npm install

cp backend/.env.example backend/.env
# fill in JWT_SECRET, BITRIX24_CLIENT_ID, BITRIX24_CLIENT_SECRET,
# BITRIX24_ALLOWED_PORTALS

cd backend && npm run dev
```

```bash
curl http://localhost:3000/health   # {"status":"ok"}
```

Or bring up the backend and its database together with Docker, which is the
shortest path to a working deployment:

```bash
cp .env.docker.example .env    # fill in the Bitrix24 values and two secrets
docker compose up -d
```

Full walkthrough in [docs/deployment/docker.md](docs/deployment/docker.md).

Then build and load the extension:

```bash
cd extension && npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `extension/dist/`. Open the extension and enter your backend URL when it
asks.

For deployment, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Configuring the extension

The extension ships with no backend address compiled in, so one build works for
everyone.

**Backend URL.** Set it on first run, or later from the options page. Stored per
installation in `chrome.storage.local`.

**Choosing a backend.** The options page offers three routes: managed hosting,
a one command Docker deployment, or pointing at a server you or your
administrator already run. Whichever you take, the result is one origin pasted
into the Backend URL field.

**Portals.** Portals on `bitrix24.com` work immediately. For any other portal, a
regional domain like `acme.bitrix24.de`, your own domain, or a self hosted
install, add it on the options page. Chrome asks you to approve access to that
site, and the extension then registers a content script for it. Remove a portal
and both the permission and the registration are withdrawn.

Distributors who want a pre-configured build can bake in a default:

```bash
echo 'VITE_BACKEND_URL=https://api.example.com' > .env
cd extension && npm run build
```

That only seeds the initial value. Users can still change it.

## API reference

Every endpoint except `/health`, `/readiness`, and `/auth/*` requires a
`Bearer` JWT.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Liveness. Returns `{"status":"ok"}` |
| `GET` | `/readiness` | No | Configuration and database checks |
| `GET` | `/auth/login?portal=` | No | Returns `{ authUrl, state, portal }` |
| `GET` | `/auth/callback` | No | Where Bitrix24 redirects after consent |
| `GET` | `/auth/poll?state=` | No | Extension polls for the JWT after the callback |
| `POST` | `/auth/logout` | JWT | Blacklists the JWT and drops stored tokens |
| `POST` | `/auth/refresh` | JWT | Issues a fresh JWT, blacklists the old one |
| `POST` | `/api/comments` | JWT | Create a timeline comment |
| `PUT` | `/api/comments/:id` | JWT | Edit a comment |
| `DELETE` | `/api/comments/:id` | JWT | Delete a comment |
| `GET` | `/api/leads/:leadId` | JWT | Fetch lead details |
| `GET` | `/api/activity` | JWT | The agent's recent audit entries |
| `GET` | `/support/config` | No | Whether this deployment accepts support mail, and its limits |
| `POST` | `/support` | No | Support message, optionally with one attachment |

`/support` is the only unauthenticated route that sends email, so it is
deliberately narrow: the sender and recipient come from configuration and can
never be set by a request, submissions are rate limited per IP on their own
namespace, the body and attachment are size capped before anything is decoded,
and attachment types are an allowlist. A deployment that sets none of
`RESEND_API_KEY`, `SUPPORT_FROM_EMAIL` and `SUPPORT_TO_EMAIL` answers 503 and
sends nothing, which is the normal state for a self hosted instance.

Setting `SUPPORT_ONLY=1` runs a process as a support mailbox and nothing else,
with the Bitrix24 and database requirements lifted and the comment routes
unmounted. That is what the publisher of a build runs so the Get help form has
somewhere to post; see
[docs/deployment/docker.md](docs/deployment/docker.md#running-a-support-mailbox-only).

### Authorization chain

`POST /api/comments` passes through nine checks in order. Each is a separate
middleware, so a failure is attributable:

1. JWT present and correctly signed
2. JWT not expired and not blacklisted
3. Agent active, meaning Bitrix24 tokens exist
4. Agent to Bitrix24 mapping complete
5. Lead exists (`crm.lead.get`)
6. Agent authorized for that lead
7. Per agent rate limit
8. Comment size
9. Duplicate detection

## Project layout

```
backend/
  migrations/          MySQL schema, applied in numeric order
  src/
    config.ts          Environment loading, portal allowlist
    server.ts          Express app, middleware, graceful shutdown
    middleware/        jwtAuth, agentAuth, leadAuth, rateLimiter, commentValidator
    routes/            auth, comments, leads, activity, support
    services/          tokenService, tokenStore, bitrix24Client, auditLogger,
                       supportMailer
    utils/             errors, logger, hash, crypto
extension/
  manifest.json        Manifest V3
  background/          service worker, message router, auth, tokens, portals
  content/             lead page detection
  popup/               main UI
  options/             configuration and activity log
  shared/              settings, constants, message types, types
docker-compose.yml     Backend and MySQL, for a one command deployment
docker-compose.support.yml  Support mailbox only, for the build's publisher
deploy/php-proxy/      Optional front door for shared hosting
docs/                  Setup, deployment, operations
tests/                 unit, integration, load
```

Deeper references: [ARCHITECTURE.md](ARCHITECTURE.md),
[DATA_MODEL.md](DATA_MODEL.md), [DOMAIN.md](DOMAIN.md),
[MEMORY.md](MEMORY.md) for decisions and their rationale,
[PLAYBOOK.md](PLAYBOOK.md) for common procedures.

## Development

```bash
npm install          # workspaces: covers both packages
npm run lint
npm run typecheck
npm test             # 343 tests
npm run test:coverage
```

```bash
cd backend && npm run dev      # backend with reload
cd extension && npm run build  # extension bundle into extension/dist/
```

MySQL is optional locally. Without `DATABASE_URL` the backend runs, audit writes
are skipped with a logged warning, and Bitrix24 tokens are held in memory only,
so they are lost on restart.

## Security

- Bitrix24 OAuth credentials never leave the backend.
- Bitrix24 access and refresh tokens are encrypted with AES-256-GCM before they
  are written to the database.
- The JWT lives in `chrome.storage.session`: memory backed, cleared when the
  browser closes, unreachable from content scripts and from any web page.
- Audit rows cannot be updated or deleted. A database trigger enforces it, with a
  single scoped exception for the retention purge.
- Comment bodies are never persisted, only their SHA-256 hash.
- Requests are redirected to HTTPS in production, with HSTS.
- The extension requests `https://*.bitrix24.com/*` up front, and anything else
  only when the user adds a portal.
- The support form posts to a fixed origin compiled into the build, never to a
  user settable one. A form whose recipient the user could change would be a
  mail relay.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Known limitations

Worth knowing before you deploy:

- **Leads only.** Deals, contacts, companies, and smart process automation
  entities are not supported yet.
- **Single instance.** The JWT blacklist, OAuth state, pending sessions, and rate
  limiter windows are per process. Running several instances behind a load
  balancer needs those moved to a shared store; see the roadmap.
- **The comment list is local.** The popup shows comments created in that session
  rather than the full Bitrix24 timeline.
- **Retention needs the MySQL event scheduler**, or an external cron calling
  `purge_expired_audit_logs`.

## Roadmap

- [ ] Move per process stores to Redis so the backend can scale horizontally
- [ ] Support deals, contacts, and companies alongside leads
- [ ] Read the real timeline into the popup instead of a session local list
- [ ] Prometheus metrics endpoint
- [ ] Admin dashboard for activity monitoring

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
