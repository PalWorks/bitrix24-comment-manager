# Changelog

All notable changes to the Bitrix24 Comment Manager are documented in this file. Entries are ordered from newest to oldest.

## [2.0.1] Resilience audit

A pass over the whole codebase looking for what breaks under a bad network and
under concurrency, rather than under a wrong input. Nothing here changes how the
extension is configured or deployed, and no migration is needed.

### Fixed

- **A slow portal could hold a request open indefinitely.** No outbound call had
  a deadline, and Node's `fetch` has no default one, so a Bitrix24 that accepted
  a connection and then stopped answering held the socket, the Express request
  and a queue slot until the operating system gave up. Every call the backend
  makes now carries a 20 second timeout.
- **Concurrent 401s raced over the refresh token.** Bitrix24 rotates the refresh
  token on use, so when several requests for one member expired together, the
  first exchange invalidated the token the rest were holding, and the last to
  finish wrote back a pair Bitrix24 had already superseded. Refreshes now
  coalesce per member.
- **A failed comment blocked its own retry.** The duplicate guard claimed the
  comment hash before the comment was sent and kept the claim when the send
  failed, so an agent whose connection dropped was refused when they tried again
  with "already submitted recently". The claim is released when the send does
  not succeed; a successful comment still holds it for the full window.
- **A dropped connection failed the request outright.** Transport failures are
  now retried with the same backoff as a rate limit. Retrying stops as soon as
  the far end gives an actual answer, since that is a decision rather than a
  failure to reach one.
- **A timed out token refresh logged the agent out.** The extension cleared its
  JWT on any refresh failure, including a timeout on a congested link, ending a
  session that was still valid for another five minutes. It now distinguishes a
  refusal (401 or 403, cleared) from a failure to reach the backend (kept, and
  retried with backoff until the token would expire anyway).
- **The popup reported no lead after the service worker slept.** Lead state
  lives in the worker, Manifest V3 discards an idle worker after about thirty
  seconds, and the content script only speaks on navigation, so reading a lead
  for a minute and then opening the popup showed nothing. The worker now falls
  back to the active tab's own URL, which is the same evidence the content
  script would have sent.
- **A login could be stored under a shared placeholder.** An OAuth callback with
  no member id was filed as `unknown`, and tokens are looked up by that id
  alone, so two unattributed logins from different portals would collide in one
  row. Such a callback is now refused.
- **The last retry slept its full backoff before failing.** Up to eight seconds
  added to an error the caller was always going to receive.
- **Cancelling a login left it running.** Closing the authorization window now
  stops the poll, after one final attempt in case the window was closed just
  after authorizing.
- **A non-JSON reply surfaced as a parse error.** A proxy, captive portal or
  dead tunnel answers with HTML; the agent saw "Unexpected token <". The status
  code is reported instead, and a 200 that is not JSON says so.
- **The content script logged an error on every navigation.** Its lead messages
  are one way, so the promise `sendMessage` returns always rejected, unhandled,
  in the console of the customer's own Bitrix24 page.
- **`history.pushState` was patched in the wrong world.** A content script runs
  in an isolated world, so the patch applied to its own `history` while Bitrix24
  went on calling an untouched one. It never fired, the MutationObserver was
  doing all the work, and the only lasting effect was a listener that could not
  be removed. Removed.
- **Logging out after a restart reported no session.** The result was taken from
  the in-process cache alone, which is empty after a restart while the tokens
  are still on disk.
- **Shutdown could hang until SIGKILL.** `server.close()` waits for every
  keep-alive connection, and pending login timers held the event loop open.
  There is now a 15 second ceiling, and those timers are unreferenced.
- **The duplicate store rebuilt itself on every request** and passed each entry
  as a function argument, which throws once the store outgrows the engine's
  argument limit.

### Added

- `VITE_SUPPORT_URL` is committed in `.env.production`. It was passed on the
  command line, so a build that forgot it shipped with the Get help form
  silently hidden and nothing anywhere saying so.
- Unhandled rejections and uncaught exceptions are logged in the same shape as
  everything else before the process exits.
- A token close to expiry is renewed before a request is spent on it, which
  covers the case where Manifest V3 discarded the scheduled refresh and nothing
  woke the worker to reinstate it.
- "Who builds this" on the Help page, and a matching support topic, for teams
  who want Bitrix24, eCommerce or AI agent work done rather than just the
  extension.
- 23 tests covering the above.

### Changed

- The per-portal request queue now holds a request that arrives mid-drain,
  instead of letting it go direct and defeat the throttle the queue exists to
  impose.
- The rate limiters are documented as fixed window, which is what they are.

## [2.0.0] Open Source Release

The project is now portable: any Bitrix24 team can run it, against any portal,
without editing the source. Existing single portal deployments keep working with
no configuration change.

### Breaking

- **New required secret.** `TOKEN_ENCRYPTION_KEY` (64 hex characters, generate
  with `openssl rand -hex 32`) is required in production. The backend refuses to
  start without it rather than storing Bitrix24 tokens in plaintext.
- **Two new migrations**, `006_add_portal_domain.sql` and
  `007_create_bitrix_tokens.sql`. Apply both before deploying.
- **Re-run `004` and `005`.** Both are now idempotent and must be re-applied to
  fix the retention conflict described below.
- **Voice input removed.** It was disabled in the popup and advertised in the
  README. See below.
- `BITRIX24_PORTAL_DOMAIN` is no longer required on its own; either it or
  `BITRIX24_ALLOWED_PORTALS` must be set. Existing deployments that set it are
  unaffected.

### Added

- **Runtime configuration.** The backend URL is set from the options page and
  stored per installation. One build now serves every deployment.
  `VITE_BACKEND_URL` remains as an optional build time default.
- **Multi portal support.** `BITRIX24_ALLOWED_PORTALS` accepts a comma separated
  list with `*.suffix` wildcards, so one backend can serve several portals.
  `GET /auth/login` takes a `portal` parameter, validated against that allowlist.
- **Portals beyond bitrix24.com.** Regional domains, custom domains, and self
  hosted installations are added from the options page, which requests the host
  permission and registers a content script at runtime.
- **Durable Bitrix24 tokens.** Persisted to MySQL, encrypted with AES-256-GCM.
- `portal_domain` recorded on every audit entry.
- OAuth state is bound to the portal the login started for, so a state issued
  for one allowed portal cannot be completed against another.
- Community documentation: `docs/SETUP.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue and pull request templates, MIT `LICENSE`.

### Fixed

- **The retention purge could never run.** Migration 004's `BEFORE DELETE`
  trigger blocked every delete on `comment_audit_log`, including the purge that
  migration 005 schedules. The trigger now permits deletes only from within the
  retention procedure.
- **Migration 005 failed on MySQL.** It used `CREATE INDEX IF NOT EXISTS`, which
  MySQL does not support. The index was redundant with one from migration 003 and
  has been removed.
- **Agents were logged out whenever the service worker idled out.** The JWT was
  held in a module variable, which Manifest V3 discards when it terminates an
  idle worker. It now lives in `chrome.storage.session` and the refresh schedule
  is reinstated on startup.
- **Every backend restart de-authenticated every agent.** Bitrix24 tokens were
  held only in memory. See the persistence change above.
- **Failed authorizations were not audited.** Only a failed token exchange
  produced an `AUTH_FAILURE` entry; a missing parameter, a replayed state, and a
  disallowed portal did not. All four are audited now.
- **Lead detection missed portals served under a path prefix.** The URL pattern
  is matched against the pathname rather than the whole URL.
- **The test suite was red.** Thirteen tests were failing against the previous
  release. The suite is green at 274 tests, up from 203, with new coverage for
  settings, the portal registry, encryption, the token store, and the portal
  allowlist.

### Changed

- CSP no longer pins `connect-src`. Manifest V3's default carries no such
  directive, and pinning it hard coded a single deployment's hostname into every
  build.
- The popup and options page no longer load fonts from a CDN.
- CI consolidated to a single workflow with one job, running on pull requests and
  pushes to `main` only. The unused Cloud Run deployment workflow was removed.
- The corrected description of backend state and scaling replaces an inaccurate
  comment in `config.ts` that claimed the backend held no in-process state.

### Removed

- **Voice input.** The Web Speech API integration was unconditionally hidden in
  the popup because of CSP and permission prompt problems, while the README
  listed it as a headline feature. The module, the button, its test, and the
  associated `google.com` CSP entries are gone. It remains in git history.
- Dead `agents` and `agent_mappings` migrations. Neither table was referenced by
  any code.
- Cloud Run deployment documentation and workflow, which did not match how the
  project is actually deployed.

## [1.1.0] Deployment and OAuth Rewrite

### MySQL Migration (commit 7f1cf73)

- Migrated database driver from `pg` (PostgreSQL) to `mysql2`.
- Updated `DATABASE_URL` format to `mysql://user:pass@host:3306/db`.
- Rewrote all migration SQL files for MySQL syntax (`AUTO_INCREMENT`, `DATETIME`, `CURRENT_TIMESTAMP`).
- Updated `auditLogger.ts` and readiness checks for `mysql2` query API.
- Updated all unit and integration tests to mock `mysql2` instead of `pg`.

### Shared Hosting Deployment (commit e420b32 context)

- Set up Node.js 20 via NVM and PM2 on shared hosting.
- Created PHP reverse proxy (`deploy/php-proxy/proxy.php`) to forward HTTPS traffic from `api.example.com` to Node.js on port 3001.
- Created `.htaccess` to route all API subdomain requests through the proxy.
- Configured TLS for `api.example.com`.
- Backend confirmed live at `https://api.example.com/health`.

### OAuth Flow Rewrite: Server-Side Callback (commit e746b01)

**Backend:**
- `GET /auth/login` now returns `{ authUrl, state }` using `https://api.example.com/auth/callback` as `redirect_uri` (accepted by Bitrix24).
- Added `GET /auth/callback`: handles Bitrix24 redirect, exchanges code for tokens, stores JWT in `pendingSessions` map keyed by state (10-minute TTL).
- Added `GET /auth/poll?state=`: extension polls this until JWT is available.

**Extension:**
- Replaced `chrome.identity.launchWebAuthFlow` with `chrome.windows.create({ type: 'popup' })` + polling loop.
- Removed `identity` permission from `manifest.json`.
- `VITE_BACKEND_URL` set via root `.env` file read by Vite's `envDir: '..'`.

### UX Improvements (commit 6fc8426)

- Auth flow now opens a small floating popup window (520x680) instead of a new tab, keeping the user on the Bitrix24 page throughout.
- `navigationWatcher.ts`: added `history.pushState` and `replaceState` interception so the extension detects Bitrix24 SPA navigation immediately without requiring a page refresh.

### Self-Healing Proxy and PM2 Watchdog (commits d3ca08a)

- `proxy.php` upgraded with self-healing logic: detects `CURLE_COULDNT_CONNECT`, calls `shell_exec` to restart PM2, waits 5 seconds, and retries the request.
- `scripts/start-b24-backend.sh`: PM2 watchdog registered as an hPanel cron job (every 5 minutes).
- Added `DEPLOYMENT.md` with the full development and deployment pipeline.

### Documentation Updates (this session)

- Updated `README.md`: MySQL stack, deployment section, new OAuth API table, corrected tech stack and prerequisites.
- Updated `ARCHITECTURE.md`: MySQL references, runtime, server-side OAuth flow, mysql2 pool.
- Updated `DATA_MODEL.md`: MySQL schema syntax, `mysql` CLI migration command.
- Updated `MEMORY.md`: replaced Cloud Run and GCP assumptions with a PM2 process, updated AD-8 to document server-side OAuth decision.

## [1.0.0] Production Release


### Final Remediations (commit 5067aec)

**Security:**
- Stripped `http://localhost:3000` from the Content Security Policy in production extension builds via `build-extension.sh`.

**Reliability:**
- Added 30-second `AbortController` timeout to all backend `fetch` calls in `apiClient.ts` and `tokenManager.ts`.
- Added promise guard mutex in `tokenManager.ts` to prevent concurrent token refresh network calls.

**Performance:**
- Added periodic pruning (every 60s) of expired rate limiter Map entries in `rateLimiter.ts`.
- Wired `stopPruneTimer()` into the graceful shutdown sequence in `server.ts`.

**User Experience:**
- Added offline feedback banner to the popup UI. Pings `/health` every 15 seconds with a 5-second timeout and displays an orange "Backend unreachable" banner when connectivity is lost.

**Tests:**
- Added `tests/unit/extension/apiClient.test.ts` (6 tests: success, signal passing, API error, network error, timeout, no token).
- Updated `tests/unit/backend/rateLimiter.test.ts` with pruning cleanup and idempotency test.

### Phase 8: Deployment Infrastructure (commit 7110ee6)

- Created `backend/Dockerfile` with multi-stage build (node:20-alpine, non-root user).
- Created `.github/workflows/ci.yml` (lint, typecheck, test, build on push/PR).
- Created `.github/workflows/deploy.yml` (Docker build, GCR push, Cloud Run deploy with health check verification).
- Created `scripts/build-extension.sh` (production build with CSP injection, zip bundling, size validation).
- Created deployment documentation: `docs/deployment/cloud-run.md`, `chrome-web-store.md`, `secrets.md`, `monitoring.md`.
- Created `docs/operations/runbook.md` for production troubleshooting.

### Phases 3 to 5: Comments, Audit, Options, Voice (commit 666bba7)

**Backend:**
- Added `routes/comments.ts` with full CRUD (create, edit, delete) for timeline comments.
- Added `middleware/commentValidator.ts` with body validation, length limits, and SHA-256 duplicate detection.
- Added `middleware/leadAuth.ts` for lead-level authorization via Bitrix24 API.
- Added `services/bitrix24Client.ts` with request queuing and exponential backoff for Bitrix24 rate limits.
- Added `services/auditLogger.ts` with fire-and-forget PostgreSQL logging, pending write tracking, and graceful drain.
- Added `models/auditLog.ts` with typed `AuditLogEntry` and `ActivityLogRow` interfaces.
- Added `routes/activity.ts` for agent activity log queries.
- Added `utils/hash.ts` for SHA-256 comment hashing.

**Extension:**
- Built popup UI with comment form (textarea, voice button, submit), comment list with edit/delete actions, character counter, and loading states.
- Added `popup/voiceInput.ts` with Web Speech API integration for voice to text transcription.
- Built options page with agent info display and paginated activity log.
- Added `COMMENT_CREATE`, `COMMENT_EDIT`, `COMMENT_DELETE`, `GET_LEAD_INFO`, `GET_ACTIVITY_LOG` message handlers to `messageRouter.ts`.

### Phase 2: Lead Detection (commit 1f412e3)

- Added `content/content.ts` as the content script entry point injected into `*.bitrix24.com` pages.
- Added `content/urlParser.ts` with regex-based lead ID extraction from Bitrix24 URLs.
- Added `content/navigationWatcher.ts` with throttled monitoring for SPA navigation events.
- Added `background/leadState.ts` for per-tab lead ID tracking.
- Added `LEAD_DETECTED`, `LEAD_NOT_DETECTED`, `GET_LEAD_STATE` message handlers to `messageRouter.ts`.
- Added lead context display to the popup UI (lead ID, name, detecting/found/not-found states).

### Phase 1: Authentication (commit e759638)

**Backend:**
- Added `services/tokenService.ts` with JWT signing/verification, Bitrix24 token storage, OAuth state management, and JTI blacklist with expiry-based cleanup.
- Added `middleware/jwtAuth.ts` for Bearer token verification and `req.user` injection.
- Added `middleware/agentAuth.ts` for agent-level authorization (verifies stored Bitrix24 tokens).
- Added `middleware/rateLimiter.ts` with sliding window rate limiting (per-agent and per-IP).
- Added `routes/auth.ts` with `GET /auth/login` (OAuth URL generation), `POST /auth/callback` (code exchange), `POST /auth/logout` (token cleanup), and `POST /auth/refresh` (JWT renewal).

**Extension:**
- Added `background/tokenManager.ts` with in-memory JWT storage and automatic refresh scheduling (5 minutes before expiry).
- Added `background/apiClient.ts` as a fetch wrapper with JWT injection.
- Added `background/auth.ts` with OAuth2 flow via `chrome.identity.launchWebAuthFlow`.
- Added `background/messageRouter.ts` with typed message dispatch for `AUTH_LOGIN`, `AUTH_LOGOUT`, `AUTH_STATUS`.
- Implemented `background/service-worker.ts` entry point with `chrome.runtime.onMessage` listener.
- Built popup UI with three-state layout: loading, logged out (connect button), and logged in (agent info + lead context).

### Phase 0: Project Setup (commit 0e20986)

- Initialized npm workspaces monorepo with `backend/` and `extension/` packages.
- Configured TypeScript (strict mode, `tsconfig.base.json` with project references).
- Configured Vite with CRXJS plugin for Chrome extension development.
- Configured ESLint and Prettier for code quality.
- Created `manifest.json` (Manifest V3) with permissions, CSP, and content script registration.
- Created `vitest.config.ts` with jsdom environment for extension tests and custom JS-to-TS resolver.
- Set up Express server skeleton with Helmet, CORS, health/readiness endpoints, and graceful shutdown.
- Created `backend/src/config.ts` with environment variable loading and validation.
- Created typed error hierarchy in `backend/src/utils/errors.ts` (8 error subclasses).
- Created structured JSON logger in `backend/src/utils/logger.ts`.
